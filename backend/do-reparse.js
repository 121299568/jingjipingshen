// 部署后自检：对指定批次跑重新解析，并逐项对账「Excel 原始值 vs 系统落库值」
const SID = parseInt(process.argv[2] || '8', 10);
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const TOKEN = process.argv[3] || '';
(async () => {
  const hdr = { 'Content-Type': 'application/json' };
  if (TOKEN) hdr.Authorization = 'Bearer ' + TOKEN;
  const r = await fetch(BASE + '/api/sessions/' + SID + '/reparse', {
    method: 'POST', headers: hdr, body: '{}'
  });
  const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
  console.log('HTTP', r.status);
  if (d.error) { console.log('失败:', d.error); process.exit(1); }
  console.log('项目 ' + d.projects + ' 个 | 解析成功 ' + d.parsed + ' | 由 other 改判为 estimation ' + d.reclassified + ' | 解析不出内容 ' + d.failed);
  const bad = (d.report || []).filter(x => x.result === 'parse-empty' || x.result === 'no-excel');
  if (bad.length) {
    console.log('\n未解析出内容的项目：');
    bad.forEach(b => console.log('  #' + b.project_id + ' ' + (b.project_name || '').slice(0, 30) + '  [' + b.result + ']'));
  }
  const warn = (d.report || []).filter(x => (x.warnings || []).length);
  if (warn.length) {
    console.log('\n带校验告警的项目 ' + warn.length + ' 个（前 6）：');
    warn.slice(0, 6).forEach(w => {
      console.log('  #' + w.project_id + ' ' + (w.project_name || '').slice(0, 26));
      w.warnings.forEach(m => console.log('     - ' + m.slice(0, 110)));
    });
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
