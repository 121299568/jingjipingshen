/**
 * Excel 项目成本估算表解析器
 * 解析格式：项目成本估算汇总簿（12个工作表：项目基本信息 + 人员/分包成本 + 采购 + 差旅）
 * 特性：展开合并单元格、跳过表头/合计/说明行、公式取缓存值
 *       —— 兼容真实业务表的「表名变体」与「表头行位置不一」
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

// ---------- 合计行识别 ----------
// 明细表里的「合计/小计」行不是工作项，绝不能参与成本计算（项目70 曾因此把分包成本
// 虚增 339.8 万）。两条判据，命中任一即按合计行跳过：
//   1) 文本判据：指定列的文本**整词**为 合计/小计/总计/汇总/累计/Sum/Total。
//      ★ 必须整词匹配：真实工作项名常含「汇总」二字（如「成果汇总与验收」「调研结果汇总」），
//        用 includes 会把明细误删。「合计」字样也可能不在首列（模板把「合计」写在 B 列），
//        所以调用方把值得检查的列都传进来。
//   2) 公式判据：该行人天/费用单元格是 SUM 公式。真实明细行的数字是手填常量，
//      只有合计行才是公式求和；这条能兜住「没有合计字样但确实是 SUM」的模板。
const TOTAL_LABEL_RE = /^(合计|小计|总计|汇总|累计|求和|sum|total|subtotal)\s*[:：]?$/i;
function isTotalRowByLabel(grid, r, cols) {
  for (const c of cols) {
    if (c == null || c < 0) continue;
    if (TOTAL_LABEL_RE.test(str(gv(grid, r, c)))) return true;
  }
  return false;
}
function rowHasSumFormula(ws, r, cols) {
  for (const c of cols) {
    if (c == null || c < 0) continue;
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    // 只认 SUM( ：明细行也可能写 =D3*E3 之类的公式，那不是合计
    if (cell && cell.f && /SUM\s*\(/i.test(String(cell.f))) return true;
  }
  return false;
}

// ---------- 表名模糊匹配 ----------
// 业务人员手工表的 sheet 名往往与模板有出入（如「专业分包成本测算」「XX项目成本」）。
// 不再要求精确相等，而是按关键词命中；先精确后模糊，且一张 sheet 只归属一个规范表。
const SHEET_RULES = [
  { key: '项目基本信息', kws: ['基本信息', '项目信息'] },
  { key: '长期职工成本估算', kws: ['长期职工', '长期'] },
  { key: '中实职工成本估算', kws: ['中实职工', '中实'] },
  { key: '华兆职工成本估算', kws: ['华兆职工', '华兆'] },
  { key: '人员外包成本估算', kws: ['人员外包', '外包'] },
  { key: '专业分包成本估算', kws: ['专业分包', '分包'] },
  { key: '开发工作量成本估算', kws: ['开发工作量', '开发'] },
  { key: '实施工作量成本估算', kws: ['实施工作量', '实施'] },
  { key: '运维工作量成本估算', kws: ['运维工作量', '运维'] },
  { key: '咨询工作量成本估算', kws: ['咨询工作量', '咨询'] },
  { key: '采购成本估算', kws: ['采购'] },
  { key: '差旅费估算', kws: ['差旅'] }
];
function resolveSheets(wb) {
  const norm = {};
  for (const name of wb.SheetNames) norm[name.replace(/\s+/g, '')] = wb.Sheets[name];
  const used = new Set();
  const map = {};
  for (const { key, kws } of SHEET_RULES) {
    if (norm[key]) { map[key] = norm[key]; used.add(key); continue; }
    for (const name of wb.SheetNames) {
      if (used.has(name)) continue;
      const nn = name.replace(/\s+/g, '');
      if (kws.some(k => nn.includes(k))) { map[key] = wb.Sheets[name]; used.add(name); break; }
    }
  }
  return map;
}

// 自动探测表头行：在前 [0..min(lastRow,10)] 行中找第一个「含全部关键词」的行。
// 找不到时回退到 fallback（兼容旧模板固定的第2行表头）。
function detectHeaderRow(grid, lastRow, kws, fallback) {
  for (let r = 0; r <= Math.min(lastRow, 10); r++) {
    const rowStr = (grid[r] || []).map(c => str(c)).join('|');
    if (kws.every(k => rowStr.includes(k))) return r;
  }
  return fallback;
}

// ---------- 公式兜底求值 ----------
// ★ 背景：SheetJS 社区版没有公式引擎，只能读 Excel 存盘时写下的「缓存值」。
//   由程序生成的 xlsx（openpyxl / 模板导出等）常常只有公式没有缓存值（或缓存为 0），
//   表现为「Excel 里打开看着有数，系统解析出来是 0」。
//   这里对「有公式且缓存值为空或 0」的单元格做一次保守重算：
//   只支持 SUM(区域) / 单格引用（含跨表）/ 四则运算 / 括号；算不出就保持原样不动。
function colToNum(a) { let n = 0; for (const ch of a) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
function makeFormulaEvaler(wb) {
  const memo = {};
  function cellValue(sheet, addr, depth) {
    const key = sheet + '!' + addr;
    if (memo[key] !== undefined) return memo[key];
    if (depth > 6) return null;
    const ws = wb.Sheets[sheet];
    if (!ws) return null;
    const cell = ws[addr];
    if (!cell) return null;
    memo[key] = null; // 环检测占位
    let v = null;
    if (cell.f && (cell.v == null || cell.v === 0)) {
      v = evalExpr(sheet, String(cell.f), depth + 1);
    }
    if (v == null && typeof cell.v === 'number') v = cell.v;
    memo[key] = v;
    return v;
  }
  function rangeSum(sheet, a1, a2, depth) {
    const m1 = String(a1).match(/^([A-Z]+)(\d+)$/), m2 = String(a2).match(/^([A-Z]+)(\d+)$/);
    if (!m1 || !m2) return null;
    let s = 0, any = false;
    for (let r = +m1[2]; r <= +m2[2] && r <= +m2[2]; r++) {
      for (let c = colToNum(m1[1]); c <= colToNum(m2[1]); c++) {
        const v = cellValue(sheet, XLSX.utils.encode_cell({ r: r - 1, c }), depth);
        if (typeof v === 'number') { s += v; any = true; }
      }
    }
    return any ? s : null;
  }
  function evalRef(sheet, ref, depth) {
    let sh = sheet, rs = String(ref).replace(/\$/g, '');
    const m = rs.match(/^'([^']+)'!(.+)$/) || rs.match(/^([^'!]+)!(.+)$/);
    if (m) { sh = m[1]; rs = m[2]; }
    if (rs.includes(':')) { const [a, b] = rs.split(':'); return rangeSum(sh, a, b, depth); }
    return cellValue(sh, rs, depth);
  }
  function evalExpr(sheet, f, depth) {
    let s = String(f).replace(/^=/, '').trim();
    if (!s || /#REF|#VALUE|#NAME/.test(s)) return null;
    // 含我们不支持的函数（IF/ROUND/VLOOKUP…）直接放弃，避免算错
    const fns = s.match(/[A-Za-z\u4e00-\u9fa5_]+\s*\(/g) || [];
    if (fns.some(x => !/^SUM\s*\($/i.test(x))) return null;
    s = s.replace(/SUM\s*\(([^()]*)\)/gi, (_, inner) => {
      let sum = 0, any = false;
      inner.split(',').forEach(p => {
        const t = p.trim();
        if (!t) return;
        const v = evalRef(sheet, t, depth);
        if (typeof v === 'number') { sum += v; any = true; }
      });
      return any ? '(' + sum + ')' : '(0)';
    });
    // 剩余裸引用（含跨表）
    // 表名允许含数字/下划线（如「Sheet1!A1」「专业分包成本估算 !F9」）
    s = s.replace(/(?:'([^']+)'!|([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)!)?(\$?[A-Z]{1,3}\$?\d{1,7})/g, (mm, q, n2, addr) => {
      const v = evalRef(q || n2 || sheet, addr, depth);
      return typeof v === 'number' ? String(v) : '0';
    });
    if (!/^[\d\s+\-*/().%]+$/.test(s)) return null;
    try {
      const val = Function('"use strict";return (' + s.replace(/%/g, '/100') + ')')();
      return typeof val === 'number' && isFinite(val) ? val : null;
    } catch (e) { return null; }
  }
  return { evalExpr, cellValue };
}
// 对整个工作簿做一次兜底：只改写「有公式且缓存为空或 0」且重算出非 0 的单元格
function recalcFormulaCells(wb) {
  if (!wb || !wb.Sheets) return 0;
  const E = makeFormulaEvaler(wb);
  let fixed = 0;
  for (const sn of wb.SheetNames) {
    const ws = wb.Sheets[sn];
    if (!ws || !ws['!ref']) continue;
    const rng = XLSX.utils.decode_range(ws['!ref']);
    for (let r = rng.s.r; r <= rng.e.r; r++) {
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (!cell || !cell.f) continue;
        if (!(cell.v === 0 || cell.v == null || cell.v === '')) continue; // 缓存已有有效值，不干预
        const v = E.evalExpr(sn, String(cell.f), 0);
        if (typeof v === 'number' && isFinite(v) && Math.abs(v) > 1e-9) {
          cell.v = v; cell.t = 'n'; fixed++;
        }
      }
    }
  }
  return fixed;
}

// ---------- 主解析 ----------
function parseProjectExcel(filePath) {
  const wb = XLSX.readFile(filePath, { cellFormula: true, raw: true });
  recalcFormulaCells(wb);
  const sheets = resolveSheets(wb);

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

  // ===== 2. 人员成本明细（长期/中实/华兆：7 列无专家评估）=====
  // 文本列(工作任务B/工作项C)可能合并→用填充网格；数值列(人天E/费用F或G)合并会导致重复计数→用原始网格
  const staffSheets = [
    { key: '长期职工成本估算', category: 'long_term' },
    { key: '中实职工成本估算', category: 'zhongshi' },
    { key: '华兆职工成本估算', category: 'huazhao' }
  ];
  for (const { key, category } of staffSheets) {
    const ws = sheets[key];
    if (!ws) continue;
    const fill = expandGrid(ws, true).grid;   // 文本用
    const raw = expandGrid(ws, false).grid;   // 数值用
    const lastRow = XLSX.utils.decode_range(ws['!ref']).e.r;
    const lastCol = XLSX.utils.decode_range(ws['!ref']).e.c;
    const hr = detectHeaderRow(fill, lastRow, ['工作项', '费用'], 1);
    // 与专家评估表同理：列位按表头定位（人员表常见「0编号 1工作任务 2工作项 3工作说明 4人天 5人员 6费用」，
    // 但不同项目会在中间插入列），定位不到时回落到历史列位。
    const head = [];
    for (let c = 0; c <= lastCol; c++) head.push(str(gv(fill, hr, c)));
    const pick = (re, ex) => head.findIndex(h => h && re.test(h) && !(ex && ex.test(h)));
    let cTask = pick(/工作任务/), cItem = pick(/工作项/), cDesc = pick(/工作说明|说明/);
    let cDays = pick(/人天|工作量估算/), cPerson = pick(/人员|姓名|责任人/);
    let cCost = pick(/费用/, /占比|合计/);
    if (cTask < 0) cTask = 1;
    if (cItem < 0) cItem = 2;
    if (cDesc < 0) cDesc = 3;
    if (cDays < 0) cDays = 4;
    if (cPerson < 0) cPerson = 5;
    if (cCost < 0) cCost = 6;
    let task = '';
    let lastItem = '';
    for (let r = hr + 1; r <= lastRow; r++) {
      const aVal = str(gv(fill, r, 0));
      if (aVal.includes('说明')) continue;
      // 合计/小计行（含 SUM 公式合计行）不是工作项，跳过，否则会虚增成本
      if (isTotalRowByLabel(fill, r, [0, 1, 2, 3, cTask, cItem])) continue;
      if (rowHasSumFormula(ws, r, [cDays, cCost])) continue;
      const bVal = str(gv(fill, r, cTask));      // 工作任务(填充)
      let item = str(gv(fill, r, cItem));        // 工作项(填充)
      const days = num(gv(raw, r, cDays));       // 人天(原始)
      const cost = num(gv(raw, r, cCost));       // 费用(原始)
      const person = str(gv(raw, r, cPerson));
      // 合并单元格导致工作项为空：本行仍有数值则保留并沿用上一行工作项，避免静默丢行
      if (!item || item === '工作项') {
        if (days === null && cost === null && !person) continue;
        item = lastItem || '（同上）';
      } else lastItem = item;
      if (bVal && bVal !== '工作任务') task = bVal;
      result.work_items.push({
        category,
        work_task: task,
        work_item: item,
        description: str(gv(raw, r, cDesc)),
        person_days: days,
        person,
        cost,
        source_sheet: key,
        row: r + 1
      });
    }
  }

  // ===== 3. 含专家评估的成本明细（人员外包 / 专业分包：13 列）=====
  // 列：A 序号 B 工作任务 C 工作项 D 工作说明 E 工作量估算 F 费用 G-K 专家1-5 L 平均值 M 调整后费用
  const expertSheets = [
    { key: '人员外包成本估算', category: 'outsourcing' },
    { key: '专业分包成本估算', category: 'subcontract' }
  ];
  for (const { key, category } of expertSheets) {
    const ws = sheets[key];
    if (!ws) continue;
    const fill = expandGrid(ws, true).grid;
    const raw = expandGrid(ws, false).grid;
    const lastRow = XLSX.utils.decode_range(ws['!ref']).e.r;
    const lastCol = XLSX.utils.decode_range(ws['!ref']).e.c;
    const hr = detectHeaderRow(fill, lastRow, ['工作项', '专家'], 1);
    // ★ 列位必须按表头动态定位，不能写死。
    // 两种表的布局并不一致：人员外包是「0序号 1工作任务 2工作项 3工作说明 4人天 5费用」，
    // 专业分包在前面多一列「分包项目」→「0序号 1分包项目 2工作任务 3工作项 4-5工作说明 6人天 7费用」。
    // 硬编码 4/5 会让分包表把「工作说明」当人天读 → 人天与费用全部落库为 0（2026-09-21 修复）。
    const head = [];
    for (let c = 0; c <= lastCol; c++) head.push(str(gv(fill, hr, c)));
    const pick = (re, ex) => head.findIndex(h => h && re.test(h) && !(ex && ex.test(h)));
    let cTask = pick(/工作任务/), cItem = pick(/工作项/), cDesc = pick(/工作说明|工作内容|说明/);
    let cDays = pick(/人天|工作量估算/);
    let cCost = pick(/费用/, /调整|占比|核减|合计/);
    let cExp0 = pick(/专家\s*1|专家一/);
    let cAvg = pick(/平均/), cAdj = pick(/调整后/);
    // 定位失败时回落到历史列位，保证老模板不被改坏
    if (cTask < 0) cTask = 1;
    if (cItem < 0) cItem = 2;
    if (cDesc < 0) cDesc = 3;
    if (cDays < 0) cDays = 4;
    if (cCost < 0) cCost = 5;
    // ★ 一张表常有多个分区，每区各有表头且列位会漂移（项目70 的分包表有 4 个区：
    //   前 3 区是「…|工作量（人天）|费用（元）」，第 4 区表头变成
    //   「…|工作说明|单位|数量|单价|费用（元）」——费用列从 H 漂到 I，还多了数量/单价列）。
    //   只按首个表头定位一次，会让后续分区全读错列（把单价当费用），成本整体算错。
    //   因此遇到「重复表头行」时按新区表头重新定位；认不出数值列则不当表头，原样继续。
    const repick = (r2) => {
      const nh = [];
      for (let c = 0; c <= lastCol; c++) nh.push(str(gv(fill, r2, c)));
      const npick = (re, ex) => nh.findIndex(h => h && re.test(h) && !(ex && ex.test(h)));
      const nt = npick(/工作任务/), ni = npick(/工作项/), nd = npick(/工作说明|工作内容|说明/);
      const ndays = npick(/人天|工作量估算/), ncost = npick(/费用/, /调整|占比|核减|合计/);
      if (ndays < 0 && ncost < 0) return false;   // 认不出任何数值列，不是新表头
      cTask = nt;                                  // 新区没有的列一律置 -1（num(gv) 对 -1 安全返回 null）
      cItem = ni;
      cDesc = nd;
      cDays = ndays;
      cCost = ncost;
      cExp0 = npick(/专家\s*1|专家一/);
      cAvg = npick(/平均/);
      cAdj = npick(/调整后/);
      lastItem = '';                               // 新分区：工作项不沿用上一区的
      return true;
    };
    let task = '';
    let lastItem = '';
    for (let r = hr + 1; r <= lastRow; r++) {
      const aVal = str(gv(fill, r, 0));
      if (aVal.includes('说明')) continue;
      // 合计/小计行（含 SUM 公式合计行）不是工作项，跳过，否则会虚增成本
      if (isTotalRowByLabel(fill, r, [0, 1, 2, 3, cTask, cItem])) continue;
      if (rowHasSumFormula(ws, r, [cDays, cCost])) continue;
      // 遇到新分区表头（A 列为「序号/编号」且能认出数值列）：重定位列位后跳过表头行
      if (/^(序号|编号)$/.test(aVal) && repick(r)) continue;
      const bVal = str(gv(fill, r, cTask));
      if (bVal && bVal !== '工作任务') task = bVal;
      let item = str(gv(fill, r, cItem));
      const days = num(gv(raw, r, cDays));
      const cost = num(gv(raw, r, cCost));
      if (!item || item === '工作项') {
        // 合并单元格会让续行的工作项为空。以前直接 continue 丢弃，导致「表里有值、系统里没有」；
        // 改为：只要本行有人天或费用就保留，工作项沿用上一行（仍无则占位）。
        if (days === null && cost === null) continue;
        item = lastItem || '（同上）';
      } else lastItem = item;
      const expertDays = cExp0 >= 0
        ? [0, 1, 2, 3, 4].map(i => num(gv(raw, r, cExp0 + i)))
        : [6, 7, 8, 9, 10].map(ci => num(gv(raw, r, ci)));
      const avg = cAvg >= 0 ? num(gv(raw, r, cAvg)) : num(gv(raw, r, 11));
      const adjusted = cAdj >= 0 ? num(gv(raw, r, cAdj)) : num(gv(raw, r, 12));
      result.work_items.push({
        category,
        work_task: task,
        work_item: item,
        description: str(gv(raw, r, cDesc)),
        person_days: days,
        cost,
        expert_days: expertDays,
        expert_days_avg: avg,
        adjusted_cost: adjusted !== null ? adjusted : cost,
        source_sheet: key,
        row: r + 1
      });
    }
  }

  // ===== 3.5 通用工作量成本估算（开发 / 实施 / 运维 / 咨询 等表头不统一的表）=====
  // 这些表的「工作项」列名各异（最小功能名称 / 实施工作项 / 涉及到的子任务 / 工作任务…），
  // 不要求固定列位，按列名动态定位工作项列与工作量列，凡是含「工作量/人天」的表都尝试抽取。
  const genericWorkSheets = [
    { key: '开发工作量成本估算', category: 'dev' },
    { key: '实施工作量成本估算', category: 'impl' },
    { key: '运维工作量成本估算', category: 'ops' },
    { key: '咨询工作量成本估算', category: 'consult' }
  ];
  const ITEM_COL_CANDIDATES = ['工作项', '最小功能名称', '实施工作项', '涉及到的子任务', '工作任务简述', '任务环节', '工作任务'];
  const TASK_COL_CANDIDATES = ['一级菜单', '模块', '咨询设计任务', '实施工作任务', '工作任务'];
  const DESC_COL_CANDIDATES = ['工作说明', '工作任务描述', '工作任务简述', '涉及到的子任务'];
  for (const { key, category } of genericWorkSheets) {
    const ws = sheets[key];
    if (!ws) continue;
    const fill = expandGrid(ws, true).grid;
    const raw = expandGrid(ws, false).grid;
    const lastRow = XLSX.utils.decode_range(ws['!ref']).e.r;
    // 表头行：首个含「工作量/人天」的行
    let hr = -1;
    for (let r = 0; r <= Math.min(lastRow, 14); r++) {
      const rowStr = (fill[r] || []).map(c => str(c)).join('|');
      if (/工作量估算|工作量（人天）|工作量（人天|人天|工作量$/.test(rowStr)) { hr = r; break; }
    }
    if (hr < 0) continue;
    const header = (fill[hr] || []).map(c => str(c));
    const findCol = (cands) => {
      for (const cand of cands) {
        const idx = header.findIndex(h => h && h.includes(cand));
        if (idx >= 0) return idx;
      }
      return -1;
    };
    const itemCol = findCol(ITEM_COL_CANDIDATES);
    if (itemCol < 0) continue;            // 认不出工作项列则不抽，避免误抽
    const taskCol = (() => { const i = findCol(TASK_COL_CANDIDATES); return i >= 0 && i !== itemCol ? i : -1; })();
    const descCol = (() => { const i = findCol(DESC_COL_CANDIDATES); return i >= 0 && i !== itemCol ? i : -1; })();
    const workloadCol = header.findIndex(h => h && /工作量估算|工作量（人天）|人天|工作量$/.test(h));
    let task = '';
    for (let r = hr + 1; r <= lastRow; r++) {
      const aVal = str(gv(fill, r, 0));
      if (aVal.includes('说明')) continue;
      // 合计/小计行（含 SUM 公式合计行）不是工作项，跳过，否则会虚增成本
      if (isTotalRowByLabel(fill, r, [0, 1, 2, 3, taskCol, itemCol])) continue;
      if (rowHasSumFormula(ws, r, [workloadCol])) continue;
      const item = str(gv(fill, r, itemCol));
      if (!item || item === header[itemCol]) continue;   // 空行 / 表头重复
      if (taskCol >= 0) { const tv = str(gv(fill, r, taskCol)); if (tv && tv !== header[taskCol]) task = tv; }
      const days = workloadCol >= 0 ? num(gv(raw, r, workloadCol)) : null;
      const desc = descCol >= 0 ? str(gv(raw, r, descCol)) : '';
      if (days === null && !desc) {
        // 没有工作量也没有说明的行，多半是占位空行，跳过
        if (!item) continue;
      }
      result.work_items.push({
        category,
        work_task: task,
        work_item: item,
        description: desc,
        person_days: days,
        source_sheet: key,
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
    if (swStart >= 0) scanBlock(swStart, hwStart >= 0 ? hwStart - 1 : lastRow, 'software');
    if (hwStart >= 0) scanBlock(hwStart, lastRow, 'hardware');
    // 兜底：若未识别到软件/硬件分区，则把表中所有「有名称且非合计」的行当软件项抽取
    if (swStart < 0 && hwStart < 0) {
      const hr = detectHeaderRow(fill, lastRow, ['名称', '规格'], 1);
      for (let r = hr + 1; r <= lastRow; r++) {
        const aVal = str(gv(fill, r, 0));
        if (aVal.includes('合')) break;
        const name = str(gv(fill, r, 1));
        if (!name) continue;
        result.procurement_items.push({
          type: 'software',
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
      if (result.procurement_items.length === 0) {
        result.warnings.push('采购成本表未识别到「软件/硬件」分区，已按通用商品行兜底抽取');
      }
    }
  }

  // ===== 5. 差旅费 =====
  if (sheets['差旅费估算']) {
    const ws = sheets['差旅费估算'];
    const fill = expandGrid(ws, true).grid;
    const raw = expandGrid(ws, false).grid;
    const lastRow = XLSX.utils.decode_range(ws['!ref']).e.r;
    const hr = detectHeaderRow(fill, lastRow, ['出差', '事由', '目的地', '天数', '目的'], 1);
    for (let r = hr + 1; r <= lastRow; r++) {
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
  result.meta = { parsed_at: new Date().toISOString(), sheet_count: wb.SheetNames.length, sheets: wb.SheetNames };
  return result;
}

// 通用询价单/采购协议解析：扫描所有工作表，按表头关键词识别「货物名称/规格/单价」列，
// 抽取每项货物定价，作为采购成本比对的"上限价"来源。兼容 Excel（xlsx/xls）。
// 说明：Word/PDF 暂不支持自动抽取，需由人员在页面按货物录入上限价（见 server.js 的 inquiry_prices）。
const INQUIRY_COLS = {
  item: ['名称', '货物', '物品', '物料', '设备', '品名', '标的', '采购内容', '项目'],
  spec: ['规格', '型号', '参数', '技术参数'],
  unit_price: ['单价', '单元价', '含税单价', '未税单价'],
  qty: ['数量', '台数', '套数', '个数', '工程量'],
  amount: ['金额', '总价', '合价', '小计', '费用', '总额', '含税金额']
};
function matchInquiryCol(headers, kws) {
  for (let c = 0; c < headers.length; c++) {
    const h = str(headers[c]);
    if (kws.some(k => h.includes(k))) return c;
  }
  return -1;
}
function parseInquiryExcel(filePath) {
  let wb;
  try { wb = XLSX.readFile(filePath, { cellFormula: true, raw: true }); }
  catch (e) { return { __parseError: e && e.message, items: [] }; }
  recalcFormulaCells(wb);
  const items = [];
  const seen = new Set();
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    const { grid } = expandGrid(ws, true);
    const lastRow = grid.length - 1;
    if (lastRow < 1) continue;
    // 探测表头行：同时含"名称/货物/物品/品名"与"单价"的行
    let hdr = -1;
    for (let r = 0; r <= Math.min(lastRow, 12); r++) {
      const rowStr = (grid[r] || []).map(c => str(c)).join('|');
      if ((rowStr.includes('名称') || rowStr.includes('货物') || rowStr.includes('物品') || rowStr.includes('品名')) && rowStr.includes('单价')) { hdr = r; break; }
    }
    if (hdr < 0) continue;
    const headers = grid[hdr] || [];
    const cItem = matchInquiryCol(headers, INQUIRY_COLS.item);
    const cSpec = matchInquiryCol(headers, INQUIRY_COLS.spec);
    const cPrice = matchInquiryCol(headers, INQUIRY_COLS.unit_price);
    const cQty = matchInquiryCol(headers, INQUIRY_COLS.qty);
    const cAmt = matchInquiryCol(headers, INQUIRY_COLS.amount);
    if (cItem < 0 || cPrice < 0) continue; // 该表不是询价明细
    for (let r = hdr + 1; r <= lastRow; r++) {
      const name = str(gv(grid, r, cItem));
      if (!name) continue;
      const price = num(gv(grid, r, cPrice));
      if (price == null) continue;
      const spec = cSpec >= 0 ? str(gv(grid, r, cSpec)) : '';
      const qty = cQty >= 0 ? (num(gv(grid, r, cQty)) || 0) : 0;
      const amount = cAmt >= 0 ? (num(gv(grid, r, cAmt)) || 0) : 0;
      const key = name + '|' + spec;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ item_name: name, spec, unit_price: price, quantity: qty, amount });
    }
  }
  return { items };
}

module.exports = { parseProjectExcel, parseInquiryExcel, recalcFormulaCells };

if (require.main === module) {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('用法: node parse-excel.js <xlsx文件路径>');
    process.exit(1);
  }
  console.log(JSON.stringify(parseProjectExcel(file), null, 2));
}
