// verify-alert-parity.js —— 部署后自检：用【线上页面代码 + 真实接口数据】核对两页告警数一致
// 与 test-alert-render.js 的区别：数据不再用夹具，而是直连 127.0.0.1:3000 拿真实 /api/projects 与
// /api/sessions/:id/workload-summary，跑【真实渲染函数】后数标红行。必须在服务器上跑（或本机带 token）。
// 用法：node verify-alert-parity.js <token> <sessionId> [frontend/index.html 路径]
const fs = require('fs');
const http = require('http');

function get(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 3000, path, headers: { Authorization: 'Bearer ' + token } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(path + ' -> HTTP ' + res.statusCode)); } });
    });
    req.on('error', reject); req.end();
  });
}

const CAND = [process.argv[4], '/opt/jingjipingshen/frontend/index.html', __dirname + '/frontend/index.html', __dirname + '/../frontend/index.html'].filter(Boolean);
let APP = null;
for (const c of CAND) { try { if (fs.existsSync(c) && /projectAlerts/.test(fs.readFileSync(c, 'utf8'))) { APP = c; break; } } catch (_) {} }
if (!APP) { console.error('找不到含 projectAlerts 的页面文件，试过：' + CAND.join(' , ')); process.exit(1); }
const html = fs.readFileSync(APP, 'utf8');

function grabFn(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('函数缺失: ' + name);
  let d = 0;
  for (let i = src.indexOf('{', s); i < src.length; i++) {
    if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) return src.slice(s, i + 1); }
  }
  throw new Error('括号不配平: ' + name);
}
function slice(src, a, b) { const s = src.indexOf(a); const e = src.indexOf(b, s + 1); if (s < 0 || e < 0) throw new Error('anchor fail: ' + a); return src.slice(s, e); }

const SHARED = grabFn(html, 'esc') + '\n' + grabFn(html, 'projectAlerts') + '\n' + grabFn(html, 'alertRowAttrs');
const rpSrc = slice(html, 'function renderProjects(){', 'function renderBizConfirmSummary(){');
const rwSrc = slice(html, 'function renderWorkloadProjectTable(d){', 'function toggleWlCompact(){');

function makeDoc() {
  const store = {};
  return { getElementById(id) { if (!store[id]) store[id] = { innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, getAttribute() { return null; }, querySelectorAll() { return []; } }; return store[id]; } };
}
function renderProjectsHtml(projects, sessions) {
  const document = makeDoc();
  const fn = new Function('document', 'sessions', 'projects', 'files', 'openBatches', 'batchLabel', 'sessionStatusBadge', 'statusBadgeClass', 'projectStatusLabel', 'fmtTime', 'canDeleteProject', 'renderBizConfirmSummary',
    SHARED + '\n' + rpSrc + '\nrenderProjects();\nreturn document.getElementById("batchDrawerList").innerHTML;');
  return fn(document, sessions, projects, [], new Set(), n => '第' + n + '批', () => '<span></span>', () => 'bg-secondary', s => s, t => String(t || ''), () => false, () => {});
}
function renderWorkloadHtml(data) {
  const document = makeDoc();
  const fn = new Function('document', 'wlCompactMode', 'wlFilterTable', 'DATA',
    SHARED + '\n' + rwSrc + '\nrenderWorkloadProjectTable(DATA);\nreturn document.getElementById("wlProjects").innerHTML;');
  return fn(document, false, () => {}, data);
}

(async () => {
  const token = process.argv[2];
  const sid = Number(process.argv[3] || 7);
  const projects = await get('/api/projects', token);
  const sessions = await get('/api/sessions', token);
  const ws = await get('/api/sessions/' + sid + '/workload-summary', token);
  console.log('页面文件 =', APP);
  console.log('批次 = #' + sid + ' ' + (ws.session_name || '') + ' | /api/projects 全量 ' + projects.length + ' 个，本批次 ' + (ws.projects || []).length + ' 个');

  // 项目资料页：只渲染本项目所在一批的项目（与评估汇总页可比口径）
  const ids = new Set((ws.projects || []).map(p => Number(p.project_id)));
  const subset = projects.filter(p => ids.has(Number(p.id)));
  const rp = renderProjectsHtml(subset, (sessions || []).filter(s => Number(s.id) === sid));
  const rw = renderWorkloadHtml(ws);
  const rpFlags = (rp.match(/class="dt-flag"/g) || []).length;
  const rwFlags = (rw.match(/class="wl-flag"/g) || []).length;
  const rpTips = (rp.match(/data-tip="⚠ 需关注：/g) || []).length;
  const rwTips = (rw.match(/data-tip="⚠ 需关注：/g) || []).length;

  console.log('项目资料页：标红 ' + rpFlags + ' 行 / 提示 ' + rpTips + ' 条');
  console.log('评估汇总页：标红 ' + rwFlags + ' 行 / 提示 ' + rwTips + ' 条');

  const fail = [];
  if (rpFlags !== rwFlags) fail.push('两页告警项目数不一致：项目资料页 ' + rpFlags + ' vs 评估汇总页 ' + rwFlags);
  if (rpFlags !== rpTips) fail.push('项目资料页标红与提示不配对（' + rpFlags + ' vs ' + rpTips + '）');
  if (rwFlags !== rwTips) fail.push('评估汇总页标红与提示不配对（' + rwFlags + ' vs ' + rwTips + '）');
  if (/bi-exclamation-triangle-fill/.test(rp + rw)) fail.push('仍存在 ⚠ 角标渲染');

  // 逐项目比对告警文案（同源规则应逐条一致）
  const msgsOf = (out, cls) => {
    const rows = out.split(/<tr[^>]*class="(?:dt|wl)-flag"/).slice(1);
    return rows.map(r => (r.match(/data-tip="⚠ 需关注：([^"]*)"/) || [, ''])[1]).sort();
  };
  const a = JSON.stringify(msgsOf(rp, 'dt-flag')), b = JSON.stringify(msgsOf(rw, 'wl-flag'));
  if (a !== b) fail.push('两页告警文案集合不一致\n  项目资料页: ' + a + '\n  评估汇总页: ' + b);
  else if (rpFlags) console.log('两页告警文案逐条一致：\n  ' + msgsOf(rp, 'dt-flag').join('\n  '));

  if (fail.length) { fail.forEach(f => console.log('FAIL ' + f)); process.exit(2); }
  console.log('PASS 两页告警口径一致（' + rpFlags + ' 个项目需关注）');
})().catch(e => { console.error('FAIL ' + e.message); process.exit(1); });
