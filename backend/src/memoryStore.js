/**
 * 内存虚拟数据层（上线前测试专用）
 *
 * 用途：
 *   DB_DRIVER=memory 时，服务启动后把一份「标注清楚的模拟业务数据」载入内存，
 *   完全不读写磁盘（store.json / uploads 都不碰）。每次重启都是同一份干净数据，
 *   非常适合上线前的接口冒烟、权限隔离、统计/报告逻辑验证。
 *
 * 注意：
 *   - 这是一个「虚拟数据库」，仅供测试，绝不用于生产（生产用 json / mysql）。
 *   - 文件类元数据（files）仅作记录，磁盘上并不存在对应文件；uploads 受保护接口
 *     会按权限返回 401/403/404，不影响其它接口的测试。
 *   - 种子账号密码与 json 模式一致（admin/admin123、biz_gdw/123456 …），
 *     密码使用与 db.js 相同的预计算 bcrypt 哈希，避免启动时跑 bcrypt。
 */

// 与 db.js SEED_HASHES 保持一致（rounds=12）。如需重置密码，用 db.hashPassword 重新生成。
const SEED_HASHES = {
  admin:    '$2a$12$Mnma11Yl9XJYkusfhlUntOwKNfPnjFVHL7vsetWeD8P0ioxzfiYWC',
  biz_gdw:  '$2a$12$9pQjCD.aZxGtHifoANxXXO6W2jU0ktCL0Jbt8r364tapoid3QgHS6',
  biz_xt:   '$2a$12$lyq0ovz6zU9UdXfHWp1H3.xm6ckj9oAPMDvn235dCEtgrOW.8OQH2',
  rd_staff: '$2a$12$5uZxitJPgIRzcEhshFImse3ggZjjKH.sQCmKI81w4C8LOGVBkDmVi',
  expert01: '$2a$12$miQ//4wtkxh3fKGFib01AO3wDYpkjwAUIfl3tMIqCHKl2vThy.q42',
  cpa01:    '$2a$12$BhfSeCeNpvi8pZtT1smHOuOa9nlppHDLDRV11QfQvNPqBaPLrxUbG'
};

function mkUser(id, username, real_name, role, department, business_dept) {
  return {
    id, username,
    password: SEED_HASHES[username] || SEED_HASHES.admin,
    real_name, role, department, business_dept,
    created_at: '2026-04-01T08:00:00.000Z',
    is_active: true
  };
}

function build() {
  const users = [
    mkUser(1, 'admin', '系统管理员', 'admin', 'IT部', null),
    mkUser(2, 'biz_gdw', '电网事业部经办人', 'biz', '电网事业部', '电网事业部'),
    mkUser(3, 'biz_xt', '系统集成事业部经办人', 'biz', '系统集成事业部', '系统集成事业部'),
    mkUser(4, 'rd_staff', '研发中心员工', 'rd', '研发中心', null),
    mkUser(5, 'expert01', '评审专家A', 'expert', '评审专家库', null),
    mkUser(6, 'cpa01', '会计师事务所专家甲', 'accountant', '外部会计师事务所', null)
  ];

  const reviewSessions = [
    { id: 1, name: '2026年度Q3经济评审', status: 'in_progress', review_time: '2026-09-15 09:00', creator_id: 1, note: '虚拟数据批次', created_at: '2026-08-01T09:00:00.000Z' },
    { id: 2, name: '2026年度Q2经济评审', status: 'completed', review_time: '2026-06-20 14:00', creator_id: 1, note: '虚拟数据批次', created_at: '2026-06-01T09:00:00.000Z' }
  ];

  // 8 个项目，覆盖两个事业部、三种状态、5~9 月分布（用于月度趋势）
  const projects = [
    { id: 1, project_name: '电网项目A-主网基建', project_code: 'GW-2026-001', project_type: '基建', business_direction: '电网', product_direction: '输电', is_digital: false, business_sub_direction: '主网', contract_amount: 5800000, biz_department: '电网事业部', session_id: 1, description: '虚拟测试项目', contract_party: '某省电力公司', remark: '', status: 'completed', created_at: '2026-05-12T10:00:00.000Z', creator_id: 2 },
    { id: 2, project_name: '输电线路改造工程', project_code: 'GW-2026-002', project_type: '技改', business_direction: '电网', product_direction: '输电', is_digital: false, business_sub_direction: '配网', contract_amount: 3200000, biz_department: '电网事业部', session_id: 1, description: '虚拟测试项目', contract_party: '某市供电公司', remark: '', status: 'in_review', created_at: '2026-06-18T10:00:00.000Z', creator_id: 2 },
    { id: 3, project_name: '变电站智能运维平台', project_code: 'GW-2026-003', project_type: '信息化', business_direction: '电网', product_direction: '数字化', is_digital: true, business_sub_direction: '运维', contract_amount: 4100000, biz_department: '电网事业部', session_id: 2, description: '虚拟测试项目', contract_party: '某电网公司', remark: '', status: 'completed', created_at: '2026-07-05T10:00:00.000Z', creator_id: 2 },
    { id: 4, project_name: '农网升级改造', project_code: 'GW-2026-004', project_type: '基建', business_direction: '电网', product_direction: '配电', is_digital: false, business_sub_direction: '农网', contract_amount: 2600000, biz_department: '电网事业部', session_id: 1, description: '虚拟测试项目', contract_party: '某县供电公司', remark: '', status: 'draft', created_at: '2026-08-22T10:00:00.000Z', creator_id: 2 },

    { id: 5, project_name: '系统集成项目甲', project_code: 'XT-2026-001', project_type: '集成', business_direction: '系统集成', product_direction: '基础平台', is_digital: true, business_sub_direction: '平台', contract_amount: 7200000, biz_department: '系统集成事业部', session_id: 1, description: '虚拟测试项目', contract_party: '某政企客户', remark: '', status: 'completed', created_at: '2026-05-30T10:00:00.000Z', creator_id: 3 },
    { id: 6, project_name: '数据中心建设', project_code: 'XT-2026-002', project_type: '基建', business_direction: '系统集成', product_direction: '算力', is_digital: true, business_sub_direction: '数据中心', contract_amount: 9300000, biz_department: '系统集成事业部', session_id: 1, description: '虚拟测试项目', contract_party: '某国企', remark: '', status: 'in_review', created_at: '2026-06-10T10:00:00.000Z', creator_id: 3 },
    { id: 7, project_name: '云平台迁移', project_code: 'XT-2026-003', project_type: '集成', business_direction: '系统集成', product_direction: '云', is_digital: true, business_sub_direction: '迁移', contract_amount: 5400000, biz_department: '系统集成事业部', session_id: 2, description: '虚拟测试项目', contract_party: '某金融机构', remark: '', status: 'completed', created_at: '2026-07-15T10:00:00.000Z', creator_id: 3 },
    { id: 8, project_name: '办公网升级', project_code: 'XT-2026-004', project_type: '技改', business_direction: '系统集成', product_direction: '网络', is_digital: true, business_sub_direction: '办公', contract_amount: 1800000, biz_department: '系统集成事业部', session_id: 1, description: '虚拟测试项目', contract_party: '某事业单位', remark: '', status: 'draft', created_at: '2026-09-01T10:00:00.000Z', creator_id: 3 }
  ];

  // 工作项成本（category 取值须与 calculateCategoryCost 一致：
  // long_term / zhongshi / huazhao / outsourcing / subcontract）
  const workItems = [
    { id: 1, project_id: 1, work_task: '可研设计', work_item: '主网可研报告编制', category: 'long_term', cost: 380000, person_days: 30, unit_price: 12000, quantity: 1, remark: '虚拟' },
    { id: 2, project_id: 1, work_task: '设备采购', work_item: '变压器采购', category: 'zhongshi', cost: 2100000, person_days: 0, unit_price: 2100000, quantity: 1, remark: '虚拟' },
    { id: 3, project_id: 1, work_task: '施工安装', work_item: '主网线路施工', category: 'huazhao', cost: 1500000, person_days: 120, unit_price: 12500, quantity: 120, remark: '虚拟' },
    { id: 4, project_id: 2, work_task: '设计', work_item: '线路改造设计', category: 'long_term', cost: 240000, person_days: 20, unit_price: 12000, quantity: 1, remark: '虚拟' },
    { id: 5, project_id: 2, work_task: '施工', work_item: '线路改造施工', category: 'huazhao', cost: 1900000, person_days: 150, unit_price: 12600, quantity: 150, remark: '虚拟' },
    { id: 6, project_id: 3, work_task: '平台开发', work_item: '智能运维平台开发', category: 'outsourcing', cost: 2600000, person_days: 200, unit_price: 13000, quantity: 200, remark: '虚拟' },
    { id: 7, project_id: 3, work_task: '集成实施', work_item: '运维系统集成', category: 'subcontract', cost: 900000, person_days: 60, unit_price: 15000, quantity: 60, remark: '虚拟' },
    { id: 8, project_id: 5, work_task: '系统集成', work_item: '基础平台集成', category: 'zhongshi', cost: 3200000, person_days: 180, unit_price: 17700, quantity: 180, remark: '虚拟' },
    { id: 9, project_id: 6, work_task: '数据中心建设', work_item: '机房与算力建设', category: 'huazhao', cost: 5200000, person_days: 240, unit_price: 21600, quantity: 240, remark: '虚拟' },
    { id: 10, project_id: 7, work_task: '云迁移', work_item: '业务系统上云', category: 'outsourcing', cost: 2800000, person_days: 160, unit_price: 17500, quantity: 160, remark: '虚拟' },
    { id: 11, project_id: 8, work_task: '网络升级', work_item: '办公网设备更换', category: 'zhongshi', cost: 1200000, person_days: 40, unit_price: 30000, quantity: 40, remark: '虚拟' },
    { id: 12, project_id: 4, work_task: '农网施工', work_item: '农网线路改造', category: 'huazhao', cost: 1700000, person_days: 130, unit_price: 13000, quantity: 130, remark: '虚拟' }
  ];

  const procurementItems = [
    { id: 1, project_id: 1, item_name: '主变压器', spec: '220kV', amount: 2100000, supplier: '虚拟供应商甲', remark: '虚拟' },
    { id: 2, project_id: 6, item_name: '服务器机柜', spec: '42U', amount: 1200000, supplier: '虚拟供应商乙', remark: '虚拟' },
    { id: 3, project_id: 7, item_name: '云资源包', spec: '年度', amount: 900000, supplier: '虚拟云厂商', remark: '虚拟' }
  ];

  const travelItems = [
    { id: 1, project_id: 2, purpose: '现场勘察', person: '经办人', days: 5, amount: 6000, remark: '虚拟' },
    { id: 2, project_id: 5, purpose: '客户对接', person: '经办人', days: 3, amount: 4500, remark: '虚拟' },
    { id: 3, project_id: 8, purpose: '设备调试', person: '工程师', days: 4, amount: 5200, remark: '虚拟' }
  ];

  // 专家评估（expert_id 5=expert01，6=cpa01），关联到具体工作项
  const expertEstimates = [
    { id: 1, project_id: 1, work_item_id: 1, expert_id: 5, expert_name: '评审专家A', days: 28, comment: '虚拟评估', created_at: '2026-05-20T10:00:00.000Z' },
    { id: 2, project_id: 1, work_item_id: 3, expert_id: 5, expert_name: '评审专家A', days: 118, comment: '虚拟评估', created_at: '2026-05-20T10:05:00.000Z' },
    { id: 3, project_id: 5, work_item_id: 8, expert_id: 5, expert_name: '评审专家A', days: 175, comment: '虚拟评估', created_at: '2026-06-02T10:00:00.000Z' },
    { id: 4, project_id: 7, work_item_id: 10, expert_id: 5, expert_name: '评审专家A', days: 156, comment: '虚拟评估', created_at: '2026-07-18T10:00:00.000Z' },
    { id: 5, project_id: 1, work_item_id: 2, expert_id: 6, expert_name: '会计师事务所专家甲', days: 0, comment: '设备类不计人天', created_at: '2026-05-21T10:00:00.000Z' },
    { id: 6, project_id: 6, work_item_id: 9, expert_id: 6, expert_name: '会计师事务所专家甲', days: 235, comment: '虚拟评估', created_at: '2026-06-12T10:00:00.000Z' }
  ];

  const confirmations = [
    { id: 1, project_id: 1, work_item_id: 1, expert_id: 5, expert_name: '评审专家A', confirmed: true, comment: '认可', created_at: '2026-05-22T10:00:00.000Z' },
    { id: 2, project_id: 1, work_item_id: 3, expert_id: 5, expert_name: '评审专家A', confirmed: true, comment: '认可', created_at: '2026-05-22T10:05:00.000Z' },
    { id: 3, project_id: 5, work_item_id: 8, expert_id: 5, expert_name: '评审专家A', confirmed: false, comment: '偏高，建议复核', created_at: '2026-06-04T10:00:00.000Z' },
    { id: 4, project_id: 6, work_item_id: 9, expert_id: 6, expert_name: '会计师事务所专家甲', confirmed: true, comment: '认可', created_at: '2026-06-14T10:00:00.000Z' }
  ];

  // 文件元数据（磁盘上不存在对应文件，仅用于测试文件统计/权限接口）
  const files = [
    { id: 1, project_id: 1, originalname: '电网项目A-概算表.xlsx', uploader_id: 2, uploader_name: '电网事业部经办人', file_category: 'estimation', created_at: '2026-05-12T11:00:00.000Z' },
    { id: 2, project_id: 1, originalname: '电网项目A-合同.pdf', uploader_id: 2, uploader_name: '电网事业部经办人', file_category: 'contract', created_at: '2026-05-13T09:00:00.000Z' },
    { id: 3, project_id: 5, originalname: '系统集成项目甲-成本表.xlsx', uploader_id: 3, uploader_name: '系统集成事业部经办人', file_category: 'estimation', created_at: '2026-05-30T11:00:00.000Z' },
    { id: 4, project_id: 6, originalname: '数据中心建设-合同.pdf', uploader_id: 3, uploader_name: '系统集成事业部经办人', file_category: 'contract', created_at: '2026-06-10T11:00:00.000Z' }
  ];

  const workflowLogs = [
    { id: 1, project_id: 1, operator_id: 2, operator_role: 'biz', operator_name: '电网事业部经办人', action: 'create_project', remark: '创建项目：电网项目A-主网基建', created_at: '2026-05-12T10:00:00.000Z' },
    { id: 2, project_id: 1, operator_id: 5, operator_role: 'expert', operator_name: '评审专家A', action: 'submit_estimate', remark: '专家评审专家A评估工作项1: 28人天', created_at: '2026-05-20T10:00:00.000Z' },
    { id: 3, project_id: 1, operator_id: 5, operator_role: 'expert', operator_name: '评审专家A', action: 'submit_estimate', remark: '专家评审专家A评估工作项3: 118人天', created_at: '2026-05-20T10:05:00.000Z' },
    { id: 4, project_id: 5, operator_id: 3, operator_role: 'biz', operator_name: '系统集成事业部经办人', action: 'create_project', remark: '创建项目：系统集成项目甲', created_at: '2026-05-30T10:00:00.000Z' },
    { id: 5, project_id: 6, operator_id: 3, operator_role: 'biz', operator_name: '系统集成事业部经办人', action: 'create_project', remark: '创建项目：数据中心建设', created_at: '2026-06-10T10:00:00.000Z' }
  ];

  const userGroups = [];
  const userPermissions = [];

  return {
    users, reviewSessions, projects, workItems, procurementItems,
    travelItems, expertEstimates, confirmations, files, workflowLogs,
    userGroups, userPermissions, projectAssignments: []
  };
}

module.exports = { build, SEED_HASHES };
