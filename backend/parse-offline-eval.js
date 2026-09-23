/**
 * 离线评估表（专家评估示例 / 项目成本估算汇总表，多 sheet）解析器
 *
 * 输入：一份「第X批项目经济评审-专家评估示例.xlsx」，含：
 *   - 项目基本信息：标签-值 布局，含 项目名称/编号/部门/类型/是否数字化/业务方向/产品方向/
 *                    合同额/总成本/利润率/各成本分量（长期/中实/华兆职工、人员外包、专业分包、采购、差旅、第三方测试、知识产权）
 *   - 长期职工成本估算 / 中实职工成本估算 / 华兆职工成本估算 / 人员外包成本估算 / 专业分包成本估算 /
 *     采购成本估算 / 差旅费估算 等明细 sheet（含「合计」行，作为成本分量的兜底来源）
 *
 * 输出：{ project: {...}, warnings: [] }
 *   project 内含 cost_summary（与系统 parseProjectExcel 产出的 cost_summary 字段对齐）：
 *     contract_amount, total_cost, profit_rate(小数), long_term_cost, zhongshi_cost, huazhao_cost,
 *     outsourcing_cost, subcontract_cost, subcontract_ratio, procurement_cost, travel_cost,
 *     third_party_test_cost, ip_cost；以及项目级字段 is_digital/business_direction/...
 */
const XLSX = require('xlsx');

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  let s = String(v).replace(/,/g, '').replace(/\s/g, '');
  // 去掉百分号（利润率单独处理）
  s = s.replace(/%$/, '');
  const n = Number(s);
  return isNaN(n) ? null : n;
}
function pctToDecimal(v) {
  if (v === undefined || v === null || v === '') return null;
  let s = String(v).trim().replace(/%$/, '').replace(/,/g, '').replace(/\s/g, '');
  const n = Number(s);
  if (isNaN(n)) return null;
  return Math.round(n * 100) / 10000; // 24.14% -> 0.2414
}

// 在 grid 中找到标签所在 [r,c]，取值为其右侧单元格（本表布局为 标签在 A/C，值在 B/D，均为右侧）。
// 注意：不要回退到左侧单元格——左侧是上一个标签的“值”，会导致误取（如 项目编号 右侧为空时误取承建部门）。
function findVal(grid, label) {
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < (grid[r] || []).length; c++) {
      if (String(grid[r][c] || '').trim() === label) {
        const right = grid[r][c + 1];
        if (right !== undefined && String(right).trim() !== '') return String(right).trim();
      }
    }
  }
  return '';
}

// 取某明细 sheet 的「合计」行数值（合计行通常在倒数，列 F/G 为 费用/小计）
function sheetTotal(grid, labelColPattern, valueCol) {
  for (let r = 0; r < grid.length; r++) {
    const a = String(grid[r][0] || '').trim();
    if (a === '合计' || a === '合  计') {
      const v = num(grid[r][valueCol]);
      if (v !== null) return v;
    }
  }
  return null;
}

function getSheetGrid(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true });
}

// ==================== 「人员外包 / 专业分包」明细 sheet 的专家评估值解析 ====================
// 这两张明细表的结构是「一行一个工作项 × 5 位专家各一列人天」，但：
//   1) 专家列位置不固定（模板改版、多插/少插一列都会漂移），**绝不写死 G~K**；
//   2) 序号列为空但「工作说明」有内容的行为数不少（分母 sheet 实测 94 个有序号 + 29 个无序号 = 123 行）；
//   3) 合并单元格导致「工作任务 / 工作项」列大量为空，需向下填充。
// 因此全部按表头动态定位。
const EXPERT_SHEET_HINTS = [
  { category: 'outsourcing', hint: '人员外包' },
  { category: 'subcontract', hint: '专业分包' }
];

const cstr = (v) => String(v === undefined || v === null ? '' : v).trim();

function findSheetName(wb, hint) {
  return (wb.SheetNames || []).find(n => n.replace(/\s/g, '').includes(hint)) || null;
}

// 定位「5 位专家评估值」所在列：
//   首选：表头上方紧邻的标题行里的连续 1/2/3/4/5（模板原样，最贴近"专家N"语义）；
//   兜底：表头行中重复出现的「工作量估算（人天）」列，去掉项目自身那一列后取后 5 列。
function locateExpertCols(grid, headerRow, dayCols) {
  for (let r = Math.max(0, headerRow - 3); r < headerRow; r++) {
    const row = grid[r] || [];
    const nums = [];
    row.forEach((c, i) => { if (/^[1-5]$/.test(cstr(c))) nums.push(i); });
    if (nums.length === 5) return nums;
  }
  if (dayCols.length >= 6) return dayCols.slice(dayCols.length - 5);
  if (dayCols.length === 5) return dayCols.slice();
  return [];
}

function parseDetailExperts(grid) {
  if (!grid) return null;
  // 表头行：含「工作任务」的那一行（实测为第 2 行，但按内容定位更稳）
  let headerRow = -1;
  for (let r = 0; r < grid.length; r++) {
    if ((grid[r] || []).some(c => cstr(c) === '工作任务')) { headerRow = r; break; }
  }
  if (headerRow < 0) return null;
  const head = grid[headerRow] || [];
  const colOf = (re) => { for (let c = 0; c < head.length; c++) if (re.test(cstr(head[c]))) return c; return -1; };

  const colNo = head.findIndex(c => cstr(c) === '序号');
  const colTask = colOf(/工作任务/);
  const colItem = colOf(/工作项/);
  const colDesc = colOf(/工作说明|工作内容/);
  const colCost = colOf(/^费用/);           // 第一个「费用（元）」= 项目自身费用列
  const dayCols = [];
  head.forEach((c, i) => { if (/工作量估算|人天/.test(cstr(c))) dayCols.push(i); });
  const expertCols = locateExpertCols(grid, headerRow, dayCols);
  // 项目自身工作量列 = 工作量列中不属于专家列的（存在时）
  const selfDayCol = dayCols.find(c => expertCols.indexOf(c) < 0);
  if (colDesc < 0) return null;

  const rows = [];
  let lastTask = '', lastItem = '';
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const A = cstr(row[0]);
    const B = cstr(row[1]);
    const desc = cstr(row[colDesc]);
    const rawItem = cstr(row[colItem]);
    // 排除：重复表头、合计/小计行、说明行、全空行
    if (desc === '工作说明' || /^序号$/.test(A)) continue;
    if (/合计|小计|说明/.test(A) || /^合计$/.test(B) || /^小计$/.test(B)) continue;
    if (!A && !B && !desc && !rawItem && !cstr(row[colTask])) continue;
    // 数据行判定：序号为数字，或虽有合并单元格但「工作说明」有内容
    if (!/^\d+$/.test(A) && !desc) continue;

    if (cstr(row[colTask])) lastTask = cstr(row[colTask]);
    if (rawItem) lastItem = rawItem;
    // raw:false 下空单元格为 ''，与真实的 0 可区分 → 空值视为「该专家未评估」，不写入
    const expert_days = expertCols.map(c => (cstr(row[c]) === '' ? null : num(cstr(row[c]))));
    rows.push({
      work_task: lastTask, work_item: lastItem, description: desc,
      person_days: selfDayCol >= 0 ? num(cstr(row[selfDayCol])) : null,
      cost: colCost >= 0 ? num(cstr(row[colCost])) : null,
      expert_days
    });
  }
  return {
    header_row: headerRow, col_no: colNo, col_task: colTask, col_item: colItem,
    col_desc: colDesc, col_days: selfDayCol, col_cost: colCost,
    expert_cols: expertCols, rows
  };
}

// 解析「人员外包 / 专业分包」两张明细表的专家评估值（供导入时按顺序回写 expertEstimates）
function parseExpertSheets(wb) {
  const out = [];
  const warnings = [];
  for (const cfg of EXPERT_SHEET_HINTS) {
    const name = findSheetName(wb, cfg.hint);
    if (!name) { warnings.push(`未找到「${cfg.hint}」明细 sheet，其专家评估值未解析`); continue; }
    const detail = parseDetailExperts(getSheetGrid(wb, name));
    if (!detail) { warnings.push(`「${name}」无法识别表头，其专家评估值未解析`); continue; }
    if (detail.expert_cols.length !== 5) {
      warnings.push(`「${name}」按表头只定位到 ${detail.expert_cols.length} 个专家列（期望 5），请核对表头`);
    }
    out.push({ sheet: name, category: cfg.category, ...detail });
  }
  return { sheets: out, warnings };
}

function parseOfflineEval(filePath) {
  const wb = XLSX.readFile(filePath, { raw: false, cellFormula: false });
  const base = getSheetGrid(wb, '项目基本信息');
  if (!base) throw new Error('缺少「项目基本信息」sheet，无法解析离线评估表');
  const g = (k) => findVal(base, k);

  const project_name = g('项目名称');
  const project_code = g('项目编号');
  const biz_department = g('项目承建部门');
  const project_type = g('项目类型');
  const isDigitalRaw = g('是否属于数字化');
  const is_digital = /^(是|y|yes|true|1)$/i.test(isDigitalRaw);
  const business_direction = g('业务方向');
  const business_sub_direction = g('业务子方向');
  const product_direction = g('产品方向');

  const contract_amount = num(g('预估合同金额（元）')) || num(g('合同额（元）')) || 0;
  let total_cost = num(g('项目总成本（元）'));
  const profit_rate = pctToDecimal(g('预估利润率'));

  let long_term_cost = num(g('长期职工成本（元）'));
  let zhongshi_cost = num(g('中实职工成本（元）'));
  let huazhao_cost = num(g('华兆职工成本（元）'));
  let outsourcing_cost = num(g('人员外包成本（元）'));
  let subcontract_cost = num(g('专业分包成本（元）'));
  let procurement_cost = num(g('采购成本（元）'));
  let travel_cost = num(g('差旅费用（元）')) || num(g('差旅费（元）'));
  let third_party_test_cost = num(g('第三方测试费用（元）'));
  let ip_cost = num(g('知识产权费（元）'));

  const warnings = [];

  // 兜底：若基本信息里某项缺失，尝试从对应明细 sheet 的「合计」行取
  const detailMap = [
    { key: 'long_term_cost', sheet: '长期职工成本估算', col: 6 },
    { key: 'zhongshi_cost', sheet: '中实职工成本估算', col: 6 },
    { key: 'huazhao_cost', sheet: '华兆职工成本估算', col: 6 },
    { key: 'outsourcing_cost', sheet: '人员外包成本估算', col: 6 },
    { key: 'subcontract_cost', sheet: '专业分包成本估算 ', col: 6 },
    { key: 'subcontract_cost', sheet: '专业分包成本估算', col: 6 },
    { key: 'procurement_cost', sheet: '采购成本估算', col: 7 },
    { key: 'travel_cost', sheet: '差旅费估算', col: 6 }
  ];
  const detailTotals = {};
  for (const dm of detailMap) {
    if (detailTotals[dm.key] === undefined) {
      const dg = getSheetGrid(wb, dm.sheet);
      detailTotals[dm.key] = dg ? sheetTotal(dg, null, dm.col) : null;
    }
  }
  const pick = (val, key) => {
    if (val !== null && !isNaN(val)) return val;
    const t = detailTotals[key];
    if (t !== null && t !== undefined) { warnings.push(`「${key}」基本信息为空，已用「${key}」明细 sheet 合计兜底`); return t; }
    return val || 0;
  };
  long_term_cost = pick(long_term_cost, 'long_term_cost');
  zhongshi_cost = pick(zhongshi_cost, 'zhongshi_cost');
  huazhao_cost = pick(huazhao_cost, 'huazhao_cost');
  outsourcing_cost = pick(outsourcing_cost, 'outsourcing_cost');
  subcontract_cost = pick(subcontract_cost, 'subcontract_cost');
  procurement_cost = pick(procurement_cost, 'procurement_cost');
  travel_cost = pick(travel_cost, 'travel_cost');

  // total_cost 兜底：分项求和
  if (total_cost === null || isNaN(total_cost)) {
    total_cost = Math.round((long_term_cost + zhongshi_cost + huazhao_cost + outsourcing_cost +
      subcontract_cost + procurement_cost + travel_cost + (third_party_test_cost || 0) + (ip_cost || 0)) * 100) / 100;
    if (total_cost > 0) warnings.push('「项目总成本」缺失，已用各项成本求和兜底');
  }

  // 利润率兜底：用 合同额-总成本 推算
  let finalProfit = profit_rate;
  if ((finalProfit === null || isNaN(finalProfit)) && contract_amount > 0 && total_cost > 0) {
    finalProfit = Math.round((1 - total_cost / contract_amount) * 10000) / 10000;
    warnings.push('「预估利润率」缺失，已用 (1-总成本/合同额) 推算');
  }

  const subcontract_ratio = (total_cost > 0) ? Math.round(subcontract_cost / total_cost * 10000) / 10000 : 0;

  const project = {
    project_name, project_code, biz_department, project_type, is_digital,
    business_direction, business_sub_direction, product_direction,
    contract_amount,
    cost_summary: {
      contract_amount,
      total_cost,
      profit_rate: finalProfit,
      long_term_cost, zhongshi_cost, huazhao_cost,
      outsourcing_cost, subcontract_cost, subcontract_ratio,
      procurement_cost, travel_cost, third_party_test_cost: third_party_test_cost || 0, ip_cost: ip_cost || 0
    }
  };
  // 专家评估值（人员外包 / 专业分包两张明细表，列位置按表头动态解析）
  const expertParsed = parseExpertSheets(wb);
  warnings.push(...expertParsed.warnings);
  return { project, warnings, expertSheets: expertParsed.sheets };
}

module.exports = { parseOfflineEval };
