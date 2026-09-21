// 深挖：逐单元格 dump 某个 sheet 的原始对象（类型/值/公式/显示文本），并对整表做类型统计
const XLSX = require('xlsx');
const file = process.argv[2];
const kw = process.argv[3] || '人员外包';
const maxRows = parseInt(process.argv[4] || '8', 10);

const wb = XLSX.readFile(file, { cellFormula: true, cellStyles: true, sheetStubs: true, cellNF: false, cellText: false });
console.log('sheets: ' + wb.SheetNames.join(' | '));
const name = wb.SheetNames.find(n => n.includes(kw));
if (!name) { console.log('未找到 sheet'); process.exit(1); }
const ws = wb.Sheets[name];
const range = XLSX.utils.decode_range(ws['!ref']);
console.log('sheet「' + name + '」ref=' + ws['!ref'] + ' rows=' + (range.e.r + 1) + ' cols=' + (range.e.c + 1));

// 全表类型统计
const typeCount = {};
for (let r = 0; r <= range.e.r; r++) {
  for (let c = 0; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell) { typeCount['缺'] = (typeCount['缺'] || 0) + 1; continue; }
    let k = cell.t;
    if (cell.f) k = 'f(' + cell.t + ')';
    if (cell.t === 's') k = 's';
    typeCount[k] = (typeCount[k] || 0) + 1;
  }
}
console.log('全表单元格类型分布: ' + JSON.stringify(typeCount));

// 逐格 dump 前若干行
for (let r = 0; r <= Math.min(maxRows, range.e.r); r++) {
  const parts = [];
  for (let c = 0; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (!cell) continue;
    let s = XLSX.utils.encode_col(c) + ':t=' + cell.t;
    if (cell.f) s += ',f=' + String(cell.f).slice(0, 40);
    if (cell.v !== undefined) s += ',v=' + JSON.stringify(cell.v).slice(0, 60);
    if (cell.w !== undefined) s += ',w=' + JSON.stringify(cell.w).slice(0, 40);
    parts.push(s);
  }
  console.log('r' + r + ' | ' + parts.join('  ||  '));
}
// 检查共享公式
let shared = 0;
const raw = ws['!ref'] ? Object.keys(ws).filter(k => k[0] !== '!') : [];
for (const k of raw) { const cd = ws[k]; if (cd && cd.f && /SHARED/i.test(String(cd.F || ''))) shared++; }
console.log('含共享公式标记的单元格数: ' + shared);
