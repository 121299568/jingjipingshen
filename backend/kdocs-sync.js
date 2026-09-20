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
//   KDOCS_REDIRECT_URI   - 用户授权回调地址（须与开发者后台「安全配置→用户授权回调配置」完全一致）
//   KDOCS_USER_SCOPE     - 用户授权申请的 scope，逗号分隔（须已在权限管理里开通）
//   KDOCS_TOKEN_FILE     - 用户授权令牌的落盘路径，默认 backend/.kdocs-user-token.json
//
// ⚠️ 为什么有两种令牌模式（2026-09-20 实测结论）：
//   WPS 开放平台按「开发者身份」划分能力——如果你的应用是「第三方个人应用」（账号未做企业认证），
//   「企业文档」「团队管理」这类企业能力永远申请不到，用 client_credentials（应用身份）调用
//   /v7/drives、/v7/links/{id}/meta 必然报 ErrPrivileges: interface_company_doc。
//   官方对「第三方个人应用」只开放**用户授权**类能力，因此必须走 OAuth 授权码模式：
//   令牌代表「你本人」，访问的是你个人金山文档空间里的文件，能力判定与数据范围都随用户身份走。
//   → 有用户令牌时优先用用户令牌；没有才回退到应用凭证（企业应用场景）。
//
// 官方接口（已核对文档）：
//   1) 取令牌： POST https://openapi.wps.cn/oauth2/token
//              Content-Type: application/x-www-form-urlencoded
//              grant_type=client_credentials&client_id=...&client_secret=...        ← 应用身份
//              grant_type=authorization_code&client_id=&client_secret=&code=&redirect_uri=   ← 用户身份
//              grant_type=refresh_token&client_id=&client_secret=&refresh_token=
//              （注意：本接口不接受 application/json，传 json 会返回 41500001）
//   1b) 引导授权：GET https://openapi.wps.cn/oauth2/auth
//              ?response_type=code&client_id=&redirect_uri=&scope=&state=
//              支持「企业自建应用 / 第三方企业应用 / 第三方个人应用」；
//              回调 redirect_uri?code=xxx&state=xxx，code 10 分钟内有效且只能用一次；
//              access_token 2 小时，refresh_token 365 天（刷新会换新的 refresh_token，旧的立即失效）
//   2) 换 file_id：GET https://openapi.wps.cn/v7/links/{link_id}/meta   → data.file_id / data.drive_id
//   3) 工作表列表：GET https://openapi.wps.cn/v7/{airsheet|sheets}/{file_id}/worksheets
//   4) 写单元格：  POST https://openapi.wps.cn/v7/{airsheet|sheets}/{file_id}/worksheets/{sheet_id}/range_data/batch_update
//              body: { range_data: [ { op_type:'cell_operation_type_formula', formula, row_from,row_to,col_from,col_to } ] }
//              v7 没有 values 字段，内容与公式共用 formula；单次最多 1024 项，限频 10 次/秒（429000001 为超频）
//
// 首次联调建议先用 dryRun=true 打印矩阵核对，再真同步。

const BASE = 'https://openapi.wps.cn';
const fs = require('fs');
const nodePath = require('path');

const CFG = {
  id: process.env.KDOCS_CLIENT_ID || '',
  secret: process.env.KDOCS_CLIENT_SECRET || '',
  fileRaw: (process.env.KDOCS_FILE_ID || '').trim(),
  fileType: (process.env.KDOCS_FILE_TYPE || 'airsheet').trim().toLowerCase(),
  sheetName: process.env.KDOCS_SHEET_NAME || '年度汇总',
  createName: process.env.KDOCS_CREATE_NAME || '年度经济评审结果汇总表.ksheet',
  autoCreate: (process.env.KDOCS_AUTO_CREATE || '1') !== '0',
  // 用户授权（个人开发者唯一可用模式）
  redirectUri: process.env.KDOCS_REDIRECT_URI || 'https://lnsoft.mjumju.com/api/kdocs/oauth/callback',
  // ⚠️ 这里只能列「已在权限管理里开通」的 scope，否则授权接口会直接报错（未开通的 scope 不能出现在请求里）
  userScope: process.env.KDOCS_USER_SCOPE || 'kso.file.search,kso.file.readwrite,kso.file_link.readwrite,kso.sheets.readwrite,kso.airsheet.readwrite,kso.drive.readwrite',
  tokenFile: process.env.KDOCS_TOKEN_FILE || nodePath.join(__dirname, '.kdocs-user-token.json')
};

let tokenCache = { token: '', exp: 0 };
let resolved = { fileId: '', driveId: '', name: '', from: '' };

// ---------- 用户授权令牌的持久化 ----------
// 与系统 JWT 无关，纯粹是「本应用代表哪个金山用户」的凭据；落在 backend 下的隐藏文件里（勿提交）。
let userTokMem = null;
function loadUserToken() {
  if (userTokMem) return userTokMem;
  try {
    const j = JSON.parse(fs.readFileSync(CFG.tokenFile, 'utf8'));
    if (j && j.access_token) {
      userTokMem = { access_token: j.access_token, refresh_token: j.refresh_token || '', exp: Number(j.exp || 0), at: j.at || '' };
      return userTokMem;
    }
  } catch (_) { /* 未授权过 */ }
  return null;
}
function saveUserToken(t) {
  userTokMem = t;
  try { fs.writeFileSync(CFG.tokenFile, JSON.stringify(t, null, 2), { mode: 0o600 }); } catch (_) { /* 落盘失败不影响本次运行 */ }
}
function clearUserToken() {
  userTokMem = null;
  tokenCache = { token: '', exp: 0 };
  try { fs.unlinkSync(CFG.tokenFile); } catch (_) { /* 本来就没有 */ }
}
function tokenMode() {
  const u = loadUserToken();
  return {
    mode: u && u.access_token ? 'user' : 'app',
    mode_text: u && u.access_token ? '用户授权（以你本人的金山账号身份调用）' : '应用凭证（client_credentials，仅适用企业应用）',
    user_expires_at: u && u.exp ? new Date(u.exp).toISOString() : '',
    user_refreshable: !!(u && u.refresh_token),
    redirect_uri: CFG.redirectUri,
    scope: CFG.userScope
  };
}

// ---------- 用户授权（OAuth 授权码模式）----------
let pendingState = '';
function authUrl(state) {
  const st = state || (Math.random().toString(36).slice(2) + Date.now().toString(36));
  pendingState = st;
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CFG.id,
    redirect_uri: CFG.redirectUri,
    scope: CFG.userScope,
    state: st
  });
  return { url: BASE + '/oauth2/auth?' + q.toString(), state: st, redirect_uri: CFG.redirectUri, scope: CFG.userScope };
}
function checkState(state) {
  if (!pendingState) return true;          // 进程重启后 pendingState 丢失，不做硬拦截，只提示
  return String(state || '') === pendingState;
}
function readTokenPayload(d, status) {
  const tok = d.access_token || (d.data && d.data.access_token);
  if (!tok) {
    const msg = d.msg || d.error_description || d.error || d.message || ('HTTP ' + (status || 0));
    throw Object.assign(new Error('换取用户令牌失败：' + msg), { raw: d, status });
  }
  const exp = Number(d.expires_in || (d.data && d.data.expires_in) || 7200);
  return {
    access_token: tok,
    refresh_token: d.refresh_token || (d.data && d.data.refresh_token) || '',
    exp: Date.now() + exp * 1000,
    at: new Date().toISOString()
  };
}
async function exchangeCode(code) {
  const r = await httpJson(BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CFG.id, client_secret: CFG.secret,
      code, redirect_uri: CFG.redirectUri
    }).toString()
  });
  const t = readTokenPayload(r.json || {}, r.status);
  saveUserToken(t);
  pendingState = '';
  return { ok: true, expires_in: Math.round((t.exp - Date.now()) / 1000), has_refresh: !!t.refresh_token, raw: r.json };
}
async function refreshUserToken() {
  const u = loadUserToken();
  if (!u || !u.refresh_token) throw new Error('没有可用的 refresh_token，需要重新走一次用户授权');
  const r = await httpJson(BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: CFG.id, client_secret: CFG.secret,
      refresh_token: u.refresh_token
    }).toString()
  });
  const t = readTokenPayload(r.json || {}, r.status);
  // 官方：刷新会返回新的 refresh_token，旧的立即失效；未返回则沿用旧的
  if (!t.refresh_token) t.refresh_token = u.refresh_token;
  saveUserToken(t);
  return t;
}

// ---------- 配置 ----------
function parseFileInput(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kind: 'none' };
  const m = s.match(/kdocs\.cn\/l\/([A-Za-z0-9_-]+)/) || s.match(/^l\/([A-Za-z0-9_-]+)$/);
  if (m) return { kind: 'link', linkId: m[1] };
  return { kind: 'file', fileId: s };
}
function configOk() {
  return !!(CFG.id && CFG.secret && (CFG.fileRaw || (CFG.autoCreate && CFG.createName)));
}
function needCreate() { return !CFG.fileRaw && CFG.autoCreate; }
function missingConfig() {
  const miss = [];
  if (!CFG.id) miss.push('KDOCS_CLIENT_ID');
  if (!CFG.secret) miss.push('KDOCS_CLIENT_SECRET');
  if (!CFG.fileRaw && !needCreate()) miss.push('KDOCS_FILE_ID');
  return miss;
}
function apiPrefix() { return CFG.fileType === 'sheet' ? 'sheets' : 'airsheet'; }

// ---------- 错误翻译：把官方返回转成人能看懂的说明 ----------
// scope 名 → 开发者后台里的位置说明（实测归纳，便于用户照着点）
const SCOPE_WHERE = {
  'kso.drive.readwrite': '云文档 → KSO-管理驱动盘',
  'kso.file.readwrite': '云文档 → KSO-查询和管理文件',
  'kso.file.read': '云文档 → KSO-查询文件',
  'kso.file.search': '云文档 → KSO-搜索文件',
  'kso.file_link.readwrite': '云文档 → KSO-查询和管理文件分享',
  'kso.sheets.readwrite': '云文档 → KSO-读取和管理表格',
  'kso.sheets.read': '云文档 → KSO-查询表格',
  'kso.airsheet.readwrite': '云文档 → KSO-读取和管理智能表格',
  'kso.doclib.read': '云文档 → KSO-查询文档库',
  'kso.dbsheet.read': '多维表格 → KSO-查询多维表格',
  'kso.user_base.read': '通讯录 → KSO-查询用户基础信息'
};
// 接口权限（interface privilege）错误码 → 需要开通的「能力」
const IFACE_WHO = {
  interface_company_doc: '企业文档（企业文档二次开发接口）',
  interface_team_manage: '团队管理（团队管理能力）',
  interface_company_space: '企业空间管理',
  interface_company_group: '企业团队管理'
};
const PUBLISH_TIP = '注意：新申请的接口权限属于「版本敏感项」，必须到 开发者后台 → 应用发布 → 版本管理 → 创建版本并申请发布，再由 企业管理员 在企业管理后台审核通过后才会生效。';

function explain(status, body) {
  const txt = typeof body === 'string' ? body : JSON.stringify(body || {});
  const scope = (txt.match(/The request scopes '([^']+)'/) || [])[1];
  if (/invalid_scope/.test(txt)) {
    const where = scope && SCOPE_WHERE[scope] ? '（位置：权限管理 → ' + SCOPE_WHERE[scope] + '）' : '';
    return {
      kind: 'scope_missing',
      scope: scope || '',
      hint: '应用尚未开通该接口的 scope' + (scope ? '：' + scope : '') + where +
            '。请到 open.wps.cn 开发者后台 → 该应用 → 权限管理 → 接口权限，勾选并申请开通。' + PUBLISH_TIP
    };
  }
  const iface = (txt.match(/ErrPrivileges:\s*(\w+)/) || [])[1];
  if (iface) {
    return {
      kind: 'iface_missing',
      iface,
      hint: '应用缺少「' + (IFACE_WHO[iface] || iface) + '」接口权限。**这是应用级能力，与令牌模式无关** —— ' +
            '实测已确认：换成用户授权令牌后，/v7/files/search、/v7/drives、/v7/links/{id}/meta 仍然报同一个 ErrPrivileges。' +
            '个人开发者（未做企业认证）申请不到该能力；需成为「企业服务商」（用 WPS 365 企业超管账号登录开放平台，免认证）' +
            '并创建「企业内建应用」后，才能在权限管理里申请。' + PUBLISH_TIP
    };
  }
  if (/unable to read user permission/.test(txt)) {
    return {
      kind: 'file_permission',
      hint: '接口权限已开通，但该应用对目标文档没有权限。请把目标文档共享给该应用（或在文档「协作」里把应用加为可编辑协作者），再确认 KDOCS_FILE_ID 是该文档的真实 file_id。'
    };
  }
  if (status === 401 || /401000001/.test(txt)) return { kind: 'token', hint: 'access_token 无效或已过期（本模块会自动重取，若持续出现请检查应用密钥）。' };
  if (/403000001|Insufficient permissions|user has no write permission|PermissionDenied/.test(txt)) {
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
// 优先用户授权令牌（个人开发者唯一可用路径）；没有才回退应用凭证。
async function getToken(force) {
  if (!force && tokenCache.token && Date.now() < tokenCache.exp - 60 * 1000) return tokenCache.token;

  const u = loadUserToken();
  if (u && u.access_token) {
    if (Date.now() < u.exp - 120 * 1000) { tokenCache = { token: u.access_token, exp: u.exp }; return u.access_token; }
    try {
      const t = await refreshUserToken();
      tokenCache = { token: t.access_token, exp: t.exp };
      return t.access_token;
    } catch (e) {
      throw Object.assign(new Error('用户授权令牌已过期且刷新失败（' + e.message + '）。请在「年度汇总 → 检查连接」里重新点一次「授权金山文档」。'), {
        diag: { kind: 'user_auth_expired', hint: '用户授权已失效：' + e.message + '。重新授权地址见 /api/kdocs/oauth/url。' },
        raw: e.raw
      });
    }
  }

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

// ---------- 文件搜索（用户令牌下才有数据范围）----------
// 个人开发者拿不到「企业文档」能力 → /v7/drives、/v7/links/{id}/meta 都不可用；
// 但 /v7/files/search 是用户维度的，带上用户令牌就能搜到「你自己空间里的文件」，
// 从中拿到 file_id，再走已经可用的 /v7/{sheets|airsheet}/{file_id}/... 写入。
async function searchFiles(token, keyword, pageSize) {
  const q = new URLSearchParams({ keyword: String(keyword || ''), type: 'file_name', page_size: String(pageSize || 20) });
  const r = await httpJson(BASE + '/v7/files/search?' + q.toString(), { headers: { Authorization: 'Bearer ' + token } }, 20000);
  const d = r.json || {};
  const raw = (d.data && (d.data.files || d.data.items)) || d.files || d.items || [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
  const files = arr.map(it => ({
    file_id: it.file_id || it.id || (it.file && it.file.id) || '',
    name: it.name || it.fname || it.file_name || (it.file && (it.file.name || it.file.fname)) || '',
    type: it.type || it.ftype || (it.file && it.file.type) || '',
    drive_id: it.drive_id || (it.file && it.file.drive_id) || ''
  })).filter(x => x.file_id);
  const diag = files.length ? null : explain(r.status, d || r.text);
  return { ok: files.length > 0, files, status: r.status, raw: d, text: r.text, diag };
}

// ---------- 分享链接 / file_id → 真实 file_id ----------
async function resolveFileId(token, explicit) {
  const src = (explicit != null && String(explicit).trim()) ? String(explicit).trim() : CFG.fileRaw;
  const p = parseFileInput(src);
  if (p.kind === 'file') { resolved = { fileId: p.fileId, driveId: '', name: '', from: 'file_id' }; return resolved; }
  if (p.kind === 'none') throw new Error('尚未指定目标文档（KDOCS_FILE_ID 为空）');
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

// ---------- 云盘（drive）列表：新建文档要指定落在哪个云盘 ----------
// 官方 /v7/drives 的 allotee_type 是必填参数，漏掉会被拒；doclibs 走的是另一套「团队管理」能力，故放最后兜底
async function listDrives(token) {
  const eps = [
    '/v7/drives?allotee_type=app&page_size=100',
    '/v7/drives/authorized?page_size=100',
    '/v7/drives?allotee_type=user&page_size=100',
    '/v7/doclibs'
  ];
  let last = null, scopeHit = null, ifaceHit = null;
  for (const ep of eps) {
    const r = await httpJson(BASE + ep, { headers: { Authorization: 'Bearer ' + token } });
    const d = r.json || {};
    const items = (d.data && d.data.items) || d.items || (d.data && d.data.drives) || [];
    const arr = Array.isArray(items) ? items : (items ? Object.values(items) : []);
    const out = arr.map(it => ({
      id: (it.drive && it.drive.id) || it.drive_id || it.id,
      name: (it.drive && (it.drive.name || it.drive.title)) || it.name || ''
    })).filter(x => x.id);
    if (out.length) return { ok: true, drives: out, via: ep, raw: d };
    const diag = explain(r.status, d || r.text);
    // 权限问题是「真问题」，优先于后续候选端点的 404（否则会把权限不足误报成路径不存在）
    if (diag.kind === 'scope_missing' && !scopeHit) scopeHit = { ep, status: r.status, raw: d, text: r.text, diag };
    if (diag.kind === 'iface_missing' && !ifaceHit) ifaceHit = { ep, status: r.status, raw: d, text: r.text, diag };
    last = { ep, status: r.status, raw: d, text: r.text, diag };
  }
  const pick = ifaceHit || scopeHit || last || {};
  return { ok: false, drives: [], status: pick.status, raw: pick.raw, text: pick.text, diag: pick.diag, via: pick.ep };
}

// ---------- 新建表格文档（传统表格走 /v7/sheets）----------
// 实测：只有 POST /v7/drives/{drive_id}/files/{parent_id}/create 是存在的端点（parent_id=0 即根目录）
async function createFile(token, driveId, name) {
  const candidates = [
    { url: BASE + '/v7/drives/' + encodeURIComponent(driveId) + '/files/0/create', body: { name, on_name_conflict: 'rename' }, label: 'POST /v7/drives/{drive_id}/files/0/create' },
    { url: BASE + '/v7/drives/' + encodeURIComponent(driveId) + '/files/create', body: { name, on_name_conflict: 'rename' }, label: 'POST /v7/drives/{drive_id}/files/create' },
    { url: BASE + '/v7/' + apiPrefix() + '/files', body: { drive_id: driveId, name, on_name_conflict: 'rename' }, label: 'POST /v7/' + apiPrefix() + '/files' }
  ];
  const tries = [];
  let scopeHit = null, ifaceHit = null;
  for (const c of candidates) {
    const r = await httpJson(c.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(c.body)
    }, 20000);
    const d = r.json || {};
    const diag = explain(r.status, d || r.text);
    tries.push({ api: c.label, status: r.status, body: d });
    const id = (d.data && (d.data.id || d.data.file_id)) || d.id || d.file_id;
    if (r.status === 200 && id) return { ok: true, fileId: String(id), api: c.label, raw: d, tries };
    if (diag.kind === 'scope_missing' && !scopeHit) scopeHit = { status: r.status, body: d, diag };
    if (diag.kind === 'iface_missing' && !ifaceHit) ifaceHit = { status: r.status, body: d, diag };
  }
  const e = ifaceHit ? ifaceHit.diag : (scopeHit ? scopeHit.diag : explain(tries.length ? tries[tries.length - 1].status : 0, (tries.length ? tries[tries.length - 1].body : {}) || {}));
  return { ok: false, error: '新建表格失败：' + e.hint, diag: e, tries };
}

// ---------- 统一入口：拿到本次要写入的 file_id（必要时自动新建一次）----------
async function ensureFile(token, explicit) {
  const src = (explicit != null && String(explicit).trim()) ? String(explicit).trim() : CFG.fileRaw;
  if (src) {
    const rf = await resolveFileId(token, src);
    return { ok: true, fileId: rf.fileId, created: false, from: rf.from, name: rf.name };
  }
  if (!CFG.autoCreate) return { ok: false, error: '尚未指定目标文档（KDOCS_FILE_ID 为空且已关闭自动新建）' };

  // 用户授权模式下先按名字搜一遍：既拿到了个人空间里的 file_id，
  // 又避开了个人应用不可用的「企业文档」（/v7/drives、/v7/links）能力。
  const kw = (CFG.createName || '').replace(/\.[a-z0-9]+$/i, '');
  try {
    const s = await searchFiles(token, kw, 20);
    if (s.ok) {
      const hit = s.files.find(f => /sheet|表格/.test(f.type)) || s.files[0];
      resolved = { fileId: hit.file_id, driveId: hit.drive_id || '', name: hit.name, from: 'search' };
      return { ok: true, fileId: hit.file_id, created: false, from: 'search', name: hit.name, candidates: s.files.slice(0, 10) };
    }
  } catch (_) { /* 搜索不可用时继续走云盘新建 */ }

  const dr = await listDrives(token);
  if (!dr.ok) {
    return {
      ok: false,
      error: '无法获取云盘列表，无法自动新建文档：' + (dr.diag ? dr.diag.hint : '官方未返回云盘数据'),
      diag: dr.diag, raw: dr.raw
    };
  }
  const drive = dr.drives[0];
  const c = await createFile(token, drive.id, CFG.createName);
  if (!c.ok) return c;
  resolved = { fileId: c.fileId, driveId: drive.id, name: CFG.createName, from: 'created' };
  return { ok: true, fileId: c.fileId, created: true, drive, api: c.api, name: CFG.createName, tries: c.tries };
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

// ---------- 对外：权限矩阵（逐项探测 scope / 接口权限是否到位）----------
// 用「必定不存在的资源 id」调用，靠错误类型区分：缺 scope / 缺接口权限 / 仅资源级权限（=权限已到位）
async function capTest(token) {
  const P = '__probe__';
  const caps = [
    { name: '列出云盘', need: 'kso.drive.readwrite', m: 'GET', url: '/v7/drives?allotee_type=app&page_size=10' },
    { name: '新建文件', need: 'kso.file.readwrite + 企业文档接口', m: 'POST', url: '/v7/drives/' + P + '/files/0/create', body: { name: 'probe', on_name_conflict: 'rename' } },
    { name: '文件搜索', need: 'kso.file.search', m: 'GET', url: '/v7/files/search?keyword=' + P + '&type=file_name&page_size=1' },
    { name: '分享链接解析', need: 'kso.file_link.readwrite', m: 'GET', url: '/v7/links/' + P + '/meta' },
    { name: '传统表格', need: 'kso.sheets.readwrite', m: 'GET', url: '/v7/sheets/' + P + '/worksheets' },
    { name: '智能表格', need: 'kso.airsheet.readwrite', m: 'GET', url: '/v7/airsheet/' + P + '/worksheets' },
    { name: '团队空间', need: 'kso.doclib.read + 团队管理接口', m: 'GET', url: '/v7/doclibs' }
  ];
  const out = [];
  for (const c of caps) {
    const r = await httpJson(BASE + c.url, {
      method: c.m,
      headers: Object.assign({ Authorization: 'Bearer ' + token }, c.body ? { 'Content-Type': 'application/json' } : {}),
      body: c.body ? JSON.stringify(c.body) : undefined
    }, 12000);
    const txt = r.text || '';
    const diag = explain(r.status, r.json || txt);
    let state, note;
    if (r.status === 200) { state = 'ok'; note = '可用'; }
    else if (/404 Route Not Found/.test(txt)) { state = 'na'; note = '端点不存在，改用备用端点'; }
    else if (diag.kind === 'scope_missing') { state = 'missing'; note = '缺 scope：' + (diag.scope || '未知') + (diag.scope && SCOPE_WHERE[diag.scope] ? '（' + SCOPE_WHERE[diag.scope] + '）' : ''); }
    else if (diag.kind === 'iface_missing') {
      state = 'missing';
      note = '缺接口权限「' + (IFACE_WHO[diag.iface] || diag.iface) + '」：**应用级能力，与令牌模式无关**'
        + '（实测：用户授权令牌下同样报此错）。个人开发者账号申请不到；'
        + '需成为「企业服务商」（WPS 365 企业超管登录开放平台）后建企业内建应用再申请。'
        + '临时替代：手动从浏览器地址栏取真实 file_id（表格接口本身已就绪，只需 file_id）。';
    }
    else if (diag.kind === 'file_permission' || /unable to read user permission|unable to read file metadata/.test(txt)) { state = 'ok'; note = '权限已到位（报错为资源级，属正常）'; }
    else if (/无权限/.test(txt)) { state = 'warn'; note = '接口本身可用，但应用当前看不到目标数据（属数据范围问题，非权限未开通）'; }
    else { state = 'warn'; note = 'HTTP ' + r.status + ' / ' + (txt.slice(0, 90)); }
    out.push({ name: c.name, need: c.need, state, note });
  }
  return out;
}

// ---------- 对外：自检（凭据 / 权限 / 文档 / 工作表）----------
async function probe(opts) {
  const tm = tokenMode();
  const out = {
    client_id: CFG.id || '(未配置)', has_secret: !!CFG.secret,
    token: tm,
    file_input: CFG.fileRaw ? (parseFileInput(CFG.fileRaw).kind === 'link' ? '分享链接' : 'file_id') : '(未配置)',
    file_type: CFG.fileType, sheet_name: CFG.sheetName,
    steps: [], caps: [], ok: false
  };
  const step = (name, ok, detail, pending) => { out.steps.push({ name, ok: !!ok, detail, pending: !!pending }); return ok; };

  if (!CFG.id || !CFG.secret) {
    step('应用凭据', false, '缺少 KDOCS_CLIENT_ID / KDOCS_CLIENT_SECRET');
    out.error = '未配置应用凭据';
    return out;
  }
  step('令牌模式', tm.mode === 'user', tm.mode === 'user'
    ? ('用户授权已生效，有效期至 ' + tm.user_expires_at + (tm.user_refreshable ? '（可自动刷新）' : '（需重新授权）'))
    : '当前为应用凭证模式；个人开发者请先完成「授权金山文档」（企业文档类能力对个人应用不开放）');

  let token;
  try { token = await getToken(true); step('取令牌', true, '令牌有效，长度 ' + token.length); }
  catch (e) { step('取令牌', false, e.message); out.error = e.message; out.diag = e.diag; out.raw = e.raw; return out; }

  // 权限矩阵：先跑一遍，后面失败时能直接看出是哪一项没开通
  try { out.caps = await capTest(token); } catch (_) { out.caps = []; }
  const missing = out.caps.filter(c => c.state === 'missing');
  if (missing.length) {
    out.missing_caps = missing.map(c => c.name + '（' + c.note + '）');
  }

  // 没配目标文档时，用文件搜索找候选（用户令牌下才有数据范围）
  if (!(opts && opts.fileId) && !CFG.fileRaw) {
    try {
      const kw = (CFG.createName || '').replace(/\.[a-z]+$/i, '').replace(/年度经济评审结果汇总表/, '评审');
      const s = await searchFiles(token, kw || '评审', 20);
      out.search = { keyword: kw, found: s.files.length, files: s.files.slice(0, 10), diag: s.diag || null };
      step('文件搜索', s.ok, s.ok
        ? ('搜到 ' + s.files.length + ' 个候选：' + s.files.slice(0, 5).map(f => f.name).join(' / '))
        : (s.diag ? s.diag.hint : '无结果'));
    } catch (e) {
      step('文件搜索', false, e.message);
    }
  }

  const src = (opts && opts.fileId) ? String(opts.fileId) : CFG.fileRaw;
  if (!src) {
    if (needCreate()) {
      step('目标文档', false, '尚未指定；首次同步时会自动在你的云盘里新建「' + CFG.createName + '」', true);
      out.pending_create = true;
    } else {
      step('目标文档', false, '未配置 KDOCS_FILE_ID');
      out.error = '未配置目标文档';
    }
    return out;
  }
  try {
    const rf = await resolveFileId(token, src);
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
  let ens;
  try { ens = await ensureFile(token, opts && opts.fileId); }
  catch (e) { return { ok: false, error: e.message, diag: e.diag, raw: e.raw }; }
  if (!ens.ok) return { ok: false, error: ens.error, diag: ens.diag, raw: ens.raw, tries: ens.tries };
  const fileId = ens.fileId;
  let sheets, picked;
  try {
    sheets = await listWorksheets(token, fileId);
    picked = pickSheet(sheets);
  } catch (e) {
    return { ok: false, error: e.message, diag: e.diag, raw: e.raw, file_id: fileId, created: !!ens.created };
  }
  const batches = buildBatches(aoa, 0);
  const w = await writeBatches(token, fileId, picked.sheet.sheetId, batches, 120);
  if (!w.ok) {
    return {
      ok: false, error: (w.diag ? w.diag.hint : '写入失败'), diag: w.diag, raw: w.raw,
      file_id: fileId, created: !!ens.created,
      sheetId: picked.sheet.sheetId, sheetName: picked.sheet.name, sheets: picked.all,
      progress: w.done + '/' + w.total
    };
  }
  return {
    ok: true, sheetId: picked.sheet.sheetId, sheetName: picked.sheet.name, sheets: picked.all,
    cells: rows * cols, batches: batches.length, raw: w.raw,
    file_id: fileId, created: !!ens.created, created_name: ens.created ? ens.name : '', drive: ens.drive || null
  };
}

module.exports = {
  CFG, configOk, missingConfig, needCreate, pushAoa, probe, capTest, parseFileInput,
  buildBatches, listWorksheets, pickSheet, apiPrefix, listDrives, createFile, ensureFile,
  resolveFileId, explain, SCOPE_WHERE, IFACE_WHO,
  // 用户授权（个人开发者路径）
  authUrl, exchangeCode, refreshUserToken, clearUserToken, tokenMode, loadUserToken, searchFiles
};
