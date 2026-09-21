// test-alert-render.js — 回归：导入校验告警在「项目资料页」「评估汇总页」的渲染形态
// 约定（2026-09-21 起）：告警不再用 ⚠ 角标，统一并入行级「⚠ 需关注：<原因>」悬浮提示 + 行标红
//   · 项目资料页 renderProjects()            -> 行 <tr class="dt-flag"> + 序号 td 的 data-tip
//   · 评估汇总页 renderWorkloadProjectTable() -> 行 <tr class="wl-flag"> + 序号 td 的 data-tip
// 桩 DOM + 抽真实渲染函数，喂桩数据（不调接口、不需 token）。只读前端文件。
const fs = require('fs');
const path = require('path');

function pick(c) { for (const x of c) { try { if (fs.existsSync(x) && /renderWorkloadProjectTable/.test(fs.readFileSync(x, 'utf8'))) return x; } catch (_) {} } throw new Error('找不到前端页面，试过：' + c.join(' , ')); }
const APP = pick([__dirname + '/frontend/index.html', __dirname + '/../frontend/index.html', '/opt/jingjipingshen/frontend/index.html']);
const html = fs.readFileSync(APP, 'utf8');

function slice(src, start, end) { const s = src.indexOf(start); const e = src.indexOf(end, s + 1); if (s < 0 || e < 0) throw new Error('anchor fail: ' + start); return src.slice(s, e); }
const escSrc = (html.match(/function esc\(s\)\s*\{[\s\S]*?\n\}/) || [])[0];
if (!escSrc) throw new Error('esc 提取失败');
const rpSrc = slice(html, 'function renderProjects(){', 'function renderBizConfirmSummary(){');
const rwSrc = slice(html, 'function renderWorkloadProjectTable(d){', 'function toggleWlCompact(){');

function makeDoc() {
  const store = {};
  return { getElementById(id) { if (!store[id]) store[id] = { innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, getAttribute() { return null; }, querySelectorAll() { return []; } }; return store[id]; } };
}
function runRenderProjects(projects, sessions, files) {
  const document = makeDoc();
  const fn = new Function('document', 'sessions', 'projects', 'files', 'openBatches', 'batchLabel', 'sessionStatusBadge', 'statusBadgeClass', 'projectStatusLabel', 'fmtTime', 'canDeleteProject', 'renderBizConfirmSummary',
    escSrc + '\n' + rpSrc + '\nrenderProjects();\nreturn document.getElementById("batchDrawerList").innerHTML;');
  return fn(document, sessions, projects, files, new Set(), n => '第' + n + '批', () => '<span></span>', () => 'bg-secondary', s => s, t => String(t || ''), () => false, () => {});
}
function runRenderWorkload(data) {
  const document = makeDoc();
  const fn = new Function('document', 'wlCompactMode', 'wlFilterTable', 'DATA',
    escSrc + '\n' + rwSrc + '\nrenderWorkloadProjectTable(DATA);\nreturn document.getElementById("wlProjects").innerHTML;');
  return fn(document, false, () => {}, data);
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };

const MSG = '人员外包+专业分包占合同额 84.95%（¥5,541,250 / 合同额¥6,523,100），超过 60% 阈值，外包/分包依赖过高，请复核';
const withWarn = { id: 901, project_id: 901, project_name: '告警项目', session_id: 1, status: 'draft', biz_department: '系统集成事业部', contract_amount: 6523100, import_warnings: [{ file: '系统补算', time: '2026-09-21T00:00:00Z', messages: [MSG] }] };
const noWarn = { id: 902, project_id: 902, project_name: '正常项目', session_id: 1, status: 'draft', biz_department: '系统集成事业部', contract_amount: 1000000, import_warnings: [] };
const sessions = [{ id: 1, name: '第十五批经济评审', status: 'in_progress' }];

console.log('APP =', APP);

// ---- 项目资料页 ----
const rp = runRenderProjects([withWarn, noWarn], sessions, []);
ok(!/undefined/.test(rp), '项目资料页：渲染串无 undefined');
ok(rp.includes('⚠ 需关注：'), '项目资料页：出现「⚠ 需关注：」提示');
ok(rp.includes('人员外包+专业分包占合同额'), '项目资料页：提示含告警文案');
ok(/<tr class="dt-flag">/.test(rp), '项目资料页：告警行带 dt-flag 红标');
ok(!/bi-exclamation-triangle-fill/.test(rp), '项目资料页：已不再渲染 ⚠ 角标');
// 正常项目不应被标红：dt-flag 出现次数应为 1
ok((rp.match(/class="dt-flag"/g) || []).length === 1, '项目资料页：仅告警行标红（1 行）');

// ---- 评估汇总页 ----
const data = { session_id: 1, session_name: '第十五批经济评审', projects: [withWarn, noWarn] };
const rw = runRenderWorkload(data);
ok(!/undefined/.test(rw), '评估汇总页：渲染串无 undefined');
ok(rw.includes('⚠ 需关注：'), '评估汇总页：出现「⚠ 需关注：」提示');
ok(rw.includes('人员外包+专业分包占合同额'), '评估汇总页：提示含告警文案');
ok(/class="wl-flag" data-anom="1"/.test(rw), '评估汇总页：告警行带 wl-flag 红标');
ok(!/bi-exclamation-triangle-fill/.test(rw), '评估汇总页：已不再渲染 ⚠ 角标');
ok((rw.match(/class="wl-flag"/g) || []).length === 1, '评估汇总页：仅告警行标红（1 行）');

console.log('\nRESULT: ' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 2 : 0);
