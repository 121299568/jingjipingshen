// API 测试
const BASE = 'http://localhost:3000/api';
async function j(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, data: await r.json() };
}
(async () => {
  const login = await j('POST', '/auth/login', { username: 'admin', password: 'x' });
  const t = login.data.token;
  const proj = await j('GET', '/projects', null, t);
  console.log('projects:', proj.status, 'count=', proj.data.length, 'first=', proj.data[0] && proj.data[0].project_name);
  const cost = await j('GET', '/projects/1/cost', null, t);
  console.log('cost:', cost.status, 'work=', cost.data.work_items.length, 'proc=', cost.data.procurement_items.length, 'catSum=', JSON.stringify(cost.data.category_cost));
  const p1 = await j('GET', '/projects/1', null, t);
  console.log('project1 detail keys:', Object.keys(p1.data).join(','));
  const stat = await j('GET', '/stats/summary', null, t);
  console.log('stats:', JSON.stringify(stat.data));
  const cs = await j('GET', '/stats/cost-structure', null, t);
  console.log('cost-structure:', JSON.stringify(cs.data));
  const ss = await j('GET', '/projects/1/score-summary', null, t);
  console.log('score-summary:', JSON.stringify(ss.data));
  // 上传Excel测试
  const fs = require('fs');
  const form = new FormData();
  const buf = fs.readFileSync('C:/Users/12129/Downloads/34-国网山东德州乐陵市供电公司物资供应中心分办公区信息机房及附属设施维修施工).xlsx');
  form.append('file', new Blob([buf]), '34-机房维修.xlsx');
  const r2 = await fetch(BASE + '/projects/import-excel', {
    method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: form
  });
  const imp = await r2.json();
  console.log('import:', r2.status, 'project_id=', imp.project && imp.project.id, 'stats=', JSON.stringify(imp.stats));
})().catch(e => { console.error('ERR', e); process.exit(1); });
