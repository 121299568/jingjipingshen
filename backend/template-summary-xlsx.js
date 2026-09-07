/**
 * 评审汇总表（批次级）导入模板生成器
 * 结构对齐用户提供的「XXXX年第X批经济评审汇总表.xlsx」：
 *   汇总表 sheet：
 *     第 1 行（合并标题）: （示例）第十四批经济评审
 *     第 2 行（表头）: 序号 | 项目编号 | 项目名称 | 项目承建部门 | 项目类型 | 合同额（元） | 内部信息系统填报预估成本（元）
 *     第 3+ 行: 示例项目明细
 */
const XLSX = require('xlsx');

function buildSummaryTemplate() {
  const wb = XLSX.utils.book_new();
  const aoa = [
    ['（示例）第十四批经济评审', '', '', '', '', '', ''],
    ['序号', '项目编号', '项目名称', '项目承建部门', '项目类型', '合同额（元）', '内部信息系统填报预估成本（元）'],
    [1, 'XM20260001', '示例项目名称一', '某事业部（赋能中心）', '施工类项目', 15200000, 13665901.36],
    [2, 'XM20260002', '示例项目名称二', '某事业部（赋能中心）', '数字化类项目', 1427000, 1212604.43]
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
  XLSX.utils.book_append_sheet(wb, ws, '汇总表');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildSummaryTemplate };
