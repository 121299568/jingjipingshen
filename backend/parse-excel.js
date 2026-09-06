/**
 * Excel 项目成本估算表解析器
 * 解析格式：项目成本估算汇总簿（12个工作表：项目基本信息 + 人员/分包成本 + 采购 + 差旅）
 * 特性：展开合并单元格、跳过表头/合计/说明行、公式取缓存值
 * 依赖：xlsx（SheetJS 社区版）
 */
const XLSX = require('xlsx');
const fs = require('fs');

// ---------- 工具函数 ----------
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const n = parseFloat(String(v).replace(/[,，¥元\s]/g, ''));
  return isNaN(n) ? null : n;
}
function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

// 展开合并单元格：把 merge 区域左上角的值填充到区域所有单元格
// 返回 { s, grid }，grid[r][c] 使用绝对行列号（0-based）
// fill=false 时返回原始网格（数值列用，避免合并单元格的值被重复计入多行）
function expandGrid(ws, fill) {
  const ref = ws['!ref'];
  if (!ref) return { s: { r: 0, c: 0 }, grid: [] };
  const range = XLSX.utils.decode_range(ref);
  const s = range.s, e = range.e;
  const grid = [];
  for (let r = s.r; r <= e.r; r++) {
    grid[r] = [];
    for (let c = s.c; c <= e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      grid[r][c] = cell ? cell.v : null;
    }
  }
  if (fill) {
    const merges = ws['!merges'] || [];
    for (const m of merges) {
      const top = ws[XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })];
      const val = top ? top.v : null;
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          if (grid[r] && grid[r][c] == null) grid[r][c] = val;
        }
      }
    }
  }
  return { s, grid };
}
// 安全取格
function gv(grid, r, c) {
  const row = grid[r];
  return (row && row[c] != null) ? row[c] : null;
}

// ---------- 主解析 ----------
function parseProjectExcel(filePath) {
  const wb = XLSX.readFile(filePath, { cellFormula: true, raw: true });
  const sheets = {};
  for (const name of wb.SheetNames) sheets[name.replace(/\s+/g, '')] = wb.Sheets[name];

  const result = {
    project: {},
    cost_summary: {},
    work_items: [],
    procurement_items: [],
    travel_items: [],
    warnings: []
  };

  // ===== 1. 项目基本信息 =====
  if (sheets['项目基本信息']) {
    const { grid } = expandGrid(sheets['项目基本信息'], true);
    // 左区 A(0)=标签 B(1)=值
    result.project.project_name = str(gv(grid, 1, 1));
    result.project.biz_department = str(gv(grid, 2, 1));
    result.project.project_type = str(gv(grid, 3, 1));
    result.project.business_direction = str(gv(grid, 4, 1));
    result.project.product_direction = str(gv(grid, 5, 1));
    // 右区 C(2)=标签 D(3)=值
    result.project.project_code = num(gv(grid, 2, 3));
    result.project.is_digital = str(gv(grid, 3, 3));
    result.project.business_sub_direction = str(gv(grid, 4, 3));
    result.project.contract_amount = num(gv(grid, 5, 3));
    // 成本行 index 6..15，左 A/B，右 C/D
    // r=6: 项目总成本（元） | 预估利润率
    // r=7..14: 各分项成本 | 费用占比/差旅费
    // r=15: 知识产权费
    const costKeys = {
      '项目总成本（元）': 'total_cost',
      '预估利润率': 'profit_rate',
      '长期职工成本（元）': 'long_term_cost',
      '中实职工成本（元）': 'zhongshi_cost',
      '华兆职工成本（元）': 'huazhao_cost',
      '人员外包成本（元）': 'outsourcing_cost',
      '专业分包成本（元）': 'subcontract_cost',
      '采购成本（元）': 'procurement_cost',
      '第三方测试费用（元）': 'third_party_test_cost',
      '差旅费用（元）': 'travel_cost',
      '知识产权费（元）': 'ip_cost'
    };
    for (let r = 6; r <= 15; r++) {
      const kL = str(gv(grid, r, 0));
      if (costKeys[kL]) { const v = num(gv(grid, r, 1)); if (v !== null) result.cost_summary[costKeys[kL]] = v; }
      const kR = str(gv(grid, r, 2));
      if (costKeys[kR]) { const v = num(gv(grid, r, 3)); if (v !== null) result.cost_summary[costKeys[kR]] = v; }
    }
  } else {
    result.warnings.push('未找到"项目基本信息"工作表');
  }

  // ===== 2. 人员成本明细（长期/中实/华兆/人员外包）=====
  // 文本列(工作任务B/工作项C)可能合并→用填充网格；数值列(人天E/费用F或G)合并会导致重复计数→用原始网格
  const staffSheets = [
    { key: '长期职工成本估算', category: 'long_term' },
    { key: '中实职工成本估算', category: 'zhongshi' },
    { key: '华兆职工成本估算', category: 'huazhao' },
    { key: '人员外包成本估算', category: 'outsourcing' }
  ];
  for (const { key, category } of staffSheets) {
    if (!sheets[key]) continue;
    const ws = sheets[key];
    const fill = expandGrid(ws, true).grid;   // 文本用
    const raw = expandGrid(ws, false).grid;   // 数值用
    const ec = XLSX.utils.decode_range(ws['!ref']).e.c;
    const hasPersonCol = ec >= 6;
    const costCol = hasPersonCol ? 6 : 5;
    const lastRow = XLSX.utils.decode_range(ws['!ref']).e.r;
    let task = '';
    for (let r = 2; r <= lastRow; r++) {
      const aVal = str(gv(fill, r, 0));
      if (aVal.includes('合计') || aVal.includes('说明')) continue;
      const bVal = str(gv(fill, r, 1));        // 工作任务(填充)
      const item = str(gv(fill, r, 2));        // 工作项(填充)
      const days = num(gv(raw, r, 4));         // 人天(原始)
      const cost = num(gv(raw, r, costCol));   // 费用(原始)
      const person = hasPersonCol ? str(gv(raw, r, 5)) : '';
      if (!item || item === '工作项') continue; // 需有工作项名，过滤表头/空行
      if (days === null && cost === null && !person) continue; // 过滤说明文字行
      if (bVal && bVal !== '工作任务') task = bVal;
      result.work_items.push({
        category,
        work_task: task,
        work_item: item,
        description: str(gv(raw, r, 3)),
        person_days: days,
        person,
        cost,
        source_sheet: key,
        row: r + 1
      });
    }
  }

  // ===== 3. 专业分包（含 5 位专家工作量）=====
  if (sheets['专业分包成本估算']) {
    const ws = sheets['专业分包成本估算'];
    const fill = expandGrid(ws, true).grid;
    const raw = expandGrid(ws, false).grid;
    const lastRow = XLSX.utils.decode_range(ws['!ref']).e.r;
    let task = '';
    for (let r = 2; r <= lastRow; r++) {
      const aVal = str(gv(fill, r, 0));
      if (aVal.includes('合计')) continue;
      const bVal = str(gv(fill, r, 1));
      if (bVal && bVal !== '工作任务') task = bVal;
      const item = str(gv(fill, r, 2));
      if (!item || item === '工作项') continue;
      const days = num(gv(raw, r, 4));
      const cost = num(gv(raw, r, 5));
      const expertDays = [6, 7, 8, 9, 10].map(ci => num(gv(raw, r, ci)));
      const avg = num(gv(raw, r, 11));
      const adjusted = num(gv(raw, r, 12));
      result.work_items.push({
        category: 'subcontract',
        work_task: task,
        work_item: item,
        description: str(gv(raw, r, 3)),
        person_days: days,
        cost,
        expert_days: expertDays,
        expert_days_avg: avg,
        adjusted_cost: adjusted !== null ? adjusted : cost,
        source_sheet: '专业分包成本估算',
        row: r + 1
      });
    }
  }

  // ===== 4. 采购成本（软件区 + 硬件区）=====
  if (sheets['采购成本估算']) {
    const ws = sheets['采购成本估算'];
    const fill = expandGrid(ws, true).grid;
    const raw = expandGrid(ws, false).grid;
    const lastRow = XLSX.utils.decode_range(ws['!ref']).e.r;
    let swStart = -1, hwStart = -1;
    for (let r = 0; r <= Math.min(lastRow, 14); r++) {
      const aVal = str(gv(fill, r, 0));
      if (aVal.includes('软件')) swStart = r;
      if (aVal.includes('硬件')) hwStart = r;
    }
    const scanBlock = (startLabelIdx, endIdx, type) => {
      for (let r = startLabelIdx + 2; r <= endIdx; r++) {
        const aVal = str(gv(fill, r, 0));
        if (aVal.includes('合')) break;
        const name = str(gv(fill, r, 1));
        if (!name) continue;
        result.procurement_items.push({
          type,
          name,
          spec: str(gv(raw, r, 2)),
          unit: str(gv(raw, r, 3)),
          quantity: num(gv(raw, r, 4)),
          unit_price: num(gv(raw, r, 5)),
          subtotal: num(gv(raw, r, 6)),
          remark: str(gv(raw, r, 7)),
          source_sheet: '采购成本估算',
          row: r + 1
        });
      }
    };
    if (swStart > 0) scanBlock(swStart, hwStart > 0 ? hwStart - 1 : lastRow, 'software');
    if (hwStart > 0) scanBlock(hwStart, lastRow, 'hardware');
  }

  // ===== 5. 差旅费 =====
  if (sheets['差旅费估算']) {
    const ws = sheets['差旅费估算'];
    const fill = expandGrid(ws, true).grid;
    const raw = expandGrid(ws, false).grid;
    const lastRow = XLSX.utils.decode_range(ws['!ref']).e.r;
    for (let r = 2; r <= lastRow; r++) {
      const aVal = str(gv(fill, r, 0));
      if (aVal.includes('小计') || aVal.includes('合计')) break;
      const purpose = str(gv(fill, r, 1));
      if (!purpose) continue;
      result.travel_items.push({
        purpose,
        destination: str(gv(raw, r, 2)),
        days: num(gv(raw, r, 3)),
        hotel: num(gv(raw, r, 4)),
        per_diem: num(gv(raw, r, 5)),
        transport: num(gv(raw, r, 6)),
        source_sheet: '差旅费估算',
        row: r + 1
      });
    }
  }

  // ===== 6. 成本汇总兜底（明细求和，仅当基本信息表未提供）=====
  const sum = (items, f) => items.reduce((a, b) => a + (f(b) || 0), 0);
  if (result.cost_summary.long_term_cost == null) result.cost_summary.long_term_cost = sum(result.work_items.filter(w => w.category === 'long_term'), w => w.cost);
  if (result.cost_summary.zhongshi_cost == null) result.cost_summary.zhongshi_cost = sum(result.work_items.filter(w => w.category === 'zhongshi'), w => w.cost);
  if (result.cost_summary.huazhao_cost == null) result.cost_summary.huazhao_cost = sum(result.work_items.filter(w => w.category === 'huazhao'), w => w.cost);
  if (result.cost_summary.outsourcing_cost == null) result.cost_summary.outsourcing_cost = sum(result.work_items.filter(w => w.category === 'outsourcing'), w => w.cost);
  if (result.cost_summary.subcontract_cost == null) result.cost_summary.subcontract_cost = sum(result.work_items.filter(w => w.category === 'subcontract'), w => w.cost);
  if (result.cost_summary.procurement_cost == null) result.cost_summary.procurement_cost = sum(result.procurement_items, w => w.subtotal);
  if (result.cost_summary.travel_cost == null) result.cost_summary.travel_cost = sum(result.travel_items, w => (w.hotel || 0) + (w.per_diem || 0) + (w.transport || 0));

  // total_cost: 优先用 Excel 汇总行直接读取的值，否则用分项求和
  if (result.cost_summary.total_cost == null) {
    const known = ['long_term_cost', 'zhongshi_cost', 'huazhao_cost', 'outsourcing_cost', 'subcontract_cost', 'procurement_cost', 'third_party_test_cost', 'travel_cost', 'ip_cost'];
    result.cost_summary.total_cost = known.reduce((a, k) => a + (result.cost_summary[k] || 0), 0);
  }
  // profit_rate: 优先用 Excel 直接读取的值，否则用计算
  if (result.cost_summary.profit_rate == null && result.project.contract_amount) {
    result.cost_summary.profit_rate = +(1 - result.cost_summary.total_cost / result.project.contract_amount).toFixed(4);
  }
  result.meta = { parsed_at: new Date().toISOString(), sheet_count: Object.keys(sheets).length };
  return result;
}

module.exports = { parseProjectExcel };

if (require.main === module) {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('用法: node parse-excel.js <xlsx文件路径>');
    process.exit(1);
  }
  console.log(JSON.stringify(parseProjectExcel(file), null, 2));
}
