/**
 * 年终经济评审工作汇报数据（由 docx 提取，固化进仓库）。
 * 字段：title/department/date/paragraphs[]/tables[]（每张表含 index 与 rows[][]）。
 * 统计分析报告生成时自动附加上去，保证「工作汇报」全部信息落入报告。
 */
module.exports = require('./work-report-data.json');
