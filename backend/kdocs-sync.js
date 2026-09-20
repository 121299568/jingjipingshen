// 金山云文档（WPS 365 开放平台）同步
// ---------------------------------------------------------------
// 用于把系统实时算出的「年度经济评审结果汇总表」推送到金山云文档，
// 实现「线上系统算数 + 云文档协同」：系统保留自动计算/留痕/评论，云文档侧拿到同样的数据。
//
// 需要的配置（写在 backend/.env，缺任一项都只返回明确提示、不影响系统其它功能）：
//   KDOCS_CLIENT_ID      - 开放平台应用的 AppID，形如 AK2026xxxxxxx（必填）
//   KDOCS_CLIENT_SECRET  - 应用密钥（必填）
//   KDOCS_FILE_ID        - 目标文档：可直接填 file_id，也可填分享链接 https://www.kdocs.cn/l/xxxx
//                          （分享链接里 /l/ 后面的是 link_id，本模块会自动调 /v7/links/{id}/meta 换取真实 file_id）
//   KDOCS_FILE_TYPE      - airsheet（智能表格，默认）| sheet（传统表格）
//   KDOCS_SHEET_NAME     - 目标工作表名称，默认「年度汇总」（找不到时回退到第一个工作表）
//
// 官方接口（已核对文档）：
//   1) 取令牌： POST https://openapi.wps.cn/oauth2/token
//              Content-Type: application/x-www-form-urlencoded
//              grant_type=client_credentials&client_id=...&client_secret=...
//              （注意：本接口不接受 application/json，传 json 会返回 41500001）
//   2) 换 file_id：GET https://openapi.wps.cn/v7/links/{link_id}/meta   → data.file_id / data.drive_id
//   3) 工作表列表：GET https://openapi.wps.cn/v7/{airsheet|sheets}/{file_id}/worksheets
//   4) 写单元格：  POST https://openapi.wps.cn/v7/{airsheet|sheets}/{file_id}/worksheets/{sheet_id}/range_data/batch_update
//              body: { range_data: [ { op_type:'cell_operation_type_formula', formula, row_from,row_to,col_from,col_to } ] }
//              v7 没有 values 字段，内容与公式共用 formula；单次最多 1024 项，限频 10 次/秒（429000001 为超频）
//
// 首次联调建议先用 dryRun=true 打印矩阵核对，再真同步。

const BASE = 'https://openapi.wps.cn';

const CFG = {
  id: process.env.KDOCS_CLIENT_ID || '',
  secret: process.env.KDOCS_CLIENT_SECRET || '',
  fileRaw: (process.env.KDOCS_FILE_ID || '').trim(),
  fileType: (process.env.KDOCS_FILE_TYPE || 'airsheet').trim().toLowerCase(),
  sheetName: process.env.KDOCS_SHEET_NAME || '年度汇总'
};

let tokenCache = { token: '', exp: 0 };
let resolved = { fileId: '', driveId: '', name: '', from: '' };

// ---------- 配置 ----------
function parseFileInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'none' };
  const m = s.match(/kdocs\.cn\/l\/([A-Za-z0-9_-]+)/) || s.match(/^l\/([A-Za-z0-9_-]+)$/);
  if (m) return { kind: 'link', linkId: m[1] };
  return { kind: 'file', fileId: s };
}
function configOk() { return !!(CFG.id && CFG.secret && CFG.fileRaw); }
function missingConfig() {
  const miss = [];
  if (!CFG.id) miss.push('KDOCS_CLIENT_ID');
  if (!CFG.secret) miss.push('KDOCS_CLIENT_SECRET');
  if (!CFG.fileRaw) miss.push('KDOCS_FILE_ID');
  return miss;
}
function apiPrefix() { return CFG.fileType === 'sheet' ? 'sheets' : 'airsheet'; }

// ---------- 错误翻译：把官方返回转成人能看懂的说明 ----------
function explain(status, body) {
  const txt = typeof body === 'string' ? body : JSON.stringify(body || {});
  const scope = (txt.match(/The request scopes '([^']+)'/) || [])[1];
  if (/invalid_scope/.test(txt)) {
    return {
      kind: 'scope_missing',
      hint: '应用尚未开通接口权限' + (scope ? '（缺少 ' + scope + '）' : '') +
            '。请到 open.wps.cn 开发者后台 → 该应用 → 接口权限，勾选并申请开通后重试。'
    };
  }
  if (status === 401 || /401000001/.test(txt)) return { kind: 'token', hint: 'access_token 无效或已过期（本模块会自动重取，若持续出现请检查应用密钥）。' };
  if (/403000001|Insufficient permissions/.test(txt)) {
    return { kind: 'file_permission', hint: '接口权限已开通，但该应用对目标文档没有读写权限。请在金山文档里把目标文档共享给该应用（或把应用加入协作者）。' };
  }
  if (status === 403) return { kind: 'forbidden', hint: '被拒绝访问，通常是应用权限或文档协作者授权未完成。' };
  if (status === 404) return { kind: 'not_found', hint: '路径或 file_id 不存在：请确认 KDOCS_FILE_ID 填的是文件 ID；若填的是分享链接请确认链接可访问。' };
  if (/429|频率/.test(txt)) return { kind: 'rate_limit', hint: '调用超频（10 次/秒），稍后重试即可。' };
  return { kind: 'unknown', hint: '官方返回非预期结果，原始内容见 raw 字段。' };
}

async function httpJson(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    const txt = await r.text();
    let json = null;
    try { json = JSON.parse(txt); } catch (_) { json = null; }
    return { status: r.status, json, text: txt };
  } catch (e) {
    return { status: 0, json: null, text: '请求失败：' + e.message };
  } finally { clearTimeout(timer); }
}

// ---------- 令牌 ----------
async function getToken(force) {
  if (!force && tokenCache.token && Date.now() < tokenCache.exp - 60 * 1000) return tokenCache.token;
  const r = await httpJson(BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CFG.id, client_secret: CFG.secret }).toString()
  });
  const d = r.json || {};
  const tok = d.access_token || (d.data && d.data.access_token);
  if (!tok) {
    const e = explain(r.status, r.json || r.text);
    throw Object.assign(new Error('获取 access_token 失败：' + (d.msg || d.error || e.hint)), { diag: e, raw: d });
  }
  const exp = Number(d.expires_in || (d.data && d.data.expires_in) || 7200);
  tokenCache = { token: tok, exp: Date.now() + exp * 1000 };
  return tok;
}

// ---------- 分享链接 → file_id ----------
async function resolveFileId(token) {
  const p = parseFileInput(CFG.fileRaw);
  if (p.kind === 'file') { resolved = { fileId: p.fileId, driveId: '', name: '', from: 'file_id' }; return resolved; }
  if (p.kind === 'none') throw new Error('KDOCS_FILE_ID 未配置');
  const r = await httpJson(BASE + '/v7/links/' + encodeURIComponent(p.linkId) + '/meta', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const d = (r.json && (r.json.data || r.json)) || {};
  const fileId = d.file_id || d.fileId;
  if (!fileId) {
    const e = explain(r.status, r.json || r.text);
    throw Object.assign(new Error('分享链接换 file_id 失败：' + e.hint), { diag: e, raw: r.json || r.text });
  }
  resolved = { fileId, driveId: d.drive_id || '', name: d.name || d.fname || '', from: 'link' };
  return resolved;
}

// ---------- 工作表 ----------
async function listWorksheets(token, fileId) {
  const r = await httpJson(BASE + '/v7/' + apiPrefix() + '/' + encodeURIComponent(fileId) + '/worksheets', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const d = r.json || {};
  if (!(r.status === 200 && (d.code === 0 || d.code === undefined || d.data))) {
    const e = explain(r.status, d || r.text);
    throw Object.assign(new Error('获取工作表列表失败：' + e.hint), { diag: e, raw: d });
  }
  const raw = (d.data && (d.data.sheets || d.data.worksheets)) || d.sheets || d.worksheets || [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  if (!arr.length) throw new Error('该文档下没有工作表，请确认 KDOCS_FILE_ID 指向的是表格类文档');
  return arr.map(s => ({
    sheetId: s.sheet_id != null ? s.sheet_id : (s.id != null ? s.id : s.sheetId),
    name: s.name || s.title || '',
    rows: s.row_count || s.rows || null,
    cols: s.col_count || s.cols || null
  }));
}
function pickSheet(sheets) {
  const hit = sheets.find(s => s.name === CFG.sheetName);
  const first = hit || sheets[0];
  return { sheet: first, matched: !!hit, all: sheets.map(s => s.name).filter(Boolean) };
}

// ---------- 构造写入载荷 ----------
// v7 的 range_data 项：{ op_type, formula, row_from, row_to, col_from, col_to }
// 内容与公式共用 formula（以 = 开头会被当公式），故文本需原样写入、数字按数字写入。
function cellItem(v, row, col) {
  let val = v;
  if (val == null) val = '';
  else if (typeof val === 'number') val = Number.isFinite(val) ? val : '';
  else val = String(val);
  return { op_type: 'cell_operation_type_formula', formula: val, row_from: row, row_to: row, col_from: col, col_to: col };
}
// 把矩阵切成若干批次（每批最多 1024 项，官方上限）
function buildBatches(aoa, startRow) {
  const batches = [];
  let cur = [];
  const push = () => { if (cur.length) { batches.push(cur); cur = []; } };
  aoa.forEach((row, ri) => {
    (row || []).forEach((v, ci) => {
      cur.push(cellItem(v, (startRow || 0) + ri, ci));
      if (cur.length >= 1024) push();
    });
  });
  push();
  return batches;
}
// 清空一段矩形区域（用于矩阵变小时清掉旧数据残余）
function buildClearBatches(rowFrom, rowTo, cols) {
  const batches = [];
  let cur = [];
  for (let r = rowFrom; r <= rowTo; r++) {
    for (let c = 0; c < cols; c++) {
      cur.push(cellItem('', r, c));
      if (cur.length >= 1024) { batches.push(cur); cur = []; }
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function writeBatches(token, fileId, sheetId, batches, sleepMs) {
  const raws = [];
  for (let i = 0; i < batches.length; i++) {
    const r = await httpJson(BASE + '/v7/' + apiPrefix() + '/' + encodeURIComponent(fileId) +
      '/worksheets/' + encodeURIComponent(sheetId) + '/range_data/batch_update', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range_data: batches[i] })
    }, 20000);
    const d = r.json || {};
    raws.push(d);
    const ok = r.status === 200 && (d.code === 0 || d.code === undefined || d.success === true);
    if (!ok) {
      const e = explain(r.status, d || r.text);
      return { ok: false, diag: e, raw: d, done: i, total: batches.length, text: r.text };
    }
    if (sleepMs) await new Promise(s => setTimeout(s, sleepMs));
  }
  return { ok: true, done: batches.length, total: batches.length, raw: raws[raws.length - 1] };
}

// ---------- 对外：自检（凭据 / 权限 / 文档 / 工作表）----------
async function probe(opts) {
  const out = {
    client_id: CFG.id || '(未配置)', has_secret: !!CFG.secret,
    file_input: CFG.fileRaw ? (parseFileInput(CFG.fileRaw).kind === 'link' ? '分享链接' : 'file_id') : '(未配置)',
    file_type: CFG.fileType, sheet_name: CFG.sheetName,
    steps: [], ok: false
  };
  const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); return ok; };

  if (!CFG.id || !CFG.secret) {
    step('应用凭据', false, '缺少 KDOCS_CLIENT_ID / KDOCS_CLIENT_SECRET');
    out.error = '未配置应用凭据';
    return out;
  }
  let token;
  try { token = await getToken(true); step('应用凭据取令牌', true, '令牌有效，长度 ' + token.length); }
  catch (e) { step('应用凭据取令牌', false, e.message); out.error = e.message; out.diag = e.diag; return out; }

  try {
    const rf = await resolveFileId(token);
    step('目标文档 file_id', true, rf.from === 'link' ? ('由分享链接解析 → ' + rf.fileId.slice(0, 10) + '…' + (rf.name ? '（' + rf.name + '）' : '')) : ('直接使用 ' + rf.fileId.slice(0, 10) + '…'));
    const sheets = await listWorksheets(token, rf.fileId);
    const picked = pickSheet(sheets);
    step('工作表列表', true, '共 ' + sheets.length + ' 个：' + picked.all.join(' / ') + '；将写入「' + picked.sheet.name + '」' + (picked.matched ? '' : '（未找到同名表，回退第一个）'));
    out.sheet_id = picked.sheet.sheetId;
    out.sheet_picked = picked.sheet.name;
    out.ok = true;
    // 自检默认只做只读校验（取令牌 / 解析 file_id / 列工作表），不往文档里写任何东西；
    // 需要连写入权限一起验证时才传 writeTest（会占用 A1 单元格，真同步时会覆盖回来）。
    if (opts && opts.writeTest) {
      const r = await writeBatches(token, rf.fileId, picked.sheet.sheetId, [cellItem('__KDOCS_PROBE__', 0, 0)], 0);
      step('写入探针', r.ok, r.ok ? '写入成功（占用 A1，真同步时会覆盖）' : (r.diag ? r.diag.hint : '写入失败'));
      if (!r.ok) { out.error = r.diag ? r.diag.hint : '写入失败'; out.diag = r.diag; out.raw = r.raw; out.ok = false; }
    }
  } catch (e) {
    step('目标文档 / 工作表', false, e.message);
    out.error = e.message; out.diag = e.diag; out.raw = e.raw;
  }
  return out;
}

// ---------- 对外：推送矩阵 ----------
async function pushAoa(aoa, opts) {
  const dryRun = !!(opts && opts.dryRun);
  if (!configOk()) return { ok: false, error: '金山云文档未配置，缺少：' + missingConfig().join('、'), missing: missingConfig() };
  const cols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  const rows = aoa.length;
  if (dryRun) {
    return {
      ok: true, dryRun: true, size: rows + ' 行 × ' + cols + ' 列',
      preview: { headers: aoa[1] || [], totals: aoa[2] || [], first_row: aoa[3] || null },
      batches: buildBatches(aoa, 0).length
    };
  }
  const token = await getToken();
  const rf = await resolveFileId(token);
  const sheets = await listWorksheets(token, rf.fileId);
  const picked = pickSheet(sheets);
  const batches = buildBatches(aoa, 0);
  const w = await writeBatches(token, rf.fileId, picked.sheet.sheetId, batches, 120);
  if (!w.ok) {
    return {
      ok: false, error: (w.diag ? w.diag.hint : '写入失败'), diag: w.diag, raw: w.raw,
      sheetId: picked.sheet.sheetId, sheetName: picked.sheet.name, sheets: picked.all,
      progress: w.done + '/' + w.total
    };
  }
  return {
    ok: true, sheetId: picked.sheet.sheetId, sheetName: picked.sheet.name, sheets: picked.all,
    cells: rows * cols, batches: batches.length, raw: w.raw
  };
}

module.exports = { CFG, configOk, missingConfig, pushAoa, probe, parseFileInput, buildBatches, listWorksheets, pickSheet, apiPrefix };
