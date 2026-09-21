// 合计行识别回归：有「合计/小计」字样、或无字样但人天/费用是 SUM 公式的行，
// 必须被跳过不进 work_items；真实明细行（含名字带「汇总」二字的工作项）必须保留。
// 背景：项目70 的专业分包表有 4 行「小计」被当工作项入库，虚增成本 339.8 万。
// ★ sheet 布局贴合真实模板：r0 大标题、r1 表头、r2+ 数据（detectHeaderRow 从 r=1 起找表头）
const fs = require('fs'), path = require('path');
const XLSX = require('xlsx');
const { parseProjectExcel } = require(path.join(__dirname, 'parse-excel.js'));

let fail = 0;
const check = (name, ok, extra) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  -> ' + extra));
  if (!ok) fail++;
};

function buildTestXlsx(file) {
  const wb = XLSX.utils.book_new();
  const basic = [
    ['项目名称', '合计行测试项目'], ['项目编号', 'T-001'],
    ['合同金额（元）', 1000000], ['项目总成本（元）', 300000]
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(basic), '项目基本信息');

  // 人员外包：覆盖「合计字样」「小计字样」「无字样但SUM」「字样在B列」「名字含汇总的明细」
  // r0 标题 / r1 表头（0序号 1工作任务 2工作项 3工作说明 4人天 5费用）
  const rows = [
    ['人员外包成本估算', '', '', '', '', ''],
    ['序号', '工作任务', '工作项', '工作说明', '人天', '费用（元）'],
    [1, '软件开发', '功能A', '说明A', 10, 10000],
    [2, '软件开发', '功能B', '说明B', 20, 20000],
    // 小计行：A列「小计」+ SUM 公式 → 必须跳过
    ['小计', '', '', '', { t: 'n', f: 'SUM(E3:E4)', v: 30 }, { t: 'n', f: 'SUM(F3:F4)', v: 30000 }],
    [3, '软件开发', '成果汇总与验收', '名字带汇总的明细', 5, 5000],   // 必须保留
    // 合计行：A列「合计」+ SUM 公式 → 必须跳过
    ['合计', '', '', '', { t: 'n', f: 'SUM(E3:E6)', v: 35 }, { t: 'n', f: 'SUM(F3:F6)', v: 35000 }],
    [4, '数据分析', '数据汇总', '又一个含汇总的明细', 8, 8000],      // 必须保留
    // 无字样但人天是 SUM 公式 → 必须跳过
    ['', '', '隐藏的合计', '', { t: 'n', f: 'SUM(E3:E7)', v: 43 }, 9000],
    // 合计字样在 B 列（工作任务列）+ SUM → 必须跳过
    ['', '合计', '被误收的项', '', { t: 'n', f: 'SUM(E3:E8)', v: 43 }, 3000],
    ['说明：本表为示例', '', '', '', '', '']
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '人员外包成本估算');

  // 专业分包：小计字样在 A 列，合计值可能在非常规列（模拟项目70：ROUND(SUM()) 在 I 列）
  // r0 标题 / r1 表头（0序号 1分包项目 2工作任务 3工作项 4-5工作说明 6人天 7费用 8含税）
  const sub = [
    ['专业分包成本估算', '', '', '', '', '', '', '', ''],
    ['序号', '分包项目', '工作任务', '工作项', '工作说明', '', '人天', '费用（元）', '含税'],
    [1, '装修', '施工', '灯具安装', '', '', 10, 20000, 22600],
    [2, '装修', '施工', '地板铺设', '', '', 5, 10000, 11300],
    ['小计', '', '', '', '', '', { t: 'n', f: 'SUM(G3:G4)', v: 15 }, { t: 'n', f: 'SUM(H3:H4)', v: 30000 }, { t: 'n', f: 'ROUND(SUM(I3:I4),0)', v: 33900 }],
    ['合计', '', '', '', '', '', '', '', { t: 'n', f: 'SUM(I5)', v: 33900 }]
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sub), '专业分包成本估算');

  // 工作量类 sheet（合计字样在 B 列 + SUM，项目70「开发工作量」r31 形态）
  // ★ 标题故意不含「工作量估算」字样，否则 hr 会定位到标题行导致整表被跳过（那是另一个问题）
  const dev = [
    ['开发成本估算', '', '', '', '', '', '', ''],
    ['编号', '一级菜单', '模块', '最小功能名称', '功能点个数', '工作量估算（人天）', '是否外包', '是否核心业务'],
    [1, '菜单1', '模块1', '功能1', 2, 10, '', ''],
    [2, '菜单2', '模块2', '功能2', 3, 15, '', ''],
    ['', '人员外包工作量', '', '', '', 25, '', ''],
    ['', '合计', '', '', '', { t: 'n', f: 'SUM(F4:F5)', v: 25 }, '', '']
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dev), '开发工作量成本估算');

  XLSX.writeFile(wb, file);
}

(async () => {
  const f = path.join(__dirname, 'tmp-total-row.xlsx');
  buildTestXlsx(f);
  const r = parseProjectExcel(f);
  fs.unlinkSync(f);
  const wi = r.work_items || [];
  const items = wi.map(w => String(w.work_item || ''));
  console.log('解析出工作项', wi.length, '条：');
  wi.forEach(w => console.log('   ' + [w.category, w.work_task, w.work_item, w.person_days, w.cost].join(' | ')));

  // 必须保留的明细
  const get = name => wi.find(w => w.work_item === name);
  check('保留明细「功能A」(10人天/10000)', !!get('功能A') && get('功能A').person_days === 10, JSON.stringify(get('功能A') || {}));
  check('保留明细「功能B」(20/20000)', !!get('功能B') && get('功能B').cost === 20000, '');
  check('保留明细「成果汇总与验收」(名字带汇总但非整词)', items.includes('成果汇总与验收'), JSON.stringify(items));
  check('保留明细「数据汇总」', items.includes('数据汇总'), JSON.stringify(items));
  check('保留分包明细「灯具安装」', items.includes('灯具安装'), JSON.stringify(items));
  check('保留工作量明细「功能1」(最小功能名称列)', items.includes('功能1'), JSON.stringify(items));

  // 必须跳过的合计行
  check('跳过「小计」行(A列字样+SUM)', !items.includes('小计'), JSON.stringify(items.filter(x => /小计/.test(x))));
  check('跳过「合计」行(A列字样+SUM)', !items.includes('合计'), JSON.stringify(items.filter(x => /合计/.test(x))));
  check('跳过「隐藏的合计」(无字样但人天是SUM)', !items.includes('隐藏的合计'), JSON.stringify(items.filter(x => /隐藏/.test(x))));
  check('跳过「合计字样在B列」的行', !items.includes('被误收的项'), JSON.stringify(items));
  check('工作量 sheet 的「合计」行被跳过', !wi.some(w => w.source_sheet === '开发工作量成本估算' && (w.work_task === '合计' || w.work_item === '合计')),
    JSON.stringify(wi.filter(w => w.source_sheet === '开发工作量成本估算')));

  // 成本不因合计行虚增
  const outCost = wi.filter(w => w.category === 'outsourcing').reduce((a, w) => a + (w.cost || 0), 0);
  check('外包成本不含合计行 = 43000', outCost === 43000, 'actual=' + outCost);
  const outDays = wi.filter(w => w.category === 'outsourcing').reduce((a, w) => a + (w.person_days || 0), 0);
  check('外包人天不含合计行 = 43', outDays === 43, 'actual=' + outDays);
  const subCost = wi.filter(w => w.category === 'subcontract').reduce((a, w) => a + (w.cost || 0), 0);
  check('分包成本不含合计行 = 30000', subCost === 30000, 'actual=' + subCost);
  const devDays = wi.filter(w => /工作量/.test(String(w.source_sheet || ''))).reduce((a, w) => a + (w.person_days || 0), 0);
  check('工作量人天不含合计行 = 25', devDays === 25, 'actual=' + devDays);

  console.log('\n结果：PASS=' + (16 - fail) + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(2); });
