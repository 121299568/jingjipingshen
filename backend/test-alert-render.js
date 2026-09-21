// test-alert-render.js — 回归：告警判定与渲染形态（项目资料页 / 评估汇总页）
// 约定（2026-09-21 起）：
//   ① 告警只有一种形态 —— 行级「⚠ 需关注：<原因>」悬浮提示（序号格 data-tip）+ 行标红，不再有 ⚠ 角标
//   ② 告警规则唯一来源 = 前端 projectAlerts()，两页必须调用同一份，否则两边数量会对不上
//        （历史 bug：项目资料页只认 import_warnings → 1 个；评估汇总页多 4 条成本规则 → 2 个）
//   ③ 项目资料页 renderProjects()             -> 行 <tr class="dt-flag">  + 序号 td 的 data-tip
//      评估汇总页 renderWorkloadProjectTable() -> 行 <tr class="wl-flag"> + 序号 td 的 data-tip
// 桩 DOM + 抽真实渲染函数，喂桩数据（不调接口、不需 token）。只读前端文件。
const fs = require('fs');
const path = require('path');

function pick(c) { for (const x of c) { try { if (fs.existsSync(x) && /renderWorkloadProjectTable/.test(fs.readFileSync(x, 'utf8'))) return x; } catch (_) {} } throw new Error('找不到前端页面，试过：' + c.join(' , ')); }
const APP = pick([__dirname + '/frontend/index.html', __dirname + '/../frontend/index.html', '/opt/jingjipingshen/frontend/index.html']);
const html = fs.readFileSync(APP, 'utf8');

function slice(src, start, end) { const s = src.indexOf(start); const e = src.indexOf(end, s + 1); if (s < 0 || e < 0) throw new Error('anchor fail: ' + start); return src.slice(s, e); }
// 按大括号配平抽函数体（这几个函数内的字符串/正则都不含未配平的 {}）
function grabFn(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('函数缺失: ' + name);
  let depth = 0;
  for (let i = src.indexOf('{', s); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(s, i + 1); }
  }
  throw new Error('括号不配平: ' + name);
}
const escSrc = grabFn(html, 'esc');
// 共享告警判定：两页渲染函数现在都依赖它，桩沙箱必须注入
const alertsSrc = grabFn(html, 'projectAlerts');
const attrsSrc = grabFn(html, 'alertRowAttrs');
const SHARED = escSrc + '\n' + alertsSrc + '\n' + attrsSrc;
const rpSrc = slice(html, 'function renderProjects(){', 'function renderBizConfirmSummary(){');
const rwSrc = slice(html, 'function renderWorkloadProjectTable(d){', 'function toggleWlCompact(){');

function makeDoc() {
  const store = {};
  return { getElementById(id) { if (!store[id]) store[id] = { innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, getAttribute() { return null; }, querySelectorAll() { return []; } }; return store[id]; } };
}
function runRenderProjects(projects, sessions, files) {
  const document = makeDoc();
  const fn = new Function('document', 'sessions', 'projects', 'files', 'openBatches', 'batchLabel', 'sessionStatusBadge', 'statusBadgeClass', 'projectStatusLabel', 'fmtTime', 'canDeleteProject', 'renderBizConfirmSummary',
    SHARED + '\n' + rpSrc + '\nrenderProjects();\nreturn document.getElementById("batchDrawerList").innerHTML;');
  return fn(document, sessions, projects, files, new Set(), n => '第' + n + '批', () => '<span></span>', () => 'bg-secondary', s => s, t => String(t || ''), () => false, () => {});
}
function runRenderWorkload(data) {
  const document = makeDoc();
  const fn = new Function('document', 'wlCompactMode', 'wlFilterTable', 'DATA',
    SHARED + '\n' + rwSrc + '\nrenderWorkloadProjectTable(DATA);\nreturn document.getElementById("wlProjects").innerHTML;');
  return fn(document, false, () => {}, data);
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

const MSG = '人员外包+专业分包占合同额 84.95%（¥5,541,250 / 合同额¥6,523,100），超过 60% 阈值，外包/分包依赖过高，请复核';
const DEPT = '系统集成事业部';
// 5 个夹具，覆盖全部 5 类告警来源，其中 4 个应被标红、1 个干净
const F = {
  warnOnly: { id: 901, project_id: 901, project_name: '导入校验告警项目', session_id: 1, status: 'draft', biz_department: DEPT, contract_amount: 6523100, import_warnings: [{ file: '系统补算', time: '2026-09-21T00:00:00Z', messages: [MSG] }] },
  costOver: { id: 902, project_id: 902, project_name: '成本超额项目', session_id: 1, status: 'draft', biz_department: DEPT, contract_amount: 1000000, internal_estimated_cost: 30600, cost_summary: { total_cost: 1011622.9, profit_rate: 0.12, outsourcing_cost: 999, subcontract_cost: 100 } },
  noContract: { id: 903, project_id: 903, project_name: '合同额缺失项目', session_id: 1, status: 'draft', biz_department: DEPT, contract_amount: 0, cost_summary: { total_cost: 0 } },
  negProfit: { id: 904, project_id: 904, project_name: '利润率为负项目', session_id: 1, status: 'draft', biz_department: DEPT, contract_amount: 1000000, cost_summary: { total_cost: 100, profit_rate: -0.05 } },
  clean: { id: 905, project_id: 905, project_name: '正常项目', session_id: 1, status: 'draft', biz_department: DEPT, contract_amount: 1000000, import_warnings: [] },
  // ★ 成本估算与内部填报预估「同额」：真实数据里 total_cost 是浮点累加值（125046.64000000001），
  //   与 internal_estimated_cost（125046.64）差 1.45e-11。裸比较 tc>iec 会误报
  //   「成本估算 ¥125,046.64 超过内部填报预估 ¥125,046.64」——两个数字看起来一模一样。
  //   正解：四舍五入到分且差额需 >0.01（与后端上传校验同口径）。本夹具必须不被标红。
  nearEqual: { id: 906, project_id: 906, project_name: '同额浮点误差项目', session_id: 1, status: 'draft', biz_department: DEPT, contract_amount: 1000000, internal_estimated_cost: 125046.64, cost_summary: { total_cost: 125046.64000000001, profit_rate: 0.2 } }
};
const sessions = [{ id: 1, name: '第十五批经济评审', status: 'in_progress' }];
const LIST = [F.warnOnly, F.costOver, F.noContract, F.negProfit, F.clean, F.nearEqual];

console.log('APP =', APP);

// ---- 项目资料页 ----
const rp = runRenderProjects(LIST, sessions, []);
ok(!/undefined/.test(rp), '项目资料页：渲染串无 undefined');
ok(rp.includes('⚠ 需关注：'), '项目资料页：出现「⚠ 需关注：」提示');
ok(rp.includes('人员外包+专业分包占合同额'), '项目资料页：提示含导入校验告警文案');
ok(rp.includes('成本估算 ¥1,011,622.9 超过内部填报预估 ¥30,600'), '项目资料页：命中「成本超内部填报预估」（此前缺失的规则）');
ok(rp.includes('总成本估算 ¥1,011,622.9 超过合同额 ¥1,000,000'), '项目资料页：命中「总成本超合同额」');
ok(rp.includes('合同额为 0 或缺失'), '项目资料页：命中「合同额缺失」');
ok(rp.includes('估算利润率为负'), '项目资料页：命中「利润率为负」');
ok(/<tr class="dt-flag">/.test(rp), '项目资料页：告警行带 dt-flag 红标');
ok(!/bi-exclamation-triangle-fill/.test(rp), '项目资料页：已不再渲染 ⚠ 角标');
const rpFlags = (rp.match(/class="dt-flag"/g) || []).length;
ok(rpFlags === 4, '项目资料页：告警行 4 行（干净项目不标红），实际 ' + rpFlags);
ok(/\d+ 项需关注/.test(rp) && rp.includes('4 项需关注'), '项目资料页：批次头部显示「4 项需关注」计数徽标');
// ★ 同额不告警：夹具中 906（125046.64000000001 vs 125046.64）必须不产生该条告警
const rpIec = (rp.match(/超过内部填报预估/g) || []).length;
ok(rpIec === 1, '★ 项目资料页：内部填报预估规则只命中 1 个（同额浮点误差不误报），实际 ' + rpIec);
ok(!/超过内部填报预估 ¥125,046\.64/.test(rp), '★ 项目资料页：不再出现「¥125,046.64 超过 ¥125,046.64」同额告警');

// ---- 评估汇总页 ----
const data = { session_id: 1, session_name: '第十五批经济评审', projects: LIST };
const rw = runRenderWorkload(data);
ok(!/undefined/.test(rw), '评估汇总页：渲染串无 undefined');
ok(rw.includes('⚠ 需关注：'), '评估汇总页：出现「⚠ 需关注：」提示');
ok(rw.includes('人员外包+专业分包占合同额'), '评估汇总页：提示含导入校验告警文案');
ok(rw.includes('成本估算 ¥1,011,622.9 超过内部填报预估 ¥30,600'), '评估汇总页：命中「成本超内部填报预估」');
ok(rw.includes('总成本估算 ¥1,011,622.9 超过合同额 ¥1,000,000'), '评估汇总页：命中「总成本超合同额」');
ok(rw.includes('合同额为 0 或缺失'), '评估汇总页：命中「合同额缺失」');
ok(rw.includes('估算利润率为负'), '评估汇总页：命中「利润率为负」');
ok(/class="wl-flag" data-anom="1"/.test(rw), '评估汇总页：告警行带 wl-flag 红标');
ok(!/bi-exclamation-triangle-fill/.test(rw), '评估汇总页：已不再渲染 ⚠ 角标');
const rwFlags = (rw.match(/class="wl-flag"/g) || []).length;
ok(rwFlags === 4, '评估汇总页：告警行 4 行，实际 ' + rwFlags);
ok(/\d+ 项需关注/.test(rw), '评估汇总页：表头下方显示「需关注」计数');
const rwIec = (rw.match(/超过内部填报预估/g) || []).length;
ok(rwIec === 1, '★ 评估汇总页：内部填报预估规则只命中 1 个（同额浮点误差不误报），实际 ' + rwIec);

// ---- 两页一致性（本次 bug 的回归断言）----
ok(rpFlags === rwFlags, '★ 两页告警项目数一致：项目资料页 ' + rpFlags + ' = 评估汇总页 ' + rwFlags);

// 规则清单同源：同一夹具在两页产出的告警条数必须相同
const countTips = (s, cls) => (s.match(new RegExp('class="' + cls + '"', 'g')) || []).length;
ok(countTips(rp, 'dt-flag') === countTips(rw, 'wl-flag'), '★ 两页命中同一批项目（同源规则 projectAlerts）');

console.log('\nRESULT: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 2 : 0);
