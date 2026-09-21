const fs = require('fs');
const path = require('path');
// 路径自适应（同 test-dt-tables.js）：本地 / 服务器仓库 / 服务器直跑目录三处都能跑
function pick(cands) {
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  throw new Error('找不到文件，试过：' + cands.join(' , '));
}
const base = path.dirname(pick([__dirname + '/frontend/index.html', __dirname + '/index.html', __dirname + '/../frontend/index.html',
  '/opt/jingjipingshen/frontend/index.html',
  'C:/Users/12129/WorkBuddy/mjumju正式版/lnsoft-patch/index.html'])) + '/';
const app = fs.readFileSync(base + 'index.html', 'utf8');
const script = app.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/)[1];

const s0 = script.lastIndexOf('function renderWorkloadProjectTable(d){');
const e1 = script.indexOf('\n}', script.indexOf('cap.innerHTML=t;')) + 2;
const block = script.slice(s0, e1);

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 告警规则唯一来源：渲染函数依赖页面里的 projectAlerts()/alertRowAttrs()，桩沙箱必须注入真身。
// 注意与下面的 expectedAnom「独立算式」并存 —— 一份是被测实现，一份是独立口径，两者必须相等。
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
const projectAlertsReal = new Function('return ' + grabFn(script, 'projectAlerts'))();

function buildApi(compact, anomalyOnly) {
  const store = {};
  const document = {
    getElementById(id) {
      if (!store[id]) store[id] = { innerHTML: '', value: '', style: {}, classList: { toggle() {} }, setAttribute() {}, getAttribute() { return null; }, querySelectorAll() { return []; } };
      return store[id];
    }
  };
  const fn = new Function('esc', 'wlCompactMode', 'wlAnomalyOnly', 'wlCurrentData', 'document', 'window',
    ALERT_SRC + '\n' + block + '\nreturn { render: renderWorkloadProjectTable, document };');
  return fn(esc, compact, anomalyOnly, null, document, {});
}

// 预览产物写到脚本所在目录，绝不写进页面目录（否则内部数据会挂到公网可访问路径下）
const OUT = __dirname + '/';
const realPath = fs.existsSync(base + 'ws7.json') ? base + 'ws7.json' : OUT + 'ws7.json';
const useReal = fs.existsSync(realPath);
const sample = useReal ? JSON.parse(fs.readFileSync(realPath, 'utf8')) : {
  projects: [
    { project_id: 1, project_name: '山东核电有限公司天易平台技术支持服务项目', biz_department: '信息业务（工业互联网）', project_type: '数字化类项目', contract_amount: 2700000, is_digital: true, is_restricted_subcontract: '否', subcontract_scope: '共200户企业的实地核验、采集生产工艺特点、核心用户能耗预警模型、标定用电量与产能规模、生产节律的对应关系', business_direction: '能源数字化', cost_summary: { total_cost: 2290200, profit_rate: 0.1518, subcontract_cost: 141600 } },
    { project_id: 2, project_name: '运行研究院-中核运维核燃料盛造管理信息化系统科研项目技术开发外委项目招标公告', biz_department: '信息业务（工业互联网）', project_type: '数字化类项目', contract_amount: 1000000, needs_estimate: false, cost_summary: { total_cost: 1088972, profit_rate: 0.10 } },
    { project_id: 3, project_name: '国网山东烟台供电公司2026年产业链分析能力提升', biz_department: '', project_type: '数字化类项目', contract_amount: 0, cost_summary: { total_cost: 438891.63, profit_rate: -0.03 } }
  ]
};
console.log(useReal ? '===== 使用线上真实数据（第十五批经济评审 / 29 个项目）=====' : '===== 使用样例数据 =====');
const nProj = (sample.projects || []).length;

const expectedAnom = (sample.projects || []).filter(p => {
  const ca = Number(p.contract_amount) || 0;
  const cs = p.cost_summary || {};
  const tc = Number(cs.total_cost) || 0;
  const pr = cs.profit_rate != null ? Number(cs.profit_rate) : null;
  const iec = (p.internal_estimated_cost != null && p.internal_estimated_cost !== '') ? Number(p.internal_estimated_cost) : null;
  // 2026-09-21 起：导入校验告警并入「需关注」，有条目即算异常行（与 renderWorkloadProjectTable 同口径）
  const hasWarn = (p.import_warnings || []).some(w => (w.messages || []).length > 0);
  return !(ca > 0) || (ca > 0 && tc > ca) || (pr != null && pr < 0) || (iec != null && tc > iec) || hasWarn;
}).length;

const full = buildApi(false, false);
full.render(sample);
const out = full.document.getElementById('wlProjects').innerHTML;

const cmp = buildApi(true, false);
cmp.render(sample);
const outC = cmp.document.getElementById('wlProjects').innerHTML;

const wOf = s => { const m = s.match(/min-width:(\d+)px/); return m ? Number(m[1]) : 0; };
const anomRows = (out.match(/data-anom="1"/g) || []).length;
const allRows = (out.match(/data-anom=/g) || []).length;

// 几何自检：colgroup 列数 == 表头明细行列数 == 每一行 td 数（三者不等即会错行）
const headerCols = s => (s.match(/<col /g) || []).length;
const headerSubCols = s => { const m = s.match(/<tr class="wl-h2">([\s\S]*?)<\/tr>/); return m ? (m[1].match(/<th/g) || []).length : -1; };
const rowTdCounts = s => (s.match(/<tr[^>]*data-anom="[01]"[^>]*>[\s\S]*?<\/tr>/g) || []).map(r => (r.match(/<td/g) || []).length);

const checks = [
  ['无 undefined 泄漏', !/undefined/.test(out) && !/undefined/.test(outC)],
  ['表格有 min-width', wOf(out) > 0],
  ['冻结列变量已注入', /--wl-c1:44px;--wl-c2:252px/.test(out)],
  ['colgroup 列宽与变量同源', out.includes('<col style="width:44px"><col style="width:252px">')],
  ['表头首行 wl-h1', out.includes('<tr class="wl-h1">')],
  ['长文本列带 wl-txt', out.includes('wl-txt')],
  ['长文本列带 data-tip 全文', /class="[^"]*wl-txt"[^>]*data-tip="/.test(out)],
  ['截断类未落在 td 上（td 保持 table-cell）', !/<td[^>]*class="[^"]*wl-clamp/.test(out) && !/<td[^>]*class="[^"]*wl-clamp/.test(outC)],
  ['截断用单元格内层 span', /<td class="[^"]*wl-txt"[^>]*><span class="wl-clamp">/.test(out)],
  ['td 上无 display 覆写', !/<td[^>]*style="[^"]*display:/.test(out)],
  ['每行 td 数与表头列数一致（完整）', rowTdCounts(out).every(n => n === headerCols(out))],
  ['每行 td 数与表头列数一致（精简）', rowTdCounts(outC).every(n => n === headerCols(outC))],
  ['表头两行列数自洽', headerCols(out) === headerSubCols(out) + 2],
  ['行数与数据一致', allRows === nProj],
  ['异常行标记数正确', anomRows === expectedAnom],
  ['标红行与「⚠ 需关注」提示严格配对（防"红了但没提示"复发）',
    (out.match(/data-tip="⚠ 需关注：/g) || []).length === anomRows],
  ['★ 共享 projectAlerts() 与独立算式结果一致（规则未被改坏/未分叉）',
    (sample.projects || []).filter(p => projectAlertsReal(p).msgs.length > 0).length === expectedAnom],
  ['异常按钮计数正确', out.includes('只看异常' + (expectedAnom ? ' (' + expectedAnom + ')' : '<'))],
  ['异常行有红色标记类', expectedAnom === 0 || out.includes('class="wl-flag"')],
  ['问题单元格高亮', expectedAnom === 0 || out.includes('wl-cell-bad')],
  ['合计行存在', out.includes('id="wlFootRow"')],
  ['精简模式列宽更小', wOf(outC) < wOf(out)],
  ['精简模式去掉业务方向组', !outC.includes('wl-g-direction')],
  ['精简模式去掉长明细列(分包范围)', !outC.includes('分包范围')],
  ['精简模式保留核心列', outC.includes('承建部门') && outC.includes('总成本估算')],
  ['两模式行数一致', (outC.match(/data-anom=/g) || []).length === nProj],
  ['精简模式按钮为“完整”', outC.includes('完整</button>')],
  // 2026-09-21 起：专家评估列组去掉「评估后成本」，评估进度改为「完成专家数/专家总数」
  ['★ 专家评估列组只有 2 列（已删除「评估后成本」）',
    /name:'专家评估'[\s\S]{0,400}?cols:\[[\s\S]{0,300}?\]\s*\}/.test(block) &&
    !/label:'评估后成本'/.test(block) && /label:'核减额'/.test(block) && /label:'评估进度'/.test(block)],
  ['评估进度文案为「N 人」口径（非「N 项」）',
    /expert_done_count\|\|0\)\+'\/'[\s\S]{0,80}?' 人'/.test(block) && !/' 项'/.test(block)],
  // 2026-09-22：「免评估」改为醒目琥珀色标签，浅灰角标已看不清
  ['项目名前「免评估」使用醒目标签（wl-exempt-badge）',
    /needs_estimate===false[\s\S]{0,160}?wl-exempt-badge/.test(block)],
  ['专家评估列内「免评估」使用醒目占位（wl-exempt-cell）',
    /needs_estimate===false[\s\S]{0,120}?wl-exempt-cell/.test(block)],
  ['已删除浅灰角标形态（不再用 badge bg-light 写免评估）',
    !/badge bg-light text-dark border[^<]*免评估/.test(block)]
];

// ---- 行为断言：人员外包 / 专业分包展示「专家评估后」金额 ----
{
  const mk = (p) => {
    const api = buildApi(false, false);
    api.render({ projects: [p], evaluators: [{ slot: 1, user_id: 1, user_name: '专家A' }, { slot: 2, user_id: 2, user_name: '专家B' }] });
    return api.document.getElementById('wlProjects').innerHTML;
  };
  const baseP = {
    project_id: 901, project_name: '评估后金额验证项目', contract_amount: 1000000, needs_estimate: true,
    evaluated_count: 5, work_item_count: 5, expert_done_count: 1, expert_total_count: 2,
    cost_summary: { total_cost: 800000, outsourcing_cost: 300000, subcontract_cost: 200000 },
    outsourcing_evaluated_cost: 240000, outsourcing_original_cost: 300000,
    subcontract_evaluated_cost: 150000, subcontract_original_cost: 200000
  };
  const hEval = mk(baseP);
  const tr = (hEval.match(/<tr[\s\S]*?<\/tr>/g) || []).join('');
  // 原值只应出现在 data-tip 里，单元格里必须是评估后金额
  checks.push(['外包列展示评估后金额 ¥240,000（原值仅作提示）',
    /<td[^>]*data-tip="评估后（原 ¥300,000）"[^>]*>¥240,000</.test(tr) && !/>¥300,000</.test(tr)]);
  checks.push(['分包列展示评估后金额 ¥150,000（原值仅作提示）',
    /<td[^>]*data-tip="评估后（原 ¥200,000）"[^>]*>¥150,000</.test(tr) && !/>¥200,000</.test(tr)]);
  checks.push(['评估后金额带原值对照提示', /data-tip="评估后（原 ¥300,000）"/.test(tr)]);
  checks.push(['评估进度按「完成专家数/专家总数」显示 1/2 人', tr.includes('1/2 人')]);
  const noEval = mk(Object.assign({}, baseP, { evaluated_count: 0, expert_done_count: 0 }));
  const tr2 = (noEval.match(/<tr[\s\S]*?<\/tr>/g) || []).join('');
  checks.push(['未评估项目仍展示原值 ¥300,000', tr2.includes('¥300,000')]);
}
let bad = 0;
checks.forEach(([n, ok]) => { if (!ok) bad++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n); });
console.log('项目数=' + nProj + '  异常行=' + anomRows + '（独立算出 ' + expectedAnom + '）');
console.log('完整模式列宽=' + wOf(out) + 'px  精简模式列宽=' + wOf(outC) + 'px');

fs.writeFileSync(OUT + 'wl-out.html', out, 'utf8');
fs.writeFileSync(OUT + 'wl-out-compact.html', outC, 'utf8');
process.exit(bad ? 1 : 0);
