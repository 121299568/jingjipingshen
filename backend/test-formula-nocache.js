// ★ 根因回归：费用列是公式但没有缓存值（`<f>` 无 `<v>`）时，必须重算出费用。
// 场景：新版成本表把「费用（元）」写成 `=人天×单价`（F=E*G，单价在隐藏的 G 列），
// 但生成文件的工具不写缓存值。SheetJS 默认会把这类单元格**整格丢弃**，解析器于是
// 费用全空 → 落库 0（Excel 打开会自动重算，所以填表人看着有值）。
// 修法：readFile 带 sheetStubs，recalcFormulaCells 重算后清掉剩余空桩。
// 另覆盖：模板底部说明行不能被当工作项；「调整后费用」公式(含 AVERAGE)算不出时
// 不能变成 0 覆盖原成本。
const fs = require('fs'), path = require('path');
const XLSX = require('xlsx');
const { parseProjectExcel, recalcFormulaCells } = require(path.join(__dirname, 'parse-excel.js'));

let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  -> ' + extra));
  if (!ok) fail++;
};

// 构造：外包表（0序号 1工作任务 2工作项 3工作说明 4人天 5费用 6单价 …）
// 费用单元格写成「有公式、无类型、无缓存值」——即 xlsx 里的 <c><f>…</f></c>
function build(file) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['项目名称', '无缓存公式测试'], ['合同金额（元）', 1000000]
  ]), '项目基本信息');

  const rows = [
    ['人员外包成本估算表'],
    ['序号', '工作任务', '工作项', '工作说明', '工作量估算（人天）', '费用（元）', '单价'],
    [1, '软件开发', '功能A', '说明A', 10, null, 1000],
    [2, '软件开发', '功能B', '说明B', 20, null, 1000],
    [3, '软件开发', '功能C', '说明C', 5, null, 2000],
    ['合计', '', '', '', null, null, '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // 关键：不加 t、不加 v，只给公式 → 模拟「无缓存值」的真实文件
  ws['F3'] = { f: 'E3*G3' };
  ws['F4'] = { f: 'E4*G4' };
  ws['F5'] = { f: 'E5*G5' };
  ws['E6'] = { f: 'SUM(E3:E5)' };
  ws['F6'] = { f: 'SUM(F3:F5)' };
  XLSX.utils.book_append_sheet(wb, ws, '人员外包成本估算');

  // 职工表：含模板底部说明行（长句，被合并填进工作项列）
  const st = XLSX.utils.aoa_to_sheet([
    ['长期职工成本估算表'],
    ['编号', '工作任务', '工作项', '工作说明', '工作量估算（人天）', '人员', '费用（元）'],
    [1, '开发', '需求分析', '说明', 8, '张三', null],
    [2, '开发', '系统设计', '说明', 12, '李四', null],
    ['人员成本：核算长期职工工作量、成本，人员单价参照人资部价格；人员列一定要标注具体人名。']
  ]);
  st['G3'] = { f: 'E3*2000' };
  st['G4'] = { f: 'E4*2000' };
  XLSX.utils.book_append_sheet(wb, st, '长期职工成本估算');

  XLSX.writeFile(wb, file);
}

const f = path.join(__dirname, 'tmp-formula-nocache.xlsx');
build(f);

// 先确认构造出的文件确实是「无缓存值」形态（否则测试本身失效）
const wbRaw = XLSX.readFile(f, { cellFormula: true, raw: true });
check('构造的文件里费用格默认读取时确实不可见（复现前提）', !wbRaw.Sheets['人员外包成本估算'].F3, JSON.stringify(wbRaw.Sheets['人员外包成本估算'].F3));
const wbStub = XLSX.readFile(f, { cellFormula: true, raw: true, sheetStubs: true });
check('带 sheetStubs 时能看到公式', !!(wbStub.Sheets['人员外包成本估算'].F3 && wbStub.Sheets['人员外包成本估算'].F3.f), JSON.stringify(wbStub.Sheets['人员外包成本估算'].F3));

const r = parseProjectExcel(f);
const out = r.work_items.filter(w => w.category === 'outsourcing');
check('外包抽出 3 行', out.length === 3, JSON.stringify(out.map(w => w.work_item)));
check('无缓存值的费用被重算出来（10×1000）', out[0] && out[0].cost === 10000, JSON.stringify(out[0]));
check('无缓存值的费用被重算出来（20×1000）', out[1] && out[1].cost === 20000, JSON.stringify(out[1]));
check('单价不同也正确（5×2000）', out[2] && out[2].cost === 10000, JSON.stringify(out[2]));
check('外包费用合计 40000', out.reduce((a, w) => a + (w.cost || 0), 0) === 40000, String(out.reduce((a, w) => a + (w.cost || 0), 0)));
check('SUM 合计行不入库', !out.some(w => /合计/.test(String(w.work_item))), JSON.stringify(out.map(w => w.work_item)));

const st = r.work_items.filter(w => w.category === 'long_term');
check('职工表抽出 2 行（说明行被跳过）', st.length === 2, JSON.stringify(st.map(w => [w.work_item, w.cost])));
check('职工表费用重算（8×2000=16000）', st[0] && st[0].cost === 16000, JSON.stringify(st[0]));
check('职工表费用重算（12×2000=24000）', st[1] && st[1].cost === 24000, JSON.stringify(st[1]));
check('模板说明行未被当成工作项', !r.work_items.some(w => /人员单价参照/.test(String(w.work_item))), JSON.stringify(r.work_items.map(w => String(w.work_item).slice(0, 12))));

// 调整后费用公式含 AVERAGE（算不出）时，不能把 adjusted_cost 记成 0
const wb2 = XLSX.readFile(f, { cellFormula: true, raw: true, sheetStubs: true });
const wsO = wb2.Sheets['人员外包成本估算'];
wsO['H3'] = { f: 'AVERAGE(F3:F3)' };   // 无缓存值的不可算公式
const f2 = path.join(__dirname, 'tmp-formula-nocache2.xlsx');
XLSX.writeFile(wb2, f2);
const r2 = parseProjectExcel(f2);
const o2 = r2.work_items.filter(w => w.category === 'outsourcing');
check('算不出的公式格被清掉，不污染解析', o2.length === 3 && o2[0].cost === 10000, JSON.stringify(o2.map(w => w.cost)));
check('adjusted_cost 回落到原成本而不是 0', o2[0] && o2[0].adjusted_cost === 10000, JSON.stringify(o2[0]));

[f, f2].forEach(x => { try { fs.unlinkSync(x); } catch (_) {} });
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
