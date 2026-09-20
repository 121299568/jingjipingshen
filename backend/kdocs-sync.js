// 金山云文档（WPS 365 开放平台）同步
// ---------------------------------------------------------------
// 用于把系统实时算出的「年度经济评审结果汇总表」推送到金山云文档的智能表格，
// 实现「线上系统算数 + 云文档协同」：系统保留自动计算/留痕/评论，云文档侧拿到同样的数据。
//
// 需要的配置（写在 backend/.env，缺任一项都只返回错误、不影响系统其它功能）：
//   KDOCS_CLIENT_ID      - WPS 开放平台应用的 AppID(client_id)
//   KDOCS_CLIENT_SECRET  - 应用密钥
//   KDOCS_FILE_ID        - 目标智能表格的 file_id（分享链接 https://kdocs.cn/l/xxxx 中的 id）
//   KDOCS_SHEET_NAME     - 目标工作表名称，默认「年度汇总」
//
// 接入参考：WPS 365 服务端 OpenAPI
//   1) 取令牌： POST https://openapi.wps.cn/oauth2/token （grant_type=client_credentials）
//   2) 取工作表：GET  https://openapi.wps.cn/v7/airsheet/{file_id}/worksheets
//   3) 写区域：  POST https://openapi.wps.cn/v7/airsheet/{file_id}/worksheets/{sheet_id}/range_data/batch_update
//
// 说明：批量写入的载荷字段以官方最新版本为准；首次联调建议先用 dryRun=true
//       把将要发送的矩阵打出来核对（本模块会把官方返回的原文一并返回，便于排错）。

const CFG = {
  id: process.env.KDOCS_CLIENT_ID || '',
  secret: process.env.KDOCS_CLIENT_SECRET || '',
  fileId: process.env.KDOCS_FILE_ID || '',
  sheetName: process.env.KDOCS_SHEET_NAME || '年度汇总'
};

let tokenCache = { token: '', exp: 0 };

function configOk() {
  return !!(CFG.id && CFG.secret && CFG.fileId);
}
function missingConfig() {
  const miss = [];
  if (!CFG.id) miss.push('KDOCS_CLIENT_ID');
  if (!CFG.secret) miss.push('KDOCS_CLIENT_SECRET');
  if (!CFG.fileId) miss.push('KDOCS_FILE_ID');
  return miss;
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60 * 1000) return tokenCache.token;
  const r = await fetch('https://openapi.wps.cn/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CFG.id, client_secret: CFG.secret })
  });
  const d = await r.json().catch(() => ({}));
  const tok = d.access_token || (d.data && d.data.access_token);
  if (!tok) throw new Error('获取 access_token 失败：' + JSON.stringify(d).slice(0, 300));
  const exp = Number(d.expires_in || (d.data && d.data.expires_in) || 7200);
  tokenCache = { token: tok, exp: Date.now() + exp * 1000 };
  return tok;
}

async function listWorksheets(token) {
  const r = await fetch(`https://openapi.wps.cn/v7/airsheet/${CFG.fileId}/worksheets`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  const d = await r.json().catch(() => ({}));
  return d;
}

function pickSheetId(listResp) {
  const sheets = (listResp && (listResp.data && (listResp.data.sheets || listResp.data.worksheets))) || listResp.sheets || listResp.worksheets || [];
  const arr = Array.isArray(sheets) ? sheets : Object.values(sheets);
  const hit = arr.find(s => s && (s.name === CFG.sheetName));
  const first = hit || arr[0];
  if (!first) throw new Error('未找到任何工作表：' + JSON.stringify(listResp).slice(0, 300));
  return { sheetId: first.sheet_id || first.id, sheetName: first.name, all: arr.map(s => s && s.name).filter(Boolean) };
}

// aoa: 二维数组（第一行分组旗、第二行字段名、其后数据行）
function buildPayload(aoa) {
  const rows = aoa.length;
  const cols = aoa.reduce((m, r) => Math.max(m, r.length), 0);
  const endCol = colName(Math.max(cols - 1, 0));
  return {
    range_data: [{
      range: `A1:${endCol}${Math.max(rows, 1)}`,
      op_type: 'cell_operation_type_value',
      values: aoa
    }]
  };
}
function colName(i) { // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  i = i + 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

async function pushAoa(aoa, opts) {
  const dryRun = !!(opts && opts.dryRun);
  if (!configOk()) return { ok: false, error: '金山云文档未配置，缺少：' + missingConfig().join('、') };
  const payload = buildPayload(aoa);
  if (dryRun) return { ok: true, dryRun: true, payload, size: aoa.length + ' 行 × ' + (aoa[0] || []).length + ' 列' };
  const token = await getToken();
  const listResp = await listWorksheets(token);
  const { sheetId, sheetName, all } = pickSheetId(listResp);
  const r = await fetch(`https://openapi.wps.cn/v7/airsheet/${CFG.fileId}/worksheets/${sheetId}/range_data/batch_update`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const d = await r.json().catch(() => ({}));
  const ok = r.ok && (d.code === 0 || d.code === undefined || d.success === true);
  return { ok, httpStatus: r.status, sheetId, sheetName, sheets: all, raw: d };
}

module.exports = { CFG, configOk, missingConfig, pushAoa, buildPayload };
