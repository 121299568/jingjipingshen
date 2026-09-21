// 专家免登录评估页 —— 桩 DOM 回归测试
// 覆盖：①「我的评估人天」默认取原人天 + 步长箭头微调 ②紧凑排版（单行截断 + 序号）③短链路径模式
const fs = require('fs');
// 路径自适应：本地（脚本在 lnsoft-patch/ 下）、服务器仓库（backend/ 与 frontend/ 同级）、
// 服务器直跑目录 —— 三处都能跑，避免硬编码绝对路径导致换机器就崩
function pick(cands) {
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  throw new Error('找不到文件，试过：' + cands.join(' , '));
}
const html = fs.readFileSync(pick([__dirname + '/frontend/expert.html', __dirname + '/../frontend/expert.html',
  '/opt/jingjipingshen/frontend/expert.html',
  'C:/Users/12129/WorkBuddy/mjumju正式版/lnsoft-patch/frontend/expert.html']), 'utf8');
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
    value: a.value !== undefined ? a.value : '', step: a.step, type: a.type, title: a.title,
    disabled: 'disabled' in a, dataset: {}, textContent: '', innerHTML: '',
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c), toggle: (c, f) => { (f === undefined ? !cls.has(c) : f) ? cls.add(c) : cls.delete(c); } },
    addEventListener() {}, focus() {}, querySelectorAll() { return []; },
  };
  ['wid', 'pd', 'label'].forEach(k => { if (a['data-' + k] !== undefined) el.dataset[k] = a['data-' + k]; });
  Object.defineProperty(el, 'className', { get: () => [...cls].join(' ') });
  return el;
}

// ---------- 桩数据 ----------
const PROJECTS = [
  { id: 1, project_name: '山东核电有限公司天易平台技术支持服务项目（超长名称用于验证单行省略不会撑高行）', project_code: '4102600582', biz_department: '能源信息业务部（工业互联网中心）', project_type: '数字化类项目', status: 'reviewing', needs_estimate: true, locked: false, item_count: 3, done_count: 1, submitted: false },
  { id: 3, project_name: '已归档项目', project_code: '4102600723', biz_department: '信息业务', project_type: '数字化类项目', status: 'completed', needs_estimate: true, locked: true, item_count: 2, done_count: 0, submitted: false },
  { id: 4, project_name: '某免评估项目', project_code: '4102600800', biz_department: '电网事业部', project_type: '服务类项目', status: 'reviewing', needs_estimate: false, locked: false, item_count: 0, done_count: 0, submitted: false }
];
const ITEMS = {
  1: [
    { id: 101, category: 'outsourcing', work_task: '需求分析', work_item: '业务需求调研与梳理', description: '走访200户企业，梳理生产工艺与能耗模型，形成需求规格说明书并组织评审', person: '张三', person_days: 12, cost: 24000, my_days: 10, my_comment: '', my_submitted_at: '2026-09-20T10:00:00Z' },
    { id: 102, category: 'outsourcing', work_task: '开发', work_item: '平台功能开发', description: '数据接入', person: '李四', person_days: 30, cost: 60000, my_days: null, my_comment: '', my_submitted_at: null },
    // 长说明：验证「超过 6 行才折叠」——含真实换行，对应线上 326 字的超长描述
    { id: 103, category: 'subcontract', work_task: '实施', work_item: '现场部署实施', description: '工作地点：潍坊昌邑公司UPS蓄电池间\n作业现场布置\n工作班成员：1名电工，1名调试工程师\n工作内容：蓄电池间空调系统维修，含拆装、清洗、加注冷媒、调试运行并出具验收单，需配合甲方停电计划安排作业窗口，作业完成后清理现场', person: '外部供应商', person_days: 18, cost: 36000, my_days: null, my_comment: '', my_submitted_at: null }
  ],
  3: [
    { id: 301, category: 'outsourcing', work_task: '开发', work_item: '数据治理开发', description: '已归档', person: '赵六', person_days: 20, cost: 40000, my_days: null },
    { id: 302, category: 'subcontract', work_task: '测试', work_item: '第三方测试配合', description: '', person: '某测试机构', person_days: 6, cost: 12000, my_days: null }
  ]
};

function makeApp(loc) {
  let appHTML = ''; const cache = new Map(), byId = {};
  let lastPost = null; const urls = [];
  function getById(id) {
    if (!byId[id]) {
      byId[id] = mkEl('<div id="' + id + '">');
      if (id === 'app') { let v = ''; Object.defineProperty(byId[id], 'innerHTML', { get: () => v, set: x => { v = String(x); appHTML = v; cache.clear(); } }); }
    }
    return byId[id];
  }
  const el = t => { if (!cache.has(t)) cache.set(t, mkEl(t)); return cache.get(t); };
  const document = {
    getElementById: getById,
    querySelectorAll(sel) {
      if (sel === 'input[data-wid]') return [...appHTML.matchAll(/<input\b[^>]*data-wid="[^"]*"[^>]*>/g)].map(m => el(m[0]));
      if (sel === '.stepbtn') return [...appHTML.matchAll(/<button\b[^>]*class="[^"]*stepbtn[^"]*"[^>]*>/g)].map(m => el(m[0]));
      if (sel === 'input[id^="input_"]') return [];
      return [];
    }
  };
  const json = (o, code) => Promise.resolve({ ok: (code || 200) < 400, status: code || 200, json: () => Promise.resolve(o) });
  const fetch = function (url, opt) {
    url = String(url); urls.push(url);
    if (/\/estimates$/.test(url)) {
      lastPost = JSON.parse((opt && opt.body) || '{}');
      const arr = ITEMS[lastPost.project_id] || [];
      lastPost.items.forEach(it => { const f = arr.find(x => x.id === it.work_item_id); if (f) f.my_days = it.days; });
      return json({ success: true, saved: lastPost.items.length, items: lastPost.items, skipped: [] });
    }
    let m = url.match(/(?:expert-invite\/[^/]+|\/api\/e\/[^/]+)\/projects\/(\d+)/);
    if (m) { const pid = Number(m[1]); return json({ project: PROJECTS.find(x => x.id === pid), items: ITEMS[pid] || [], categories: [{ key: 'outsourcing', label: '人员外包' }, { key: 'subcontract', label: '专业分包' }] }); }
    if (/expert-invite|\/api\/e\//.test(url)) return json({ expert_name: '张伟', role_label: '评审专家', session: { id: 7, name: '第十五批经济评审', review_time: '2026-09-25 09:00' }, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(), perm: 'estimate', stats: { total: 3, todo: 1, done: 1, my_estimate_count: 1 }, projects: PROJECTS });
    return json({}, 404);
  };
  const APP = new Function('window', 'document', 'location', 'history', 'fetch', 'URLSearchParams', 'setTimeout', 'console',
    script + '\nreturn { openProject:openProject, renderList:renderList, setEstimateStep:setEstimateStep, stepDays:stepDays, submitAll:submitAll, getState:()=>STATE, appHtml:()=>document.getElementById("app").innerHTML };'
  )({}, document, loc, { replaceState() {} }, fetch, URLSearchParams, f => f(), console);
  return { APP, get appHTML() { return appHTML; }, get lastPost() { return lastPost; }, urls, document };
}

// ---------- 断言 ----------
let pass = 0, fail = 0;
const check = (name, ok, extra) => { ok ? pass++ : fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (!ok && extra !== undefined ? '  → ' + extra : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ===== A. 长链模式（?k=token，向后兼容）=====
  const A = makeApp({ search: '?k=' + 'a'.repeat(43), pathname: '/expert.html' });
  await sleep(30);
  let h = A.appHTML;
  let inputs = A.document.querySelectorAll('input[data-wid]');
  const byWid = id => inputs.find(i => i.dataset.wid === String(id));

  check('列表渲染且无 undefined', !/undefined/.test(h) && !/NaN/.test(h));
  check('列表接口用长令牌路径', A.urls[0] === '/api/expert-invite/' + 'a'.repeat(43), A.urls[0]);

  // 项目序号
  check('项目列表带序号 1', /<div class="idx">1<\/div>/.test(h));
  check('项目列表带序号 2', /<div class="idx">2<\/div>/.test(h));
  check('项目列表带序号 3', /<div class="idx">3<\/div>/.test(h));
  check('序号个数 = 项目数', (h.match(/<div class="idx">/g) || []).length === 3);
  check('项目名超长也只占单行（省略 + title 全文）',
    /<div class="pname" title="[^"]+">/.test(h) && /\.pname\{[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/.test(html));
  check('元信息行单行省略', /\.pmeta\{[^}]*text-overflow:ellipsis/.test(html));
  check('统计芯片含项目总数', /共 <b>3<\/b> 个项目/.test(h));

  // ===== B. 明细页：默认值 / 状态 / 高亮 =====
  await A.APP.openProject(1);
  h = A.appHTML;
  inputs = A.document.querySelectorAll('input[data-wid]');
  check('表格渲染 3 行输入', inputs.length === 3);
  check('已提交行沿用本人值（10，非原 12）', byWid(101).value === '10', byWid(101).value);
  check('未提交行默认取原人天（30）', byWid(102).value === '30', byWid(102).value);
  check('未提交行默认取原人天（18）', byWid(103).value === '18', byWid(103).value);
  check('所有行记录原人天 data-pd', inputs.every(i => i.dataset.pd !== ''));
  check('改动过的行标黄（adj）', byWid(101).classList.contains('adj') && !byWid(102).classList.contains('adj'));

  // ===== C. 列宽口径与全文展示 =====
  check('表格固定布局 + 最小宽度 1080', /table\{[^}]*table-layout:fixed/.test(html) && /table\{[^}]*min-width:1080px/.test(html));
  const colCount = (h.match(/<col style="width:/g) || []).length;
  const thCount = (h.match(/<th[ >]/g) || []).length;
  const groupCount = (h.match(/<colgroup>/g) || []).length;
  check('每个表格 colgroup 列数与表头一致（7 列 × 2 类）',
    groupCount === 2 && colCount === thCount && colCount % 7 === 0,
    groupCount + '表 / ' + colCount + 'col / ' + thCount + 'th');
  // 任务/工作项/说明 自适应（合计 77.5%）——内容展示全
  check('三列文本列宽度自适应（18%/18%/41.5%）',
    h.includes('<col style="width:18%"><col style="width:18%"><col style="width:41.5%">'));
  // 原人天/原费用/我的评估人天/状态 宽度够用即可（原费用略宽）
  check('四个窄列宽度够用即可（原人天 4.5 / 原费用 8 / 评估人天 6 / 状态 4%）',
    h.includes('<col style="width:4.5%"><col style="width:8%"><col style="width:6%"><col style="width:4%">'));
  const widths = [...h.matchAll(/<col style="width:([\d.]+)%">/g)].map(m => parseFloat(m[1]));
  const oneTable = widths.slice(0, 7).reduce((a, b) => a + b, 0);
  check('单表列宽合计 100%（不留空档，也不靠浏览器补齐）', Math.abs(oneTable - 100) < 0.01, oneTable + '%');
  check('原费用列宽于原人天列（费用列宽一些）', widths[4] > widths[3], widths[3] + ' vs ' + widths[4]);
  check('三个文本列都用换行容器展示全文（9 格）',
    (h.match(/<td class="txt"><span class="clamp">/g) || []).length === 9,
    (h.match(/<td class="txt"><span class="clamp">/g) || []).length);
  check('文本列已去掉单行截断的 title 写法', !/<td title="[^"]*">/.test(h));
  check('文本列 pre-line 保留原始换行 + 行高压紧 1.32',
    /td\.txt\{[^}]*white-space:pre-line/.test(html) && /td\.txt\{[^}]*line-height:1\.32/.test(html));
  check('超长文本默认折叠为 6 行', /\.clamp\{[^}]*-webkit-line-clamp:6/.test(html));
  check('超长说明带「展开全文」按钮（可就地展开）',
    /class="more"[^>]*>展开全文</.test(h) && /\.clamp\.open\{[^}]*display:block/.test(html));
  check('短说明不给按钮（避免噪音）',
    (h.match(/class="more"/g) || []).length === 1, (h.match(/class="more"/g) || []).length);
  check('人员列已移除（workItems 里本就没有该字段，一直在显示 —）',
    !/<th>人员<\/th>/.test(h) && !/class="nw"/.test(h) && !/td\.nw\{/.test(html));
  check('最后一列「状态」靠右（表头 + 单元格）',
    /<th class="st">状态<\/th>/.test(h) && /<td class="st statuscell"/.test(h) && /td\.st,th\.st\{[^}]*text-align:right/.test(html));
  check('状态列只写「已提交 / 未提交」文案（不带数值）',
    /<td class="st statuscell"[^>]*><span class="saved">已提交<\/span><\/td>/.test(h)
    && /<td class="st statuscell"[^>]*><span class="pending">未提交<\/span><\/td>/.test(h));
  check('状态悬浮标题补充人天明细', /title="已提交 10 人天（原 12）"/.test(h),
    (h.match(/title="已提交[^"]*"/) || [])[0]);
  check('无用残留样式已清理（saved.adj / adjnote）',
    !/\.saved\.adj\{/.test(html) && !/\.adjnote\{/.test(html) && !/class="adjnote"/.test(h));
  check('金额/人天右对齐等宽数字', /td\.num,th\.num\{[^}]*tabular-nums/.test(html));
  check('明细页显示序号进度', /第 1 \/ 3 个项目/.test(h), (h.match(/第 \d+ \/ \d+ 个项目/) || [])[0]);
  check('明细页项目名最多两行', /\.ptitle\{[^}]*line-clamp:2/.test(html));
  check('表格可视高度按视口计算（不用 60vh 浪费）', /max-height:calc\(100vh - \d+px\)/.test(html));

  // ===== C2. 人天步进器：左「−」右「+」替代原生上下箭头 =====
  check('人天列用「− 输入框 ＋」步进器',
    /<div class="stepper"><button type="button" class="sbtn" onclick="stepDays\(this,-1\)"[^>]*>−<\/button><input type="number"[^>]*data-wid="101"[^>]*><button type="button" class="sbtn" onclick="stepDays\(this,1\)"[^>]*>\+<\/button><\/div>/.test(h));
  check('每行一对按钮（3 行 × 2 = 6）', (h.match(/class="sbtn"/g) || []).length === 6, (h.match(/class="sbtn"/g) || []).length);
  check('按钮带 aria-label（− 减少 / + 增加）',
    (h.match(/aria-label="减少"/g) || []).length === 3 && (h.match(/aria-label="增加"/g) || []).length === 3);
  check('原生上下箭头已隐藏（不出现两套控件并存）',
    /::-webkit-inner-spin-button\{-webkit-appearance:none/.test(html) && /input\[type=number\]\{[^}]*appearance:textfield/.test(html));
  check('输入框不再为原生箭头预留右内边距（改居中）',
    /input\[type=number\]\{[^}]*text-align:center/.test(html) && !/padding:3px 14px 3px 6px/.test(html));
  check('步进按钮样式（17px 窄按钮 / 悬浮高亮 / 禁用降透明）',
    /\.sbtn\{[^}]*width:17px/.test(html) && /\.sbtn:hover:not\(:disabled\)/.test(html) && /\.sbtn:disabled\{[^}]*opacity/.test(html));
  check('底部提示改为「左右 ± 按步长微调」', /左右 ± 按步长微调/.test(h));

  // 行为：加减 / 下限 / 浮点 / 空值回落 / 高亮联动 / 归档禁用
  const mkStep = (val, pd, disabled) => {
    const inp = mkEl('<input data-wid="7" value="' + val + '" step="0.5" data-pd="' + pd + '">');
    if (disabled) inp.disabled = true;
    return { inp, btn: { parentNode: { querySelector: () => inp } } };
  };
  let S = mkStep('12', '12');
  A.APP.stepDays(S.btn, 1);
  check('＋ 按步长加（12 → 12.5）', S.inp.value === '12.5', S.inp.value);
  A.APP.stepDays(S.btn, -1); A.APP.stepDays(S.btn, -1);
  check('− 按步长减（12.5 → 11.5）', S.inp.value === '11.5', S.inp.value);
  check('改动后输入框标黄（与原人天不同）', S.inp.classList.contains('adj'));
  A.APP.stepDays(S.btn, 1);
  check('回到原人天时取消标黄', !S.inp.classList.contains('adj'), S.inp.value);
  S = mkStep('0.5', '0.5');
  A.APP.stepDays(S.btn, -1); A.APP.stepDays(S.btn, -1);
  check('下限为 0（不出现负数）', S.inp.value === '0', S.inp.value);
  S = mkStep('0', '0');
  for (let i = 0; i < 3; i++) A.APP.stepDays(S.btn, 1);
  check('消除浮点误差（三次 +0.5 = 1.5）', S.inp.value === '1.5', S.inp.value);
  S = mkStep('', '18');
  A.APP.stepDays(S.btn, 1);
  check('空值回落到原人天再增减（→ 18.5）', S.inp.value === '18.5', S.inp.value);
  S = mkStep('5', '5', true);
  A.APP.stepDays(S.btn, 1);
  check('归档（禁用）时按钮不生效', S.inp.value === '5', S.inp.value);

  // ===== D. 步长 =====
  const steps = A.document.querySelectorAll('.stepbtn');
  const stepLabels = [...h.matchAll(/class="stepbtn[^"]*"[^>]*>([^<]*)</g)].map(m => m[1]).join(',');
  check('步长按钮 0.5/1/3/5 四档', steps.length === 4 && stepLabels === '0.5,1,3,5', steps.length + ' → ' + stepLabels);
  check('默认步长 0.5', inputs.every(i => String(i.step) === '0.5'));
  A.APP.setEstimateStep(3, steps[2]);
  check('切到 3 后所有输入 step 同步', inputs.every(i => String(i.step) === '3'), inputs.map(i => i.step).join('/'));
  check('仅当前档高亮', steps[2].classList.contains('on') && !steps[0].classList.contains('on'));
  await A.APP.openProject(1);
  check('重渲染后保持所选步长', A.document.querySelectorAll('input[data-wid]').every(i => String(i.step) === '3'));
  A.APP.setEstimateStep(0.5, A.document.querySelectorAll('.stepbtn')[0]);

  // ===== E. 归档 / 无需评估 =====
  await A.APP.openProject(3);
  h = A.appHTML;
  inputs = A.document.querySelectorAll('input[data-wid]');
  check('归档项目输入禁用', inputs.every(i => i.disabled === true));
  check('归档项目仍预填原人天', inputs.map(i => i.value).join(',') === '20,6', inputs.map(i => i.value).join(','));
  check('归档按钮文案', /已归档，不可提交/.test(h));
  await A.APP.openProject(4);
  check('无需评估项目给出提示', /无需专家评估/.test(A.appHTML) && A.document.querySelectorAll('input[data-wid]').length === 0);

  // ===== F. 提交载荷 =====
  await A.APP.openProject(1);
  await A.APP.submitAll(1);
  check('提交带上全部预填项（3）', !!A.lastPost && A.lastPost.items.length === 3, JSON.stringify(A.lastPost && A.lastPost.items));
  check('提交人天 = 界面显示值 [10,30,18]', !!A.lastPost && JSON.stringify(A.lastPost.items.map(i => i.days)) === '[10,30,18]');

  // ===== G. 短链模式（/e/<code>，地址栏与接口都不出现长令牌）=====
  const B = makeApp({ search: '', pathname: '/e/Kf7mQ2x9' });
  await sleep(30);
  check('短链：无需 ?k= 也能加载', !/无法打开评估页/.test(B.appHTML) && /专家工作量评估/.test(B.appHTML));
  check('短链：接口走 /api/e/<code>', B.urls[0] === '/api/e/Kf7mQ2x9', B.urls[0]);
  check('短链：列表页仍带序号', /<div class="idx">1<\/div>/.test(B.appHTML));
  await B.APP.openProject(1);
  const b1 = B.document.querySelectorAll('input[data-wid]');
  check('短链：明细与预填同样生效', b1.length === 3 && b1.find(i => i.dataset.wid === '102').value === '30');
  check('短链：明细接口走 /api/e/<code>/projects/1', B.urls.includes('/api/e/Kf7mQ2x9/projects/1'), B.urls.slice(0, 4).join(' , '));
  check('短链：无 code 且无 k 时才报错', (() => { const C = makeApp({ search: '', pathname: '/expert.html' }); return /无法打开评估页|缺少访问令牌/.test(C.appHTML); })());

  console.log('\n结果：PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(2); });
