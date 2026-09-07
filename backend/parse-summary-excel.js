/**
 * 评审汇总表（批次级）解析器
 * 模板结构（用户提供的「2026年第十四批经济评审汇总表.xlsx」）：
 *   汇总表 sheet：
 *     第 1 行（标题行，常合并）: 2026年第十四批经济评审  -> 作为批次名称
 *     第 2 行（表头）: 序号 | 项目编号 | 项目名称 | 项目承建部门 | 项目类型 | 合同额（元） | 内部信息系统填报预估成本（元）
 *     第 3 行起: 各项目明细
 * 兼容：表头行位置不一、sheet 名含「汇总」即可、列名带（元）/空格变体。
 * 依赖：xlsx（SheetJS 社区版）
 */
const XLSX = require('xlsx');

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

// 展开合并单元格（填充）
function expandGrid(ws) {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    grid[r] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      grid[r][c] = cell ? cell.v : null;
    }
  }
  const merges = ws['!merges'] || [];
  for (const m of merges) {
    const top = ws[XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })];
    const val = top ? top.v : null;
    for (let r = m.s.r; r <= m.e.r; r++)
      for (let c = m.s.c; c <= m.e.c; c++)
        if (grid[r] && grid[r][c] == null) grid[r][c] = val;
  }
  return grid;
}

// 根据表头关键字定位列索引
function locateColumns(headerCells) {
  const norm = headerCells.map(c => str(c));
  const find = (keys) => {
    for (let i = 0; i < norm.length; i++) {
      if (keys.some(k => norm[i].includes(k))) return i;
    }
    return -1;
  };
  return {
    seq: find(['序号']),
    project_code: find(['项目编号']),
    project_name: find(['项目名称']),
    biz_department: find(['项目承建部门', '承建部门', '事业部']),
    project_type: find(['项目类型']),
    contract_amount: find(['合同额']),
    internal_cost: find(['内部信息系统填报预估成本', '内部填报预估成本', '内部预估成本', '填报预估成本'])
  };
}

function pickSummarySheet(wb) {
  const names = wb.SheetNames;
  // 1) 精确包含「汇总表」
  let name = names.find(n => /汇总表/.test(n));
  if (name) return wb.Sheets[name];
  // 2) 含「汇总」
  name = names.find(n => /汇总/.test(n));
  if (name) return wb.Sheets[name];
  // 3) 表头含 项目编号 + 合同额 的 sheet
  for (const n of names) {
    const grid = expandGrid(wb.Sheets[n]);
    if (grid.length >= 2 && grid.some(row => {
      const line = (row || []).map(c => str(c)).join('|');
      return line.includes('项目编号') && line.includes('合同额');
    })) return wb.Sheets[n];
  }
  // 4) 兜底第一个
  return wb.Sheets[names[0]];
}

function parseSummaryExcel(filePath) {
  const wb = XLSX.readFile(filePath, { cellFormula: true, raw: true });
  const ws = pickSummarySheet(wb);
  const grid = expandGrid(ws);

  const result = { sheet_name: '', batch_name: '', projects: [] };
  if (!ws) return result;
  // sheet 名（来自 wb）
  const idx = wb.SheetNames.indexOf(Object.keys(wb.Sheets).find(k => wb.Sheets[k] === ws));
  result.sheet_name = wb.SheetNames[idx] || '';

  // 找表头行：含 序号 + 项目编号 + 项目名称 + 合同额
  let headerRow = -1;
  for (let r = 0; r <= Math.min(grid.length - 1, 12); r++) {
    const line = (grid[r] || []).map(c => str(c)).join('|');
    if (line.includes('序号') && line.includes('项目编号') && line.includes('项目名称') && line.includes('合同额')) {
      headerRow = r; break;
    }
  }
  if (headerRow < 0) {
    throw new Error('未在汇总表中找到表头（需要含「序号/项目编号/项目名称/合同额」的行）');
  }

  // 标题行：表头之上、A 列首个非空单元格（常为合并标题）
  for (let r = 0; r < headerRow; r++) {
    const a = str(grid[r] && grid[r][0]);
    if (a) { result.batch_name = a; break; }
  }
  if (!result.batch_name) result.batch_name = '未命名评审批次';

  const cols = locateColumns(grid[headerRow]);
  if (cols.project_name < 0 || cols.contract_amount < 0) {
    throw new Error('汇总表表头缺少必要列：项目名称 / 合同额');
  }

  // 数据行：从 headerRow+1 起，直到 项目编号/项目名称 为空
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const project_code = cols.project_code >= 0 ? str(row[cols.project_code]) : '';
    const project_name = cols.project_name >= 0 ? str(row[cols.project_name]) : '';
    // 终止条件：项目编号/名称 均为空，或序号列为「合计」等说明文字
    const seqCell = cols.seq >= 0 ? str(row[cols.seq]) : '';
    if (!project_code && !project_name) break;
    if (/合计|小计|说明/.test(seqCell) && !project_name) continue;
    const contract_amount = cols.contract_amount >= 0 ? num(row[cols.contract_amount]) : null;
    const internal_estimated_cost = cols.internal_cost >= 0 ? num(row[cols.internal_cost]) : null;
    result.projects.push({
      seq: seqCell ? Number(seqCell) || null : null,
      project_code,
      project_name,
      biz_department: cols.biz_department >= 0 ? str(row[cols.biz_department]) : '',
      project_type: cols.project_type >= 0 ? str(row[cols.project_type]) : '',
      contract_amount: contract_amount != null ? Math.round(contract_amount * 100) / 100 : null,
      internal_estimated_cost: internal_estimated_cost != null ? Math.round(internal_estimated_cost * 100) / 100 : null
    });
  }
  if (!result.projects.length) {
    throw new Error('汇总表中未解析到任何项目明细（请确认数据从第 ' + (headerRow + 2) + ' 行开始）');
  }
  return result;
}

module.exports = { parseSummaryExcel };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('用法: node parse-summary-excel.js <xlsx>'); process.exit(1); }
  console.log(JSON.stringify(parseSummaryExcel(file), null, 2));
}
