// 诊断：对比同一项目新旧两版成本估算表的「人天/费用」列原始单元格
// 用法: node diag-cost-col.js <文件1.xlsx> <文件2.xlsx> [sheet关键词]
const fs = require('fs');
const XLSX = require('xlsx');

const files = process.argv.slice(2, 4);
const kw = process.argv[4] || '人员外包';

function dump(path) {
  console.log('\n========== ' + path + ' ==========');
  const wb = XLSX.readFile(path, { cellFormula: true, cellNF: true, cellText: false });
  const name = wb.SheetNames.find(n => n.includes(kw));
  if (!name) { console.log('  未找到含「' + kw + '」的 sheet，全部 sheet:', wb.SheetNames.join(' | ')); return; }
  const ws = wb.Sheets[name];
  const ref = ws['!ref'];
  console.log('  sheet: 「' + name + '」 ref=' + ref + ' merges=' + (ws['!merges'] || []).length);
  const range = XLSX.utils.decode_range(ref);
  // 表头行：扫描前 5 行找含「工作项」的行
  let hr = -1;
  for (let r = 0; r <= Math.min(4, range.e.r); r++) {
    for (let c = 0; c <= range.e.c; c++) {
      const v = ws[XLSX.utils.encode_cell({ r, c })];
      if (v && typeof v.v === 'string' && v.v.includes('工作项')) { hr = r; break; }
    }
    if (hr >= 0) break;
  }
  if (hr < 0) { console.log('  找不到表头行'); return; }
  const head = [];
  for (let c = 0; c <= range.e.c; c++) {
    const v = ws[XLSX.utils.encode_cell({ r: hr, c })];
    head.push(v && v.v != null ? String(v.v) : '');
  }
  console.log('  表头(行' + (hr + 1) + '): ' + head.map((h, i) => h ? i + ':' + h : '').filter(Boolean).join(' | '));
  const cDays = head.findIndex(h => /人天|工作量估算/.test(h));
  const cCost = head.findIndex(h => /费用/.test(h) && !/调整|占比|核减|合计/.test(h));
  console.log('  定位: 人天列=' + cDays + ' 费用列=' + cCost);
  // 逐单元格统计费用列内容类型
  const stat = { numeric: 0, formula: 0, str: 0, empty: 0, other: 0 };
  const strSamples = new Set();
  let daysRows = 0, costRows = 0, daysNoCost = 0;
  const samples = [];
  for (let r = hr + 1; r <= range.e.r; r++) {
    const dv = ws[XLSX.utils.encode_cell({ r, c: cDays })];
    const cv = ws[XLSX.utils.encode_cell({ r, c: cCost })];
    const dnum = dv && dv.t === 'n' && typeof dv.v === 'number' ? dv.v : null;
    const cnum = cv && cv.t === 'n' && typeof cv.v === 'number' ? cv.v : null;
    if (dnum != null) daysRows++;
    if (cnum != null) costRows++;
    if (dnum != null && cnum == null) {
      daysNoCost++;
      if (samples.length < 6) {
        samples.push({
          row: r + 1, days: dnum,
          costCell: cv ? JSON.stringify({ t: cv.t, v: cv.v, f: cv.f, w: cv.w }) : 'NULL'
        });
      }
    }
    if (!cv) stat.empty++;
    else if (cv.f) stat.formula++;
    else if (cv.t === 'n') stat.numeric++;
    else if (cv.t === 's') { stat.str++; if (strSamples.size < 8) strSamples.add(JSON.stringify(cv.v)); }
    else stat.other++;
  }
  // 全列数值分布：看费用是否挪到了别的列（如调整后费用列）
  const colDist = {};
  for (let r = hr + 1; r <= range.e.r; r++) {
    for (let c = 0; c <= range.e.c; c++) {
      const v = ws[XLSX.utils.encode_cell({ r, c })];
      if (v && v.t === 'n' && typeof v.v === 'number') colDist[c] = (colDist[c] || 0) + 1;
    }
  }
  console.log('  全列数值单元格分布: ' + JSON.stringify(colDist));
  console.log('  人天列有数值行数: ' + daysRows + '，费用列有数值行数: ' + costRows + '，有人天无费用: ' + daysNoCost);
  console.log('  费用列内容类型统计: ' + JSON.stringify(stat));
  if (strSamples.size) console.log('  费用列字符串样本: ' + [...strSamples].join(' , '));
  if (samples.length) console.log('  「有人天无费用」行样本:'); 
  samples.forEach(s => console.log('    行' + s.row + ' 人天=' + s.days + ' 费用单元格=' + s.costCell));
}

files.forEach(f => { if (fs.existsSync(f)) dump(f); else console.log('文件不存在: ' + f); });
