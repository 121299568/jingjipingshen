// 对账：Excel 原始单元格 vs 系统落库值（第十四批）
// 重点回答两个现象：①表里非空、进系统为空；②表里为空、进系统非空
const mysql = require('mysql2/promise');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const cfg = {};
env.split(/\r?\n/).forEach(l => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) cfg[m[1]] = m[2]; });
const UP = path.join(__dirname, 'uploads');
const SID = parseInt(process.argv[2] || '8', 10);

const SJ = v => { if (v == null) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) || {}; } catch (_) { return {}; } };
const n2 = v => Math.round((Number(v) || 0) * 100) / 100;

(async () => {
  const c = await mysql.createConnection({ host: cfg.DB_HOST, port: +cfg.DB_PORT, user: cfg.DB_USER, password: cfg.DB_PASSWORD, database: cfg.DB_NAME, charset: 'utf8mb4' });
  const [ps] = await c.query('select id,project_name,extra from projects where session_id=? order by id', [SID]);
  const [ws] = await c.query('select id,project_id,category,work_task,work_item,cost,person_days,extra from workItems');
  const byP = new Map();
  ws.forEach(w => { const e = SJ(w.extra); w._src = e.source_sheet; w._row = e.row; if (!byP.has(w.project_id)) byP.set(w.project_id, []); byP.get(w.project_id).push(w); });

  let totItem = 0, dayDiff = 0, costDiff = 0, missing = 0, extraRow = 0, noCol = 0;
  const samples = [];
  for (const p of ps) {
    const items = byP.get(p.id) || [];
    if (!items.length) continue;
    // 找到该项目的估算表文件
    const [fl] = await c.query('select filename,originalname from files where project_id=? and file_category=? order by id desc limit 1', [p.id, 'estimation']);
    if (!fl.length) continue;
    const fp = path.join(UP, fl[0].filename);
    if (!fs.existsSync(fp)) continue;
    let wb; try { wb = XLSX.readFile(fp); } catch (_) { continue; }
    const aoa = {}; const colmap = {};
    wb.SheetNames.forEach(sn => {
      const a = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: null, raw: true });
      // sheet 名可能带尾随空格（如「专业分包成本估算 」），解析器存的是 trim 后的名字，
      // 对账时两个 key 都登记，否则会误报「定位不到源行」
      aoa[sn] = a; aoa[String(sn).trim()] = a;
      // ★ 各 sheet 列布局不同（人员外包费用在 5，长期/中实/华兆在 6，专业分包在 7），
      // 必须按表头动态定位，不能写死列号，否则对账结论全是假的。
      const head = (a[1] || []).map(v => String(v == null ? '' : v));
      const dayCol = head.findIndex(h => /人天/.test(h));
      const costCol = head.findIndex(h => /费用/.test(h) && !/占比/.test(h));
      colmap[sn] = { day: dayCol, cost: costCol };
      colmap[String(sn).trim()] = colmap[sn];
      if (dayCol < 0 || costCol < 0) console.log('  ⚠ 表头定位失败 [' + sn + '] ' + head.join('|').slice(0, 90));
    });
    for (const w of items) {
      totItem++;
      const rows = aoa[w._src];
      if (!rows || w._row == null) { missing++; if (missing <= 3) console.log('  定位不到源行示例: 项目#' + p.id + ' sheet=' + w._src + ' row=' + w._row); continue; }
      const cm = colmap[w._src] || {};
      if (cm.day < 0 || cm.cost < 0) { noCol++; continue; }
      const r = rows[w._row - 1]; // row 为 1-based
      if (!r) { missing++; continue; }
      const xlDay = r[cm.day], xlCost = r[cm.cost];
      const dbDay = w.person_days, dbCost = w.cost;
      const xlDayEmpty = xlDay == null || xlDay === '';
      const xlCostEmpty = xlCost == null || xlCost === '';
      // 注意：0 是有效值，只有 null/undefined 才算「空」，否则 0 人天会被误报成「表有值→库空」
      const dbDayEmpty = dbDay == null;
      const dbCostEmpty = dbCost == null;
      // ①表里非空→系统空
      if (!xlDayEmpty && dbDayEmpty) { dayDiff++; if (samples.length < 12) samples.push(['人天 表有值→库空', p.id, w._src, w._row, xlDay, dbDay]); }
      if (!xlCostEmpty && dbCostEmpty) { costDiff++; if (samples.length < 12) samples.push(['费用 表有值→库空', p.id, w._src, w._row, xlCost, dbCost]); }
      // ②表里空→系统非空
      if (xlDayEmpty && !dbDayEmpty) { extraRow++; if (samples.length < 12) samples.push(['人天 表空→库有值', p.id, w._src, w._row, xlDay, dbDay]); }
      if (xlCostEmpty && !dbCostEmpty) { extraRow++; if (samples.length < 12) samples.push(['费用 表空→库有值', p.id, w._src, w._row, xlCost, dbCost]); }
      // 数值不一致
      if (!xlDayEmpty && !dbDayEmpty && Math.abs(n2(xlDay) - n2(dbDay)) > 0.01) { dayDiff++; if (samples.length < 12) samples.push(['人天 数值不符', p.id, w._src, w._row, xlDay, dbDay]); }
      if (!xlCostEmpty && !dbCostEmpty && Math.abs(n2(xlCost) - n2(dbCost)) > 0.01) { costDiff++; if (samples.length < 12) samples.push(['费用 数值不符', p.id, w._src, w._row, xlCost, dbCost]); }
    }
  }
  console.log('=== Excel 原值 vs 系统落库（第十四批）===');
  console.log('工作项总条数：' + totItem);
  console.log('人天 缺失/不符：' + dayDiff);
  console.log('费用 缺失/不符：' + costDiff);
  console.log('表空→库有值（多出）：' + extraRow);
  console.log('表头找不到人天/费用列：' + noCol);
  console.log('定位不到源行：' + missing);
  if (samples.length) {
    console.log('\n样例：');
    samples.forEach(s => console.log('  [' + s[0] + '] 项目#' + s[1] + ' ' + s[2] + ' r' + s[3] + '  Excel=' + JSON.stringify(s[4]) + '  DB=' + JSON.stringify(s[5])));
  }
  await c.end();
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });
