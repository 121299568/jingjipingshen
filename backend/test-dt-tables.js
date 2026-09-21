// 项目资料页 / 年度汇总页 表格 —— 结构回归测试
// 目标：这两张表套用「评估汇总」的紧凑样式后，列数、冻结列偏移、截断落点不能出错。
// 尤其防「colgroup 列数 ≠ 表头列数 ≠ 每行 td 数」——三者不等就会整行错位（评估汇总表踩过这个坑）。
const fs = require('fs');
// 路径自适应：本地（脚本与页面同目录）、服务器仓库（backend/ 与 frontend/ 同级）、
// 服务器直跑目录 —— 三处都能跑，避免硬编码绝对路径导致换机器就崩
function pick(cands) {
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  throw new Error('找不到文件，试过：' + cands.join(' , '));
}
const app = fs.readFileSync(pick([__dirname + '/frontend/index.html', __dirname + '/index.html', __dirname + '/../frontend/index.html',
  '/opt/jingjipingshen/frontend/index.html',
  'C:/Users/12129/WorkBuddy/mjumju正式版/lnsoft-patch/index.html']), 'utf8');
const server = fs.readFileSync(pick([__dirname + '/server.js', __dirname + '/../backend/server.js',
  '/opt/jingjipingshen/backend/server.js',
  'C:/Users/12129/WorkBuddy/mjumju正式版/lnsoft-patch/server.js']), 'utf8');
const script = app.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/)[1];

// 真实列定义直接取自 server.js，避免测试自造列造成假绿
const ANNUAL_COLUMNS = eval(server.match(/const ANNUAL_COLUMNS = (\[[\s\S]*?\n\]);/)[1]);
const ANNUAL_MAIN = ANNUAL_COLUMNS.length + 1; // + 操作列

// ---------- 切出待测函数 ----------
const projBlock = script.slice(script.indexOf('function renderProjects(){'), script.indexOf('function renderBizConfirmSummary(){'));
const annualBlock = script.slice(script.indexOf('function annualMoney('), script.indexOf('async function saveAnnualRow('));

// 告警规则唯一来源：渲染函数依赖页面里的 projectAlerts()/alertRowAttrs()，
// 桩沙箱必须注入"真身"（而非空壳），否则规则被绕开、测试变成假绿。
function grabFn(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('函数缺失: ' + name);
  let d = 0;
  for (let i = src.indexOf('{', s); i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(s, i + 1); }
  }
  throw new Error('括号不配平: ' + name);
}
const ALERT_SRC = grabFn(script, 'projectAlerts') + '\n' + grabFn(script, 'alertRowAttrs');

// ---------- 通用桩 ----------
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function mkDoc() {
  const store = {};
  return {
    _store: store,
    getElementById(id) {
      if (!store[id]) store[id] = { id, innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {}, toggle() {} } };
      return store[id];
    },
    querySelectorAll() { return []; }
  };
}
let pass = 0, fail = 0;
const check = (n, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (!ok && extra !== undefined ? '  → ' + extra : '')); };
const count = (s, re) => (s.match(re) || []).length;

// =======================================================================
// 一、项目资料页（renderProjects）
// =======================================================================
const LONG_NAME = '山东核电有限公司天易平台技术支持服务项目（超长名称必须完整输出，不能再被 substring 硬截断）';
const PJ = [
  { id: 1, session_id: 1, project_name: LONG_NAME, biz_department: '能源信息业务部', status: 'reviewing',
    contract_amount: 2700000, last_operation_at: '2026-09-20T10:00:00Z', import_warnings: null },
  { id: 2, session_id: 1, project_name: '短名字项目', biz_department: '信息业务', status: 'completed',
    contract_amount: 0, last_operation_at: null, import_warnings: [{ file: 'a.xlsx', messages: ['估算表与汇总表基线不一致'] }] }
];
const SES = [{ id: 1, name: '第十五批经济评审', status: 'in_progress', review_time: '2026-09-25 09:00' }];

const doc1 = mkDoc();
const renderProjects = new Function(
  'sessions', 'projects', 'files', 'openBatches', 'currentUser', 'esc', 'batchLabel',
  'sessionStatusBadge', 'statusBadgeClass', 'projectStatusLabel', 'canDeleteProject', 'fmtTime',
  'renderBizConfirmSummary', 'document',
  ALERT_SRC + '\n' + projBlock + '\nreturn renderProjects;'
)(SES, PJ, [], new Set(['s1']), { role: 'admin' }, esc,
  i => '第' + i + '批', s => '<span class="badge">' + s + '</span>',
  () => 'bg-warning text-dark', s => ({ reviewing: '评审中', completed: '已完成' }[s] || s),
  () => true, t => String(t).slice(0, 16), () => {}, doc1);
renderProjects();

const pOut = doc1._store['batchDrawerList'].innerHTML;
// 只用 tbody 内的行计数：thead 的 <tr> 也是 <tr>，混进来会误判（自适应那一列是裸 <col>，也要算进去）
const pTbody = (pOut.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0];
const pCols = count(pOut, /<col[ >]/g);
const pHead = count(pOut, /<th[ >]/g);
// ⚠ 必须写 /<tr[^>]*>/：告警行是 <tr class="dt-flag">，只匹配裸 <tr> 会漏计一整行
const pRowTds = [...pTbody.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)].map(r => count(r[0], /<td/g));

check('项目资料页：表格包在 dt-wrap 内（吸顶表头 + 斑马纹 + 悬浮）',
  /<div class="dt-wrap"[^>]*><table[\s\S]*?<colgroup>/.test(pOut));
check('项目资料页：colgroup 列数 = 表头列数 = 每行 td 数（11 列，防错行）',
  pCols === 11 && pHead === 11 && pRowTds.length === 2 && pRowTds.every(n => n === 11),
  pCols + 'col / ' + pHead + 'th / rows=' + pRowTds.join(','));
check('项目资料页：超长项目名完整输出（不再 substring 截断）', pOut.includes(LONG_NAME));
check('项目资料页：项目名两行截断 + 全文悬浮',
  /<td class="dt-txt" data-tip="[^"]*"><span class="dt-clamp">/.test(pOut));
check('项目资料页：截断类落在内层 span，没有落在 td 上', !/<td[^>]*class="[^"]*dt-clamp/.test(pOut));
check('项目资料页：序号/金额右对齐等宽数字',
  /<td class="dt-num">01<\/td>/.test(pOut) && /<td class="dt-num">¥2,700,000<\/td>/.test(pOut));
check('项目资料页：金额为 0 时仍显示 —（不误判为缺失）', /<td class="dt-num">-<\/td>/.test(pOut));
check('项目资料页：操作列够宽且不被裁（184px + dt-acts）',
  /<col style="width:184px">/.test(pOut) && /class="dt-acts"/.test(pOut));
// 2026-09-21 起：告警不再用 ⚠ 角标，统一并入行级「⚠ 需关注」悬浮提示 + 行标红。
// 且项目资料页与评估汇总页共用 projectAlerts()：合同额为 0 属共享规则，必须与导入校验告警一起出现在提示里
check('项目资料页：告警行标红 dt-flag（仅 1 行，无告警行不标）',
  count(pOut, /class="dt-flag"/g) === 1);
check('项目资料页：告警并入「⚠ 需关注」行提示（序号格 data-tip），不再渲染 ⚠ 角标',
  /<tr class="dt-flag">[\s\S]*?<td class="dt-num" data-tip="⚠ 需关注：合同额为 0 或缺失；估算表与汇总表基线不一致">02<\/td>/.test(pOut) &&
  !/bi-exclamation-triangle-fill/.test(pOut));
check('项目资料页：批次头部显示「N 项需关注」计数（便于与评估汇总页对数）',
  /<span class="badge bg-danger"[^>]*>1 项需关注<\/span>/.test(pOut));
check('前端：告警规则唯一来源 projectAlerts() 已定义（两页共用，防再次各写一份）',
  /function projectAlerts\(p\)\{/.test(script) && /function alertRowAttrs\(msgs,\s*rowClass\)\{/.test(script));
check('项目资料页：标红行与「需关注」提示严格配对（防"红了但没提示"复发）',
  count(pOut, /class="dt-flag"/g) === count(pOut, /data-tip="⚠ 需关注：/g) &&
  count(pOut, /data-tip="⚠ 需关注：/g) === 1);
check('项目资料页：表头为 dt-num 的金额列也右对齐', /<th class="dt-num">合同金额<\/th>/.test(pOut));

// =======================================================================
// 二、年度汇总页（renderAnnual）
// =======================================================================
const cells = {};
ANNUAL_COLUMNS.forEach((c, i) => {
  if (c.type === 'money') cells[c.key] = 1000 * (i + 1);
  else if (c.type === 'pct') cells[c.key] = 0.15;
  else cells[c.key] = c.key === 'project_name'
    ? '运行研究院-中核运维核燃料盛造管理信息化系统科研项目技术开发外委项目招标公告（超长名称验证两行截断）'
    : (c.key === 'post_review_opinion' ? '成本估算偏高，建议压缩人员外包规模\n并要求补充询价单' : 'X' + i);
});
const PAYLOAD = {
  summary: {
    year: 2026, columns: ANNUAL_COLUMNS,
    rows: [{ project_id: 101, cells: { ...cells } }, { project_id: 102, cells: { ...cells } }],
    totals: { ...cells },
    projectCount: 2, batchCount: 1
  },
  doc: { data: { edit_history: [], comments: [] }, updated_at: '2026-09-21T09:00:00' }
};
const doc2 = mkDoc();
const fakeFetch = () => Promise.resolve({ json: () => Promise.resolve(PAYLOAD) });
const renderAnnual = new Function('esc', 'annualMoney', 'annualPct', 'API', 'authH', 'annualYear', 'fetch', 'document',
  annualBlock + '\nreturn renderAnnual;'
)(esc, v => v == null ? '—' : Number(v).toLocaleString(), v => v == null ? '' : (v * 100).toFixed(2) + '%',
  '/api', () => ({}), 2026, fakeFetch, doc2);

(async () => {
  renderAnnual();
  await new Promise(r => setTimeout(r, 20));

  const colsHtml = doc2._store['annualCols'].innerHTML;
  const widths = [...colsHtml.matchAll(/<col style="width:(\d+)px">/g)].map(m => Number(m[1]));
  const head = doc2._store['annualHead'].innerHTML;
  const body = doc2._store['annualBody'].innerHTML;
  const foot = doc2._store['annualFoot'].innerHTML;
  const r1 = (head.match(/<tr class="dt-h1">[\s\S]*?<\/tr>/) || [''])[0];
  const r2 = (head.match(/<tr class="dt-h2">[\s\S]*?<\/tr>/) || [''])[0];
  const rows = [...body.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(m => m[0]);

  check('年度汇总：colgroup 列数 = 49 业务列 + 操作列',
    widths.length === ANNUAL_MAIN, widths.length + ' vs ' + ANNUAL_MAIN);
  check('年度汇总：表头明细行 th 数 = 总列数', count(r2, /<th/g) === ANNUAL_MAIN, count(r2, /<th/g));
  check('年度汇总：每行 td 数 = 总列数（防错行）',
    rows.length === 2 && rows.every(r => count(r, /<td/g) === ANNUAL_MAIN),
    rows.map(r => count(r, /<td/g)).join(','));
  check('年度汇总：表格最小宽度 = 各列宽累计（横向滚动不挤列）',
    doc2._store['annualTable'].style.minWidth === widths.reduce((a, b) => a + b, 0) + 'px',
    doc2._store['annualTable'].style.minWidth);
  check('年度汇总：表头文字长度纳入列宽下限（表头不被截断）',
    widths.every((w, i) => i >= ANNUAL_COLUMNS.length || w >= String(ANNUAL_COLUMNS[i].label).length * 12));
  check('年度汇总：首行 dt-h1 带评审前 / 评审后分组',
    /dt-group dt-group-pre[^>]*>评审前</.test(r1) && /dt-group dt-group-post[^>]*>评审后</.test(r1));
  check('年度汇总：首行分组 colspan 合计 = 总列数（防错行）',
    [...r1.matchAll(/<th([^>]*)>/g)].reduce((s, m) => s + (Number((m[1].match(/colspan="(\d+)"/) || [])[1]) || 1), 0) === ANNUAL_MAIN);
  check('年度汇总：批次/序号/项目名称三列冻结，左偏移按列宽累计',
    /class="dt-f"[^>]*style="left:0px"/.test(r2) &&
    /class="dt-f"[^>]*style="left:60px"/.test(r2) &&
    /class="dt-f dt-f-last"[^>]*style="left:104px"/.test(r2));
  check('年度汇总：金额/比率列右对齐等宽数字',
    /class="[^"]*dt-num/.test(body) && /class="[^"]*dt-num/.test(foot));
  check('年度汇总：长文本列两行截断 + 全文悬浮',
    /<td class="[^"]*dt-txt"[^>]*data-tip="[^"]*"><span class="dt-clamp">/.test(body));
  check('年度汇总：截断类没有落在 td 上（会错行）', !/<td[^>]*class="[^"]*dt-clamp/.test(body));
  check('年度汇总：可编辑单元格保留 ed 类并套用紧凑样式',
    /class="ed dt-ed" contenteditable="true"/.test(body) && /\.dt-ed\{/.test(app));
  check('年度汇总：吸底合计行存在', /<tfoot/.test(app) && /dt-num/.test(foot));
  check('年度汇总：操作列右对齐按钮', /<td class="dt-acts"><button[^>]*>保存<\/button><\/td>/.test(body));
  check('年度汇总：无 undefined 泄漏', !/undefined/.test(body) && !/undefined/.test(head));

  console.log('\n结果：PASS=' + pass + ' FAIL=' + fail + '   总列数=' + ANNUAL_MAIN + ' 表宽=' + doc2._store['annualTable'].style.minWidth);
  process.exit(fail ? 1 : 0);
})();
