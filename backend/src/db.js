/**
 * 数据层（可替换适配器）
 *
 * 当前默认实现：JSON 文件存储（适用于轻量部署 / 演示）。
 * 设计为「集合式」接口，未来接 MySQL 时只需新增一个实现并在 config.dbDriver 切换，
 * server.js 的业务逻辑无需改动。
 *
 * 安全性与健壮性：
 *  - 启动时把遗留明文密码自动迁移为 bcrypt（兼容旧 store.json）
 *  - 原子写入（先写 .tmp 再 rename），避免写一半进程被杀导致文件损坏
 *  - 损坏时自动回滚到最近一份备份，仍失败则回退到默认种子
 *  - 每次写入前做一次滚动备份（最多保留 30 份）
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('./config');
const memoryStore = require('./memoryStore');

const DATA_DIR = config.dataDir;
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const COLLECTIONS = [
  'users', 'reviewSessions', 'projects', 'workItems', 'procurementItems',
  'travelItems', 'expertEstimates', 'confirmations', 'files', 'workflowLogs',
  'userGroups', 'userPermissions'
];

// ---------- 密码 ----------
function hashPassword(pw) {
  return bcrypt.hashSync(String(pw), config.bcryptRounds);
}
function verifyPassword(pw, hash) {
  if (!hash) return false;
  // 已迁移的密码以 $2 开头，走 bcrypt；遗留明文仅作一次性回退（启动后即被迁移）
  if (hash.startsWith('$2')) return bcrypt.compareSync(String(pw), hash);
  return String(pw) === String(hash);
}

// 预计算的种子密码 bcrypt 哈希（rounds=12），避免每次启动都跑 bcrypt（约 6 次 × 1.5s 的浪费）。
// 需要重置默认密码时，用 hashPassword('新密码') 重新生成后替换对应值即可。
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
    // 优先用预计算哈希；新增种子用户若未登记哈希则即时生成（兜底）
    password: SEED_HASHES[username] || hashPassword('123456'),
    real_name, role, department, business_dept,
    created_at: new Date().toISOString(),
    is_active: true
  };
}
function defaultStore() {
  return {
    users: [
      mkUser(1, 'admin', '系统管理员', 'admin', 'IT部', null),
      mkUser(2, 'biz_gdw', '电网事业部经办人', 'biz', '电网事业部', '电网事业部'),
      mkUser(3, 'biz_xt', '系统集成事业部经办人', 'biz', '系统集成事业部', '系统集成事业部'),
      mkUser(4, 'rd_staff', '研发中心员工', 'rd', '研发中心', null),
      mkUser(5, 'expert01', '评审专家A', 'expert', '评审专家库', null),
      mkUser(6, 'cpa01', '会计师事务所专家甲', 'accountant', '外部会计师事务所', null)
    ],
    reviewSessions: [{
      id: 1, name: '2026年度Q3经济评审', status: 'in_progress',
      review_time: '2026-09-15 09:00', creator_id: 1, note: '示例批次',
      created_at: new Date().toISOString()
    }],
    projects: [], workItems: [], procurementItems: [], travelItems: [],
    expertEstimates: [], confirmations: [], files: [], workflowLogs: [],
    userGroups: [], userPermissions: []
  };
}

// ---------- 启动迁移 ----------
function migrate(s) {
  (s.users || []).forEach(u => {
    if (u.password && !u.password.startsWith('$2')) u.password = hashPassword(u.password);
    if (u.is_active === undefined) u.is_active = true;
  });
  return s;
}

let store = null;
let isMemory = false; // 虚拟数据模式：数据只活在内存，不落盘
let mysqlAdapter = null; // mysql 驱动适配器（懒加载，仅在 DB_DRIVER=mysql 时 require）

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
function latestBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return null;
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('store.') && f.endsWith('.json')).sort();
    return files.length ? path.join(BACKUP_DIR, files[files.length - 1]) : null;
  } catch { return null; }
}

function load() {
  // 虚拟数据模式：载入一份内置的模拟业务数据，不读写磁盘，重启即复原，专为上线前测试
  if (config.dbDriver === 'memory') {
    store = memoryStore.build();
    migrate(store);
    isMemory = true;
    console.log('[db] 已加载内存虚拟数据集（DB_DRIVER=memory），不落盘，仅用于测试');
    return Promise.resolve();
  }
  // MySQL 模式：启动时从数据库整表载入内存；save() 异步刷回。load 为异步，server.js 需 await 后再 listen
  if (config.dbDriver === 'mysql') {
    mysqlAdapter = require('./db.mysql');
    return Promise.resolve()
      .then(() => mysqlAdapter.load())
      .then(s => {
        store = s;
        migrate(store);
        console.log('[db] 已从 MySQL 载入数据（DB_DRIVER=mysql）');
        return;
      })
      .catch(err => {
        console.error('[db] MySQL 载入失败:', err && err.message);
        throw err; // 交由 server.js 启动逻辑决定退出
      });
  }
  ensureDirs();
  if (!fs.existsSync(STORE_FILE)) {
    store = defaultStore();
    persist(store);
    return;
  }
  try {
    const loaded = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const defaults = defaultStore();
    const merged = { ...defaults, ...loaded };
    COLLECTIONS.forEach(c => { if (!Array.isArray(merged[c])) merged[c] = defaults[c] || []; });
    migrate(merged);
    store = merged;
  } catch (e) {
    console.error('[db] store.json 解析失败，尝试从备份恢复:', e.message);
    const bak = latestBackup();
    if (bak) {
      try {
        store = JSON.parse(fs.readFileSync(bak, 'utf8'));
        migrate(store);
        console.warn('[db] 已从备份恢复:', bak);
      } catch { store = defaultStore(); }
    } else {
      console.error('[db] 无可用备份，回退到默认种子数据');
      store = defaultStore();
    }
  }
  // 启动后落盘一次，确保明文密码已完成迁移
  persist(store);
  return Promise.resolve();
}

function persist(s) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.copyFileSync(STORE_FILE, path.join(BACKUP_DIR, `store.${ts}.json`)); } catch (_) {}
      // 清理超过 30 份的旧备份
      try {
        const olds = fs.readdirSync(BACKUP_DIR)
          .filter(f => f.startsWith('store.') && f.endsWith('.json')).sort();
        while (olds.length > 30) {
          const old = olds.shift();
          try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (_) {}
        }
      } catch (_) {}
    }
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, STORE_FILE); // POSIX 下 rename 是原子操作
  } catch (e) {
    console.error('[db] 持久化失败:', e.message);
  }
}

function save() {
  // 虚拟数据模式不落盘（数据只在内存，重启复原）
  if (isMemory) return;
  // MySQL 模式：异步刷回数据库；串行化与错误吞掉都在适配器内处理，这里只 fire-and-forget，
  // 避免阻塞请求；若真写库失败，适配器会 console.error 报警，不崩进程。
  if (config.dbDriver === 'mysql' && mysqlAdapter) {
    mysqlAdapter.save(store).catch(e => console.error('[db.mysql] 保存失败:', e && e.message));
    return;
  }
  // 单进程下同步写入即可保证原子性；多实例部署请切换 DB_DRIVER=mysql
  persist(store);
}

// ---------- 通用工具 ----------
function nextId(arr) {
  if (!arr || arr.length === 0) return 1;
  return Math.max(...arr.map(x => x.id || 0)) + 1;
}

// 数据隔离：按用户角色过滤项目集合（根因修复：项目用 biz_department，用户用 business_dept）
function filterByDept(key, user) {
  const list = store[key] || [];
  if (user.role === 'admin' || user.role === 'rd') return list;
  if (user.role === 'biz') {
    if (!user.business_dept) return []; // 无事业部归属的经办人看不到任何项目
    return list.filter(item => item.biz_department === user.business_dept);
  }
  if (user.role === 'expert' || user.role === 'accountant') {
    const assigned = new Set(
      store.expertEstimates.filter(e => e.expert_id === user.id).map(e => e.project_id)
    );
    return list.filter(item => assigned.has(item.id));
  }
  return [];
}

function logWorkflow(projectId, action, remark, userId) {
  const user = store.users.find(u => u.id === userId);
  store.workflowLogs.push({
    id: nextId(store.workflowLogs),
    project_id: projectId,
    operator_id: userId,
    operator_role: user ? user.role : 'unknown',
    operator_name: user ? user.real_name : '未知',
    action, remark,
    created_at: new Date().toISOString()
  });
  save();
}

module.exports = {
  config, COLLECTIONS, hashPassword, verifyPassword,
  load, save, nextId, filterByDept, logWorkflow, migrate,
  get store() { return store; }
};
