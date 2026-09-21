// 回归：公式单元格「无缓存值/缓存为 0」时的兜底重算
// 背景：由程序生成的 xlsx 常常只有公式没有缓存值，Excel 打开能算出结果，
//       SheetJS 社区版没有公式引擎 → 解析出来是 0。recalcFormulaCells 负责补算。
const path = require('path');
let XLSX;
try { XLSX = require('xlsx'); }
catch (e) {
  // 本机工作区没有装 xlsx 依赖（该文件只在服务器 / 装了依赖的环境运行）
  console.log('SKIP 本机缺少 xlsx 依赖，测试需在服务器（或安装 xlsx 后）运行');
  process.exit(0);
}
const os = require('os');
const fs = require('fs');
let P;
try { P = require(path.join(__dirname, 'parse-excel.js')); }
catch (e) { P = require(path.join(__dirname, '..', 'parse-excel.js')); }

let pass = 0, fail = 0;
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

function buildWb(cells) {
  const ws = {};
  Object.keys(cells).forEach(a => { ws[a] = cells[a]; });
  ws['!ref'] = 'A1:C4';
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S1');
  return wb;
}

console.log('公式兜底求值 recalcFormulaCells');
// 1) 纯公式无缓存：A1=10 A2=20，A3=SUM(A1:A2) 无 v
let wb = buildWb({ A1: { t: 'n', v: 10 }, A2: { t: 'n', v: 20 }, A3: { t: 'n', f: 'SUM(A1:A2)' } });
let n = P.recalcFormulaCells(wb);
ck('SUM 无缓存值 → 补算为 30', wb.Sheets.S1.A3.v === 30, 'v=' + wb.Sheets.S1.A3.v);
ck('只改写必要的单元格（本次 1 个）', n === 1, 'fixed=' + n);

// 2) 缓存为 0 但公式算得出非零 → 修正
wb = buildWb({ A1: { t: 'n', v: 8 }, B1: { t: 'n', v: 5 }, C1: { t: 'n', f: 'A1*B1', v: 0 } });
P.recalcFormulaCells(wb);
ck('缓存 0 但公式 = 40 → 修正为 40', wb.Sheets.S1.C1.v === 40, 'v=' + wb.Sheets.S1.C1.v);

// 3) 缓存真为 0（公式结果就是 0）→ 不动
wb = buildWb({ A1: { t: 'n', v: 0 }, A2: { t: 'n', v: 0 }, A3: { t: 'n', f: 'SUM(A1:A2)', v: 0 } });
P.recalcFormulaCells(wb);
ck('公式结果本就是 0 → 保持 0', wb.Sheets.S1.A3.v === 0, 'v=' + wb.Sheets.S1.A3.v);

// 4) 四则混合
wb = buildWb({ A1: { t: 'n', v: 100 }, A2: { t: 'n', v: 20 }, A3: { t: 'n', f: '(A1-A2)/2*3' } });
P.recalcFormulaCells(wb);
ck('四则混合 (100-20)/2*3 = 120', wb.Sheets.S1.A3.v === 120, 'v=' + wb.Sheets.S1.A3.v);

// 5) 不支持的函数（IF/ROUND）→ 放弃，保持原样
wb = buildWb({ A1: { t: 'n', v: 3 }, A3: { t: 'n', f: 'ROUND(A1,0)' } });
P.recalcFormulaCells(wb);
ck('不支持的函数不瞎算（保持无值）', wb.Sheets.S1.A3.v === undefined, 'v=' + wb.Sheets.S1.A3.v);

// 6) 跨表引用
const ws1 = { A1: { t: 'n', v: 7 }, '!ref': 'A1:A1' };
const ws2 = { B1: { t: 'n', f: 'S1!A1*3' }, '!ref': 'B1:B1' };
const wb2 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb2, ws1, 'S1');
XLSX.utils.book_append_sheet(wb2, ws2, 'S2');
P.recalcFormulaCells(wb2);
ck('跨表引用 S1!A1*3 = 21', wb2.Sheets.S2.B1.v === 21, 'v=' + wb2.Sheets.S2.B1.v);

// 7) 端到端：写出真实 xlsx 再读回（程序生成的表常带 v=0 的初始缓存）
const tmp = path.join(os.tmpdir(), 'formula-test-' + Date.now() + '.xlsx');
const wsT = { A1: { t: 'n', v: 12 }, A2: { t: 'n', v: 13 }, A3: { t: 'n', f: 'SUM(A1:A2)', v: 0 }, '!ref': 'A1:A3' };
const wbT = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbT, wsT, 'S1');
XLSX.writeFile(wbT, tmp, { cellFormula: true });
const wbR = XLSX.readFile(tmp, { cellFormula: true });
const c3 = wbR.Sheets.S1.A3 || {};
const before = c3.v;
console.log('  （落盘读回后 A3: f=' + c3.f + ' v=' + before + '）');
P.recalcFormulaCells(wbR);
const after = (wbR.Sheets.S1.A3 || {}).v;
ck('落盘再读回：公式缓存为空/0 时补算为 25', (before == null || before === 0) ? after === 25 : true, 'before=' + before + ' after=' + after);
try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
