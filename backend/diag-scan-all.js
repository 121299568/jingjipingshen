// 批量扫描 uploads/ 下所有成本估算表：人员外包/专业分包 sheet 的「有人天无费用」情况
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const dir = process.argv[2] || 'uploads';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.xlsx')).sort();

console.log('扫描目录: ' + path.resolve(dir) + '，共 ' + files.length + ' 个 xlsx\n');
console.log(['文件', '外包', '分包', '长期', '中实', '华兆', '备注'].join('\t'));

for (const f of files) {
  const full = path.join(dir, f);
  const row = { name: f, out: '-', sub: '-', note: '' };
  try {
    const wb = XLSX.readFile(full, { cellFormula: true });
    for (const kw of ['人员外包', '专业分包', '长期职工', '中实职工', '华兆职工']) {
      const sname = wb.SheetNames.find(n => n.includes(kw));
      if (!sname) continue;
      const ws = wb.Sheets[sname];
      const range = XLSX.utils.decode_range(ws['!ref']);
      let hr = -1;
      for (let r = 0; r <= Math.min(4, range.e.r); r++) {
        for (let c = 0; c <= range.e.c; c++) {
          const v = ws[XLSX.utils.encode_cell({ r, c })];
          if (v && typeof v.v === 'string' && v.v.includes('工作项')) { hr = r; break; }
        }
        if (hr >= 0) break;
      }
      if (hr < 0) continue;
      const head = [];
      for (let c = 0; c <= range.e.c; c++) {
        const v = ws[XLSX.utils.encode_cell({ r: hr, c })];
        head.push(v && v.v != null ? String(v.v) : '');
      }
      const cDays = head.findIndex(h => /人天|工作量估算/.test(h));
      const cCost = head.findIndex(h => /费用/.test(h) && !/调整|占比|核减|合计/.test(h));
      if (cDays < 0) continue;
      let days = 0, cost = 0, noCost = 0, formula = 0;
      for (let r = hr + 1; r <= range.e.r; r++) {
        const dv = ws[XLSX.utils.encode_cell({ r, c: cDays })];
        const cv = cCost >= 0 ? ws[XLSX.utils.encode_cell({ r, c: cCost })] : null;
        const dn = dv && dv.t === 'n' && typeof dv.v === 'number' ? dv.v : null;
        const cn = cv && cv.t === 'n' && typeof cv.v === 'number' ? cv.v : null;
        if (dn != null) days++;
        if (cn != null) cost++;
        if (dn != null && cn == null) noCost++;
        if (cv && cv.f) formula++;
      }
      const key = kw === '人员外包' ? 'out' : kw === '专业分包' ? 'sub' : kw === '长期职工' ? 'lt' : kw === '中实职工' ? 'zs' : 'hz';
      row[key] = noCost + '/' + days;
      if (days > 0 && cost === 0) row.note = (row.note ? row.note + ';' : '') + kw + '费用列全空';
      if (formula > 0) row.note = (row.note ? row.note + ';' : '') + kw + '费用为公式(' + formula + ')';
    }
  } catch (e) {
    row.note = '读取失败: ' + e.message;
  }
  const vals = [row.name, row.out, row.sub, row.lt, row.zs, row.hz, row.note];
  if (row.note) console.log(vals.join('\t'));
}
