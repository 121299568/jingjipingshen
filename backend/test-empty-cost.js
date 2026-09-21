// 「费用列整列为空」告警回归：当某成本表有人天但费用列全部为空时，解析器必须挂告警；
// 费用列有值时不告警。背景：2026-09-21 批量出现「有人天无费用」，根因是新版 Excel
// 的费用列整列没填，解析器如实反映后成本记为 0，事后才发现。加此告警让上传时就能看到。
const fs = require('fs'), path = require('path');
const XLSX = require('xlsx');
const { parseProjectExcel } = require(path.join(__dirname, 'parse-excel.js'));

let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  -> ' + extra));
  if (!ok) fail++;
};

function build(file, opts) {
  const wb = XLSX.utils.book_new();
  const basic = [['项目名称', '空费用列测试'], ['合同金额（元）', 1000000]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(basic), '项目基本信息');
  // 两种布局：外包 6 列 / 分包 8 列（前多「分包项目」+合并的工作说明占两列）
  const sub = opts.subcontract;
  const header = sub
    ? ['序号', '分包项目', '工作任务', '工作项', '工作说明', '', '人天', '费用（元）']
    : ['序号', '工作任务', '工作项', '工作说明', '人天', '费用（元）'];
  const rows = [[sub ? '专业分包成本估算' : '人员外包成本估算'], header];
  const n = opts.fillCost === false ? 3 : 2;
  for (let i = 1; i <= n; i++) {
    const days = i * 10;
    const cost = opts.fillCost === false ? '' : days * 1000;
    rows.push(sub ? [i, '装修', '施工', '工作项' + i, '', '', days, cost] : [i, '任务', '工作项' + i, '说明' + i, days, cost]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sub ? '专业分包成本估算' : '人员外包成本估算');
  XLSX.writeFile(wb, file);
}

const dir = path.join(__dirname);
const f1 = path.join(dir, 'tmp-empty-cost-1.xlsx');
const f2 = path.join(dir, 'tmp-empty-cost-2.xlsx');
const f3 = path.join(dir, 'tmp-empty-cost-3.xlsx');

// 1) 外包费用列全空 → 告警
build(f1, { subcontract: false, fillCost: false });
let r = parseProjectExcel(f1);
check('外包费用列全空时产生告警', r.warnings.some(w => /人员外包/.test(w) && /全部为空/.test(w)), JSON.stringify(r.warnings));
check('外包费用列全空时仍抽出人天', r.work_items.filter(w => w.category === 'outsourcing' && w.person_days > 0).length === 3, JSON.stringify(r.work_items.map(w => w.person_days)));
check('告警文案含行数「3 行」', r.warnings.some(w => /3 行有人天/.test(w)), JSON.stringify(r.warnings));

// 2) 外包费用列有值 → 不告警
build(f2, { subcontract: false, fillCost: true });
r = parseProjectExcel(f2);
check('外包费用列有值时不告警', !r.warnings.some(w => /人员外包/.test(w)), JSON.stringify(r.warnings));
check('外包费用列有值时成本正确', r.work_items.filter(w => w.category === 'outsourcing').reduce((a, w) => a + w.cost, 0) === 30000, JSON.stringify(r.work_items.map(w => w.cost)));

// 3) 分包费用列全空 → 告警（覆盖分包布局）
build(f3, { subcontract: true, fillCost: false });
r = parseProjectExcel(f3);
check('分包费用列全空时产生告警', r.warnings.some(w => /专业分包/.test(w) && /全部为空/.test(w)), JSON.stringify(r.warnings));
check('分包费用列全空时人天列仍正确', r.work_items.filter(w => w.category === 'subcontract' && w.person_days === 10).length === 1, JSON.stringify(r.work_items.map(w => w.person_days)));

// 4) 无人天的空表不告警（避免空 sheet 误报）
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['项目名称', 'x']]), '项目基本信息');
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['人员外包成本估算'], ['序号', '工作任务', '工作项', '工作说明', '人天', '费用（元）']]), '人员外包成本估算');
const f4 = path.join(dir, 'tmp-empty-cost-4.xlsx');
XLSX.writeFile(wb, f4);
r = parseProjectExcel(f4);
check('无人天数据时不告警', !r.warnings.some(w => /人员外包/.test(w)), JSON.stringify(r.warnings));

[f1, f2, f3, f4].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
console.log(fail === 0 ? '\n全部通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
