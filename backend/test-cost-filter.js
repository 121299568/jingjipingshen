// 工作量评估页「先选批次 → 再按项目资料页序号选项目」回归
// 核心断言：①序号与项目资料页批次汇总表同口径（批次内从 01 起）
//          ②切换批次后只显示该批次项目
//          ③管理员可见未启动评审的批次（pending + draft），专家仍受限
const fs = require('fs');
const path = require('path');
// 路径自适应：本地（backend 与 frontend 同级）/ 部署机直跑（/root/jps-local-only）
// 硬编码本机绝对路径会在服务器上直接崩
const APP = [
  path.join(__dirname, 'frontend/index.html'),
  path.join(__dirname, '../frontend/index.html'),
  '/opt/jingjipingshen/frontend/index.html'
].find(p => fs.existsSync(p));
if (!APP) { console.error('找不到 frontend/index.html'); process.exit(1); }
const html = fs.readFileSync(APP, 'utf8');
const script = html.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/)[1];

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
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let pass = 0, fail = 0;
const ck = (n, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (!ok && extra !== undefined ? '  → ' + extra : '')); };

// ---------- 构造数据：两个批次 ----------
// 项目顺序刻意打乱 id 顺序，用来证明序号按 projects 数组顺序而非 id 排序
const P7 = [
  { id: 91, session_id: 7, project_name: '批次7-甲', status: 'reviewing' },
  { id: 72, session_id: 7, project_name: '批次7-乙', status: 'reviewing' },
  { id: 88, session_id: 7, project_name: '批次7-丙', status: 'pending_confirm' }
];
const P8 = [
  { id: 105, session_id: 8, project_name: '批次8-甲', status: 'draft' },
  { id: 70, session_id: 8, project_name: '批次8-乙', status: 'draft' },
  { id: 96, session_id: 8, project_name: '批次8-丙', status: 'draft' },
  { id: 71, session_id: 8, project_name: '批次8-丁', status: 'draft' }
];
const projects = [...P7, ...P8];
const sessions = [
  { id: 7, name: '第十五批经济评审', status: 'in_progress' },
  { id: 8, name: '第十四批经济评审', status: 'pending' }
];

function makeEnv(role) {
  const store = {};
  const document = {
    getElementById(id) {
      if (!store[id]) store[id] = { innerHTML: '', value: '', classList: { toggle() {}, add() {}, remove() {} } };
      return store[id];
    }
  };
  const src = [
    grabFn(script, 'isCostReadonly'),
    grabFn(script, 'getCostVisibleProjects'),
    grabFn(script, 'costSeqMap'),
    grabFn(script, 'costSessionOptions'),
    grabFn(script, 'renderCostSessionFilter'),
    grabFn(script, 'selectCostSession'),
    grabFn(script, 'getCostFilteredProjects'),
    grabFn(script, 'renderCostProjectFilter'),
    'return { isCostReadonly, getCostVisibleProjects, costSeqMap, costSessionOptions, renderCostSessionFilter, selectCostSession, getCostFilteredProjects, renderCostProjectFilter, document };'
  ].join('\n');
  const fn = new Function('projects', 'sessions', 'currentUser', 'costSessionFilterId', 'costProjectStatus', 'currentProjectId', 'esc', 'document', 'selectCostProject', 'autoSelectCostProject', src);
  return fn(projects, sessions, { role }, null, {}, null, esc, document, () => {}, async () => {});
}

(async () => {
  // ===== A. 管理员 =====
  const A = makeEnv('admin');
  ck('管理员：可见未启动评审的批次（pending+draft 也能看）', A.getCostVisibleProjects().length === 7, A.getCostVisibleProjects().length);
  ck('管理员：只读标记为真', A.isCostReadonly() === true);
  const opts = A.costSessionOptions();
  ck('批次下拉按 session id 升序给出 2 个批次', opts.length === 2 && opts[0].id === 7 && opts[1].id === 8, JSON.stringify(opts));
  ck('批次下拉显示批次名', opts[0].name === '第十五批经济评审', opts[0].name);

  A.renderCostSessionFilter();
  // costSessionFilterId 是脚本内部变量，通过过滤结果反推默认批次（应为 id 升序的第一个 = 7）
  const f7 = A.getCostFilteredProjects();
  ck('默认落在第一个批次（批次7，3 个项目）', f7.length === 3 && f7.every(p => p.session_id === 7), f7.map(p => p.id).join(','));

  // 序号口径：与项目资料页一致 = 批次内 projects 顺序索引 +1
  const seq = A.costSeqMap();
  ck('序号按 projects 顺序而非 id（批次7：91→01、72→02、88→03）',
    seq.get('7').get(P7[0]) === 1 && seq.get('7').get(P7[1]) === 2 && seq.get('7').get(P7[2]) === 3,
    JSON.stringify([seq.get('7').get(P7[0]), seq.get('7').get(P7[1]), seq.get('7').get(P7[2])]));
  ck('序号按 projects 顺序而非 id（批次8：105→01、70→02、96→03、71→04）',
    seq.get('8').get(P8[0]) === 1 && seq.get('8').get(P8[1]) === 2 && seq.get('8').get(P8[2]) === 3 && seq.get('8').get(P8[3]) === 4);

  // 渲染出来的按钮序号
  A.renderCostProjectFilter();
  const html7 = A.document.getElementById('costProjectFilter').innerHTML;
  const nums7 = [...html7.matchAll(/>([0-9]{2})<span|>([0-9]{2})</g)].map(m => m[1] || m[2]);
  ck('批次7 按钮序号为 01/02/03', nums7.join(',') === '01,02,03', nums7.join(','));

  A.selectCostSession('8');
  const f8 = A.getCostFilteredProjects();
  ck('切到批次8后只剩 4 个项目', f8.length === 4, f8.length);
  A.renderCostProjectFilter();
  const html8 = A.document.getElementById('costSessionFilter').innerHTML;
  ck('切换后下拉保持选中批次8', /value="8"[^>]*selected|selected[^>]*value="8"/.test(html8), html8.slice(0, 120));

  // ===== B. 专家仍受限 =====
  const E = makeEnv('expert');
  const ev = E.getCostVisibleProjects();
  ck('专家：仍只能看「进行中批次 + 评审中/待确认」项目（3 个）', ev.length === 3, ev.length);
  ck('专家：只读标记为假', E.isCostReadonly() === false);
  const eopts = E.costSessionOptions();
  ck('专家：批次下拉只有进行中的批次', eopts.length === 1 && eopts[0].id === 7, JSON.stringify(eopts));

  // ===== C. 源码层面 =====
  ck('源码：页面新增批次选择容器', /id="costSessionFilter"/.test(html));
  ck('源码：管理员例外有注释说明原因', /管理员\/研发中心例外/.test(script));
  ck('源码：序号口径有注释说明与项目资料页一致', /项目资料页.{0,40}一致|不能用本页过滤后数组的索引/.test(script));

  console.log('\n结果：PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });
