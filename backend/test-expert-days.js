// 专家免登录评估页 —— 「我的评估人天默认取原人天 + 步长箭头微调」桩 DOM 回归测试
// 做法：把 expert.html 的内联脚本原样抽出来，用桩 DOM 跑真实渲染，断言产出的 HTML 与行为。
const fs = require('fs');
const base = 'C:/Users/12129/WorkBuddy/mjumju正式版/lnsoft-patch/';
const html = fs.readFileSync(base + 'frontend/expert.html', 'utf8');
const script = html.match(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/)[1];

// ---------- 桩 DOM ----------
function parseAttrs(tagStr) {
  const o = {};
  const inner = tagStr.replace(/^<[a-zA-Z]+/, '').replace(/\/?>$/, '');
  const re = /([a-zA-Z_:][\w:-]*)(?:\s*=\s*"([^"]*)")?/g;
  let m; while ((m = re.exec(inner))) { if (m[1]) o[m[1]] = m[2] !== undefined ? m[2] : ''; }
  return o;
}
function mkEl(tagStr) {
  const a = parseAttrs(tagStr);
  const cls = new Set(String(a.class || '').split(/\s+/).filter(Boolean));
  const el = {
    tag: tagStr.match(/^<([a-zA-Z]+)/)[1], id: a.id || '',
    value: a.value !== undefined ? a.value : '', step: a.step, type: a.type,
    disabled: 'disabled' in a, dataset: {}, textContent: '', innerHTML: '',
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c), toggle: (c, f) => { (f === undefined ? !cls.has(c) : f) ? cls.add(c) : cls.delete(c); } },
    addEventListener() {}, focus() {}, querySelectorAll() { return []; },
  };
  if (a['data-wid'] !== undefined) el.dataset.wid = a['data-wid'];
  if (a['data-pd'] !== undefined) el.dataset.pd = a['data-pd'];
  if (a['data-label'] !== undefined) el.dataset.label = a['data-label'];
  Object.defineProperty(el, 'className', { get: () => [...cls].join(' ') });
  return el;
}
let appHTML = '';
const cache = new Map();
const byId = {};
function getById(id) {
  if (!byId[id]) {
    byId[id] = mkEl('<div id="' + id + '">');
    if (id === 'app') {
      let _v = '';
      Object.defineProperty(byId[id], 'innerHTML', {
        get: () => _v,
        set: v => { _v = String(v); appHTML = _v; cache.clear(); } // 重新渲染即失效缓存
      });
    }
  }
  return byId[id];
}
function el(tagStr) { if (!cache.has(tagStr)) cache.set(tagStr, mkEl(tagStr)); return cache.get(tagStr); }
const document = {
  getElementById: getById,
  querySelectorAll(sel) {
    if (sel === 'input[data-wid]') return [...appHTML.matchAll(/<input\b[^>]*data-wid="[^"]*"[^>]*>/g)].map(m => el(m[0]));
    if (sel === '.stepbtn') return [...appHTML.matchAll(/<button\b[^>]*class="[^"]*stepbtn[^"]*"[^>]*>/g)].map(m => el(m[0]));
    if (sel === 'input[id^="input_"]') return [];
    return [];
  }
};

// ---------- 桩数据 ----------
const PROJECTS = [
  { id: 1, project_name: '山东核电天易平台', project_code: '4102600582', biz_department: '能源信息业务部', project_type: '数字化类项目', status: 'reviewing', needs_estimate: true, locked: false, item_count: 3, done_count: 1, submitted: false },
  { id: 3, project_name: '已归档项目', project_code: '4102600723', biz_department: '信息业务', project_type: '数字化类项目', status: 'completed', needs_estimate: true, locked: true, item_count: 2, done_count: 0, submitted: false },
  { id: 4, project_name: '某免评估项目', project_code: '4102600800', biz_department: '电网事业部', project_type: '服务类项目', status: 'reviewing', needs_estimate: false, locked: false, item_count: 0, done_count: 0, submitted: false }
];
const ITEMS = {
  1: [
    { id: 101, category: 'outsourcing', work_task: '需求分析', work_item: '业务需求调研', description: '走访200户', person: '张三', person_days: 12, cost: 24000, my_days: 10, my_comment: '', my_submitted_at: '2026-09-20T10:00:00Z' },
    { id: 102, category: 'outsourcing', work_task: '开发', work_item: '平台功能开发', description: '数据接入', person: '李四', person_days: 30, cost: 60000, my_days: null, my_comment: '', my_submitted_at: null },
    { id: 103, category: 'subcontract', work_task: '实施', work_item: '现场部署实施', description: '共200户核验', person: '外部供应商', person_days: 18, cost: 36000, my_days: null, my_comment: '', my_submitted_at: null }
  ],
  3: [
    { id: 301, category: 'outsourcing', work_task: '开发', work_item: '数据治理开发', description: '已归档', person: '赵六', person_days: 20, cost: 40000, my_days: null },
    { id: 302, category: 'subcontract', work_task: '测试', work_item: '第三方测试配合', description: '', person: '某测试机构', person_days: 6, cost: 12000, my_days: null }
  ]
};
let lastPost = null;
function json(o, code) { return Promise.resolve({ ok: (code || 200) < 400, status: code || 200, json: () => Promise.resolve(o) }); }
const fetch = function (url, opt) {
  url = String(url);
  if (/\/estimates$/.test(url)) {
    lastPost = JSON.parse((opt && opt.body) || '{}');
    const arr = ITEMS[lastPost.project_id] || [];
    lastPost.items.forEach(it => { const f = arr.find(x => x.id === it.work_item_id); if (f) f.my_days = it.days; });
    return json({ success: true, saved: lastPost.items.length, items: lastPost.items, skipped: [] });
  }
  let m = url.match(/expert-invite\/[^/]+\/projects\/(\d+)/);
  if (m) { const pid = Number(m[1]); return json({ project: PROJECTS.find(x => x.id === pid), items: ITEMS[pid] || [], categories: [{ key: 'outsourcing', label: '人员外包' }, { key: 'subcontract', label: '专业分包' }] }); }
  if (/expert-invite/.test(url)) return json({ expert_name: '张伟', role_label: '评审专家', session: { id: 7, name: '第十五批经济评审', review_time: '2026-09-25 09:00' }, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), perm: 'estimate', stats: { total: 3, todo: 1, done: 1, my_estimate_count: 1 }, projects: PROJECTS });
  return json({}, 404);
};

const APP = new Function('window', 'document', 'location', 'history', 'fetch', 'URLSearchParams', 'setTimeout', 'console',
  script + '\nreturn { openProject:openProject, setEstimateStep:setEstimateStep, submitAll:submitAll, getState:()=>STATE, appHtml:()=>document.getElementById("app").innerHTML };'
)({}, document, { search: '?k=' + 'a'.repeat(43) }, { replaceState() {} }, fetch, URLSearchParams, (f) => f(), console);

// ---------- 断言 ----------
let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (!ok && extra !== undefined ? '  → ' + extra : '')); };
const inputs = () => document.querySelectorAll('input[data-wid]');
const byWid = id => inputs().find(i => i.dataset.wid === String(id));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(30); // 等首次 load()

  // 打开「待评估」项目（1 已提交过 1 项）
  await APP.openProject(1);
  let h = APP.appHtml();

  check('未渲染出 undefined', !/undefined/.test(h) && !/NaN/.test(h));
  check('表格渲染出 3 行输入框', inputs().length === 3, inputs().length);

  // 1) 默认值：已提交的用自己填的值，未提交的取原人天
  check('已提交行沿用本人值（10，非原 12）', byWid(101).value === '10', byWid(101).value);
  check('未提交行默认取原人天（30）', byWid(102).value === '30', byWid(102).value);
  check('未提交行默认取原人天（18）', byWid(103).value === '18', byWid(103).value);
  check('所有行都有 data-pd 记录原人天', inputs().every(i => i.dataset.pd !== ''));
  check('原人天列仍在（可对照）', /<td class="num">12<\/td>/.test(h) && /<td class="num">30<\/td>/.test(h));

  // 2) 状态列
  check('已提交行显示已提交值', /已提交 10/.test(h));
  check('已提交且与原始不同则标出原值', /<span class="adjnote">原12<\/span>/.test(h));
  check('未提交行显示「未提交」', (h.match(/<span class="pending">未提交<\/span>/g) || []).length === 2, (h.match(/pending/g) || []).length);
  check('改动过的行加 adj 高亮', byWid(101).classList.contains('adj') === true);
  check('未改动的行不加 adj 高亮', byWid(102).classList.contains('adj') === false);
  check('input 带 adj 样式类定义', /input\[type=number\]\.adj\{/.test(html));

  // 3) 步长控件
  const steps = document.querySelectorAll('.stepbtn');
  const stepLabels = [...h.matchAll(/class="stepbtn[^"]*"[^>]*>([^<]*)</g)].map(m => m[1]).join(',');
  check('步长按钮为 0.5/1/3/5 四档', steps.length === 4 && stepLabels === '0.5,1,3,5', steps.length + ' → ' + stepLabels);
  check('默认步长 0.5 且按钮高亮', inputs().every(i => i.step === '0.5') && steps[0].classList.contains('on'));
  APP.setEstimateStep(3, steps[2]);
  check('切到步长 3 后所有输入框 step 同步', inputs().every(i => String(i.step) === '3'), inputs().map(i => i.step).join('/'));
  check('仅当前步长按钮高亮', steps[2].classList.contains('on') && !steps[0].classList.contains('on') && !steps[1].classList.contains('on') && !steps[3].classList.contains('on'));
  await APP.openProject(1);
  check('重渲染后保持所选步长 3', inputs().every(i => String(i.step) === '3'));
  check('数字框 min=0（不允许负数）', inputs().every(i => /min="0"/.test(htmlOf(i))) || /min="0" step="3"/.test(APP.appHtml()));
  APP.setEstimateStep(0.5, document.querySelectorAll('.stepbtn')[0]);

  // 4) 提交按钮文案随是否已提交切换
  check('已提交过 → 按钮为「更新我的评估」', /data-label="更新我的评估"/.test(h), h.match(/id="submitBtn"[^>]*/));
  await APP.openProject(4);
  check('无需评估的项目给出提示且无输入框', /无需专家评估/.test(APP.appHtml()) && inputs().length === 0);

  // 5) 归档项目：只读
  await APP.openProject(3);
  h = APP.appHtml();
  check('归档项目输入框禁用', inputs().every(i => i.disabled === true));
  check('归档项目仍预填原人天（20 / 6）', byWid(301).value === '20' && byWid(302).value === '6', byWid(301).value + '/' + byWid(302).value);
  check('归档项目按钮为「已归档，不可提交」', /已归档，不可提交/.test(h));

  // 6) 提交内容 = 全部预填值（回归主站口径：默认即原人天，提交即确认）
  await APP.openProject(2); // 不存在 → 走兜底
  await APP.openProject(1);
  APP.setEstimateStep(1, document.querySelectorAll('.stepbtn')[1]);
  await APP.submitAll(1);
  check('提交时带上全部已预填项（3 项）', !!lastPost && lastPost.items.length === 3, JSON.stringify(lastPost && lastPost.items));
  check('提交人天 = 界面显示值 [10,30,18]', !!lastPost && JSON.stringify(lastPost.items.map(i => i.days)) === '[10,30,18]', JSON.stringify(lastPost && lastPost.items.map(i => i.days)));

  function htmlOf(i) { return '<input data-wid="' + i.dataset.wid + '" step="' + i.step + '">'; }

  console.log('\n结果：PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(2); });
