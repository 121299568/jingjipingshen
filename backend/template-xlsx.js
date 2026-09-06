/**
 * 经济评审项目 Excel 导入模板生成器
 * 生成的 workbook 结构与 parse-excel.js 期望的表名/列位置一致，
 * 用户拿到后按示例行填数即可导入。
 */
const XLSX = require('xlsx');

function buildImportTemplate() {
  const wb = XLSX.utils.book_new();

  // ===== 1. 项目基本信息 =====
  // parse-excel.js 读取位置（0-based）：
  // project_name (1,1), biz_department (2,1), project_type (3,1), business_direction (4,1),
  // product_direction (5,1), contract_amount (5,3)
  const basic = XLSX.utils.aoa_to_sheet([
    ['项目标签', '项目值', '', '项目标签', '项目值'],
    ['项目名称', '（填写项目名称）', '', '项目编号', '2025001'],
    ['事业部', '（填写事业部）', '', '是否数字化', '是/否'],
    ['项目类型', '（填写类型）', '', '业务子方向', '（填写）'],
    ['业务方向', '（填写方向）', '', '产品方向', '（填写）'],
    ['', '（产品方向占位，勿删）', '', '合同金额', '0'],
  ]);
  XLSX.utils.book_append_sheet(wb, basic, '项目基本信息');

  // ===== 2. 人员成本明细（4 类 + 专业分包） =====
  // staff 表：从第 3 行（0-based r=2）开始读；列 A 占位/合计过滤，B 工作任务，C 工作项，D 描述，E 人天，F 人员，G 费用
  const staffHeader = [
    ['编号', '工作任务', '工作项', '描述', '人天', '人员', '费用'],
    ['', '', '', '', '', '', ''],
  ];
  const staffSheets = [
    { name: '长期职工成本估算', category: 'long_term' },
    { name: '中实职工成本估算', category: 'zhongshi' },
    { name: '华兆职工成本估算', category: 'huazhao' },
    { name: '人员外包成本估算', category: 'outsourcing' },
  ];
  for (const { name } of staffSheets) {
    const ws = XLSX.utils.aoa_to_sheet([
      ...staffHeader,
      ['', '（示例任务）', '（示例工作项）', '（说明）', '0', '（姓名）', '0'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  // 专业分包：列 A 占位，B 任务，C 工作项，D 描述，E 人天，F 费用，G-K 专家1-5，L 平均，M 调整后费用
  const subcontract = XLSX.utils.aoa_to_sheet([
    ['编号', '工作任务', '工作项', '描述', '人天', '费用', '专家1', '专家2', '专家3', '专家4', '专家5', '平均', '调整后费用'],
    ['', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '（示例任务）', '（示例工作项）', '（说明）', '0', '0', '0', '0', '0', '0', '0', '0', '0'],
  ]);
  XLSX.utils.book_append_sheet(wb, subcontract, '专业分包成本估算');

  // ===== 3. 采购成本估算 =====
  // 结构：r0 表头；r1 写「软件」标签；r3 起软件项；之后写「硬件」标签；再两行后硬件项
  const procure = XLSX.utils.aoa_to_sheet([
    ['类别', '名称', '规格', '单位', '数量', '单价', '小计', '备注'],
    ['软件', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['', '（软件项名称）', '（规格）', '套', '0', '0', '0', ''],
    ['', '', '', '', '', '', '', ''],
    ['硬件', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['', '（硬件项名称）', '（规格）', '台', '0', '0', '0', ''],
  ]);
  XLSX.utils.book_append_sheet(wb, procure, '采购成本估算');

  // ===== 4. 差旅费估算 =====
  const travel = XLSX.utils.aoa_to_sheet([
    ['序号', '出差目的', '目的地', '天数', '住宿', '补助', '交通'],
    ['', '', '', '', '', '', ''],
    ['', '（示例出差）', '（目的地）', '0', '0', '0', '0'],
  ]);
  XLSX.utils.book_append_sheet(wb, travel, '差旅费估算');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildImportTemplate };
