/**
 * MySQL 数据层适配器（DB_DRIVER=mysql）
 *
 * 设计：把 12 个集合「整表载入内存」作为进程内缓存，server.js 全部逻辑不变（仍同步读写内存），
 * 每次 db.save() 再把变更回写 MySQL。
 *   - 启动时 ensureSchema() 自动建表（含 extra JSON 溢出列），无需手动执行 db.sql
 *   - 启动时从 MySQL 载入 → 内存即真实数据
 *   - 每次写操作落内存后 db.save() 异步刷回 MySQL（串行化，避免并发 REPLACE 死锁）
 *   - 进程重启后从 MySQL 重新载入 → 数据不丢（解决 json 模式 Render 重启即丢的痛点）
 *
 * 字段兜底：每张表除已知列外还有 extra JSON 列，server.js 写入的任何“未预定义字段”
 * （例如文件的 filename/file_seq、项目的 source_file）都会自动落入 extra，绝不会静默丢失。
 *
 * 多实例/多进程部署不支持（内存会分叉），正式多节点请改用真正的 ORM/查询层。
 */

const mysql = require('mysql2/promise');
const config = require('./config');
const memoryStore = require('./memoryStore');

// ---------- 列类型（与 CREATE TABLE 一致）----------
const COL_TYPE = {
  id: 'INT NOT NULL AUTO_INCREMENT',
  username: 'VARCHAR(64) NOT NULL',
  password: 'VARCHAR(255) NOT NULL',
  real_name: 'VARCHAR(64) NOT NULL DEFAULT ""',
  role: 'VARCHAR(32) NOT NULL DEFAULT "rd"',
  department: 'VARCHAR(64) NOT NULL DEFAULT ""',
  business_dept: 'VARCHAR(64) DEFAULT NULL',
  created_at: 'VARCHAR(32) DEFAULT NULL',
  updated_at: 'VARCHAR(32) DEFAULT NULL',
  is_active: 'TINYINT(1) NOT NULL DEFAULT 1',
  name: 'VARCHAR(128) NOT NULL DEFAULT ""',
  status: 'VARCHAR(32) NOT NULL DEFAULT "pending"',
  review_time: 'VARCHAR(64) DEFAULT NULL',
  creator_id: 'INT DEFAULT NULL',
  note: 'VARCHAR(255) DEFAULT NULL',
  project_name: 'VARCHAR(255) NOT NULL DEFAULT ""',
  project_code: 'VARCHAR(64) DEFAULT NULL',
  project_type: 'VARCHAR(64) DEFAULT NULL',
  business_direction: 'VARCHAR(64) DEFAULT NULL',
  product_direction: 'VARCHAR(64) DEFAULT NULL',
  is_digital: 'TINYINT(1) NOT NULL DEFAULT 0',
  business_sub_direction: 'VARCHAR(64) DEFAULT NULL',
  contract_amount: 'DOUBLE NOT NULL DEFAULT 0',
  biz_department: 'VARCHAR(64) DEFAULT NULL',
  session_id: 'INT DEFAULT NULL',
  description: 'TEXT',
  contract_party: 'VARCHAR(255) DEFAULT NULL',
  remark: 'TEXT',
  project_id: 'INT DEFAULT NULL',
  work_task: 'VARCHAR(128) DEFAULT NULL',
  work_item: 'VARCHAR(255) DEFAULT NULL',
  category: 'VARCHAR(32) DEFAULT NULL',
  cost: 'DOUBLE NOT NULL DEFAULT 0',
  person_days: 'DOUBLE NOT NULL DEFAULT 0',
  unit_price: 'DOUBLE NOT NULL DEFAULT 0',
  quantity: 'DOUBLE NOT NULL DEFAULT 0',
  item_name: 'VARCHAR(255) DEFAULT NULL',
  spec: 'VARCHAR(128) DEFAULT NULL',
  amount: 'DOUBLE NOT NULL DEFAULT 0',
  supplier: 'VARCHAR(128) DEFAULT NULL',
  purpose: 'VARCHAR(128) DEFAULT NULL',
  person: 'VARCHAR(64) DEFAULT NULL',
  days: 'DOUBLE NOT NULL DEFAULT 0',
  work_item_id: 'INT DEFAULT NULL',
  expert_id: 'INT DEFAULT NULL',
  expert_name: 'VARCHAR(64) DEFAULT NULL',
  comment: 'VARCHAR(255) DEFAULT NULL',
  confirmed: 'TINYINT(1) NOT NULL DEFAULT 0',
  originalname: 'VARCHAR(255) DEFAULT NULL',
  uploader_id: 'INT DEFAULT NULL',
  uploader_name: 'VARCHAR(64) DEFAULT NULL',
  file_category: 'VARCHAR(32) DEFAULT NULL',
  filename: 'VARCHAR(255) DEFAULT NULL',
  file_seq: 'INT DEFAULT NULL',
  file_type: 'VARCHAR(16) DEFAULT NULL',
  auto_detected: 'TINYINT(1) NOT NULL DEFAULT 0',
  upload_time: 'VARCHAR(32) DEFAULT NULL',
  operator_id: 'INT DEFAULT NULL',
  operator_role: 'VARCHAR(32) DEFAULT NULL',
  operator_name: 'VARCHAR(64) DEFAULT NULL',
  action: 'VARCHAR(64) DEFAULT NULL',
  user_id: 'INT NOT NULL DEFAULT 0',
  user_role: 'VARCHAR(32) DEFAULT NULL',
  user_name: 'VARCHAR(64) DEFAULT NULL',
  assigned_by: 'INT DEFAULT NULL',
  assigned_at: 'VARCHAR(32) DEFAULT NULL',
  permissions: 'JSON DEFAULT NULL',
  extra: 'JSON DEFAULT NULL'
};

// ---------- 集合 → 表定义 ----------
// cols：已知列（参与 REPLACE 与映射）；bool/num：类型转换；json：JSON 序列化列；indexes：建表索引
const SCHEMA = {
  users: {
    table: 'users',
    cols: ['id', 'username', 'password', 'real_name', 'role', 'department', 'business_dept', 'created_at', 'is_active'],
    bool: ['is_active'], num: ['id'], indexes: ['UNIQUE KEY `uk_username` (`username`)']
  },
  reviewSessions: {
    table: 'reviewSessions',
    cols: ['id', 'name', 'status', 'review_time', 'creator_id', 'note', 'created_at'],
    bool: [], num: ['id', 'creator_id'], indexes: []
  },
  projects: {
    table: 'projects',
    cols: ['id', 'project_name', 'project_code', 'project_type', 'business_direction', 'product_direction',
      'is_digital', 'business_sub_direction', 'contract_amount', 'biz_department', 'session_id',
      'description', 'contract_party', 'remark', 'status', 'created_at', 'creator_id', 'updated_at'],
    bool: ['is_digital'], num: ['id', 'contract_amount', 'session_id', 'creator_id'],
    indexes: ['KEY `idx_biz_department` (`biz_department`)', 'KEY `idx_session_id` (`session_id`)']
  },
  workItems: {
    table: 'workItems',
    cols: ['id', 'project_id', 'work_task', 'work_item', 'category', 'cost', 'person_days', 'unit_price', 'quantity', 'remark'],
    bool: [], num: ['id', 'project_id', 'cost', 'person_days', 'unit_price', 'quantity'],
    indexes: ['KEY `idx_project_id` (`project_id`)']
  },
  procurementItems: {
    table: 'procurementItems',
    cols: ['id', 'project_id', 'item_name', 'spec', 'amount', 'supplier', 'remark'],
    bool: [], num: ['id', 'project_id', 'amount'],
    indexes: ['KEY `idx_project_id` (`project_id`)']
  },
  travelItems: {
    table: 'travelItems',
    cols: ['id', 'project_id', 'purpose', 'person', 'days', 'amount', 'remark'],
    bool: [], num: ['id', 'project_id', 'days', 'amount'],
    indexes: ['KEY `idx_project_id` (`project_id`)']
  },
  expertEstimates: {
    table: 'expertEstimates',
    cols: ['id', 'project_id', 'work_item_id', 'expert_id', 'expert_name', 'days', 'comment', 'created_at'],
    bool: [], num: ['id', 'project_id', 'work_item_id', 'expert_id', 'days'],
    indexes: ['KEY `idx_project_id` (`project_id`)', 'KEY `idx_expert_id` (`expert_id`)']
  },
  confirmations: {
    table: 'confirmations',
    cols: ['id', 'project_id', 'work_item_id', 'expert_id', 'expert_name', 'confirmed', 'comment', 'created_at'],
    bool: ['confirmed'], num: ['id', 'project_id', 'work_item_id', 'expert_id'],
    indexes: ['KEY `idx_project_id` (`project_id`)']
  },
  files: {
    table: 'files',
    cols: ['id', 'project_id', 'filename', 'originalname', 'file_seq', 'file_type', 'file_category',
      'auto_detected', 'uploader_id', 'uploader_name', 'description', 'upload_time'],
    bool: ['auto_detected'], num: ['id', 'project_id', 'file_seq', 'uploader_id'],
    indexes: ['KEY `idx_project_id` (`project_id`)']
  },
  workflowLogs: {
    table: 'workflowLogs',
    cols: ['id', 'project_id', 'operator_id', 'operator_role', 'operator_name', 'action', 'remark', 'created_at'],
    bool: [], num: ['id', 'project_id', 'operator_id'],
    indexes: ['KEY `idx_project_id` (`project_id`)']
  },
  userGroups: {
    table: 'userGroups',
    cols: ['id', 'name', 'description', 'created_at'],
    bool: [], num: ['id'], indexes: []
  },
  userPermissions: {
    table: 'userPermissions',
    cols: ['id', 'user_id', 'permissions'],
    bool: [], num: ['id', 'user_id'], json: ['permissions'],
    indexes: ['KEY `idx_user_id` (`user_id`)']
  },
  projectAssignments: {
    table: 'projectAssignments',
    cols: ['id', 'project_id', 'user_id', 'user_role', 'user_name', 'assigned_by', 'assigned_at'],
    bool: [], num: ['id', 'project_id', 'user_id', 'assigned_by'],
    indexes: ['KEY `idx_project_id` (`project_id`)', 'KEY `idx_user_id` (`user_id`)']
  }
};

const COLLECTIONS = Object.keys(SCHEMA);

// ---------- 连接池 ----------
let pool = null;
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 10,
      enableKeepAlive: true
    });
  }
  return pool;
}

// ---------- 类型转换 ----------
// 关键兜底：MySQL 部分列声明为 NOT NULL（如 contract_amount DOUBLE NOT NULL DEFAULT 0）。
// 若应用层未给值而直接 REPLACE NULL，会触发 "Column ... cannot be null" 并让整批保存失败、
// 被 .catch 吞掉 -> 数据只存在于内存、重启即丢。
// 因此：缺失值时，对 NOT NULL 列按类型补 0 / ''，对可空列保持 NULL。
function isNotNull(col) {
  const t = COL_TYPE[col];
  return !!(t && t.includes('NOT NULL'));
}
function toVal(col, def, row) {
  const v = row == null ? null : row[col];
  if (def.json && def.json.includes(col)) {
    if (v == null) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  if (def.bool.includes(col)) return v ? 1 : 0;
  if (def.num.includes(col)) {
    if (v == null) return isNotNull(col) ? 0 : null;
    const n = Number(v);
    return isFinite(n) ? n : (isNotNull(col) ? 0 : null);
  }
  // 其余按字符串处理：NOT NULL 列给空串兜底，避免 cannot be null
  if (v === null || v === undefined) return isNotNull(col) ? '' : null;
  return String(v);
}
function fromVal(col, def, raw) {
  if (def.json && def.json.includes(col)) {
    if (raw == null) return null;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return raw; } }
    return raw;
  }
  if (def.bool.includes(col)) return !!raw;
  if (def.num.includes(col)) return raw == null ? null : Number(raw);
  return raw;
}

function rowToObj(def, r) {
  const o = {};
  for (const c of def.cols) o[c] = fromVal(c, def, r[c]);
  // extra 溢出列：把未知字段平铺回对象，应用层无需感知
  if (r.extra != null) {
    try {
      const ex = (typeof r.extra === 'string') ? JSON.parse(r.extra) : r.extra;
      if (ex && typeof ex === 'object') Object.assign(o, ex);
    } catch (_) { /* 损坏的 extra 忽略 */ }
  }
  return o;
}
function extraOf(def, row) {
  const ex = {};
  for (const k of Object.keys(row)) if (!def.cols.includes(k)) ex[k] = row[k];
  return Object.keys(ex).length ? JSON.stringify(ex) : null;
}

// ---------- 自动建表 ----------
function ddlFor(name) {
  const def = SCHEMA[name];
  const cols = def.cols.filter(c => c !== 'id')
    .map(c => `  \`${c}\` ${COL_TYPE[c]}`).join(',\n');
  const idx = (def.indexes || []).map(i => `  ${i}`).join(',\n');
  const parts = [
    `  \`id\` ${COL_TYPE.id}`,
    cols,
    `  \`extra\` ${COL_TYPE.extra}`,
    '  PRIMARY KEY (`id`)',
    idx
  ].filter(Boolean).join(',\n');
  return `CREATE TABLE IF NOT EXISTS \`${def.table}\` (\n${parts}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
}

async function ensureSchema(p) {
  for (const name of COLLECTIONS) {
    await p.query(ddlFor(name));
  }
}

// ---------- 载入 ----------
async function load() {
  const p = getPool();
  await ensureSchema(p);
  const store = {};
  for (const name of COLLECTIONS) {
    const def = SCHEMA[name];
    const [rows] = await p.query(`SELECT * FROM \`${def.table}\``);
    store[name] = rows.map(r => rowToObj(def, r));
    savedSnap[name] = JSON.stringify(store[name]);
  }
  if (!store.users || store.users.length === 0) {
    await seedDefaults(p);
    const [u] = await p.query('SELECT * FROM `users`');
    store.users = u.map(r => rowToObj(SCHEMA.users, r));
    savedSnap.users = JSON.stringify(store.users);
  }
  return store;
}

// 仅种入默认账号 + 一个默认批次，绝不灌入测试业务数据（测试数据请走 memory 驱动）
async function seedDefaults(p) {
  const H = memoryStore.SEED_HASHES;
  const now = new Date().toISOString();
  const users = [
    { id: 1, username: 'admin', password: H.admin, real_name: '系统管理员', role: 'admin', department: 'IT部', business_dept: null, created_at: now, is_active: true },
    { id: 2, username: 'biz_gdw', password: H.biz_gdw, real_name: '电网事业部经办人', role: 'biz', department: '电网事业部', business_dept: '电网事业部', created_at: now, is_active: true },
    { id: 3, username: 'biz_xt', password: H.biz_xt, real_name: '系统集成事业部经办人', role: 'biz', department: '系统集成事业部', business_dept: '系统集成事业部', created_at: now, is_active: true },
    { id: 4, username: 'rd_staff', password: H.rd_staff, real_name: '研发中心员工', role: 'rd', department: '研发中心', business_dept: null, created_at: now, is_active: true },
    { id: 5, username: 'expert01', password: H.expert01, real_name: '评审专家A', role: 'expert', department: '评审专家库', business_dept: null, created_at: now, is_active: true },
    { id: 6, username: 'cpa01', password: H.cpa01, real_name: '会计师事务所专家甲', role: 'accountant', department: '外部会计师事务所', business_dept: null, created_at: now, is_active: true }
  ];
  const session = { id: 1, name: '2026年度Q3经济评审', status: 'in_progress', review_time: '2026-09-15 09:00', creator_id: 1, note: '默认批次', created_at: now };
  for (const u of users) await writeRow(p, SCHEMA.users, u);
  await writeRow(p, SCHEMA.reviewSessions, session);
}

async function writeRow(p, def, row) {
  const cols = [...def.cols, 'extra'];
  const colList = cols.map(c => `\`${c}\``).join(',');
  const placeholders = cols.map(() => '?').join(',');
  const vals = def.cols.map(c => toVal(c, def, row));
  vals.push(extraOf(def, row));
  await p.query(`REPLACE INTO \`${def.table}\` (${colList}) VALUES (${placeholders})`, vals);
}

// ---------- 保存（串行化，避免并发 REPLACE 死锁）----------
let saveChain = Promise.resolve();
const savedSnap = {};

async function doSave(p, store) {
  for (const name of COLLECTIONS) {
    const rows = store[name] || [];
    const snap = JSON.stringify(rows);
    if (savedSnap[name] === snap) continue; // 无变化则跳过，减少 DB 压力
    try {
      const def = SCHEMA[name];
      const table = def.table;
      const cols = [...def.cols, 'extra'];
      const colList = cols.map(c => `\`${c}\``).join(',');
      const placeholders = cols.map(() => '?').join(',');
      const sql = `REPLACE INTO \`${table}\` (${colList}) VALUES (${placeholders})`;
      for (const row of rows) {
        const vals = def.cols.map(c => toVal(c, def, row));
        vals.push(extraOf(def, row));
        await p.query(sql, vals);
      }
      // 删除内存中已不存在的孤儿行（支持删项目/删用户等真正落库）
      const ids = rows.map(r => r.id).filter(id => id != null);
      if (ids.length === 0) {
        await p.query(`DELETE FROM \`${table}\``);
      } else {
        await p.query(`DELETE FROM \`${table}\` WHERE id NOT IN (?)`, [ids]);
      }
      savedSnap[name] = snap;
    } catch (e) {
      // 单个集合保存失败不应连累其他集合；记录后继续，下一轮 save 会重试
      console.error(`[db.mysql] 集合 ${name} 保存失败（已跳过，下一轮重试）:`, e.message);
    }
  }
}

function save(store) {
  const p = getPool();
  const run = () => doSave(p, store).catch(e => console.error('[db.mysql] 保存失败:', e.message));
  saveChain = saveChain.then(run, run);
  return saveChain;
}

module.exports = { load, save, getPool, SCHEMA, ddlFor, rowToObj, extraOf, toVal, fromVal };
