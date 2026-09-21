// 成本明细表「人员」列回归：人员外包/专业分包的明细表不应再有「人员」列；
// 职工成本表（长期/中实/华兆）保留该列。
// 桩 DOM：抽出 index.html 的 renderWorkItemsTable 在 Node 里跑，检查表头列。
const fs = require('fs'), path = require('path');

let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  -> ' + extra));
  if (!ok) fail++;
};

// 路径自适应：★ 必须优先 frontend/index.html（真源）；
// lnsoft-patch/index.html 是历史旧副本（缺 projectAlerts 等），排第一会静默读旧文件得出假绿结论
const pick = (cands) => cands.find(f => fs.existsSync(f));
const htmlPath = pick([
  path.join(__dirname, 'frontend', 'index.html'),             // 真源（本机工作副本）
  path.join(__dirname, '..', 'frontend', 'index.html'),       // 仓库/服务器布局
  '/opt/jingjipingshen/frontend/index.html',                  // 服务器部署位
  path.join(__dirname, 'index.html')                         // 兜底（旧副本，最后选）
]);
if (!htmlPath) { console.log('找不到 index.html'); process.exit(1); }
const html = fs.readFileSync(htmlPath, 'utf8');

// 抽出 renderWorkItemsTable 函数体（到匹配的结尾大括号）
const start = html.indexOf('function renderWorkItemsTable(');
if (start < 0) { console.log('找不到 renderWorkItemsTable'); process.exit(1); }
let depth = 0, end = -1;
for (let i = html.indexOf('{', start); i < html.length; i++) {
  if (html[i] === '{') depth++;
  else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
}
const fnSrc = html.slice(start, end + 1);

const document = {
  querySelectorAll: () => [],
  getElementById: () => null
};
const window = {};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const env = { document, window, esc, console };
const fn = new Function(...Object.keys(env), fnSrc + '\nreturn renderWorkItemsTable;')(...Object.values(env));

const mk = (category, extra) => Object.assign({
  id: 1, category, work_task: '任务', work_item: '工作项A', description: '说明',
  person_days: 10, person: '张三', cost: 10000
}, extra || {});

// 1) 人员外包：无「人员」列
let out = fn([mk('outsourcing')], true, false, []);
check('外包表头无「人员」列', !/<th>人员<\/th>/.test(out), out);
check('外包数据行无人员单元格', !/>张三</.test(out), out);
check('外包仍含「原费用」列', /<th>原费用<\/th>/.test(out), out);

// 2) 专业分包：无「人员」列
out = fn([mk('subcontract')], true, false, []);
check('分包表头无「人员」列', !/<th>人员<\/th>/.test(out), out);
check('分包数据行无人员单元格', !/>张三</.test(out), out);

// 3) 长期职工：保留「人员」列
out = fn([mk('long_term')], false, false, []);
check('职工表头有「人员」列', /<th>人员<\/th>/.test(out), out);
check('职工数据行含人员', />张三</.test(out), out);

// 4) 外包行的人天/费用仍渲染
out = fn([mk('outsourcing', { person_days: 12, cost: 3400 })], true, false, []);
check('外包人天正常渲染', /<td>12<\/td>/.test(out), out);
check('外包费用正常渲染', /¥3,400/.test(out), out);

// 5) 空列表兜底
out = fn([], false, false, []);
check('空表返回兜底文案', /暂无明细/.test(out), out);

console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
