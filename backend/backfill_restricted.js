/**
 * 一次性回填：扫描 uploads/*.xlsx 中的评审汇总表，把「是否属于限制分包 / 专业分包范围」
 * 回填到对应项目（仅填充空缺字段，不覆盖已有值）。按 project_code 匹配，无编号时按项目名。
 * 用法：node backfill_restricted.js  （建议先 pm2 stop，跑完再 start，避免并发写冲突）
 */
const db = require('./src/db');
const { parseSummaryExcel } = require('./parse-summary-excel');
const fs = require('fs');

(async () => {
  await db.load();
  const files = fs.readdirSync('uploads').filter(f => f.endsWith('.xlsx'));
  let scanned = 0, updated = 0, filledFields = 0;
  for (const f of files) {
    let parsed;
    try { parsed = parseSummaryExcel('uploads/' + f); } catch (e) { continue; } // 非汇总表文件跳过
    scanned++;
    for (const row of parsed.projects) {
      const candidates = db.store.projects.filter(p =>
        (row.project_code && p.project_code === row.project_code) ||
        (!row.project_code && row.project_name && p.project_name === row.project_name));
      for (const p of candidates) {
        let ch = false;
        if (row.is_restricted_subcontract && !p.is_restricted_subcontract) { p.is_restricted_subcontract = row.is_restricted_subcontract; ch = true; filledFields++; }
        if (row.subcontract_scope && !p.subcontract_scope) { p.subcontract_scope = row.subcontract_scope; ch = true; filledFields++; }
        if (ch) updated++;
      }
    }
  }
  if (filledFields > 0) await db.save();
  console.log(`scanned summary files: ${scanned}, projects updated: ${updated}, fields filled: ${filledFields}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
