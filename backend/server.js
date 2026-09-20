/**
 * 经济评审管理系统后端 v4
 * 安全加固 + 数据隔离 + 功能修复 + 移动端就绪
 * 数据层见 src/db.js，配置见 src/config.js
 */
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const XLSX = require('xlsx');

const config = require('./src/config');
const db = require('./src/db');
const workReport = require('./work-report');

const app = express();
const PORT = config.port;

const DATA_DIR = config.dataDir;
const UPLOAD_DIR = config.uploadDir;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// 数据载入（json/memory 同步完成，mysql 异步从库载入）。载入成功后再启动 HTTP 监听。
// 数据载入（json/memory 同步完成，mysql 异步从库载入）。载入成功后再启动 HTTP 监听。
//
// 2026-09-20 改造：原实现为 db.load() 失败即 process.exit(1)。
// 机器重启时 PM2 往往先于 MySQL 完成初始化而拉起本进程，此时加载必然失败并自杀，
// 快速连败会耗尽 PM2 的重启配额，服务随后彻底躺平 —— 表现为「重启后 lnsoft 打不开」。
// 改为指数退避重试：最多 12 次、累计约 84 秒，足以覆盖 MySQL 冷启动时间。
const LOAD_MAX_ATTEMPTS = 12;
const LOAD_BASE_DELAY_MS = 2000;

async function loadDataWithRetry() {
  let lastErr;
  for (let attempt = 1; attempt <= LOAD_MAX_ATTEMPTS; attempt++) {
    try {
      await db.load();
      return;
    } catch (err) {
      lastErr = err;
      const delay = Math.min(LOAD_BASE_DELAY_MS * attempt, 8000);
      console.error(
        `[启动] 数据加载失败（第 ${attempt}/${LOAD_MAX_ATTEMPTS} 次）：${err && err.message}；${delay}ms 后重试`
      );
      if (attempt < LOAD_MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  console.error('[启动失败] 数据加载重试次数耗尽，服务未启动:', lastErr && lastErr.message);
  process.exit(1);
}

loadDataWithRetry().then(startServer).catch(err => {
  console.error('[启动失败] 数据加载出错，服务未启动:', err && err.message);
  process.exit(1);
});

// ==================== 中间件 ====================
// Helmet 默认 CSP 为 script-src 'self' + script-src-attr 'none'，会拦截本系统的内联脚本、
// 内联事件处理器(onclick) 以及 jsdelivr CDN 脚本，导致页面能显示但 JS 全不执行。
// 这里关闭默认策略并显式放行：内联脚本/事件 + jsdelivr CDN（bootstrap/chart.js）。
// 本服务运行在 nginx 反向代理之后，必须信任一级代理，req.ip 才能取到真实客户端 IP。
// 否则 express-rate-limit 检测到 X-Forwarded-For 已设置而 trust proxy=false，
// 每次请求抛 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR，登录限流退化为按代理 IP(127.0.0.1)
// 计数 —— 全体用户共用一个桶，一人刷爆则全网无法登录。
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "https:", "data:"],
      connectSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"]
    }
  }
}));
const corsOpts = config.corsOrigins.length
  ? { origin: config.corsOrigins, credentials: true }
  : { origin: true, credentials: true };
app.use(cors(corsOpts));
app.use(express.json({ limit: '50mb' }));

// 登录限流（防爆破）
const loginLimiter = rateLimit({
  windowMs: config.loginRateWindowMs,
  max: config.loginRateMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请稍后再试' }
});

// ==================== 鉴权 ====================
function sign(payload) {
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Date.now() + config.jwtExpiresIn * 1000
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token) {
  try {
    const [body, sig] = (token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', config.jwtSecret).update(body).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// 支持 Header（Bearer）或 Query（?token=，便于浏览器直接下载）
function auth(requiredRoles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    const user = token ? verify(token) : null;
    if (!user) return res.status(401).json({ error: '未登录或token过期' });
    req.user = user;
    if (requiredRoles && !requiredRoles.includes(user.role)) {
      return res.status(403).json({ error: '无权限操作' });
    }
    next();
  };
}

// 解析用户实际权限：admin 拥有全部；其余按 userPermissions 记录，无记录则用角色的默认权限
function resolveUserPermissions(user) {
  if (user.role === 'admin') return PERMISSION_OPTIONS.map(p => p.code);
  const perm = db.store.userPermissions.find(p => p.user_id === user.id);
  if (perm && Array.isArray(perm.permissions)) return perm.permissions;
  return PERMISSION_OPTIONS.filter(p => p.default_roles && p.default_roles.includes(user.role)).map(p => p.code);
}

function pick(obj, allowed) {
  const r = {};
  for (const k of allowed) if (obj[k] !== undefined) r[k] = obj[k];
  return r;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ==================== 工具 ====================
function decodeFilename(name) {
  try { return Buffer.from(name, 'latin1').toString('utf8'); } catch { return name; }
}
function inferFileCategory(filename) {
  const name = filename || '';
  if (/估算|概算|预算|成本|成本.*表|成本测算|成本分劈|成本评估|成本外包|分包成本|测算|评估|工作量|报价|cost.*estimat|estimat/i.test(name)) return 'estimation';
  if (/可研|可行性|研究报|feasib/i.test(name)) return 'feasibility';
  if (/利润|利润率|profit/i.test(name)) return 'profit';
  if (/招标|投标|bid|tender/i.test(name)) return 'bid';
  if (/中标|中选|award|winning/i.test(name)) return 'award';
  if (/询价|询比|采购协议|物资采购|招标采购|采购文件|报价单/i.test(name)) return 'inquiry';
  if (/合同|协议|contract|agreement/i.test(name)) return 'contract';
  if (/分包|subcontract|外包/i.test(name)) return 'subcontract';
  if (/技术.*规范|规范.*书|技术.*规格|tech.*spec|specif/i.test(name)) return 'tech_spec';
  return 'other';
}
function getFileCategoryName(cat) {
  const map = {
    estimation: '估算表', feasibility: '可研报告', bid: '招标文件',
    award: '中标通知书', contract: '合同文件', profit: '利润率评审表',
    subcontract: '分包申请表', tech_spec: '技术规范书', inquiry: '询价单/采购协议', other: '其他'
  };
  return map[cat] || cat || '其他';
}
function generateFileSeq(projectId) {
  return String(db.store.files.filter(f => f.project_id === projectId).length + 1).padStart(2, '0');
}
function calculateCategoryCost(items) {
  const cost = { long_term: 0, zhongshi: 0, huazhao: 0, outsourcing: 0, subcontract: 0 };
  items.forEach(w => { if (cost[w.category] !== undefined) cost[w.category] += Number(w.cost || 0); });
  return cost;
}
function lastOperationAt(projectId) {
  const logs = db.store.workflowLogs.filter(l => l.project_id === projectId);
  if (!logs.length) return null;
  return logs.sort((a, b) => new Date(b.created_at || b.operated_at || 0) - new Date(a.created_at || a.operated_at || 0))[0].created_at || null;
}
function enrichProject(p) {
  if (!p) return p;
  return { ...p, last_operation_at: lastOperationAt(p.id) || p.updated_at || p.created_at || null };
}

// ==================== 通知 ====================
// 站内通知：用于主动向预审人员/管理员/事业部经办人推送待办与提醒（无需外部邮件/短信网关）
function addNotification({ user_id, role_scope, type, title, body, related_project_id, related_session_id, created_by }) {
  const n = {
    id: db.nextId(db.store.notifications),
    user_id: user_id != null ? Number(user_id) : null,
    role_scope: role_scope || null,
    type: type || 'info',
    title: title || '',
    body: body || '',
    related_project_id: related_project_id != null ? Number(related_project_id) : null,
    related_session_id: related_session_id != null ? Number(related_session_id) : null,
    read: false,
    created_by: created_by != null ? Number(created_by) : null,
    created_at: new Date().toISOString()
  };
  db.store.notifications.push(n);
  db.save();
  return n;
}
// 向指定角色的全部用户推送（rd/admin/biz/expert/accountant）
function notifyRoles(roles, payload) {
  if (!Array.isArray(roles)) roles = [roles];
  const targets = (db.store.users || []).filter(u => roles.includes(u.role) && u.is_active !== false);
  return targets.map(u => addNotification({ ...payload, user_id: u.id }));
}
// 向某事业部全部经办人推送
function notifyDeptBiz(dept, payload) {
  const targets = (db.store.users || []).filter(u => u.role === 'biz' && u.business_dept === dept && u.is_active !== false);
  return targets.map(u => addNotification({ ...payload, user_id: u.id }));
}

// 是否需要专家/会计师工作量评估：人员外包成本 或 专业分包成本 任一项 >0 才需要；
// 项目尚无成本估算表时保守按"需要评估"处理，避免漏评估。
function needsEstimate(p) {
  // 免专家评估判定（与 Feature② 一致）：
  // 无成本明细，或人员外包成本与专业分包成本均为 0 → 无需专家工作量评估。
  // 注意：生产上"无需评估"的项目往往未上传成本估算表（cost_summary 为空），
  // 此时也必须判定为免评估，否则会被批量发起确认误判为"缺评估数据"而跳过。
  if (!p || !p.cost_summary) return false;
  const cs = p.cost_summary || {};
  const out = Number(cs.outsourcing_cost) || 0;
  const sub = Number(cs.subcontract_cost) || 0;
  return (out > 0 || sub > 0);
}

// ==================== 审批流辅助 ====================
// 项目状态流转允许的方向：
// draft(草稿) → reviewing(评审中) → pending_confirm(待确认) → completed(已完成)
// rejected 为退回分支，退回后可重新预审
const PROJECT_STATUS_FLOW = {
  draft: ['reviewing', 'rejected'],
  rejected: ['reviewing', 'draft'],
  reviewing: ['pending_confirm', 'rejected'],
  pending_confirm: ['completed', 'reviewing'],
  completed: []
};
function canTransition(from, to) {
  if (from === to) return true;
  return (PROJECT_STATUS_FLOW[from] || []).includes(to);
}

// 资料类别与默认评审清单（批次未配置清单时使用）
const FILE_CATEGORIES = ['estimation', 'feasibility', 'bid', 'award', 'contract', 'tech_spec', 'subcontract', 'profit'];
// 项目资料清单齐全度：优先用所属批次下发的清单
function checklistStatus(p) {
  const sess = p.session_id ? db.store.reviewSessions.find(s => s.id === p.session_id) : null;
  const list = (sess && Array.isArray(sess.checklist) && sess.checklist.length) ? sess.checklist : FILE_CATEGORIES;
  return list.map(c => ({
    category: c,
    uploaded: db.store.files.some(f => f.project_id === p.id && f.file_category === c)
  }));
}
// 流程锁：项目已归档或所属批次已归档后，禁止再改动评估与资料
function projectLocked(p) {
  if (p.status === 'completed') return '项目已归档';
  if (p.session_id) {
    const s = db.store.reviewSessions.find(x => x.id === p.session_id);
    if (s && s.status === 'completed') return '所属批次已归档';
  }
  return null;
}

// 取批次已分配的评审专家/会计师
function getSessionAssignments(sessionId) {
  if (!sessionId) return [];
  return (db.store.sessionAssignments || []).filter(a => a.session_id === sessionId);
}
// 判断某专家/会计师是否被分配到该项目：分配改为「批次级」——
// 只要该专家被分配到项目所属批次，即视为可参与该批次下所有项目的评估（兼容已提交过评估的旧数据）
function isAssignedToProject(user, projectId) {
  if (user.role === 'expert' || user.role === 'accountant') {
    const project = db.store.projects.find(p => p.id === projectId);
    const sessionId = project ? project.session_id : null;
    if (sessionId) {
      const assigned = (db.store.sessionAssignments || []).some(a => a.session_id === sessionId && a.user_id === user.id);
      if (assigned) return true;
    }
    const estimated = db.store.expertEstimates.some(e => e.project_id === projectId && e.expert_id === user.id);
    return estimated;
  }
  return true;
}

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const realName = decodeFilename(file.originalname);
    const ext = path.extname(realName);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const fileFilter = (req, file, cb) => {
  const realName = decodeFilename(file.originalname);
  const allowed = /\.(xlsx|xls|pdf|docx?|jpg|jpeg|png|txt|csv|zip|rar|7z)$/i;
  if (allowed.test(realName)) cb(null, true);
  else cb(new Error('不支持的文件类型: ' + realName));
};
const upload = multer({ storage, fileFilter, limits: { fileSize: config.maxFileSizeMB * 1024 * 1024 } });

// ==================== 文件访问鉴权（/uploads 受保护）====================
function authorizeFile(req, res, next) {
  const filename = req.path.replace(/^\/+/, '');
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  const user = token ? verify(token) : null;
  if (!user) return res.status(401).json({ error: '未登录' });
  const file = db.store.files.find(f => f.filename === filename);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  if (user.role === 'admin' || user.role === 'rd') return next();
  const proj = db.store.projects.find(p => p.id === file.project_id);
  if (!proj) {
    // 收件箱文件（未分配到项目的文件夹批量上传）：仅上传者本人可访问
    if (file.uploader_id && file.uploader_id === user.id) return next();
    return res.status(403).json({ error: '无权访问' });
  }
  if (user.role === 'biz' && user.business_dept && user.business_dept === proj.biz_department) return next();
  if (user.role === 'expert' || user.role === 'accountant') {
    if (isAssignedToProject(user, file.project_id)) return next();
  }
  return res.status(403).json({ error: '无权访问该文件' });
}
app.use('/uploads', authorizeFile, express.static(UPLOAD_DIR));

// 健康检查（供容器编排 / 监控探活）
app.get('/api/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ==================== 登录 ====================
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const user = db.store.users.find(u => u.username === username);
  if (!user || !user.is_active) return res.status(401).json({ error: '用户不存在或已停用' });
  if (!db.verifyPassword(password, user.password)) return res.status(401).json({ error: '密码错误' });
  const token = sign({
    id: user.id, username: user.username, role: user.role,
    real_name: user.real_name, business_dept: user.business_dept
  });
  res.json({
    token,
    user: {
      id: user.id, username: user.username, role: user.role,
      department: user.department, real_name: user.real_name, business_dept: user.business_dept,
      permissions: resolveUserPermissions(user)
    }
  });
});

// ==================== 用户管理 ====================
app.get('/api/users', auth(), (req, res) => {
  res.json(db.store.users.map(({ password, ...u }) => u));
});
app.post('/api/users', auth(['admin']), (req, res) => {
  const { username, real_name, role, department, business_dept, password, group_id } = req.body;
  if (!username || !real_name) return res.status(400).json({ error: '用户名和姓名为必填' });
  if (db.store.users.some(u => u.username === username)) return res.status(400).json({ error: '用户名已存在' });
  const validRoles = ['admin', 'biz', 'rd', 'expert', 'accountant'];
  if (role && !validRoles.includes(role)) return res.status(400).json({ error: '无效的角色' });
  const u = {
    id: db.nextId(db.store.users),
    username,
    password: db.hashPassword(password || '123456'),
    real_name,
    role: role || 'expert',
    department: department || '',
    business_dept: business_dept || null,
    group_id: group_id || null,
    created_at: new Date().toISOString(),
    is_active: true
  };
  db.store.users.push(u);
  db.save();
  res.json({ ...u, password: undefined });
});

app.patch('/api/users/:id', auth(['admin']), (req, res) => {
  const userId = parseInt(req.params.id);
  const user = db.store.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const allowed = ['real_name', 'role', 'department', 'business_dept', 'group_id', 'is_active'];
  allowed.forEach(f => { if (req.body[f] !== undefined) user[f] = req.body[f]; });
  if (typeof req.body.password === 'string' && req.body.password.length > 0) {
    user.password = db.hashPassword(req.body.password);
  }
  db.save();
  res.json({ ...user, password: undefined });
});

app.delete('/api/users/:id', auth(['admin']), (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const idx = db.store.users.findIndex(u => u.id === userId);
  if (idx < 0) return res.status(404).json({ error: '用户不存在' });
  db.store.users.splice(idx, 1);
  db.save();
  res.json({ success: true });
});

// ==================== 用户分组 ====================
app.get('/api/user-groups', auth(), (req, res) => {
  res.json(db.store.userGroups.map(g => ({
    ...g,
    member_count: db.store.users.filter(u => u.group_id === g.id).length
  })));
});
app.post('/api/user-groups', auth(['admin']), (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: '分组名称为必填' });
  const g = { id: db.nextId(db.store.userGroups), name, description: description || '', created_at: new Date().toISOString() };
  db.store.userGroups.push(g);
  db.save();
  res.json(g);
});
app.patch('/api/user-groups/:id', auth(['admin']), (req, res) => {
  const g = db.store.userGroups.find(x => x.id === parseInt(req.params.id));
  if (!g) return res.status(404).json({ error: '分组不存在' });
  if (req.body.name !== undefined) g.name = req.body.name;
  if (req.body.description !== undefined) g.description = req.body.description;
  db.save();
  res.json(g);
});
app.delete('/api/user-groups/:id', auth(['admin']), (req, res) => {
  const groupId = parseInt(req.params.id);
  const idx = db.store.userGroups.findIndex(x => x.id === groupId);
  if (idx < 0) return res.status(404).json({ error: '分组不存在' });
  db.store.userGroups.splice(idx, 1);
  db.store.users.forEach(u => { if (u.group_id === groupId) u.group_id = null; });
  db.save();
  res.json({ success: true });
});

// ==================== 权限配置（接口鉴权仍以 role 为准，此处仅持久化配置）====================
app.get('/api/permissions', auth(['admin']), (req, res) => res.json(db.store.userPermissions || []));
app.put('/api/users/:id/permissions', auth(['admin']), (req, res) => {
  const userId = parseInt(req.params.id);
  if (!db.store.users.find(u => u.id === userId)) return res.status(404).json({ error: '用户不存在' });
  const { permissions } = req.body || {};
  if (!Array.isArray(permissions)) return res.status(400).json({ error: '权限必须是数组' });
  // 规范化：去重 + 转为字符串
  const cleanPerms = Array.from(new Set(permissions.map(p => String(p))));
  // 整体替换该用户的权限记录（避免引用替换被脏检查忽略）
  const idx = db.store.userPermissions.findIndex(p => p.user_id === userId);
  if (idx >= 0) {
    db.store.userPermissions[idx] = { ...db.store.userPermissions[idx], permissions: cleanPerms };
  } else {
    db.store.userPermissions.push({ id: db.nextId(db.store.userPermissions), user_id: userId, permissions: cleanPerms });
  }
  db.save();
  // 返回最新值，便于前端校验落库
  res.json(db.store.userPermissions.find(p => p.user_id === userId));
});
app.get('/api/users/:id/permissions', auth(['admin']), (req, res) => {
  const perm = db.store.userPermissions.find(p => p.user_id === parseInt(req.params.id));
  res.json(perm ? perm.permissions : []);
});
const PERMISSION_OPTIONS = [
  { code: 'view_projects', name: '查看项目', default_roles: ['admin', 'biz', 'rd', 'expert', 'accountant'] },
  { code: 'upload_files', name: '上传资料', default_roles: ['admin', 'biz', 'rd'] },
  { code: 'download_files', name: '下载单文件', default_roles: ['admin', 'biz', 'rd', 'expert', 'accountant'] },
  { code: 'download_batch', name: '批次全量下载', default_roles: ['admin'] },
  { code: 'import_excel', name: 'Excel导入项目', default_roles: ['admin', 'biz', 'rd'] },
  { code: 'manage_sessions', name: '管理评审批次', default_roles: ['admin', 'rd'] },
  { code: 'submit_estimate', name: '提交工作量评估', default_roles: ['expert', 'accountant'] },
  { code: 'confirm_estimate', name: '确认/驳回评估', default_roles: ['expert', 'accountant'] },
  { code: 'manage_users', name: '用户管理', default_roles: ['admin'] },
  { code: 'view_stats', name: '查看统计分析', default_roles: ['admin', 'rd', 'biz'] },
  { code: 'view_work_report', name: '查看年终工作报告', default_roles: ['admin', 'rd'] }
];
app.get('/api/permission-options', auth(), (req, res) => res.json(PERMISSION_OPTIONS));

// ==================== 评审批次 ====================
app.get('/api/sessions', auth(), (req, res) => {
  res.json(db.store.reviewSessions.map(s => ({
    ...s,
    project_count: db.store.projects.filter(p => p.session_id === s.id).length
  })));
});
app.post('/api/sessions', auth(['admin', 'rd']), (req, res) => {
  const allowed = ['name', 'review_time', 'note', 'status', 'meeting_location', 'meeting_agenda'];
  const body = pick(req.body, allowed);
  const validStatus = ['pending', 'in_progress', 'completed'];
  const s = {
    id: db.nextId(db.store.reviewSessions),
    name: body.name || '未命名批次',
    review_time: body.review_time || null,
    note: body.note || '',
    // 评审会元数据（时间复用 review_time，另增地点与议程）
    meeting_location: body.meeting_location || '',
    meeting_agenda: body.meeting_agenda || '',
    // 下发的评审材料清单（资料类别数组）
    checklist: Array.isArray(req.body.checklist) ? req.body.checklist.filter(c => FILE_CATEGORIES.includes(c)) : [],
    status: body.status && validStatus.includes(body.status) ? body.status : 'pending',
    creator_id: req.user.id,
    created_at: new Date().toISOString(),
    // 评审开始时间：批次转「评审中」时记录；此处若直接以 in_progress 创建也一并记录
    review_started_at: body.status === 'in_progress' ? new Date().toISOString() : null
  };
  db.store.reviewSessions.push(s);
  db.save();
  res.json(s);
});
app.patch('/api/sessions/:id', auth(['admin', 'rd']), (req, res) => {
  const idx = db.store.reviewSessions.findIndex(x => x.id === parseInt(req.params.id));
  if (idx < 0) return res.status(404).json({ error: '批次不存在' });
  const s = db.store.reviewSessions[idx];
  // 元数据可单独编辑（名称/时间/备注/会议地点/议程/评审清单）
  if (req.body.name !== undefined) s.name = req.body.name;
  if (req.body.review_time !== undefined) s.review_time = req.body.review_time;
  if (req.body.note !== undefined) s.note = req.body.note;
  if (req.body.meeting_location !== undefined) s.meeting_location = req.body.meeting_location;
  if (req.body.meeting_agenda !== undefined) s.meeting_agenda = req.body.meeting_agenda;
  if (Array.isArray(req.body.checklist)) s.checklist = req.body.checklist.filter(c => FILE_CATEGORIES.includes(c));
  const newStatus = req.body.status;
  if (newStatus !== undefined) {
    const allowed = ['pending', 'in_progress', 'completed'];
    if (!allowed.includes(newStatus)) {
      return res.status(400).json({ error: '无效状态，可选: pending/in_progress/completed' });
    }
    // 流程锁：启动评审前校验资料齐全；归档前校验项目全部完成
    const ps = db.store.projects.filter(p => p.session_id === s.id);
    if (newStatus === 'in_progress') {
      const missing = ps.filter(p => !db.store.files.some(f => f.project_id === p.id && f.file_category === 'estimation'));
      if (missing.length) {
        return res.status(400).json({
          error: `还有 ${missing.length} 个项目未上传成本估算表，不可启动评审（` +
            missing.slice(0, 3).map(p => p.project_name).join('、') + (missing.length > 3 ? ' 等' : '') + '）'
        });
      }
    }
    if (newStatus === 'completed') {
      const undone = ps.filter(p => p.status !== 'completed');
      if (undone.length) {
        return res.status(400).json({
          error: `还有 ${undone.length} 个项目未完成评审，不可归档（` +
            undone.slice(0, 3).map(p => p.project_name).join('、') + (undone.length > 3 ? ' 等' : '') + '）'
        });
      }
    }
    s.status = newStatus;
    if (newStatus === 'in_progress' && !s.review_started_at) s.review_started_at = new Date().toISOString();
    if (newStatus === 'completed') s.completed_at = new Date().toISOString();
    db.logWorkflow(null, newStatus === 'completed' ? 'archive_session' : 'update_session_status',
      (newStatus === 'completed' ? '归档批次：' : '更新批次状态为 ' + newStatus + '：') + (s.name || ''), req.user.id);
  }
  db.save();
  res.json(s);
});

// 管理员删除批次：级联删除批次下所有项目与挂接文件（磁盘+记录）、工作量、分配、日志等
app.delete('/api/sessions/:id', auth(['admin']), (req, res) => {
  const sid = parseInt(req.params.id);
  const idx = db.store.reviewSessions.findIndex(s => s.id === sid);
  if (idx < 0) return res.status(404).json({ error: '批次不存在' });
  const sess = db.store.reviewSessions[idx];
  const projectIds = new Set(db.store.projects.filter(p => p.session_id === sid).map(p => p.id));

  // 1) 删除挂接文件（含批次收件箱待分配文件）：磁盘 + 记录
  let fileCount = 0;
  db.store.files = db.store.files.filter(f => {
    const hit = f.session_id === sid || projectIds.has(f.project_id);
    if (hit) {
      const fp = path.join(UPLOAD_DIR, f.filename);
      if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} }
      fileCount++;
    }
    return !hit;
  });

  // 2) 删除批次下项目及其派生数据
  db.store.projects = db.store.projects.filter(p => p.session_id !== sid);
  ['workItems', 'procurementItems', 'travelItems', 'expertEstimates', 'confirmations', 'workflowLogs'].forEach(c => {
    if (Array.isArray(db.store[c])) db.store[c] = db.store[c].filter(x => !projectIds.has(x.project_id));
  });

  // 3) 删除批次分配与相关通知
  db.store.sessionAssignments = (db.store.sessionAssignments || []).filter(a => a.session_id !== sid);
  db.store.notifications = (db.store.notifications || []).filter(n => n.related_session_id !== sid);

  // 4) 删除批次本身
  db.store.reviewSessions.splice(idx, 1);
  db.save();
  console.log(`[删除批次] ${sess.name}(#${sid}): 项目 ${projectIds.size} 个, 文件 ${fileCount} 个, 操作人 ${req.user.username}`);
  res.json({ success: true, message: `批次「${sess.name}」已删除`, deleted: { projects: projectIds.size, files: fileCount } });
});

// ==================== 项目 ====================
app.get('/api/projects', auth(), (req, res) => {
  res.json(db.filterByDept('projects', req.user).map(enrichProject));
});

app.get('/api/projects/:id', auth(), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  // 事业部经办人只能看本事业部
  if (req.user.role === 'biz' && req.user.business_dept !== p.biz_department) {
    return res.status(403).json({ error: '无权查看该项目' });
  }
  // 专家/会计师只能看被分配到评估的项目
  if (req.user.role === 'expert' || req.user.role === 'accountant') {
    if (!isAssignedToProject(req.user, p.id)) return res.status(403).json({ error: '无权查看该项目' });
  }
  res.json({
    ...enrichProject(p),
    needs_estimate: needsEstimate(p),
    procurement_check: checkProcurementCompliance(p.id),
    inquiry_prices: p.inquiry_prices || [],
    work_items: db.store.workItems.filter(w => w.project_id === p.id),
    procurement_items: db.store.procurementItems.filter(x => x.project_id === p.id),
    travel_items: db.store.travelItems.filter(t => t.project_id === p.id),
    files: db.store.files.filter(f => f.project_id === p.id),
    expert_estimates: db.store.expertEstimates.filter(e => e.project_id === p.id),
    confirmations: db.store.confirmations.filter(c => c.project_id === p.id),
    assignments: getSessionAssignments(p.session_id),
    checklist_status: checklistStatus(p)
  });
});

const PROJECT_FIELDS = [
  'project_name', 'project_code', 'project_type', 'business_direction',
  'product_direction', 'is_digital', 'business_sub_direction', 'contract_amount',
  'biz_department', 'session_id', 'description', 'contract_party', 'remark',
  'review_opinion', 'bid_gross_margin', 'import_status', 'import_time', 'import_reason',
  'labor_subcontract_note', 'review_time', 'rate_reason'
];
app.post('/api/projects', auth(['admin', 'rd', 'biz']), (req, res) => {
  const p = {
    id: db.nextId(db.store.projects),
    status: 'draft', // 强制草稿，防止越权直接标完成跳过评审
    created_at: new Date().toISOString(),
    creator_id: req.user.id,
    ...pick(req.body, PROJECT_FIELDS)
  };
  // 前端表单 select 传的是字符串，转成数值避免后续 session_id === s.id 严格相等失败
  if (p.session_id !== undefined) p.session_id = p.session_id ? parseInt(p.session_id) || null : null;
  if (p.contract_amount !== undefined) p.contract_amount = Number(p.contract_amount) || 0;
  if (!p.project_name) return res.status(400).json({ error: '项目名称不能为空' });
  db.store.projects.push(p);
  db.save();
  db.logWorkflow(p.id, 'create_project', `创建项目：${p.project_name}`, req.user.id);
  res.json(p);
});

app.patch('/api/projects/:id', auth(['admin', 'rd', 'biz']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  // 事业部经办人只能改本事业部的项目
  if (req.user.role === 'biz' && req.user.business_dept !== p.biz_department) {
    return res.status(403).json({ error: '无权修改该项目' });
  }
  const body = pick(req.body, PROJECT_FIELDS);
  // 允许研发中心/管理员通过 PATCH 推进项目状态（受状态机约束）
  if (req.body.status !== undefined) {
    if (req.user.role !== 'admin' && req.user.role !== 'rd') {
      return res.status(403).json({ error: '无权限修改项目状态' });
    }
    const to = String(req.body.status);
    if (!canTransition(p.status, to)) {
      return res.status(400).json({ error: `状态流转不允许：${p.status} → ${to}` });
    }
    p.status = to;
  }
  if (body.session_id !== undefined) body.session_id = body.session_id ? parseInt(body.session_id) || null : null;
  if (body.contract_amount !== undefined) body.contract_amount = Number(body.contract_amount) || 0;
  if (body.biz_department !== undefined) p.biz_department = body.biz_department;
  Object.keys(body).forEach(k => { if (k !== 'biz_department') p[k] = body[k]; });
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, 'update_project', `更新项目：${p.project_name}`, req.user.id);
  res.json(p);
});

app.delete('/api/projects/:id', auth(['admin', 'rd', 'biz']), (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = db.store.projects.find(x => x.id === projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  // 事业部经办人只能删除本事业部的项目
  if (req.user.role === 'biz' && req.user.business_dept !== project.biz_department) {
    return res.status(403).json({ error: '无权删除该项目' });
  }
  deleteProjectAndChildren(projectId);
  db.save();
  res.json({ success: true });
});

function deleteProjectAndChildren(projectId) {
  const fileRecs = db.store.files.filter(f => f.project_id === projectId);
  fileRecs.forEach(f => {
    const fp = path.join(UPLOAD_DIR, f.filename);
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} }
  });
  db.store.files = db.store.files.filter(f => f.project_id !== projectId);
  db.store.workItems = db.store.workItems.filter(w => w.project_id !== projectId);
  db.store.procurementItems = db.store.procurementItems.filter(x => x.project_id !== projectId);
  db.store.travelItems = db.store.travelItems.filter(t => t.project_id !== projectId);
  db.store.expertEstimates = db.store.expertEstimates.filter(e => e.project_id !== projectId);
  db.store.confirmations = db.store.confirmations.filter(c => c.project_id !== projectId);
  db.store.workflowLogs = db.store.workflowLogs.filter(l => l.project_id !== projectId);
  db.store.projects = db.store.projects.filter(p => p.id !== projectId);
}

// ==================== Excel 导入 ====================
app.post('/api/projects/import-excel', auth(['admin', 'rd', 'biz']), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  try {
    const { parseProjectExcel } = require('./parse-excel');
    const parsed = parseProjectExcel(req.file.path);
    const bizDept = req.body.business_dept || req.body.biz_department || parsed.project.biz_department || null;
    const p = {
      id: db.nextId(db.store.projects),
      status: 'reviewing',
      source_file: req.file.originalname,
      source_path: req.file.path,
      biz_department: bizDept,
      session_id: req.body.session_id ? parseInt(req.body.session_id) : null,
      ...parsed.project,
      biz_department: bizDept, // 确保字段一致
      cost_summary: parsed.cost_summary,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      creator_id: req.user.id
    };
    if (!p.project_name) return res.status(400).json({ error: 'Excel 中未解析到项目名称' });
    db.store.projects.push(p);
    snapshotPre(p);
    parsed.work_items.forEach(w => db.store.workItems.push({ id: db.nextId(db.store.workItems), project_id: p.id, ...w }));
    // 字段名对齐：解析器输出 name/subtotal，数据库列为 item_name/amount
    parsed.procurement_items.forEach(x => db.store.procurementItems.push({
      id: db.nextId(db.store.procurementItems), project_id: p.id,
      item_name: x.name, spec: x.spec, amount: x.subtotal, supplier: x.supplier, remark: x.remark,
      ...x
    }));
    // 差旅费：金额列 amount = 住宿+补助+交通；解析器原始分项落入 extra
    parsed.travel_items.forEach(t => db.store.travelItems.push({
      id: db.nextId(db.store.travelItems), project_id: p.id,
      purpose: t.purpose, person: t.person, days: t.days,
      amount: (Number(t.hotel) || 0) + (Number(t.per_diem) || 0) + (Number(t.transport) || 0),
      remark: t.remark,
      ...t
    }));
    db.save();
    db.logWorkflow(p.id, 'excel_import', `Excel导入项目：${p.project_name}`, req.user.id);
    res.json({
      project: p,
      stats: {
        work_items: parsed.work_items.length,
        procurement_items: parsed.procurement_items.length,
        travel_items: parsed.travel_items.length,
        total_cost: parsed.cost_summary.total_cost,
        contract_amount: parsed.project.contract_amount || 0
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== Excel 导入模板下载 ====================
app.get('/api/template/import-xlsx', auth(['admin', 'rd', 'biz']), (req, res) => {
  try {
    const { buildImportTemplate } = require('./template-xlsx');
    const buf = buildImportTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('经济评审项目导入模板.xlsx')}`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 评审汇总表导入（批次级，支持挂接 / 新建批次）====================
app.post('/api/sessions/import-summary', auth(['admin', 'rd', 'biz']), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const mode = req.body.mode === 'attach' ? 'attach' : 'create';
  try {
    const { parseSummaryExcel } = require('./parse-summary-excel');
    const parsed = parseSummaryExcel(req.file.path);
    let session, session_id;
    if (mode === 'attach') {
      session_id = parseInt(req.body.session_id);
      session = db.store.reviewSessions.find(s => s.id === session_id);
      if (!session) return res.status(404).json({ error: '所选批次不存在' });
    } else {
      const name = (req.body.session_name && String(req.body.session_name).trim()) || parsed.batch_name || '未命名评审批次';
      session = {
        id: db.nextId(db.store.reviewSessions),
        name,
        review_time: req.body.review_time || null,
        note: '',
        meeting_location: '',
        meeting_agenda: '',
        checklist: [],
        status: 'pending',
        creator_id: req.user.id,
        created_at: new Date().toISOString()
      };
      db.store.reviewSessions.push(session);
      session_id = session.id;
    }
    const created = [];
    let skipped = 0;
    parsed.projects.forEach(row => {
      if (!row.project_name) return;
      const dup = db.store.projects.some(p =>
        p.session_id === session_id &&
        ((row.project_code && p.project_code === row.project_code) ||
         (!row.project_code && p.project_name === row.project_name))
      );
      if (dup) { skipped++; return; }
      const p = {
        id: db.nextId(db.store.projects),
        session_id,
        project_name: row.project_name,
        project_code: row.project_code || '',
        biz_department: row.biz_department || '',
        project_type: row.project_type || '',
        contract_amount: row.contract_amount != null ? row.contract_amount : 0,
        internal_estimated_cost: row.internal_estimated_cost != null ? row.internal_estimated_cost : null,
        is_restricted_subcontract: row.is_restricted_subcontract || '',
        subcontract_scope: row.subcontract_scope || '',
        status: 'draft',
        cost_summary: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        creator_id: req.user.id
      };
      db.store.projects.push(p);
      created.push(p.id);
    });
    db.save();
    if (mode === 'create') db.logWorkflow(null, 'session_import', `汇总表导入创建批次「${session.name}」，导入项目 ${created.length} 个（跳过重复 ${skipped} 个）`, req.user.id);
    else db.logWorkflow(null, 'session_import', `汇总表导入挂接批次「${session.name}」，新增项目 ${created.length} 个（跳过重复 ${skipped} 个）`, req.user.id);
    res.json({ session_id, session_name: session.name, total: parsed.projects.length, created: created.length, skipped, project_ids: created });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 评审汇总表导入模板下载 ====================
app.get('/api/template/summary-xlsx', auth(['admin', 'rd', 'biz']), (req, res) => {
  try {
    const { buildSummaryTemplate } = require('./template-summary-xlsx');
    const buf = buildSummaryTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('评审汇总表导入模板.xlsx')}`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==================== 年终工作汇报（供统计分析页查看 / 报告生成引用）====================
// ==================== 年终工作汇报（实时统计 + 管理员手填文字）====================
function getSetting(key) {
  const s = (db.store.settings || []).find(x => x.setting_key === key);
  return s ? s.setting_value : null;
}
function setSetting(key, value) {
  if (!db.store.settings) db.store.settings = [];
  let s = db.store.settings.find(x => x.setting_key === key);
  if (!s) { s = { id: db.nextId(db.store.settings), setting_key: key, setting_value: value, updated_at: new Date().toISOString() }; db.store.settings.push(s); }
  else { s.setting_value = value; s.updated_at = new Date().toISOString(); }
  db.save();
}
// 首次进入时作为手填模板的默认文字（取 25 年报告正文段落，去掉标题/密级/表标题行）
function workReportDefaultText() {
  return (workReport.paragraphs || [])
    .filter(p => p && !/商密/.test(p))
    .filter(p => p !== workReport.title && p !== workReport.department && p !== workReport.date)
    .filter(p => !/^表\d+/.test(p.trim()))
    .join('\n\n');
}

// 动态生成工作汇报标题/日期（按当前时间）
function getWorkReportTitleDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return {
    title: `${year}年年终项目经济评审工作汇报`,
    department: '研发中心',
    date: `（${year}年${month}月${day}日）`
  };
}
// 依据系统真实数据计算的基础数字
function computeWorkReportStats() {
  const projects = db.store.projects || [];
  const sessions = db.store.reviewSessions || [];
  const depts = new Set(projects.map(p => p.biz_department).filter(Boolean));
  const WIs = db.store.workItems || [];
  const preW2 = w => Number(w.cost) || 0;
  let contractTotal = 0, originalCostTotal = 0, adjustedCostTotal = 0;
  projects.forEach(p => {
    const contract = Number(p.contract_amount) || 0;
    contractTotal += contract;
    const base = (p.internal_estimated_cost != null ? Number(p.internal_estimated_cost) : 0);
    originalCostTotal += base;
    const wis = WIs.filter(w => w.project_id === p.id);
    const evaluated = wis.some(w => Number(w.adjusted_cost) > 0);
    let adj = base;
    if (evaluated) {
      const itemCost = wis.reduce((a, w) => a + preW2(w), 0);
      const itemAdj = wis.reduce((a, w) => a + (Number(w.adjusted_cost) > 0 ? Number(w.adjusted_cost) : preW2(w)), 0);
      adj = itemAdj + Math.max(0, base - itemCost);   // 未细化到 workItem 的部分按原预估带入，评审后不虚低
    }
    adjustedCostTotal += adj;
  });
  const reduction = Math.round((originalCostTotal - adjustedCostTotal) * 100) / 100;
  const profitRate = contractTotal > 0 ? Math.round((contractTotal - adjustedCostTotal) / contractTotal * 10000) / 10000 : 0;
  return {
    department_count: depts.size,
    session_count: sessions.length,
    project_count: projects.length,
    contract_total: Math.round(contractTotal * 100) / 100,
    original_cost_total: Math.round(originalCostTotal * 100) / 100,
    adjusted_cost_total: Math.round(adjustedCostTotal * 100) / 100,
    reduction_total: reduction,
    profit_rate: profitRate
  };
}
// 依据系统真实数据动态生成 7 张结构化表格（模板取自 25 年报告，维度与数值取实时）
function buildWorkReportTables() {
  const s = db.store;
  const projects = s.projects || [];
  const workItems = s.workItems || [];
  const travelItems = s.travelItems || [];
  const procurementItems = s.procurementItems || [];

  const depts = [...new Set(projects.map(p => p.biz_department).filter(Boolean))].sort();
  const types = [...new Set(projects.map(p => p.project_type).filter(Boolean))].sort();
  const projDept = {}, projType = {};
  projects.forEach(p => { projDept[p.id] = p.biz_department || ''; projType[p.id] = p.project_type || ''; });

  const preW = w => Number(w.cost) || 0;
  const adjW = w => { const a = Number(w.adjusted_cost); return a > 0 ? a : preW(w); };
  const contract = p => Number(p.contract_amount) || 0;
  // 评审前 = 项目级 internal_estimated_cost（事业部填报预估，完整）；明细成本仅作分类分解。
  // 已评估项目：评审后 = 各 workItem 调整后成本 + 未细化到 workItem 的部分（按原预估带入），避免评审后虚低。
  const projPre = p => Number(p.internal_estimated_cost) || 0;
  function projAdj(p) {
    const wis = workItems.filter(w => w.project_id === p.id);
    const evaluated = wis.some(w => Number(w.adjusted_cost) > 0);
    if (!evaluated) return projPre(p);
    const itemCost = wis.reduce((a, w) => a + preW(w), 0);
    const itemAdj = wis.reduce((a, w) => a + (Number(w.adjusted_cost) > 0 ? Number(w.adjusted_cost) : preW(w)), 0);
    const carry = Math.max(0, projPre(p) - itemCost);
    return itemAdj + carry;
  }
  const byDept = {}; depts.forEach(d => byDept[d] = { contract: 0, pre: 0, adj: 0, count: 0 });
  const byType = {}; types.forEach(t => byType[t] = { contract: 0, pre: 0, adj: 0, count: 0 });
  const cntDT = {}; depts.forEach(d => { cntDT[d] = {}; types.forEach(t => cntDT[d][t] = 0); });
  projects.forEach(p => {
    const d = projDept[p.id], t = projType[p.id];
    const c = contract(p), pre = projPre(p), adj = projAdj(p);
    if (d && byDept[d]) { byDept[d].contract += c; byDept[d].pre += pre; byDept[d].adj += adj; byDept[d].count++; }
    if (t && byType[t]) { byType[t].contract += c; byType[t].pre += pre; byType[t].adj += adj; byType[t].count++; }
    if (d && t && cntDT[d] && cntDT[d][t] != null) cntDT[d][t]++;
  });
  const totContract = projects.reduce((a, p) => a + contract(p), 0);
  const totPre = projects.reduce((a, p) => a + projPre(p), 0);
  const totAdj = projects.reduce((a, p) => a + projAdj(p), 0);

  const wan = n => Math.round((n / 10000) * 100) / 100;
  const pct = (a, b) => (b > 0 ? (Math.round((a / b) * 10000) / 100) + '%' : '—');
  const profit = (c, adj) => (c > 0 ? (Math.round((c - adj) / c * 10000) / 100) + '%' : '—');

  // 成本类别：系统 5 类(英文键) + 采购/差旅(来自 procurement/travel) + 第三方测试/知识产权(系统暂无→0)
  const COST_CATS = [
    { key: 'long_term', label: '长期职工成本' },
    { key: 'zhongshi', label: '中实职工成本' },
    { key: 'huazhao', label: '华兆职工成本' },
    { key: 'outsourcing', label: '人员外包成本' },
    { key: 'subcontract', label: '专业分包成本' },
    { key: 'procurement', label: '采购成本', src: 'proc' },
    { key: 'travel', label: '差旅费', src: 'travel' },
    { key: 'third_test', label: '第三方测试费', src: 'zero' },
    { key: 'ip', label: '知识产权费', src: 'zero' }
  ];
  function matchDim(pid, dept, type) {
    if (dept && projDept[pid] !== dept) return false;
    if (type && projType[pid] !== type) return false;
    return true;
  }
  function catPre(key, dept, type) {
    if (key === 'procurement') return procurementItems.filter(x => matchDim(x.project_id, dept, type)).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    if (key === 'travel') return travelItems.filter(x => matchDim(x.project_id, dept, type)).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    if (key === 'third_test' || key === 'ip') return 0;
    return workItems.filter(w => w.category === key && matchDim(w.project_id, dept, type)).reduce((a, w) => a + preW(w), 0);
  }
  function catAdj(key, dept, type) {
    if (key === 'procurement') return procurementItems.filter(x => matchDim(x.project_id, dept, type)).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    if (key === 'travel') return travelItems.filter(x => matchDim(x.project_id, dept, type)).reduce((a, x) => a + (Number(x.amount) || 0), 0);
    if (key === 'third_test' || key === 'ip') return 0;
    return workItems.filter(w => w.category === key && matchDim(w.project_id, dept, type)).reduce((a, w) => a + adjW(w), 0);
  }

  const tables = [];

  // 表1 评审项目统计：项目类型(rows) × 部门(cols) + 合计
  {
    const head = [[{ t: '部门\n类型' }, ...depts.map(d => ({ t: d })), { t: '合计' }]];
    const rows = types.map(t => {
      const row = [t]; let sum = 0;
      depts.forEach(d => { const v = cntDT[d][t] || 0; row.push(v); sum += v; });
      row.push(sum); return row;
    });
    const totRow = ['合计']; let gt = 0;
    depts.forEach(d => { let c = 0; types.forEach(t => c += cntDT[d][t] || 0); totRow.push(c); gt += c; });
    totRow.push(gt); rows.push(totRow);
    tables.push({ index: 1, caption: '表1 评审项目统计', head, rows });
  }

  // 表2/表3 利润表（按部门 / 按项目类型）
  function profitTable(index, caption, dimKeys, aggMap) {
    const lead = '类别\n' + (index === 2 ? '部门' : '项目类型');
    const head = [
      [{ t: lead, r: 2 }, { t: '合同额（万元）', r: 2 }, { t: '估算总成本（万元）', c: 2 }, { t: '利润率', c: 2 }],
      ['评审前', '评审后', '评审前', '评审后']
    ];
    const rows = dimKeys.map(k => {
      const a = aggMap[k];
      return [k, wan(a.contract), wan(a.pre), wan(a.adj), profit(a.contract, a.pre), profit(a.contract, a.adj)];
    });
    rows.push(['公司总体', wan(totContract), wan(totPre), wan(totAdj), profit(totContract, totPre), profit(totContract, totAdj)]);
    tables.push({ index, caption: '表' + index + ' ' + caption, head, rows });
  }
  profitTable(2, '各部门利润情况', depts, byDept);
  profitTable(3, '各项目类型利润情况', types, byType);

  // 表4 公司总体分项成本
  {
    const head = [
      [{ t: '类别', r: 2 }, { t: '公司总体', c: 2 }, { t: '成本占比', c: 2 }],
      ['评审前', '评审后', '评审前', '评审后']
    ];
    const rows = [['合同额', wan(totContract), wan(totContract), '', '']];
    COST_CATS.forEach(cat => {
      const pre = catPre(cat.key), adj = catAdj(cat.key);
      rows.push([cat.label, wan(pre), wan(adj), pct(pre, totPre), pct(adj, totAdj)]);
    });
    rows.push(['估算总成本', wan(totPre), wan(totAdj), pct(totPre, totPre), pct(totAdj, totAdj)]);
    rows.push(['利润率', '', '', profit(totContract, totPre), profit(totContract, totAdj)]);
    tables.push({ index: 4, caption: '表4 公司项目评审总体情况分项汇总', head, rows });
  }

  // 表5 按部门成本分析：成本类别(rows) × 部门(cols, 评审前/评审后) + 公司总体
  {
    const groups = depts.map(d => ({ label: d, subs: ['评审前', '评审后'] }));
    groups.push({ label: '公司总体', subs: ['评审前', '评审后'] });
    const head = [
      [{ t: '部门\n类别', r: 2 }, ...groups.map(g => ({ t: g.label, c: 2 }))],
      [...groups.flatMap(g => ['评审前', '评审后'])]
    ];
    const rows = [['合同额', ...depts.map(d => [wan(byDept[d].contract), wan(byDept[d].contract)]).flat(), wan(totContract), wan(totContract)]];
    COST_CATS.forEach(cat => {
      const row = [cat.label];
      depts.forEach(d => row.push(wan(catPre(cat.key, d)), wan(catAdj(cat.key, d))));
      row.push(wan(catPre(cat.key)), wan(catAdj(cat.key)));
      rows.push(row);
    });
    rows.push(['估算总成本', ...depts.map(d => [wan(byDept[d].pre), wan(byDept[d].adj)]).flat(), wan(totPre), wan(totAdj)]);
    rows.push(['利润率', ...depts.map(d => [profit(byDept[d].contract, byDept[d].pre), profit(byDept[d].contract, byDept[d].adj)]).flat(), profit(totContract, totPre), profit(totContract, totAdj)]);
    tables.push({ index: 5, caption: '表5 公司项目按部门成本分析', head, rows });
  }

  // 表6 按部门及项目类型成本分析：部门(rows) × 项目类型(cols, 评审前利润率/评审后利润率)
  {
    const groups = types.map(t => ({ label: t, subs: ['评审前', '评审后'] }));
    const head = [
      [{ t: '部门', r: 2 }, ...groups.map(g => ({ t: g.label, c: 2 }))],
      [...groups.flatMap(g => ['评审前', '评审后'])]
    ];
    const rows = depts.map(d => {
      const row = [d];
      types.forEach(t => {
        const ps = projects.filter(p => projDept[p.id] === d && projType[p.id] === t);
        const c = ps.reduce((a, p) => a + contract(p), 0);
        const pre = ps.reduce((a, p) => a + projPre(p), 0);
        const adj = ps.reduce((a, p) => a + projAdj(p), 0);
        row.push(profit(c, pre), profit(c, adj));
      });
      return row;
    });
    tables.push({ index: 6, caption: '表6 公司项目按部门及项目类型成本分析', head, rows });
  }

  // 表7 按项目类型成本分析：成本类别(rows) × 项目类型(cols, 评审前/评审后) + 公司总体
  {
    const groups = types.map(t => ({ label: t, subs: ['评审前', '评审后'] }));
    groups.push({ label: '公司总体', subs: ['评审前', '评审后'] });
    const head = [
      [{ t: '项目类型\n费用类别', r: 2 }, ...groups.map(g => ({ t: g.label, c: 2 }))],
      [...groups.flatMap(g => ['评审前', '评审后'])]
    ];
    const rows = [['合同额', ...types.map(t => [wan(byType[t].contract), wan(byType[t].contract)]).flat(), wan(totContract), wan(totContract)]];
    COST_CATS.forEach(cat => {
      const row = [cat.label];
      types.forEach(t => row.push(wan(catPre(cat.key, null, t)), wan(catAdj(cat.key, null, t))));
      row.push(wan(catPre(cat.key)), wan(catAdj(cat.key)));
      rows.push(row);
    });
    rows.push(['估算总成本', ...types.map(t => [wan(byType[t].pre), wan(byType[t].adj)]).flat(), wan(totPre), wan(totAdj)]);
    rows.push(['利润率', ...types.map(t => [profit(byType[t].contract, byType[t].pre), profit(byType[t].contract, byType[t].adj)]).flat(), profit(totContract, totPre), profit(totContract, totAdj)]);
    tables.push({ index: 7, caption: '表7 公司项目按项目类型成本分析', head, rows });
  }

  return tables;
}

app.get('/api/work-report', auth(), (req, res) => {
  const saved = getSetting('work_report_text');
  let header = '', footer = '';
  if (saved != null) {
    try {
      const o = JSON.parse(saved);
      if (o && typeof o === 'object') { header = o.header || ''; footer = o.footer || ''; }
      else header = String(saved);
    } catch (e) { header = String(saved); }
  }
  const meta = getWorkReportTitleDate();
  res.json({
    title: meta.title,
    department: meta.department,
    date: meta.date,
    stats: computeWorkReportStats(),
    tables: buildWorkReportTables(),
    header, footer,
    isDefault: saved == null
  });
});
app.put('/api/work-report/text', auth(['admin']), (req, res) => {
  const body = req.body || {};
  let header = '', footer = '';
  if (typeof body.text === 'string') header = body.text;          // 兼容旧调用
  else {
    header = typeof body.header === 'string' ? body.header : '';
    footer = typeof body.footer === 'string' ? body.footer : '';
  }
  setSetting('work_report_text', JSON.stringify({ header, footer }));
  res.json({ ok: true });
});
app.post('/api/projects/:id/files', auth(), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const projectId = parseInt(req.params.id);
  const project = db.store.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'biz' && req.user.business_dept !== project.biz_department) {
    return res.status(403).json({ error: '无权上传该项目文件' });
  }
  // 流程锁：项目或所属批次归档后资料锁定
  const upLock = projectLocked(project);
  if (upLock) return res.status(403).json({ error: upLock + '，资料已锁定不可再上传' });
  const clientCategory = req.body.category;
  const realOriginalName = decodeFilename(req.file.originalname);
  const autoCategory = (clientCategory && clientCategory !== 'auto') ? clientCategory : inferFileCategory(realOriginalName);
  const seq = generateFileSeq(projectId);
  const ext = path.extname(realOriginalName);
  const safeOriginalName = realOriginalName.replace(/[^\w\u4e00-\u9fa5.-]/g, '_');
  const newFilename = `${projectId}-${seq}-${safeOriginalName}`;
  const oldPath = req.file.path;
  const newPath = path.join(UPLOAD_DIR, newFilename);
  if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);

  // 任何 .xlsx 都先尝试解析成本估算表；即使文件名不含「成本/估算」字样，
  // 只要真抽出了工作项/成本数据，就自动当成估算表处理（避免按文件名误判为「其他资料」而漏解析）
  const isExcel = /\.(xlsx|xls)$/i.test(realOriginalName);
  let parsed = null;
  if (isExcel) {
    try {
      const { parseProjectExcel } = require('./parse-excel');
      parsed = parseProjectExcel(newPath);
    } catch (ex) {
      parsed = { __parseError: ex && ex.message };
    }
  }
  const looksLikeEstimation = autoCategory === 'estimation'
    || (parsed && !parsed.__parseError && (parsed.work_items.length > 0 || Object.keys(parsed.cost_summary || {}).length > 0));
  const finalCategory = looksLikeEstimation ? 'estimation' : autoCategory;

  const file = {
    id: db.nextId(db.store.files),
    project_id: projectId,
    filename: newFilename,
    originalname: realOriginalName,
    file_seq: seq,
    file_type: ext.slice(1),
    file_category: finalCategory,
    auto_detected: !clientCategory || clientCategory === 'auto',
    uploader_id: req.user.id,
    uploader_name: req.user.real_name || req.user.username,
    url: `/uploads/${newFilename}`,
    description: req.body.description || '',
    upload_time: new Date().toISOString()
  };
  db.store.files.push(file);
  // 若上传的是成本估算表（xlsx），自动抽取工作明细与成本项，供工作量评估页使用
  if (finalCategory === 'estimation' && parsed && !parsed.__parseError) {
    // ===== 双数字校验（仅告警、不拦截导入）=====
    // 产品决策：以前校验不过会删文件+400 整个拒绝，单个数字对不上就导致整批资料传不上去，
    // 用户体验极差。现改为：照常导入落库 + 抽取明细，告警持久化到项目 import_warnings，
    // 在批次项目列表里 ⚠ 黄标提示，由人工判断是否需要修正。
    const vIssues = [];
    const pContract = project.contract_amount != null ? Number(project.contract_amount) : null;
    const eContract = parsed.project.contract_amount != null ? Number(parsed.project.contract_amount) : null;
    if (pContract != null && eContract != null && Math.abs(pContract - eContract) > 1) {
      vIssues.push(`合同额不一致：本次成本估算表为 ¥${eContract.toLocaleString()}，汇总表基线为 ¥${pContract.toLocaleString()}`);
    }
    const estCost = parsed.cost_summary && parsed.cost_summary.total_cost != null ? Number(parsed.cost_summary.total_cost) : null;
    const internalCost = project.internal_estimated_cost != null ? Number(project.internal_estimated_cost) : null;
    // 先四舍五入到分再比较，避免浮点误差导致同额误报
    const estCostR2 = estCost != null ? Math.round(estCost * 100) / 100 : null;
    const internalCostR2 = internalCost != null ? Math.round(internalCost * 100) / 100 : null;
    if (internalCostR2 != null && estCostR2 != null && estCostR2 - internalCostR2 > 0.01) {
      vIssues.push(`估算成本 ¥${estCostR2.toLocaleString()} 大于汇总表「内部信息系统填报预估成本」 ¥${internalCostR2.toLocaleString()}`);
    }
    // 最新一次估算表上传的校验结论覆盖旧告警：传了干净的表，旧告警自动消除
    project.import_warnings = vIssues.length
      ? [{ file: realOriginalName, messages: vIssues, time: new Date().toISOString() }]
      : [];
    if (vIssues.length) {
      db.logWorkflow(projectId, 'extract_cost', '成本估算表校验告警（已导入）：' + vIssues.join('；'), req.user.id);
    }
    file.validation = vIssues;
    try {
      // 先清掉该项目已有的明细，避免重复累加
      db.store.workItems = db.store.workItems.filter(w => w.project_id !== projectId);
      db.store.procurementItems = db.store.procurementItems.filter(x => x.project_id !== projectId);
      db.store.travelItems = db.store.travelItems.filter(t => t.project_id !== projectId);
      parsed.work_items.forEach(w => db.store.workItems.push({ id: db.nextId(db.store.workItems), project_id: projectId, ...w }));
      parsed.procurement_items.forEach(x => db.store.procurementItems.push({
        id: db.nextId(db.store.procurementItems), project_id: projectId,
        item_name: x.name, spec: x.spec, amount: x.subtotal, supplier: x.supplier, remark: x.remark, ...x
      }));
      parsed.travel_items.forEach(t => db.store.travelItems.push({
        id: db.nextId(db.store.travelItems), project_id: projectId,
        purpose: t.purpose, person: t.person, days: t.days,
        amount: (Number(t.hotel) || 0) + (Number(t.per_diem) || 0) + (Number(t.transport) || 0),
        remark: t.remark, ...t
      }));
      project.cost_summary = parsed.cost_summary;
      snapshotPre(project);
      db.logWorkflow(projectId, 'extract_cost', `解析成本估算表，抽取工作项${parsed.work_items.length}条、采购${parsed.procurement_items.length}条、差旅${parsed.travel_items.length}条`, req.user.id);
      // 把解析结果暴露给前端，避免"上传成功但空数据"的静默失败
      file.extracted = {
        work_items: parsed.work_items.length,
        procurement_items: parsed.procurement_items.length,
        travel_items: parsed.travel_items.length,
        total_cost: parsed.cost_summary.total_cost || 0,
        warnings: parsed.warnings || []
      };
    } catch (ex) {
      console.error('估算表解析失败:', ex && ex.message);
      file.parse_error = ex && ex.message;
    }
  } else if (parsed && parsed.__parseError) {
    console.error('估算表解析失败:', parsed.__parseError);
    file.parse_error = parsed.__parseError;
  }
  project.updated_at = new Date().toISOString();
  // 采购成本合规比对：若采购成本不为零，自动比对询价单/协议上限价，超标则提醒预审/管理员
  try { runProcurementCheckAndNotify(projectId, req.user.id); } catch (e) { console.error('采购合规检查失败:', e && e.message); }
  db.save();
  db.logWorkflow(projectId, 'upload_file', `上传${getFileCategoryName(autoCategory)}文件[${seq}]: ${file.originalname}`, req.user.id);
  res.json(file);
});

// ==================== 文件夹批量上传（按项目编号匹配 + 合同额二次校验）====================
// 用于「线上线下双轨」：把一整个项目资料文件夹一次性上传，系统按文件名/子文件夹名中的
// 项目编号(主)或项目名称(次)自动归属到对应项目；估算表解析出的合同额与项目登记合同额
// 做二次比对（仅 warn 不阻塞，符合「一般成本估算表能对上、其余也不会错」的判定逻辑）。
// 未能匹配到项目的文件进入该批次「收件箱」待人工分配。
// 文件夹上传专用 fileFilter：缓存/隐藏文件（.DS_Store、Thumbs.db 等）先放行，
// 交由 handleFolderUpload 统一按 relPaths 过滤丢弃，避免「单个缓存文件导致整批上传 400、真实文件全丢」。
// 真实但类型不支持的文件仍按原逻辑拒绝。
const folderFileFilter = (req, file, cb) => {
  const realName = decodeFilename(file.originalname);
  const base = realName.toLowerCase();
  const isJunk = base.charAt(0) === '.' || base === 'thumbs.db' || base === 'desktop.ini' || base.endsWith(':encryptable');
  if (isJunk) return cb(null, true);
  const allowed = /\.(xlsx|xls|pdf|docx?|jpg|jpeg|png|txt|csv|zip|rar|7z)$/i;
  if (allowed.test(realName)) cb(null, true);
  else cb(new Error('不支持的文件类型: ' + realName));
};
// 文件夹上传 multer 不卡文件大小：大文件（>50MB）交由 handleFolderUpload 统一按大小优雅跳过
// 并清理磁盘孤儿，绝不让单个大文件导致 multer 在中间件阶段 400 中止、把整批真实文件一起拖垮。
// nginx client_max_body_size(60m) 仍是硬性天花板，>60MB 会在网关层 413，到不了这里。
const folderUpload = multer({ storage, fileFilter: folderFileFilter }).array('files', 500);

// 评审前/评审后成本双口径：首次写入成本估算时，把初始值快照为 cost_summary_pre（评审前），
// 后续更新只改 cost_summary（评审后）。年度汇总据此计算核减。
function snapshotPre(p) {
  if (p && p.cost_summary && !p.cost_summary_pre) {
    try { p.cost_summary_pre = JSON.parse(JSON.stringify(p.cost_summary)); }
    catch (_) { p.cost_summary_pre = p.cost_summary; }
  }
}

function extractCostIntoProject(project, parsed, userId) {
  db.store.workItems = db.store.workItems.filter(w => w.project_id !== project.id);
  db.store.procurementItems = db.store.procurementItems.filter(x => x.project_id !== project.id);
  db.store.travelItems = db.store.travelItems.filter(t => t.project_id !== project.id);
  parsed.work_items.forEach(w => db.store.workItems.push({ id: db.nextId(db.store.workItems), project_id: project.id, ...w }));
  parsed.procurement_items.forEach(x => db.store.procurementItems.push({
    id: db.nextId(db.store.procurementItems), project_id: project.id,
    item_name: x.name, spec: x.spec, amount: x.subtotal, supplier: x.supplier, remark: x.remark, ...x
  }));
  parsed.travel_items.forEach(t => db.store.travelItems.push({
    id: db.nextId(db.store.travelItems), project_id: project.id,
    purpose: t.purpose, person: t.person, days: t.days,
    amount: (Number(t.hotel) || 0) + (Number(t.per_diem) || 0) + (Number(t.transport) || 0),
    remark: t.remark, ...t
  }));
  project.cost_summary = parsed.cost_summary;
  snapshotPre(project);
  db.logWorkflow(project.id, 'extract_cost', `[文件夹]解析成本估算表，抽取工作项${parsed.work_items.length}条、采购${parsed.procurement_items.length}条、差旅${parsed.travel_items.length}条`, userId);
}

async function handleFolderUpload(req, res) {
  const sessionId = parseInt(req.params.id);
  const session = db.store.reviewSessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: '批次不存在' });
  let files = req.files || [];
  // 后端兜底：过滤系统缓存/隐藏文件（Mac .DS_Store、__MACOSX、Windows Thumbs.db/desktop.ini 等），
  // 与前端 onFolderSelected 一致；按索引同步裁剪 relPaths/overrides，避免错位。保守判断，绝不误删真实业务文件。
  const isJunkFile = (rel) => {
    const segs = (rel || '').split('/');
    const base = (segs.pop() || '').toLowerCase();
    if (!base) return true;
    if (base.charAt(0) === '.') return true;            // .DS_Store / .localized / .gitkeep
    if (base === 'thumbs.db' || base === 'desktop.ini') return true;
    if (base.endsWith(':encryptable')) return true;
    return segs.some(p => ['__macosx', '.git'].includes(p.toLowerCase()));
  };
  if (files.length) {
    const MAX = 50 * 1024 * 1024;
    let relPaths0 = [];
    try { relPaths0 = JSON.parse(req.body.relPaths || '[]') || []; } catch (_) {}
    const keep = [];
    files.forEach((f, i) => {
      const rel = (relPaths0[i] || f.originalname || '').toString();
      const tooBig = (f.size || 0) > MAX;
      if (!isJunkFile(rel) && !tooBig) keep.push(i);
    });
    if (keep.length !== files.length) {
      const dropped = files.filter((_, i) => !keep.includes(i));
      files = keep.map(i => files[i]);
      const keptRel = keep.map(i => relPaths0[i] || '');
      const keptOv = {};
      keep.forEach((i, k) => { keptOv[k] = (JSON.parse(req.body.overrides || '{}') || {})[i]; });
      req.body = { ...req.body, relPaths: JSON.stringify(keptRel), overrides: JSON.stringify(keptOv) };
      // 清理被丢弃的缓存文件在磁盘上的残留（multer 已落盘），避免孤儿文件
      const fs = require('fs');
      dropped.forEach(f => { try { if (f.path) fs.unlinkSync(f.path); } catch (_) {} });
    }
  }
  if (!files.length) return res.status(400).json({ error: '未收到有效文件（所选文件夹可能只有系统缓存文件）' });
  let relPaths = [];
  try { relPaths = JSON.parse(req.body.relPaths || '[]') || []; } catch (_) {}
  let overrides = {};
  try { overrides = JSON.parse(req.body.overrides || '{}') || {}; } catch (_) {}
  const projects = db.store.projects.filter(p => p.session_id === sessionId);
  const rpcModule = require('./resolve-project-content');
  const resolveContent = rpcModule.resolveProjectByContent;
  const bestNameFragmentMatch = rpcModule.bestNameFragmentMatch;
  // 第一遍：逐文件解析归属（人工改派 > 文件内容识别 > 文件名兜底）。内容识别为异步（pdf/docx 需读取文件内容）
  const pre = await Promise.all(files.map(async (f, i) => {
    const rel = (relPaths[i] || f.originalname || '').toString();
    const realName = decodeFilename(f.originalname);
    const override = overrides[String(i)] || {};
    let match = null, matchedBy = '', conflict = null;
    if (override.projectId) { match = projects.find(p => p.id === parseInt(override.projectId)); if (match) matchedBy = 'manual'; }
    // 强文件名信号优先于内容识别：文件名包含项目编号或完整项目名时直接定归属，
    // 不让较弱的内容部分匹配抢跑（曾导致估算表因含「有限责任公司」通用词被错配到别的项目）
    const base = rel.split('/').pop().replace(/\.[^.]+$/, '');
    if (!match) {
      const byCode = projects.filter(p => p.project_code && realName.includes(p.project_code));
      if (byCode.length) { match = byCode[0]; matchedBy = 'name-code'; }
      else {
        const byName = projects.filter(p => p.project_name && realName.includes(p.project_name));
        if (byName.length) { match = byName[0]; matchedBy = 'name'; }
      }
    }
    if (!match) {
      const c = await resolveContent(f.path, projects);
      if (c) {
        // 文件名与内容交叉校验：文件名片段明确指向另一个项目时视为冲突，
        // 宁可不匹配（进收件箱人工分配），也不让「文件名 A 项目、内容 B 项目」的文件错配。
        // 典型场景：模板复制后只改了文件名、没改表内「项目名称」单元格。
        const fc = bestNameFragmentMatch(base, projects);
        if (fc && fc.project.id !== c.project.id) {
          conflict = { contentProject: c.project.project_name, fileProject: fc.project.project_name };
        } else { match = c.project; matchedBy = c.by; }
      }
    }
    if (!match) {
      // 弱文件名兜底：项目名包含文件名主体。要求主体 ≥6 字，
      // 避免「估算表」「报告」这类通用短文件名匹配到批次里所有项目
      if (base && base.length >= 6) {
        const byName = projects.filter(p => p.project_name && p.project_name.includes(base));
        if (byName.length) { match = byName[0]; matchedBy = 'name'; }
      }
    }
    return { f, i, rel, realName, override, match, matchedBy, conflict };
  }));
  // 第二遍：同文件夹归并——若某文件夹内有文件解析出项目，该文件夹下其余未匹配文件一并挂接到该项目
  const byFolder = {};
  for (const it of pre) {
    const dir = it.rel.split('/').slice(0, -1).join('/') || '(root)';
    (byFolder[dir] = byFolder[dir] || []).push(it);
  }
  for (const dir in byFolder) {
    const group = byFolder[dir];
    const cnt = {};
    for (const it of group) if (it.match) cnt[it.match.id] = (cnt[it.match.id] || 0) + 1;
    let folderPid = null, max = 0;
    for (const pid in cnt) if (cnt[pid] > max) { max = cnt[pid]; folderPid = parseInt(pid); }
    if (folderPid != null) for (const it of group) if (!it.match && !it.conflict) { it.match = projects.find(p => p.id === folderPid); it.matchedBy = 'folder'; }
  }
  const report = [];
  for (const it of pre) {
    const { f, i, rel, realName, override, match, matchedBy, conflict } = it;
    const category = (override.category && override.category !== 'auto') ? override.category : inferFileCategory(realName);
    const validation = { level: 'ok', messages: [] };
    if (conflict) {
      validation.level = 'warn';
      validation.messages.push(`文件名与内容指向不同项目（文件名似「${conflict.fileProject}」、内容为「${conflict.contentProject}」），未自动匹配，请人工分配`);
    }
    const isExcel = /\.(xlsx|xls)$/i.test(realName);
    let parsed = null;
    if (match && isExcel) {
      try { parsed = require('./parse-excel').parseProjectExcel(f.path); }
      catch (e) { parsed = { __parseError: e && e.message }; }
      if (parsed && !parsed.__parseError) {
        const eContract = parsed.project && parsed.project.contract_amount != null ? Number(parsed.project.contract_amount) : null;
        const pContract = match.contract_amount != null ? Number(match.contract_amount) : null;
        if (eContract != null && pContract != null && Math.abs(eContract - pContract) > 1) {
          validation.level = 'warn';
          validation.messages.push(`成本估算表合同额 ¥${eContract.toLocaleString()} 与项目登记合同额 ¥${pContract.toLocaleString()} 不一致`);
        }
        const estCost = parsed.cost_summary && parsed.cost_summary.total_cost != null ? Number(parsed.cost_summary.total_cost) : null;
        const internalCost = match.internal_estimated_cost != null ? Number(match.internal_estimated_cost) : null;
        // 先四舍五入到分再比较，避免浮点误差导致「125046.64000001 > 125046.64」这类同额误报
        const estCostR = estCost != null ? Math.round(estCost * 100) / 100 : null;
        const internalCostR = internalCost != null ? Math.round(internalCost * 100) / 100 : null;
        if (internalCostR != null && estCostR != null && estCostR - internalCostR > 0.01) {
          validation.messages.push(`估算成本 ¥${estCostR.toLocaleString()} 大于明细表「内部填报预估成本」 ¥${internalCostR.toLocaleString()}`);
        }
      }
    }
    const ext = path.extname(realName);
    const safe = realName.replace(/[^\w\u4e00-\u9fa5.-]/g, '_');
    if (match) {
      let finalCategory = category;
      // 校验告警持久化到项目（批次项目列表 ⚠ 显示）：仅估算表类 Excel 覆盖旧告警，干净的估算表自动消除旧告警
      if (parsed && !parsed.__parseError && finalCategory === 'estimation') {
        match.import_warnings = validation.messages.length
          ? [{ file: realName, messages: validation.messages, time: new Date().toISOString() }]
          : [];
      }
      const seq = generateFileSeq(match.id);
      const newFilename = `${match.id}-${seq}-${safe}`;
      const newPath = path.join(UPLOAD_DIR, newFilename);
      if (fs.existsSync(f.path)) fs.renameSync(f.path, newPath);
      let extracted = null;
      if (finalCategory === 'estimation' && parsed && !parsed.__parseError) {
        try { extractCostIntoProject(match, parsed, req.user.id); extracted = { work_items: parsed.work_items.length, procurement_items: parsed.procurement_items.length, travel_items: parsed.travel_items.length, total_cost: parsed.cost_summary.total_cost || 0 }; }
        catch (e) { console.error('文件夹估算表解析失败:', e && e.message); }
      } else if (parsed && parsed.__parseError) {
        console.error('文件夹估算表解析失败:', parsed.__parseError);
      }
      const file = {
        id: db.nextId(db.store.files), project_id: match.id, filename: newFilename, originalname: realName,
        file_seq: seq, file_type: ext.slice(1), file_category: finalCategory,
        auto_detected: !override.category || override.category === 'auto',
        uploader_id: req.user.id, uploader_name: req.user.real_name || req.user.username,
        url: `/uploads/${newFilename}`, description: '文件夹批量上传', upload_time: new Date().toISOString()
      };
      db.store.files.push(file);
      try { runProcurementCheckAndNotify(match.id, req.user.id); } catch (e) { console.error('采购合规检查失败:', e && e.message); }
      db.logWorkflow(match.id, 'upload_file', `[文件夹]上传${getFileCategoryName(finalCategory)}: ${realName}${validation.messages.length ? '（校验：' + validation.messages.join('；') + '）' : ''}`, req.user.id);
      report.push({ filename: realName, relPath: rel, matchedProjectId: match.id, matchedProjectName: match.project_name, matchedBy, category: finalCategory, validation, extracted });
    } else {
      const newFilename = `inbox-${sessionId}-${Date.now()}-${i}-${safe}`;
      const newPath = path.join(UPLOAD_DIR, newFilename);
      if (fs.existsSync(f.path)) fs.renameSync(f.path, newPath);
      const file = {
        id: db.nextId(db.store.files), project_id: null, session_id: sessionId, filename: newFilename, originalname: realName,
        file_seq: 0, file_type: ext.slice(1), file_category: category, auto_detected: true,
        uploader_id: req.user.id, uploader_name: req.user.real_name || req.user.username,
        url: `/uploads/${newFilename}`, description: '文件夹批量上传-待分配', upload_time: new Date().toISOString(), inbox: true
      };
      db.store.files.push(file);
      report.push({ filename: realName, relPath: rel, matchedProjectId: null, matchedProjectName: '(未匹配，待分配)', matchedBy: 'none', category, validation, inbox: true });
    }
  }
  db.save();
  res.json({
    ok: true, count: files.length,
    matched: report.filter(r => r.matchedProjectId).length,
    unmatched: report.filter(r => !r.matchedProjectId).length,
    report
  });
}

app.post('/api/sessions/:id/upload-folder', auth(['admin', 'rd', 'biz']), (req, res) => {
  folderUpload(req, res, (err) => {
    if (err) return res.status(400).json({ error: '上传失败：' + (err && err.message || err) });
    handleFolderUpload(req, res).catch(e => { console.error('文件夹上传处理异常:', e); res.status(500).json({ error: '处理失败：' + (e && e.message) }); });
  });
});

// 批次收件箱（文件夹批量上传中未匹配到项目的文件）
app.get('/api/sessions/:id/inbox', auth(['admin', 'rd', 'biz']), (req, res) => {
  const sessionId = parseInt(req.params.id);
  const list = db.store.files.filter(f => f.session_id === sessionId && f.inbox);
  res.json(list);
});

// 按批次列出全部文件（项目文件 + 收件箱待分配），供前端「文件管理」面板使用
app.get('/api/sessions/:id/files', auth(['admin', 'rd', 'biz']), (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = db.store.reviewSessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: '批次不存在' });
  const pids = new Set(db.store.projects.filter(p => p.session_id === sessionId).map(p => p.id));
  res.json(db.store.files.filter(f => (f.inbox && f.session_id === sessionId) || (!f.inbox && pids.has(f.project_id))));
});

// 收件箱文件改派到具体项目
app.post('/api/files/:id/reassign', auth(['admin', 'rd']), (req, res) => {
  const fileId = parseInt(req.params.id);
  const file = db.store.files.find(f => f.id === fileId);
  if (!file) return res.status(404).json({ error: '文件不存在' });
  const target = db.store.projects.find(p => p.id === parseInt(req.body.projectId));
  if (!target) return res.status(404).json({ error: '目标项目不存在' });
  file.project_id = target.id;
  file.inbox = false;
  file.description = (file.description || '') + ' [已分配至 ' + (target.project_name || target.id) + ']';
  file.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(target.id, 'upload_file', `收件箱文件「${file.originalname}」分配给本项目`, req.user.id);
  res.json(file);
});

app.get('/api/projects/:id/files', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = db.store.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'expert' || req.user.role === 'accountant') {
    if (!isAssignedToProject(req.user, projectId)) return res.status(403).json({ error: '无权查看该项目文件' });
  }
  res.json(db.store.files.filter(f => f.project_id === projectId));
});

app.delete('/api/files/:id', auth(), (req, res) => {
  const fileId = parseInt(req.params.id);
  const fileIndex = db.store.files.findIndex(f => f.id === fileId);
  if (fileIndex === -1) return res.status(404).json({ error: '文件不存在' });
  const file = db.store.files[fileIndex];
  if (req.user.role !== 'admin' && file.uploader_id !== req.user.id) {
    return res.status(403).json({ error: '无权删除该文件' });
  }
  const filePath = path.join(UPLOAD_DIR, file.filename);
  if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (_) {} }
  db.store.files.splice(fileIndex, 1);
  db.save();
  db.logWorkflow(file.project_id, 'delete_file', `删除文件: ${file.originalname}`, req.user.id);
  res.json({ success: true, message: '文件已删除' });
});

// ==================== 工作量评估 ====================
app.get('/api/projects/:id/estimates', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const estimates = db.store.expertEstimates.filter(e => e.project_id === projectId);
  if (req.user.role === 'expert' || req.user.role === 'accountant') {
    return res.json(estimates.filter(e => e.expert_id === req.user.id));
  }
  const summary = {};
  estimates.forEach(e => {
    if (!summary[e.work_item_id]) summary[e.work_item_id] = { count: 0, total: 0 };
    summary[e.work_item_id].count++;
    summary[e.work_item_id].total += Number(e.days || 0);
  });
  res.json(Object.entries(summary).map(([workItemId, d]) => ({
    work_item_id: parseInt(workItemId),
    avg_days: d.count > 0 ? Math.round(d.total / d.count * 10) / 10 : 0,
    estimate_count: d.count
  })));
});

app.post('/api/estimates', auth(['expert', 'accountant']), (req, res) => {
  const { project_id, work_item_id, days, comment } = req.body;
  if (!project_id || !work_item_id || days === undefined || days === null || days === '') {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  const daysNum = Number(days);
  if (!isFinite(daysNum) || daysNum <= 0) {
    return res.status(400).json({ error: '评估人天必须为大于 0 的数字' });
  }
  const pid = parseInt(project_id);
  const project = db.store.projects.find(p => p.id === pid);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  // 流程锁：项目或所属批次归档后禁止再改动评估
  const lockReason = projectLocked(project);
  if (lockReason) return res.status(403).json({ error: lockReason + '，禁止提交或修改评估' });
  // P0-2：校验评估人已被分配到该项目（会计师事务所同样以专家身份参与评估）
  if (!isAssignedToProject(req.user, pid)) {
    return res.status(403).json({ error: '您未被分配到该项目，无法提交评估' });
  }
  // 校验工作项属于该项目
  const wi = db.store.workItems.find(w => w.id === parseInt(work_item_id));
  if (!wi || wi.project_id !== pid) {
    return res.status(400).json({ error: '工作项不存在或不属于该项目' });
  }
  const existing = db.store.expertEstimates.find(e => e.expert_id === req.user.id && e.project_id === pid && e.work_item_id === parseInt(work_item_id));
  const roleLabel = req.user.role === 'accountant' ? '会计师事务所' : '专家';
  if (existing) {
    // 已提交过：允许专家/会计师重新修改评估值（覆盖更新），仍受归档锁约束
    existing.days = daysNum;
    existing.comment = comment || existing.comment || '';
    existing.updated_at = new Date().toISOString();
    persistWorkItemRollup(pid, parseInt(work_item_id));
    db.save();
    db.logWorkflow(pid, 'update_estimate', `${roleLabel}${existing.expert_name}重新评估工作项${work_item_id}: ${daysNum}人天（覆盖原值）`, req.user.id);
    return res.json(existing);
  }
  const estimate = {
    id: db.nextId(db.store.expertEstimates),
    project_id: pid,
    work_item_id: parseInt(work_item_id),
    expert_id: req.user.id,
    expert_name: req.user.real_name,
    expert_role: req.user.role,
    days: daysNum,
    comment: comment || '',
    submitted_at: new Date().toISOString()
  };
  db.store.expertEstimates.push(estimate);
  const pj = db.store.projects.find(p => p.id === pid);
  if (pj) pj.updated_at = new Date().toISOString();
  // 提交评估后落库工作项的 5 人评估汇总（平均人天 / 调整后费用）
  persistWorkItemRollup(pid, parseInt(work_item_id));
  db.save();
  db.logWorkflow(pid, 'submit_estimate', `${roleLabel}${estimate.expert_name}评估工作项${work_item_id}: ${daysNum}人天`, req.user.id);
  res.json(estimate);
});

app.get('/api/projects/:id/estimate-summary', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const estimates = db.store.expertEstimates.filter(e => e.project_id === projectId);
  if (estimates.length === 0) return res.json({ message: '暂无专家评估数据' });
  const summary = {};
  estimates.forEach(e => {
    if (!summary[e.work_item_id]) summary[e.work_item_id] = { items: [], total: 0, count: 0 };
    summary[e.work_item_id].items.push(e.days);
    summary[e.work_item_id].total += Number(e.days || 0);
    summary[e.work_item_id].count++;
  });
  res.json(Object.entries(summary).map(([workItemId, d]) => ({
    work_item_id: parseInt(workItemId),
    days_list: d.items,
    avg_days: Math.round(d.total / d.count * 10) / 10,
    expert_count: d.count,
    max_days: Math.max(...d.items),
    min_days: Math.min(...d.items)
  })));
});

app.post('/api/confirmations', auth(['expert', 'accountant']), (req, res) => {
  const { project_id, work_item_id, confirmed, comment } = req.body;
  if (!project_id || !work_item_id || confirmed === undefined) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  const confirmation = {
    id: db.nextId(db.store.confirmations),
    project_id: parseInt(project_id),
    work_item_id: parseInt(work_item_id),
    expert_id: req.user.id,
    expert_name: req.user.real_name,
    confirmed: !!confirmed,
    comment: comment || '',
    confirmed_at: new Date().toISOString()
  };
  db.store.confirmations.push(confirmation);
  const cpj = db.store.projects.find(p => p.id === parseInt(project_id));
  if (cpj) cpj.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(parseInt(project_id), confirmed ? 'confirm_estimate' : 'reject_estimate',
    `专家${confirmation.expert_name}${confirmed ? '确认' : '驳回'}工作项${work_item_id}的平均值`, req.user.id);
  res.json(confirmation);
});

app.get('/api/projects/:id/confirmations', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const confirmations = db.store.confirmations.filter(c => c.project_id === projectId);
  if (req.user.role === 'expert' || req.user.role === 'accountant') {
    return res.json(confirmations.filter(c => c.expert_id === req.user.id));
  }
  res.json(confirmations);
});

// ==================== 评审人员分配（批次级）====================
// 专家分配改为「按批次分配」：分配到某批次的专家/会计师，可参与该批次下所有项目的评估。
// 查看某批次已分配的评审专家/会计师（研发中心/管理员）
app.get('/api/sessions/:id/assignments', auth(['admin', 'rd']), (req, res) => {
  const sessionId = parseInt(req.params.id);
  const sess = db.store.reviewSessions.find(s => s.id === sessionId);
  if (!sess) return res.status(404).json({ error: '批次不存在' });
  const assignments = getSessionAssignments(sessionId).map(a => {
    const u = db.store.users.find(x => x.id === a.user_id) || {};
    return { ...a, user_name: u.real_name || a.user_name, user_role: u.role || a.user_role };
  });
  res.json(assignments);
});

// 分配/重分配批次评审专家与会计师（研发中心/管理员）。替换式：提交即覆盖该批次原有分配。
app.post('/api/sessions/:id/assign', auth(['admin', 'rd']), (req, res) => {
  const sessionId = parseInt(req.params.id);
  const sess = db.store.reviewSessions.find(s => s.id === sessionId);
  if (!sess) return res.status(404).json({ error: '批次不存在' });
  const expertIds = (Array.isArray(req.body.expert_ids) ? req.body.expert_ids : []).map(Number).filter(Boolean);
  const accountantIds = (Array.isArray(req.body.accountant_ids) ? req.body.accountant_ids : []).map(Number).filter(Boolean);
  for (const id of [...expertIds, ...accountantIds]) {
    const u = db.store.users.find(x => x.id === id);
    if (!u) return res.status(400).json({ error: '存在无效的用户ID: ' + id });
  }
  const make = (uid, role) => ({
    id: db.nextId(db.store.sessionAssignments),
    session_id: sessionId,
    user_id: uid,
    user_role: role,
    user_name: (db.store.users.find(x => x.id === uid) || {}).real_name,
    assigned_by: req.user.id,
    assigned_at: new Date().toISOString()
  });
  const newOnes = [];
  expertIds.forEach(id => newOnes.push(make(id, 'expert')));
  accountantIds.forEach(id => newOnes.push(make(id, 'accountant')));
  db.store.sessionAssignments = (db.store.sessionAssignments || []).filter(a => a.session_id !== sessionId);
  db.store.sessionAssignments.push(...newOnes);
  db.save();
  db.logWorkflow(null, 'assign_expert', `批次${sessionId}分配评审人员：${newOnes.map(a => a.user_name).join('、') || '无'}`, req.user.id);
  res.json({ success: true, assignments: newOnes });
});

// ==================== 评审流程节点 ====================
// 研发中心预审：通过(draft/rejected → reviewing) 或 退回(→ rejected)
// 注：评审项目清单由管理员/研发中心通过 Excel 导入或新建项目录入，无需事业部提交申请，草稿即可预审
app.post('/api/projects/:id/pre-review', auth(['admin', 'rd']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!['draft', 'rejected'].includes(p.status)) {
    return res.status(400).json({ error: '当前状态（' + p.status + '）不可进行预审' });
  }
  const approve = !!req.body.approve;
  const reason = (req.body.reason || '').toString();
  if (!approve && !reason.trim()) return res.status(400).json({ error: '退回时必须填写退回原因' });
  p.status = approve ? 'reviewing' : 'rejected';
  if (!approve) p.review_note = reason;
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, approve ? 'pre_review_pass' : 'pre_review_reject',
    approve ? '研发中心预审通过，进入评审' : '研发中心预审退回：' + reason, req.user.id);
  res.json(p);
});

// 研发中心汇总结果并发起成果确认（reviewing → pending_confirm）
// 复用逻辑：发起成果确认（单项目 / 批量共用）。返回 {ok, reason}
// 规则：人员外包成本与专业分包成本均为 0 的项目无需专家评估，可直接发起；
// 其余项目必须已存在专家/会计师评估数据。发起时记录下发时间并通知对应事业部经办人。
function doInitiateConfirmation(p, userId) {
  if (p.status !== 'reviewing') return { ok: false, reason: '当前状态（' + p.status + '）不可发起确认' };
  if (needsEstimate(p)) {
    const estCount = db.store.expertEstimates.filter(e => e.project_id === p.id).length;
    if (estCount === 0) return { ok: false, reason: '尚无专家/会计师评估数据，请先组织评审会并收集评估' };
  }
  p.status = 'pending_confirm';
  p.skip_estimate = !needsEstimate(p);
  if (!p.confirmation_issued_at) p.confirmation_issued_at = new Date().toISOString();
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, 'initiate_confirmation', '研发中心汇总结果并发起成果确认', userId);
  notifyDeptBiz(p.biz_department, {
    type: 'biz_confirm', title: '成果确认待办：' + (p.project_name || '项目'),
    body: '您部门的项目「' + (p.project_name || '') + '」已发起成果确认，请登录系统确认经济评审结果汇总表。',
    related_project_id: p.id, related_session_id: p.session_id, created_by: userId
  });
  return { ok: true };
}
app.post('/api/projects/:id/initiate-confirmation', auth(['admin', 'rd']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const r = doInitiateConfirmation(p, req.user.id);
  if (!r.ok) return res.status(400).json({ error: r.reason });
  res.json(p);
});

// 研发中心复核后完成结果导入（pending_confirm → completed）
app.post('/api/projects/:id/finalize', auth(['admin', 'rd']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (p.status !== 'pending_confirm') return res.status(400).json({ error: '仅待确认项目可归档（当前：' + p.status + '）' });
  if (!p.biz_confirmed) return res.status(400).json({ error: '请先由事业部确认成果后再归档' });
  p.status = 'completed';
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, 'finalize', '研发中心复核并导入结果，项目完成', req.user.id);
  // 联动批次：本项目所属批次下所有项目均完成时，批次自动归档
  if (p.session_id) {
    const sess = db.store.reviewSessions.find(s => s.id === p.session_id);
    if (sess) {
      const ps = db.store.projects.filter(x => x.session_id === sess.id);
      if (ps.length && ps.every(x => x.status === 'completed')) {
        sess.status = 'completed';
        sess.completed_at = new Date().toISOString();
        db.save();
      }
    }
  }
  res.json(p);
});

// 结果校核（评审专家 / 会计师事务所；需已分配到该项目）
// conclusion: approved=认可 / adjust=建议调整 / rejected=不认可（后两者必填说明）
app.post('/api/projects/:id/verify', auth(['expert', 'accountant']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (!isAssignedToProject(req.user, p.id)) return res.status(403).json({ error: '您未被分配到该项目，无法提交校核结论' });
  const conclusion = (req.body.conclusion || '').toString();
  if (!['approved', 'adjust', 'rejected'].includes(conclusion)) {
    return res.status(400).json({ error: '无效校核结论，可选: approved/adjust/rejected' });
  }
  const note = (req.body.note || '').toString();
  if (conclusion !== 'approved' && !note.trim()) return res.status(400).json({ error: '非“认可”结论必须填写校核说明' });
  p.audit_conclusion = {
    conclusion, note,
    by: req.user.id, by_name: req.user.real_name,
    by_role: req.user.role, at: new Date().toISOString()
  };
  p.updated_at = new Date().toISOString();
  db.save();
  const label = { approved: '认可', adjust: '建议调整', rejected: '不认可' }[conclusion];
  db.logWorkflow(p.id, 'verify_result', (req.user.real_name || '') + '提交结果校核：' + label + (note ? '（' + note + '）' : ''), req.user.id);
  res.json(p);
});

// 事业部确认成果（项目级；pending_confirm 阶段，biz 限本事业部，rd/admin 可代确认）
app.post('/api/projects/:id/confirm', auth(['admin', 'rd', 'biz']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'biz' && req.user.business_dept !== p.biz_department) {
    return res.status(403).json({ error: '无权确认非本事业部的项目' });
  }
  if (p.status !== 'pending_confirm') return res.status(400).json({ error: '当前状态（' + p.status + '）无需事业部确认' });
  const confirmed = !!req.body.confirmed;
  const comment = (req.body.comment || '').toString();
  if (!confirmed && !comment.trim()) return res.status(400).json({ error: '退回时必须填写退回原因' });
  p.biz_confirmed = confirmed;
  p.biz_confirmed_by = req.user.id;
  p.biz_confirmed_name = req.user.real_name;
  p.biz_confirmed_at = new Date().toISOString();
  p.biz_confirm_note = comment;
  if (!confirmed) p.status = 'reviewing'; // 事业部退回则回到评审中
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, confirmed ? 'biz_confirm' : 'biz_reject',
    (req.user.real_name || '事业部') + (confirmed ? '确认成果' : '退回成果：' + comment), req.user.id);
  res.json(p);
});

// ==================== 站内通知 ====================
app.get('/api/notifications', auth(), (req, res) => {
  const uid = req.user.id, role = req.user.role;
  const list = (db.store.notifications || [])
    .filter(n => (n.user_id && n.user_id === uid) || (n.role_scope && n.role_scope === role))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json({ list, unread: list.filter(n => !n.read).length });
});
app.post('/api/notifications/:id/read', auth(), (req, res) => {
  const n = (db.store.notifications || []).find(x => x.id === parseInt(req.params.id));
  if (!n) return res.status(404).json({ error: '通知不存在' });
  n.read = true; db.save();
  res.json({ ok: true });
});
app.post('/api/notifications/read-all', auth(), (req, res) => {
  const uid = req.user.id, role = req.user.role;
  (db.store.notifications || []).forEach(n => {
    if ((n.user_id && n.user_id === uid) || (n.role_scope && n.role_scope === role)) n.read = true;
  });
  db.save();
  res.json({ ok: true });
});

// ==================== 采购成本合规比对 ====================
// 汇总某项目的询价/协议上限价：自动解析 inquiry 类 Excel 文件 + 人工录入的 p.inquiry_prices
function getInquiryPrices(p) {
  const prices = [];
  const seen = new Set();
  const add = (it) => {
    const key = (it.item_name || '') + '|' + (it.spec || '');
    if (seen.has(key)) return;
    seen.add(key);
    prices.push({ item_name: it.item_name, spec: it.spec || '', unit_price: Number(it.unit_price) || 0, source: it.source || 'unknown' });
  };
  // 人工录入（Word/PDF 或无法直接解析时由预审/管理员在页面维护）
  (p.inquiry_prices || []).forEach(add);
  // 自动解析 Excel 询价单
  const inquiryFiles = (db.store.files || []).filter(f => f.project_id === p.id && f.file_category === 'inquiry');
  for (const f of inquiryFiles) {
    const filePath = path.join(UPLOAD_DIR, f.filename);
    if (!fs.existsSync(filePath)) continue;
    if (!/\.(xlsx|xls)$/i.test(f.filename)) continue; // Word/PDF 暂不支持自动解析
    try {
      const { parseInquiryExcel } = require('./parse-excel');
      const r = parseInquiryExcel(filePath);
      (r.items || []).forEach(it => add({ ...it, source: 'excel:' + f.originalname }));
    } catch (e) { /* 解析失败忽略，交由人工录入 */ }
  }
  return prices;
}
function issueKey(iss) { return iss.key + ':' + (iss.item_name || '') + ':' + (iss.spec || ''); }
// 比对成本估算表采购明细与询价/协议上限价，返回违规项与已消除项
function checkProcurementCompliance(projectId) {
  const p = db.store.projects.find(x => x.id === projectId);
  if (!p) return { error: '项目不存在' };
  const procItems = db.store.procurementItems.filter(x => x.project_id === p.id);
  const procCost = procItems.reduce((a, x) => a + (Number(x.amount) || 0), 0);
  const prices = getInquiryPrices(p);
  const hasInquiry = prices.length > 0;
  const issues = [];
  if (procCost > 0 && !hasInquiry) {
    issues.push({ key: 'missing_inquiry', severity: 'high', item_name: '（整体）', spec: '', detail: '采购成本不为零，但未上传询价单/采购协议或录入上限价，无法比对。' });
  }
  const byNameSpec = {}, byName = {};
  prices.forEach(pr => {
    byNameSpec[(pr.item_name || '') + '|' + (pr.spec || '')] = pr;
    if (!byName[pr.item_name || '']) byName[pr.item_name || ''] = pr;
  });
  procItems.forEach(pi => {
    const name = pi.item_name || pi.name || '';
    const spec = pi.spec || '';
    const upper = byNameSpec[name + '|' + spec] || byName[name];
    if (!upper) {
      if (hasInquiry) issues.push({ key: 'unmatched', severity: 'low', item_name: name, spec, detail: '成本估算表采购项「' + name + (spec ? '(' + spec + ')' : '') + '」在询价单/协议中未找到对应货物，无法比对（建议补充询价）。' });
      return;
    }
    let estPrice = Number(pi.unit_price) || 0;
    if (!estPrice && (Number(pi.quantity) || 0) > 0) estPrice = (Number(pi.amount) || 0) / Number(pi.quantity);
    if (estPrice > upper.unit_price) {
      issues.push({
        key: 'over_price', severity: 'high', item_name: name, spec,
        est_price: Math.round(estPrice * 100) / 100, upper_price: upper.unit_price,
        detail: '「' + name + (spec ? '(' + spec + ')' : '') + '」成本估算单价 ¥' + estPrice + ' 超出询价/协议上限价 ¥' + upper.unit_price + '。'
      });
    }
  });
  const resolved = (p.procurement_resolutions || []) || [];
  const openIssues = issues.filter(iss => !resolved.some(r => r.issue_key === issueKey(iss)));
  return {
    procurement_cost: Math.round(procCost * 100) / 100,
    has_inquiry: hasInquiry,
    inquiry_count: prices.length,
    issues, open_issues: openIssues, resolved_count: resolved.length,
    resolved: resolved
  };
}
// 采购合规检查并主动提醒（仅对新增的"高危未消除"问题通知，避免重复刷屏）
function runProcurementCheckAndNotify(projectId, userId) {
  const p = db.store.projects.find(x => x.id === projectId);
  if (!p) return;
  const procCost = db.store.procurementItems.filter(x => x.project_id === p.id).reduce((a, x) => a + (Number(x.amount) || 0), 0);
  if (procCost <= 0) return; // 无采购成本无需检查
  const result = checkProcurementCompliance(projectId);
  const highOpen = (result.open_issues || []).filter(i => i.severity === 'high');
  if (!highOpen.length) return;
  const notified = (p.procurement_notified_keys || []);
  const newOnes = highOpen.filter(i => !notified.includes(issueKey(i)));
  if (!newOnes.length) return;
  const titles = newOnes.map(i => i.detail).join('；');
  notifyRoles(['admin', 'rd'], {
    type: 'procurement', title: '采购成本超标提醒：' + (p.project_name || '项目'),
    body: '项目「' + (p.project_name || '') + '」采购成本比对发现 ' + newOnes.length + ' 项问题，请复核：' + titles,
    related_project_id: p.id, related_session_id: p.session_id, created_by: userId
  });
  p.procurement_notified_keys = Array.from(new Set([...notified, ...newOnes.map(issueKey)]));
  db.save();
}

// 人工录入/维护询价单或采购协议的上限价（事业部经办人可录；预审/管理员可改）
app.post('/api/projects/:id/inquiry-prices', auth(['admin', 'rd', 'biz']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'biz' && req.user.business_dept !== p.biz_department) {
    return res.status(403).json({ error: '无权维护该项目询价价' });
  }
  const list = Array.isArray(req.body.items) ? req.body.items : [];
  const cleaned = list.filter(it => it && it.item_name && Number(it.unit_price) >= 0).map(it => ({
    item_name: String(it.item_name).trim(),
    spec: String(it.spec || '').trim(),
    unit_price: Number(it.unit_price) || 0,
    source: 'manual'
  }));
  p.inquiry_prices = cleaned;
  p.updated_at = new Date().toISOString();
  try { runProcurementCheckAndNotify(p.id, req.user.id); } catch (e) { console.error('采购合规检查失败:', e && e.message); }
  db.save();
  db.logWorkflow(p.id, 'set_inquiry_prices', `维护询价/协议上限价 ${cleaned.length} 条`, req.user.id);
  res.json({ ok: true, check: checkProcurementCompliance(p.id) });
});

// 预审人员/管理员复核后消除采购合规问题
app.post('/api/projects/:id/procurement-resolve', auth(['admin', 'rd']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const issueKeyParam = req.body.issue_key;
  const note = (req.body.note || '').toString();
  if (!issueKeyParam) return res.status(400).json({ error: '缺少 issue_key' });
  // 兼容前端传入的"短 key"(iss.key) 或完整 issueKey：统一归一为完整 key 后再比对
  const chk = checkProcurementCompliance(p.id);
  const match = (chk.issues || []).find(i => i.key === issueKeyParam || issueKey(i) === issueKeyParam);
  const targetKey = match ? issueKey(match) : issueKeyParam;
  p.procurement_resolutions = p.procurement_resolutions || [];
  if (p.procurement_resolutions.some(r => r.issue_key === targetKey)) {
    return res.status(400).json({ error: '该问题已消除' });
  }
  p.procurement_resolutions.push({
    issue_key: targetKey, note,
    by: req.user.id, by_name: req.user.real_name, by_role: req.user.role,
    at: new Date().toISOString()
  });
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, 'resolve_procurement', `消除采购合规问题 ${targetKey}：${note}`, req.user.id);
  res.json({ ok: true, check: checkProcurementCompliance(p.id) });
});

// ==================== 批量发起成果确认 / 批量确认 ====================
// 按批次批量发起成果确认：遍历批次下"评审中"项目，满足评估要求的直接发起并向事业部发通知；
// 不满足的（需评估但无评估数据）跳过并记录原因。采购合规问题按"软拦截"：允许发起但回带 warning。
app.post('/api/sessions/:id/initiate-confirmation-batch', auth(['admin', 'rd']), (req, res) => {
  const sid = parseInt(req.params.id);
  const sess = db.store.reviewSessions.find(s => s.id === sid);
  if (!sess) return res.status(404).json({ error: '批次不存在' });
  const idFilter = Array.isArray(req.body.project_ids) ? req.body.project_ids.map(Number) : null;
  const targets = db.store.projects.filter(p => p.session_id === sid && p.status === 'reviewing' && (!idFilter || idFilter.includes(p.id)));
  const initiated = [], skipped = [], warnings = [];
  targets.forEach(p => {
    const r = doInitiateConfirmation(p, req.user.id);
    if (r.ok) {
      initiated.push({ id: p.id, name: p.project_name });
      const chk = checkProcurementCompliance(p.id);
      const openHigh = (chk.open_issues || []).filter(i => i.severity === 'high');
      if (openHigh.length) warnings.push({ id: p.id, name: p.project_name, issues: openHigh.map(i => i.detail) });
    } else {
      skipped.push({ id: p.id, name: p.project_name, reason: r.reason });
    }
  });
  res.json({ ok: true, initiated, skipped, warnings, message: `已发起 ${initiated.length} 个，跳过 ${skipped.length} 个` });
});

// 事业部批量确认/退回（biz 限本事业部；rd/admin 可代确认）。用于"按部门拆分的结果汇总表"批量闭环。
app.post('/api/confirmations/batch', auth(['admin', 'rd', 'biz']), (req, res) => {
  const { project_ids, confirmed, comment } = req.body;
  if (!Array.isArray(project_ids) || !project_ids.length) return res.status(400).json({ error: '缺少项目列表' });
  const isBiz = req.user.role === 'biz';
  const results = [];
  for (const rawId of project_ids) {
    const pid = Number(rawId);
    const p = db.store.projects.find(x => x.id === pid);
    if (!p) { results.push({ id: pid, ok: false, reason: '项目不存在' }); continue; }
    if (p.status !== 'pending_confirm') { results.push({ id: pid, ok: false, reason: '非待确认状态' }); continue; }
    if (isBiz && req.user.business_dept !== p.biz_department) { results.push({ id: pid, ok: false, reason: '非本事业部项目' }); continue; }
    const c = !!confirmed;
    const cm = (req.body.comment || '').toString();
    if (!c && !cm.trim()) { results.push({ id: pid, ok: false, reason: '退回须填原因' }); continue; }
    p.biz_confirmed = c;
    p.biz_confirmed_by = req.user.id;
    p.biz_confirmed_name = req.user.real_name;
    p.biz_confirmed_at = new Date().toISOString();
    p.biz_confirm_note = cm;
    if (!c) p.status = 'reviewing';
    p.updated_at = new Date().toISOString();
    db.save();
    db.logWorkflow(p.id, c ? 'biz_confirm' : 'biz_reject', (req.user.real_name || '事业部') + (c ? '确认成果' : '退回成果：' + cm), req.user.id);
    results.push({ id: pid, ok: true, confirmed: c });
  }
  res.json({ ok: true, results });
});

// ==================== 工作量重评估（5 人专家评估聚合）====================
// 取项目所属批次的评审人（专家+会计师），按分配顺序取前 5 位作为 专家1-5
function getBatchEvaluators(projectId) {
  const p = db.store.projects.find(x => x.id === projectId);
  const sid = p && p.session_id;
  if (!sid) return [];
  return (db.store.sessionAssignments || [])
    .filter(a => a.session_id === sid && (a.user_role === 'expert' || a.user_role === 'accountant'))
    .sort((a, b) => a.id - b.id)
    .slice(0, 5)
    .map((a, i) => ({ slot: i + 1, user_id: a.user_id, user_name: a.user_name, role: a.user_role }));
}

// 计算单个工作项的 5 人评估汇总：平均=有效专家人天算术平均；调整后费用=平均×单人天单价(unit_price)
function computeWorkItemRollup(projectId, workItemId, evaluators) {
  const wi = db.store.workItems.find(w => w.id === workItemId && w.project_id === projectId);
  if (!wi) return null;
  const evs = evaluators || getBatchEvaluators(projectId);
  const byUser = {};
  db.store.expertEstimates
    .filter(e => e.project_id === projectId && e.work_item_id === workItemId)
    .forEach(e => { byUser[e.expert_id] = Number(e.days) || 0; });
  const expert_days = evs.map(ev => (byUser[ev.user_id] != null ? byUser[ev.user_id] : null));
  const valid = expert_days.filter(d => d != null && d > 0);
  const expert_count = valid.length;
  const avg = expert_count > 0 ? Math.round(valid.reduce((a, b) => a + b, 0) / expert_count * 100) / 100 : 0;
  const unit_price = Number(wi.unit_price) || 0;
  const adjusted_cost = avg > 0 ? Math.round(avg * unit_price * 100) / 100 : 0;
  return { evaluators: evs, expert_days, expert_count, expert_days_avg: avg, adjusted_cost, unit_price };
}

// 提交评估后落库汇总到 workItems（供管理员汇总页 / 导出读取）
function persistWorkItemRollup(projectId, workItemId) {
  const wi = db.store.workItems.find(w => w.id === workItemId && w.project_id === projectId);
  if (!wi) return;
  const r = computeWorkItemRollup(projectId, workItemId);
  if (!r) return;
  wi.expert_days = r.expert_days;
  wi.expert_count = r.expert_count;
  wi.expert_days_avg = r.expert_days_avg;
  wi.adjusted_cost = r.adjusted_cost;
}

// ==================== 成本明细 ====================
app.get('/api/projects/:id/cost', auth(), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const evaluators = getBatchEvaluators(p.id);
  const work_items = db.store.workItems.filter(w => w.project_id === p.id).map(w => {
    const r = computeWorkItemRollup(p.id, w.id, evaluators) || {};
    const ests = db.store.expertEstimates.filter(e => e.project_id === p.id && e.work_item_id === w.id);
    const myEst = ests.find(e => e.expert_id === req.user.id);
    return {
      ...w,
      expert_days: r.expert_days || [],
      expert_count: r.expert_count || 0,
      expert_days_avg: r.expert_days_avg || 0,
      adjusted_cost: r.adjusted_cost || 0,
      expert_days_list: ests.map(e => e.days),
      my_submitted: !!myEst,
      my_days: myEst ? myEst.days : null
    };
  });
  const allEst = db.store.expertEstimates.filter(e => e.project_id === p.id);
  res.json({
    cost_summary: p.cost_summary || {},
    work_items,
    evaluators,
    needs_estimate: needsEstimate(p),
    procurement_items: db.store.procurementItems.filter(x => x.project_id === p.id),
    travel_items: db.store.travelItems.filter(t => t.project_id === p.id),
    category_cost: calculateCategoryCost(db.store.workItems.filter(w => w.project_id === p.id)),
    estimate_stats: {
      total_experts: new Set(allEst.map(e => e.expert_id)).size,
      avg_days_by_item: {}
    }
  });
});

// ==================== 管理员：批次工作量评估汇总 ====================
// 构建某批次的 5 人专家评估汇总（GET 与导出共用）
function buildWorkloadSummary(sid, user) {
  const session = db.store.reviewSessions.find(s => s.id === sid);
  if (!session) return null;
  const projects = db.filterByDept('projects', user).filter(p => p.session_id === sid);
  const evaluators = (db.store.sessionAssignments || [])
    .filter(a => a.session_id === sid && (a.user_role === 'expert' || a.user_role === 'accountant'))
    .sort((a, b) => a.id - b.id).slice(0, 5)
    .map((a, i) => ({ slot: i + 1, user_id: a.user_id, user_name: a.user_name, role: a.user_role }));
  const projectSummaries = projects.map(p => {
    const wis = db.store.workItems.filter(w => w.project_id === p.id);
    let totalAdjusted = 0, evaluatedWI = 0;
    wis.forEach(w => {
      const r = computeWorkItemRollup(p.id, w.id, evaluators) || {};
      totalAdjusted += r.adjusted_cost || 0;
      if ((r.expert_count || 0) > 0) evaluatedWI++;
    });
    const cs = p.cost_summary || {};
    return {
      project_id: p.id, project_name: p.project_name, status: p.status,
      contract_amount: Number(p.contract_amount) || 0,
      internal_estimated_cost: p.internal_estimated_cost != null ? Number(p.internal_estimated_cost) : null,
      biz_department: p.biz_department || '-',
      project_type: p.project_type || '',
      is_digital: p.is_digital || false,
      business_direction: p.business_direction || '',
      business_sub_direction: p.business_sub_direction || '',
      product_direction: p.product_direction || '',
      is_restricted_subcontract: p.is_restricted_subcontract || '',
      subcontract_scope: p.subcontract_scope || '',
      cost_summary: cs,
      needs_estimate: needsEstimate(p),
      work_item_count: wis.length, evaluated_count: evaluatedWI,
      total_adjusted_cost: Math.round(totalAdjusted * 100) / 100
    };
  });
  const evaluatorProgress = evaluators.map(ev => {
    const projCount = projects.length;
    const submitted = projects.filter(p => db.store.expertEstimates.some(e => e.project_id === p.id && e.expert_id === ev.user_id)).length;
    return { ...ev, projects_assigned: projCount, projects_submitted: submitted, completion: projCount > 0 ? Math.round(submitted / projCount * 100) / 100 : 0 };
  });
  const batch_total_adjusted_cost = Math.round(projectSummaries.reduce((s, p) => s + p.total_adjusted_cost, 0) * 100) / 100;
  // 批次原预估成本（汇总表里登记的"内部信息系统填报预估成本"求和）
  const batch_total_original_cost = Math.round(projectSummaries.reduce((s, p) => s + (Number(p.internal_estimated_cost) || 0), 0) * 100) / 100;
  // 核减费用 = 原预估成本 - 专家评估完以后的预估成本
  const batch_total_reduction = Math.round((batch_total_original_cost - batch_total_adjusted_cost) * 100) / 100;
  const batch_work_item_count = projectSummaries.reduce((s, p) => s + p.work_item_count, 0);
  const batch_evaluated_count = projectSummaries.reduce((s, p) => s + p.evaluated_count, 0);
  return {
    session_id: sid, session_name: session.name, evaluators, projects: projectSummaries,
    batch_total_adjusted_cost, batch_total_original_cost, batch_total_reduction,
    batch_work_item_count, batch_evaluated_count, evaluator_progress: evaluatorProgress
  };
}

app.get('/api/sessions/:id/workload-summary', auth(['admin', 'rd']), (req, res) => {
  const sid = parseInt(req.params.id);
  const data = buildWorkloadSummary(sid, req.user);
  if (!data) return res.status(404).json({ error: '批次不存在' });
  res.json(data);
});

// 导出某批次「项目经济评审结果汇总表」为 xlsx —— 严格按用户提供的「附件3：第X批项目经济评审结果汇总表」格式：
//   3 行标题块（附件3 / 批次名 / 评审时间+单位：元）+ 两行表头（专业分包跨列 L:O 拆 4 子列，P 列分包占比）+ 数据 + 合计 + 专家签字。
// 评审结果汇总表（附件3）的行数据构造：整批导出与「按事业部拆分导出」共用
const WL_MONEY_KEYS = ['contract_amount', 'total_cost', 'long_term_cost', 'zhongshi_cost', 'huazhao_cost',
  'outsourcing_cost', 'subcontract_cost', 'procurement_cost', 'travel_cost', 'third_party_test_cost', 'ip_cost'];
function buildWorkloadAoaBlocks(data) {
  const totals = {}; WL_MONEY_KEYS.forEach(k => totals[k] = 0);
  const pct = (a, b) => (b > 0 ? Math.round(a / b * 10000) / 100 : null); // 如 47.56 表示 47.56%
  const oneRow = (p, idx, t) => {
    const cs = p.cost_summary || {};
    const contract = Number(p.contract_amount) || 0;
    const tc = Number(cs.total_cost) || 0;
    const sub = Number(cs.subcontract_cost) || 0;
    const row = {
      idx: idx + 1, project_name: p.project_name, biz_department: p.biz_department, project_type: p.project_type,
      contract_amount: contract, total_cost: tc,
      profit_rate: cs.profit_rate != null ? Math.round(Number(cs.profit_rate) * 10000) / 100 : null,
      long_term_cost: Number(cs.long_term_cost) || 0, zhongshi_cost: Number(cs.zhongshi_cost) || 0,
      huazhao_cost: Number(cs.huazhao_cost) || 0, outsourcing_cost: Number(cs.outsourcing_cost) || 0,
      subcontract_cost: sub,
      subcontract_ratio_pp: pct(sub, contract),  // 专业分包占比 = 专业分包/合同额
      is_restricted_subcontract: p.is_restricted_subcontract || '',
      subcontract_scope: p.subcontract_scope || '',
      subcontract_ratio_all: pct(sub, tc),        // 分包占比 = 专业分包/总成本
      procurement_cost: Number(cs.procurement_cost) || 0, travel_cost: Number(cs.travel_cost) || 0,
      third_party_test_cost: Number(cs.third_party_test_cost) || 0, ip_cost: Number(cs.ip_cost) || 0,
      is_digital: p.is_digital ? '是' : '否',
      business_direction: p.business_direction || '',
      business_sub_direction: p.business_sub_direction || '', product_direction: p.product_direction || ''
    };
    WL_MONEY_KEYS.forEach(k => t[k] += Number(row[k]) || 0);
    const s = v => (v == null ? '' : v + '%');
    // 24 列（A:X）
    return [row.idx, row.project_name, row.biz_department, row.project_type, row.contract_amount, row.total_cost,
      s(row.profit_rate), row.long_term_cost, row.zhongshi_cost, row.huazhao_cost, row.outsourcing_cost,
      row.subcontract_cost, s(row.subcontract_ratio_pp), row.is_restricted_subcontract, row.subcontract_scope,
      s(row.subcontract_ratio_all), row.procurement_cost, row.travel_cost,
      row.third_party_test_cost, row.ip_cost, row.is_digital, row.business_direction,
      row.business_sub_direction, row.product_direction];
  };
  const totalRowOf = t => ['', '合计', '', '', t.contract_amount, t.total_cost, null,
    t.long_term_cost, t.zhongshi_cost, t.huazhao_cost, t.outsourcing_cost, t.subcontract_cost, null, '', '',
    (t.total_cost > 0 ? (Math.round(t.subcontract_cost / t.total_cost * 10000) / 100) + '%' : ''),
    t.procurement_cost, t.travel_cost, t.third_party_test_cost, t.ip_cost, '', '', '', ''];
  return { rowsOf: ps => ps.map((p, i) => oneRow(p, i, totals)), totals, totalRowOf, oneRow, emptyTotals: () => { const t = {}; WL_MONEY_KEYS.forEach(k => t[k] = 0); return t; } };
}
app.get('/api/sessions/:id/workload-summary/export', auth(['admin', 'rd']), (req, res) => {
  const sid = parseInt(req.params.id);
  const data = buildWorkloadSummary(sid, req.user);
  if (!data) return res.status(404).json({ error: '批次不存在' });
  const B = buildWorkloadAoaBlocks(data);
  const rows = B.rowsOf(data.projects || []);
  const totals = B.totals;
  const totalRow = B.totalRowOf(totals);

  // ===== 标题块 + 两行表头 =====
  const title = data.session_name || `第${sid}批项目经济评审`;
  const now = new Date();
  const reviewTime = `评审时间：${now.getFullYear()}.${now.getMonth() + 1}`;
  const header1 = ['序号', '项目名称', '项目承建部门', '项目类型', '合同额', '项目总成本估算', '项目估算利润率',
    '长期职工成本估算', '中实职工成本估算', '华兆职工成本估算', '人员外包估算',
    '专业分包', '', '', '', '分包占比', '采购估算', '差旅费估算', '第三方测试估算', '知识产权估算',
    '是否属于数字化', '业务方向', '业务子方向', '产品方向'];
  const header2 = ['', '', '', '', '', '', '', '', '', '', '',
    '专业分包估算', '专业分包占比', '是否属于限制分包', '专业分包范围', '', '', '', '', '', '', '', '', ''];
  const aoa = [
    ['附件3'],
    [title],
    [reviewTime, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '单位：元'],
    header1, header2,
    ...rows,
    totalRow,
    ['专家签字：']
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = header1.map((h, i) => ({ wch: i === 1 ? 28 : (i === 14 ? 24 : (i >= 21 && i <= 23 ? 16 : 12)) }));
  // 合并区域（0-indexed 行列）
  const merges = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 23 } },                 // 附件3
    { s: { r: 1, c: 0 }, e: { r: 1, c: 21 } },                 // 批次名
    { s: { r: 1, c: 22 }, e: { r: 1, c: 23 } },                // 单位：元
    { s: { r: 2, c: 0 }, e: { r: 2, c: 21 } },                 // 评审时间
    { s: { r: 2, c: 22 }, e: { r: 2, c: 23 } },                // 单位：元(第三行)
    { s: { r: 3, c: 11 }, e: { r: 3, c: 14 } }                 // 专业分包 跨列头
  ];
  // 第一、二行表头中跨两行的列：A..K（0-10）、P..X（15-23）竖向合并
  for (let c = 0; c <= 10; c++) merges.push({ s: { r: 3, c }, e: { r: 4, c } });
  for (let c = 15; c <= 23; c++) merges.push({ s: { r: 3, c }, e: { r: 4, c } });
  // 专家签字行合并
  const lastRow = aoa.length - 1;
  merges.push({ s: { r: lastRow, c: 0 }, e: { r: lastRow, c: 23 } });
  ws['!merges'] = merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '项目经济评审结果汇总表');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `第${sid}批项目经济评审结果汇总表_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="batch_${sid}_summary.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

// ==================== 评审结果汇总表：按事业部拆分导出（分发给各事业部确认） ====================
// 一个工作簿内每个事业部一个工作表（选中具体事业部时只出该部门一张表），
// 表内结构与「导出本批次汇总表」完全一致（附件3 表头 + 该部门项目 + 小计 + 专家签字）。
// 权限：admin/rd 可导出任意事业部；biz 角色只能导出自己所属事业部。
app.get('/api/sessions/:id/workload-summary/export-by-dept', auth(['admin', 'rd', 'biz']), (req, res) => {
  const sid = parseInt(req.params.id);
  const data = buildWorkloadSummary(sid, req.user);
  if (!data) return res.status(404).json({ error: '批次不存在' });
  let deptFilter = (req.query.biz_department || '').toString().trim();
  if (req.user.role === 'biz') {
    const myDept = (req.user.business_dept || '').toString().trim();
    if (!myDept) return res.status(403).json({ error: '账号未绑定事业部，无法导出' });
    deptFilter = myDept;
  }
  const all = data.projects || [];
  const groups = {};
  all.forEach(p => {
    const d = (p.biz_department || '未分配事业部').toString().trim() || '未分配事业部';
    (groups[d] = groups[d] || []).push(p);
  });
  let depts = Object.keys(groups);
  if (deptFilter) {
    if (!groups[deptFilter]) return res.status(404).json({ error: '该事业部在本批次下没有项目' });
    depts = [deptFilter];
  }
  const title = data.session_name || `第${sid}批项目经济评审`;
  const now = new Date();
  const reviewTime = `评审时间：${now.getFullYear()}.${now.getMonth() + 1}`;
  const header1 = ['序号', '项目名称', '项目承建部门', '项目类型', '合同额', '项目总成本估算', '项目估算利润率',
    '长期职工成本估算', '中实职工成本估算', '华兆职工成本估算', '人员外包估算',
    '专业分包', '', '', '', '分包占比', '采购估算', '差旅费估算', '第三方测试估算', '知识产权估算',
    '是否属于数字化', '业务方向', '业务子方向', '产品方向'];
  const header2 = ['', '', '', '', '', '', '', '', '', '', '',
    '专业分包估算', '专业分包占比', '是否属于限制分包', '专业分包范围', '', '', '', '', '', '', '', '', ''];
  // 每个工作表：标题块 + 表头 + 该部门行 + 小计 + 专家签字（与整批导出同款版式）
  const buildSheetAoa = (dept, ps) => {
    const t = {}; WL_MONEY_KEYS.forEach(k => t[k] = 0);
    const B = buildWorkloadAoaBlocks({ projects: ps });
    const rows = ps.map((p, i) => B.oneRow(p, i, t));
    return [
      ['附件3'],
      [`${title}（${dept}）`],
      [reviewTime, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '单位：元'],
      header1, header2,
      ...rows,
      B.totalRowOf(t),
      ['专家签字：']
    ];
  };
  const wb = XLSX.utils.book_new();
  depts.forEach(dept => {
    const aoa = buildSheetAoa(dept, groups[dept]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = header1.map((h, i) => ({ wch: i === 1 ? 28 : (i === 14 ? 24 : (i >= 21 && i <= 23 ? 16 : 12)) }));
    const merges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 23 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 21 } },
      { s: { r: 1, c: 22 }, e: { r: 1, c: 23 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 21 } },
      { s: { r: 2, c: 22 }, e: { r: 2, c: 23 } },
      { s: { r: 3, c: 11 }, e: { r: 3, c: 14 } }
    ];
    for (let c = 0; c <= 10; c++) merges.push({ s: { r: 3, c }, e: { r: 4, c } });
    for (let c = 15; c <= 23; c++) merges.push({ s: { r: 3, c }, e: { r: 4, c } });
    const lastRow = aoa.length - 1;
    merges.push({ s: { r: lastRow, c: 0 }, e: { r: lastRow, c: 23 } });
    ws['!merges'] = merges;
    // 工作表名：Excel 上限 31 字符，且不能含 : \ / ? * [ ]
    let sname = String(dept).replace(/[:\\\/?*\[\]]/g, '_').substring(0, 31) || '事业部';
    let uniq = sname, n = 2;
    while (wb.SheetNames.includes(uniq)) uniq = sname.substring(0, 28) + '(' + (n++) + ')';
    XLSX.utils.book_append_sheet(wb, ws, uniq);
  });
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `第${sid}批评审结果确认表_${deptFilter || '按事业部'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="batch_${sid}_by_dept.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

// ==================== 离线评估表（专家评估示例）批量导入 ====================
// 「线上线下双轨」：把线下填好的 per-project 成本估算表（含「项目基本信息」+ 明细 sheet）批量导入，
// 按 项目编号(主)/项目名称(次) 在批次内匹配系统项目，自动写入 cost_summary，回灌到评审结果汇总表。
const offlineEvalUpload = upload.array('files', 200);
app.post('/api/sessions/:id/import-offline-eval', auth(['admin', 'rd']), offlineEvalUpload, (req, res) => {
  const sid = parseInt(req.params.id);
  const session = db.store.reviewSessions.find(s => s.id === sid);
  if (!session) return res.status(404).json({ error: '批次不存在' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: '未收到文件' });
  const projects = db.store.projects.filter(p => p.session_id === sid);
  const reports = [];
  let imported = 0;
  for (const f of files) {
    const realName = decodeFilename(f.originalname);
    const rep = { file: realName, matched: false };
    try {
      const { parseOfflineEval } = require('./parse-offline-eval');
      const parsed = parseOfflineEval(f.path);
      const pp = parsed.project;
      // 匹配：优先 项目编号（精确），其次 项目名称（包含/相等）
      let target = null;
      const code = (pp.project_code || '').trim();
      const pname = (pp.project_name || '').trim();
      if (code) target = projects.find(p => (p.project_code || '').trim() === code);
      if (!target && pname) {
        target = projects.find(p => (p.project_name || '').trim() === pname)
          || projects.find(p => (p.project_name || '').includes(pname) || pname.includes(p.project_name || ''));
      }
      if (!target) {
        rep.error = '未找到匹配项目（按项目编号/名称）';
        rep.parsed = { project_code: code, project_name: pname };
        reports.push(rep);
        continue;
      }
      const cs = pp.cost_summary || {};
      const updated = [];
      // 项目级字段
      if (pp.is_digital !== undefined && target.is_digital !== pp.is_digital) { target.is_digital = pp.is_digital; updated.push('是否数字化'); }
      ['business_direction', 'business_sub_direction', 'product_direction'].forEach(k => {
        if (pp[k] && target[k] !== pp[k]) { target[k] = pp[k]; updated.push(k); }
      });
      if (code && !target.project_code) { target.project_code = code; updated.push('项目编号'); }
      if (pp.biz_department && !target.biz_department) { target.biz_department = pp.biz_department; updated.push('承建部门'); }
      if (pp.project_type && !target.project_type) { target.project_type = pp.project_type; updated.push('项目类型'); }
      if ((target.contract_amount == null || Number(target.contract_amount) === 0) && pp.contract_amount) {
        target.contract_amount = pp.contract_amount; updated.push('合同额');
      }
      // 成本汇总
      target.cost_summary = cs;
      snapshotPre(target);
      updated.push('cost_summary');
      target.updated_at = new Date().toISOString();
      db.logWorkflow(target.id, 'import_offline_eval', `导入离线评估表[${realName}]，更新 ${updated.join('/')}`, req.user.id);
      rep.matched = true;
      rep.project_id = target.id;
      rep.project_name = target.project_name;
      rep.updated = updated;
      rep.warnings = parsed.warnings || [];
      imported++;
    } catch (e) {
      rep.error = '解析失败：' + (e && e.message);
      reports.push(rep);
      continue;
    }
    reports.push(rep);
  }
  db.save();
  res.json({ imported, total: files.length, reports });
});

// ==================== 年度评审结果汇总（协同查看 / 编辑 / 评论）====================
// 「线上线下双轨」下，年度汇总作为一份可多人协同的"云文档"：admin/rd 可编辑段落并留痕，
// 所有角色可查看、可评论；前端定时刷新以体现协同。数据落 annual 集合（mysql 经 extra 自动持久化）。
function annualScaffold(year) {
  return {
    year: Number(year),
    data: {
      sections: [
        { key: 'overview', title: '年度总体情况', content: '' },
        { key: 'problems', title: '存在的主要问题', content: '' },
        { key: 'plan', title: '下一步工作建议', content: '' }
      ],
      edit_history: [], comments: []
    }
  };
}
function getAnnualDoc(year) {
  return db.store.annual.find(a => a.year === Number(year)) || null;
}
// ==================== 年度评审结果汇总（49 列，严格对齐用户模板）====================
// 列定义：base(基础) / pre(评审前 I..AA) / post(评审后 AB..AP) / audit(导入校核 AQ..AW)
// type: text | money | pct ；pct 以小数存储（如 0.18），前端按百分比展示。
// 评审前成本取 cost_summary_pre（首次导入快照），评审后取 cost_summary；缺失时两件相等。
const ANNUAL_COLUMNS = [
  // base A..H
  { key: 'batch', label: '批次', group: 'base', type: 'text' },
  { key: 'seq', label: '序号', group: 'base', type: 'text' },
  { key: 'project_code', label: '项目编号', group: 'base', type: 'text' },
  { key: 'project_name', label: '项目名称', group: 'base', type: 'text' },
  { key: 'dept', label: '部门', group: 'base', type: 'text' },
  { key: 'project_type', label: '项目类型', group: 'base', type: 'text' },
  { key: 'contract_amount', label: '合同额（元）', group: 'base', type: 'money' },
  { key: 'sys_pre_cost', label: '系统填报预估成本（元）', group: 'base', type: 'money' },
  // pre 评审前 I..AA (19)
  { key: 'pre_total', label: '估算成本（元）1', group: 'pre', type: 'money' },
  { key: 'pre_profit_rate', label: '预估利润率1', group: 'pre', type: 'pct' },
  { key: 'pre_long_term', label: '长期职工成本（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_zhongshi', label: '中实职工成本（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_huazhao', label: '华兆职工成本（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_outsourcing', label: '人员外包费用（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_subcontract', label: '专业分包费用（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_subcontract_ratio', label: '专业分包比例', group: 'pre', type: 'pct' },
  { key: 'pre_restricted', label: '是否属于限制分包', group: 'pre', type: 'text', editable: true },
  { key: 'pre_subcontract_scope', label: '专业分包范围', group: 'pre', type: 'text', editable: true },
  { key: 'pre_subcontract_all_ratio', label: '分包比例', group: 'pre', type: 'pct' },
  { key: 'pre_procurement', label: '采购费用（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_travel', label: '差旅费（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_third_party', label: '第三方测试费（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_ip', label: '知识产权费（元）', group: 'pre', type: 'money', editable: true },
  { key: 'pre_is_digital', label: '否属于数字化', group: 'pre', type: 'text' },
  { key: 'pre_business_direction', label: '业务方向', group: 'pre', type: 'text', editable: true },
  { key: 'pre_business_sub_direction', label: '业务子方向', group: 'pre', type: 'text', editable: true },
  { key: 'pre_product_direction', label: '产品方向', group: 'pre', type: 'text', editable: true },
  // post 评审后 AB..AP (15)
  { key: 'post_total', label: '估算成本（元）2', group: 'post', type: 'money' },
  { key: 'post_review_opinion', label: '评审意见', group: 'post', type: 'text', editable: true },
  { key: 'post_review_time', label: '评审时间', group: 'post', type: 'text', editable: true },
  { key: 'post_long_term', label: '长期职工成本（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_zhongshi', label: '中实职工成本（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_huazhao', label: '华兆职工成本（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_outsourcing', label: '人员外包费用（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_subcontract', label: '专业分包费用（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_procurement', label: '采购费用（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_travel', label: '差旅费（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_third_party', label: '第三方测试费（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_ip', label: '知识产权费（元）', group: 'post', type: 'money', editable: true },
  { key: 'post_profit_rate', label: '预估利润率', group: 'post', type: 'pct' },
  { key: 'post_subcontract_ratio', label: '专业分包比例', group: 'post', type: 'pct' },
  { key: 'post_subcontract_all_ratio', label: '分包比例', group: 'post', type: 'pct' },
  // audit 导入校核 AQ..AW (7)
  { key: 'import_status', label: '导入情况', group: 'audit', type: 'text', editable: true },
  { key: 'import_time', label: '导入时间', group: 'audit', type: 'text', editable: true },
  { key: 'import_reason', label: '未导入原因', group: 'audit', type: 'text', editable: true },
  { key: 'reduction', label: '评审后核减值', group: 'audit', type: 'money' },
  { key: 'bid_gross_margin', label: '投标毛利率', group: 'audit', type: 'pct', editable: true },
  { key: 'rate_reason', label: '利率合理性（投标毛利率和预估利润率校核）', group: 'audit', type: 'text', editable: true },
  { key: 'labor_subcontract_note', label: '劳务分包备注', group: 'audit', type: 'text', editable: true }
];
const COST_KEYS = ['long_term_cost', 'zhongshi_cost', 'huazhao_cost', 'outsourcing_cost', 'subcontract_cost', 'procurement_cost', 'travel_cost', 'third_party_test_cost', 'ip_cost'];
function costSum(cs) { return COST_KEYS.reduce((s, k) => s + (Number(cs && cs[k]) || 0), 0); }
// 9 项成本明细提取值
function costParts(cs) {
  cs = cs || {};
  return {
    long_term: Number(cs.long_term_cost) || 0,
    zhongshi: Number(cs.zhongshi_cost) || 0,
    huazhao: Number(cs.huazhao_cost) || 0,
    outsourcing: Number(cs.outsourcing_cost) || 0,
    subcontract: Number(cs.subcontract_cost) || 0,
    procurement: Number(cs.procurement_cost) || 0,
    travel: Number(cs.travel_cost) || 0,
    third_party: Number(cs.third_party_test_cost) || 0,
    ip: Number(cs.ip_cost) || 0
  };
}
const MONEY_KEYS = ANNUAL_COLUMNS.filter(c => c.type === 'money').map(c => c.key);
const PCT_KEYS = ANNUAL_COLUMNS.filter(c => c.type === 'pct').map(c => c.key);
const r2 = n => (n == null || isNaN(n)) ? null : Math.round(n * 100) / 100;
const r4 = n => (n == null || isNaN(n)) ? null : Math.round(n * 10000) / 10000;

function buildAnnualSummary(year, user) {
  const y = String(year);
  const sessions = (db.store.reviewSessions || []).filter(s => {
    const t = s.created_at || s.review_time;
    return t && String(t).slice(0, 4) === y;
  });
  const sessionIds = new Set(sessions.map(s => s.id));
  const sName = {}; sessions.forEach(s => sName[s.id] = s.name);
  const projects = db.filterByDept('projects', user).filter(p => sessionIds.has(p.session_id));
  const rows = [];
  projects.forEach((p, i) => {
    const preCs = p.cost_summary_pre || p.cost_summary || {};
    const postCs = p.cost_summary || {};
    const pre = costParts(preCs), post = costParts(postCs);
    const I = costSum(preCs), AB = costSum(postCs);
    const G = Number(p.contract_amount) || 0;
    const J = G > 0 ? r4((G - I) / G) : null;
    const P = G > 0 ? r4(pre.subcontract / G) : null;
    const S = G > 0 ? r4((I - pre.long_term - pre.third_party) / G) : null;
    const AN = G > 0 ? r4((G - AB) / G) : null;
    const AO = G > 0 ? r4(post.subcontract / G) : null;
    const AP = G > 0 ? r4((AB - post.long_term - post.third_party) / G) : null;
    const AT = r2(I - AB);
    // 利率合理性：投标毛利率 vs 预估利润率1（评审前）偏差>3% 视为不合理
    let rateReason = p.rate_reason || '';
    if (!rateReason && p.bid_gross_margin != null && J != null) {
      rateReason = (Math.abs(Number(p.bid_gross_margin) - J) > 0.03) ? '不合理' : '合理';
    }
    const cells = {
      batch: sName[p.session_id] || ('批次' + p.session_id), seq: i + 1,
      project_code: p.project_code || '', project_name: p.project_name || '',
      dept: p.biz_department || '', project_type: p.project_type || '',
      contract_amount: G, sys_pre_cost: r2(Number(p.internal_estimated_cost) || 0),
      pre_total: r2(I), pre_profit_rate: J,
      pre_long_term: r2(pre.long_term), pre_zhongshi: r2(pre.zhongshi), pre_huazhao: r2(pre.huazhao),
      pre_outsourcing: r2(pre.outsourcing), pre_subcontract: r2(pre.subcontract),
      pre_subcontract_ratio: P, pre_restricted: p.is_restricted_subcontract || '',
      pre_subcontract_scope: p.subcontract_scope || '', pre_subcontract_all_ratio: S,
      pre_procurement: r2(pre.procurement), pre_travel: r2(pre.travel),
      pre_third_party: r2(pre.third_party), pre_ip: r2(pre.ip),
      pre_is_digital: p.is_digital ? '是' : '否',
      pre_business_direction: p.business_direction || '', pre_business_sub_direction: p.business_sub_direction || '',
      pre_product_direction: p.product_direction || '',
      post_total: r2(AB), post_review_opinion: p.review_opinion || '',
      post_review_time: (p.review_time || '').slice(0, 10),
      post_long_term: r2(post.long_term), post_zhongshi: r2(post.zhongshi), post_huazhao: r2(post.huazhao),
      post_outsourcing: r2(post.outsourcing), post_subcontract: r2(post.subcontract),
      post_procurement: r2(post.procurement), post_travel: r2(post.travel),
      post_third_party: r2(post.third_party), post_ip: r2(post.ip),
      post_profit_rate: AN, post_subcontract_ratio: AO, post_subcontract_all_ratio: AP,
      import_status: p.import_status || '', import_time: (p.import_time || '').slice(0, 10),
      import_reason: p.import_reason || '', reduction: AT,
      bid_gross_margin: p.bid_gross_margin != null ? r4(Number(p.bid_gross_margin)) : null,
      rate_reason: rateReason, labor_subcontract_note: p.labor_subcontract_note || ''
    };
    rows.push({ project_id: p.id, cells });
  });
  // 合计
  const tot = {};
  MONEY_KEYS.forEach(k => tot[k] = r2(rows.reduce((s, r) => s + (Number(r.cells[k]) || 0), 0)));
  const Gs = tot.contract_amount || 0;
  const preI = tot.pre_total, postAB = tot.post_total;
  tot.pre_profit_rate = Gs > 0 ? r4((Gs - preI) / Gs) : null;
  tot.pre_subcontract_ratio = Gs > 0 ? r4(tot.pre_subcontract / Gs) : null;
  tot.pre_subcontract_all_ratio = Gs > 0 ? r4((preI - tot.pre_long_term - tot.pre_third_party) / Gs) : null;
  tot.post_profit_rate = Gs > 0 ? r4((Gs - postAB) / Gs) : null;
  tot.post_subcontract_ratio = Gs > 0 ? r4(tot.post_subcontract / Gs) : null;
  tot.post_subcontract_all_ratio = Gs > 0 ? r4((postAB - tot.post_long_term - tot.post_third_party) / Gs) : null;
  // 文本/序号列合计留空
  ['batch', 'seq', 'project_code', 'project_name', 'dept', 'project_type',
    'pre_restricted', 'pre_subcontract_scope', 'pre_is_digital', 'pre_business_direction',
    'pre_business_sub_direction', 'pre_product_direction', 'post_review_opinion', 'post_review_time',
    'import_status', 'import_time', 'import_reason', 'bid_gross_margin', 'rate_reason', 'labor_subcontract_note'
  ].forEach(k => tot[k] = '');
  tot.batch = '合计'; tot.seq = ''; tot.project_code = ''; tot.project_name = '';
  return { year, columns: ANNUAL_COLUMNS, rows, totals: tot, projectCount: rows.length, batchCount: sessions.length };
}

app.get('/api/annual/:year', auth(), (req, res) => {
  const year = parseInt(req.params.year);
  if (!year || isNaN(year)) return res.status(400).json({ error: '无效年份' });
  const summary = buildAnnualSummary(year, req.user);
  const doc = getAnnualDoc(year);
  res.json({ summary, doc: doc ? doc : annualScaffold(year) });
});

app.put('/api/annual/:year', auth(['admin', 'rd']), (req, res) => {
  const year = parseInt(req.params.year);
  if (!year || isNaN(year)) return res.status(400).json({ error: '无效年份' });
  const incoming = Array.isArray(req.body.sections) ? req.body.sections : [];
  let doc = getAnnualDoc(year);
  const now = new Date().toISOString();
  if (!doc) {
    doc = { id: db.nextId(db.store.annual), year, data: annualScaffold(year).data, updated_at: now };
    db.store.annual.push(doc);
  }
  const existing = (doc.data && doc.data.sections) || [];
  const hist = (doc.data && doc.data.edit_history) || [];
  const byKey = {}; existing.forEach(s => byKey[s.key] = s);
  incoming.forEach(s => {
    const prev = byKey[s.key];
    const before = prev ? (prev.content || '') : '';
    const after = s.content || '';
    if (before !== after) {
      hist.push({ user: req.user.real_name || req.user.username, at: now, field: s.key, before, after });
    }
    if (prev) { prev.content = after; if (s.title) prev.title = s.title; }
    else existing.push({ key: s.key, title: s.title || s.key, content: after });
  });
  doc.data.sections = existing;
  doc.data.edit_history = hist;
  doc.updated_at = now;
  db.save();
  res.json({ ok: true, doc });
});

app.post('/api/annual/:year/comments', auth(), (req, res) => {
  const year = parseInt(req.params.year);
  if (!year || isNaN(year)) return res.status(400).json({ error: '无效年份' });
  const text = (req.body.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: '评论内容不能为空' });
  let doc = getAnnualDoc(year);
  const now = new Date().toISOString();
  if (!doc) {
    doc = { id: db.nextId(db.store.annual), year, data: annualScaffold(year).data, updated_at: now };
    db.store.annual.push(doc);
  }
  const comments = (doc.data && doc.data.comments) || [];
  const c = { id: (comments.length ? Math.max(...comments.map(x => x.id)) : 0) + 1, user: req.user.real_name || req.user.username, at: now, text };
  comments.push(c);
  doc.data.comments = comments;
  doc.updated_at = now;
  db.save();
  res.json({ ok: true, comment: c });
});

// 年度汇总行内编辑：更新某项目的「评审前/评审后 9 项成本」与可编辑元数据（业务方向/数字化/限制分包/评审意见/投标毛利率/导入情况/利率合理性等）
app.patch('/api/projects/:id/annual', auth(['admin', 'rd', 'biz']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'biz' && req.user.business_dept !== p.biz_department) {
    return res.status(403).json({ error: '无权修改该项目' });
  }
  const body = req.body || {};
  // 评审前成本
  if (body.pre && typeof body.pre === 'object') {
    p.cost_summary_pre = p.cost_summary_pre || (p.cost_summary ? JSON.parse(JSON.stringify(p.cost_summary)) : {});
    COST_KEYS.forEach(k => { if (body.pre[k] !== undefined) p.cost_summary_pre[k] = Number(body.pre[k]) || 0; });
    p.cost_summary_pre.total_cost = costSum(p.cost_summary_pre);
  }
  // 评审后成本
  if (body.post && typeof body.post === 'object') {
    p.cost_summary = p.cost_summary || {};
    COST_KEYS.forEach(k => { if (body.post[k] !== undefined) p.cost_summary[k] = Number(body.post[k]) || 0; });
    p.cost_summary.total_cost = costSum(p.cost_summary);
  }
  // 元数据
  const metaMap = {
    pre_restricted: 'is_restricted_subcontract', pre_subcontract_scope: 'subcontract_scope',
    pre_business_direction: 'business_direction', pre_business_sub_direction: 'business_sub_direction',
    pre_product_direction: 'product_direction', post_review_opinion: 'review_opinion',
    post_review_time: 'review_time', import_status: 'import_status', import_time: 'import_time',
    import_reason: 'import_reason', bid_gross_margin: 'bid_gross_margin', rate_reason: 'rate_reason',
    labor_subcontract_note: 'labor_subcontract_note'
  };
  Object.keys(metaMap).forEach(k => {
    if (body[k] !== undefined) {
      if (k === 'bid_gross_margin') p[metaMap[k]] = body[k] === '' ? null : Number(body[k]);
      else p[metaMap[k]] = body[k];
    }
  });
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, 'annual_edit', '年度汇总行内编辑', req.user.id);
  // 协同编辑历史：找到项目所属年份，写入年度文档 edit_history
  try {
    const sess = db.store.reviewSessions.find(s => s.id === p.session_id);
    const yr = sess ? String((sess.created_at || sess.review_time || '').slice(0, 4)) : null;
    if (yr) {
      let ad = getAnnualDoc(yr);
      const now = new Date().toISOString();
      if (!ad) { ad = { id: db.nextId(db.store.annual), year: Number(yr), data: annualScaffold(yr).data, updated_at: now }; db.store.annual.push(ad); }
      ad.data.edit_history = ad.data.edit_history || [];
      ad.data.edit_history.push({ user: req.user.real_name || req.user.username, at: now, field: '年度汇总行', after: (p.project_name || p.project_code || ('项目' + p.id)) });
      ad.updated_at = now;
      db.save();
    }
  } catch (_) { /* 历史记录失败不影响主流程 */ }
  res.json({ ok: true, project: p });
});

// 导出年度评审结果汇总 xlsx（严格对齐 49 列模板：双层表头 评审前/评审后 + 合计行）
app.get('/api/annual/:year/export', auth(['admin', 'rd']), (req, res) => {
  const year = parseInt(req.params.year);
  if (!year || isNaN(year)) return res.status(400).json({ error: '无效年份' });
  const summary = buildAnnualSummary(year, req.user);
  const { columns, rows, totals } = summary;
  const groupBanner = { base: '', pre: '评审前', post: '评审后', audit: '' };
  // 第1行：分组旗帜（base/audit 留空，pre 跨 19 列，post 跨 15 列）
  const row1 = columns.map(c => (c.group === 'pre' ? '评审前' : (c.group === 'post' ? '评审后' : '')));
  // 第2行：字段名
  const row2 = columns.map(c => c.label);
  const dataRows = rows.map(r => columns.map(c => {
    const v = r.cells[c.key];
    if (v == null) return '';
    if (c.type === 'money') return Number(v) || 0;
    if (c.type === 'pct') return (v == null ? '' : Number(v));
    return v;
  }));
  const totalRow = columns.map(c => {
    const v = totals[c.key];
    if (v === '' || v == null) return '';
    if (c.type === 'money') return Number(v) || 0;
    if (c.type === 'pct') return Number(v);
    return v;
  });
  // 合计行置于表头之后、项目之前，与源表模板版式一致
  const aoa = [row1, row2, totalRow, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // 双层表头样式：第1行分组合并、第2行加粗
  const range = XLSX.utils.decode_range(ws['!ref']);
  const merges = [];
  // 评审前 合并列
  const preCols = columns.map((c, i) => c.group === 'pre' ? i : -1).filter(i => i >= 0);
  const postCols = columns.map((c, i) => c.group === 'post' ? i : -1).filter(i => i >= 0);
  if (preCols.length) merges.push({ s: { r: 0, c: preCols[0] }, e: { r: 0, c: preCols[preCols.length - 1] } });
  if (postCols.length) merges.push({ s: { r: 0, c: postCols[0] }, e: { r: 0, c: postCols[postCols.length - 1] } });
  ws['!merges'] = merges;
  for (let c = 0; c <= range.e.c; c++) {
    const h2 = XLSX.utils.encode_cell({ r: 1, c });
    if (ws[h2]) { ws[h2].s = Object.assign(ws[h2].s || {}, { font: { bold: true }, alignment: { wrapText: true, vertical: 'center' } }); }
    const h1 = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[h1] && ws[h1].v) { ws[h1].s = Object.assign(ws[h1].s || {}, { font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' } }); }
  }
  // 列宽
  ws['!cols'] = columns.map(c => ({ wch: c.key === 'project_name' ? 30 : (c.type === 'text' ? 14 : 12) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, String(year) + '年度汇总');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `${year}年经济评审汇总表.xlsx`;
  const asciiName = `${year}_annual_summary.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(buf);
});

// ==================== 统计分析 ====================
function getDetailedStats(user) {
  return {
    projects: db.filterByDept('projects', user),
    files: db.store.files || [],
    sessions: db.store.reviewSessions || [],
    estimates: db.store.expertEstimates || []
  };
}

// 事业部分析：批次 × 部门 矩阵
// 三项指标（均以「评审开始当天」为基准日，带符号天数：负=评审开始前已提交=提前）：
//   1) 满足评审要求耗时 = 成本估算表 + 合同 均提交 之日 距评审开始的天数
//   2) 满足归档要求耗时 = 批次下发的归档清单(checklist)全部类别均提交 之日 距评审开始的天数
//   3) 评审开始当天资料完整度 = 评审开始当日，归档清单各类别已提交数 / 类别总数
// 旧批次若未记录评审开始时间(in_progress/completed 但无 review_started_at)，回退用 created_at 并标记 is_approx_start
function computeDeptAnalysis(projects, files, sessions) {
  const DAY = 86400000;
  const toMs = iso => { if (!iso) return null; const t = new Date(iso).getTime(); return isNaN(t) ? null : t; };
  const dayDiff = (fromISO, toISO) => {
    const a = toMs(fromISO), b = toMs(toISO);
    if (a == null || b == null) return null;
    return Math.round((b - a) / DAY);
  };
  const latestUpload = (pid, cat) => {
    const fs = files.filter(f => f.project_id === pid && f.file_category === cat);
    if (!fs.length) return null;
    return fs.reduce((m, f) => (f.upload_time > m ? f.upload_time : m), fs[0].upload_time);
  };
  const sessionsOut = [];
  sessions.forEach(s => {
    const rawStart = s.review_started_at || null;
    const reviewStart = rawStart || ((s.status === 'in_progress' || s.status === 'completed') ? s.created_at : null);
    const isApproxStart = !rawStart && !!reviewStart;
    const required = (Array.isArray(s.checklist) && s.checklist.length) ? s.checklist : FILE_CATEGORIES;
    const sessProjects = projects.filter(p => p.session_id === s.id);
    const deptSet = new Set(sessProjects.map(p => (p.biz_department || '未分类')).filter(Boolean));
    const rows = [];
    deptSet.forEach(dept => {
      const deptProjects = sessProjects.filter(p => (p.biz_department || '未分类') === dept);
      const projMetrics = deptProjects.map(p => {
        // 满足评审要求：成本估算表 + 合同 均已提交
        const est = latestUpload(p.id, 'estimation');
        const con = latestUpload(p.id, 'contract');
        const reviewReqMet = !!(est && con);
        const reviewReqAt = reviewReqMet ? (est > con ? est : con) : null;
        const reviewReqDuration = reviewStart ? dayDiff(reviewStart, reviewReqAt) : null;
        // 满足归档要求：归档清单全部类别均已提交
        const reqUploads = [];
        let archiveMet = true;
        required.forEach(cat => { const u = latestUpload(p.id, cat); if (u) reqUploads.push(u); else archiveMet = false; });
        const archiveAt = archiveMet ? reqUploads.reduce((m, u) => (u > m ? u : m), reqUploads[0]) : null;
        const archiveDuration = reviewStart ? dayDiff(reviewStart, archiveAt) : null;
        // 评审开始当天资料完整度（按项目）
        let completenessAtStart = null;
        if (reviewStart) {
          const st = new Date(reviewStart); st.setHours(0, 0, 0, 0);
          const up = required.filter(cat => {
            const u = latestUpload(p.id, cat); if (!u) return false;
            const d = new Date(u); d.setHours(0, 0, 0, 0);
            return d <= st;
          }).length;
          completenessAtStart = required.length ? up / required.length : 0;
        }
        return {
          project_id: p.id, project_name: p.project_name,
          review_req_met: reviewReqMet, review_req_duration: reviewReqDuration,
          archive_met: archiveMet, archive_duration: archiveDuration,
          completeness_at_start: completenessAtStart,
          confirmation_issued_at: p.confirmation_issued_at || null,
          biz_confirmed_at: p.biz_confirmed_at || null
        };
      });
      const avg = key => {
        const vals = projMetrics.map(m => m[key]).filter(v => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      // 部门级评审开始当天完整度（跨项目合计占比）
      let cellCompleteness = null;
      if (reviewStart) {
        const st = new Date(reviewStart); st.setHours(0, 0, 0, 0);
        let num = 0, den = 0;
        deptProjects.forEach(p => {
          required.forEach(cat => {
            den++;
            const u = latestUpload(p.id, cat);
            if (u) { const d = new Date(u); d.setHours(0, 0, 0, 0); if (d <= st) num++; }
          });
        });
        cellCompleteness = den ? num / den : null;
      }
      // 结果确认工作耗时：从下发当天(confirmation_issued_at) 到该部门本批次所有项目反馈完成(biz_confirmed_at 齐全)
      const issued = projMetrics.map(m => m.confirmation_issued_at).filter(Boolean);
      const done = projMetrics.map(m => m.biz_confirmed_at).filter(Boolean);
      const confirmIssuedAt = issued.length ? issued.reduce((a, b) => a < b ? a : b) : null;
      const confirmDoneAt = done.length ? done.reduce((a, b) => a > b ? a : b) : null;
      const allConfirmed = projMetrics.length > 0 && projMetrics.every(m => m.biz_confirmed_at);
      const confirmDuration = (confirmIssuedAt && allConfirmed) ? Math.round((new Date(confirmDoneAt).getTime() - new Date(confirmIssuedAt).getTime()) / DAY) : null;
      rows.push({
        dept, project_count: deptProjects.length,
        review_req_duration_avg: avg('review_req_duration'),
        review_req_met_count: projMetrics.filter(m => m.review_req_met).length,
        archive_duration_avg: avg('archive_duration'),
        archive_met_count: projMetrics.filter(m => m.archive_met).length,
        completeness_at_start: cellCompleteness,
        confirm_issued_at: confirmIssuedAt,
        confirm_done_at: allConfirmed ? confirmDoneAt : null,
        confirm_all_done: allConfirmed,
        confirm_duration_days: confirmDuration,
        projects: projMetrics
      });
    });
    rows.sort((a, b) => (b.completeness_at_start == null ? -1 : b.completeness_at_start) - (a.completeness_at_start == null ? -1 : a.completeness_at_start));
    sessionsOut.push({
      session_id: s.id, name: s.name, status: s.status,
      review_started_at: rawStart, is_approx_start: isApproxStart,
      review_time: s.review_time || null,
      rows
    });
  });
  sessionsOut.sort((a, b) => (b.review_started_at || '').localeCompare(a.review_started_at || ''));
  return sessionsOut;
}

app.get('/api/stats/detailed', auth(), (req, res) => {
  const user = req.user;
  const { projects, files, sessions, estimates } = getDetailedStats(user);

  const sessionStats = sessions.map(s => ({
    ...s,
    project_count: projects.filter(p => p.session_id === s.id).length,
    completed_projects: projects.filter(p => p.session_id === s.id && p.status === 'completed').length,
    files_count: files.filter(f => projects.some(p => p.id === f.project_id && p.session_id === s.id)).length
  }));

  const requiredCategories = ['estimation', 'feasibility', 'bid', 'contract'];
  const deptMap = {};
  projects.forEach(p => {
    const dept = p.biz_department || '未分类';
    if (!deptMap[dept]) deptMap[dept] = { count: 0, total_amount: 0, complete_count: 0, est_count: 0 };
    deptMap[dept].count++;
    deptMap[dept].total_amount += Number(p.contract_amount) || 0;
    if (files.some(f => f.project_id === p.id && f.file_category === 'estimation')) deptMap[dept].est_count++;
    const projFiles = files.filter(f => f.project_id === p.id);
    if (requiredCategories.every(cat => projFiles.some(f => f.file_category === cat))) deptMap[dept].complete_count++;
  });
  const deptStats = Object.entries(deptMap).map(([name, d]) => ({
    name, ...d,
    avg_amount: d.count > 0 ? d.total_amount / d.count : 0,
    completeness: d.count > 0 ? d.complete_count / d.count : 0
  })).sort((a, b) => b.completeness - a.completeness || b.total_amount - a.total_amount);

  const categories = ['estimation', 'feasibility', 'bid', 'award', 'contract', 'profit', 'subcontract'];
  const fileCategoryStats = {};
  categories.forEach(cat => {
    const catFiles = files.filter(f => f.file_category === cat);
    fileCategoryStats[cat] = { count: catFiles.length, projects_with_file: new Set(catFiles.map(f => f.project_id)).size };
  });

  const statusDist = {};
  projects.forEach(p => { const s = p.status || 'draft'; statusDist[s] = (statusDist[s] || 0) + 1; });

  const estimateStats = { total_estimates: estimates.length, avg_days: 0, by_project: {} };
  if (estimates.length > 0) {
    estimateStats.avg_days = estimates.reduce((s, e) => s + Number(e.days || 0), 0) / estimates.length;
    estimates.forEach(e => {
      const pid = e.project_id;
      if (!estimateStats.by_project[pid]) estimateStats.by_project[pid] = { count: 0, total_days: 0, experts: new Set() };
      estimateStats.by_project[pid].count++;
      estimateStats.by_project[pid].total_days += Number(e.days || 0);
      estimateStats.by_project[pid].experts.add(e.expert_id);
    });
    Object.values(estimateStats.by_project).forEach(p => {
      p.avg_days = p.count > 0 ? p.total_days / p.count : 0;
      p.expert_count = p.experts.size;
      delete p.experts;
    });
  }

  const monthlyStats = {};
  projects.forEach(p => {
    const month = new Date(p.created_at).toISOString().slice(0, 7);
    if (!monthlyStats[month]) monthlyStats[month] = { projects: 0, amount: 0 };
    monthlyStats[month].projects++;
    monthlyStats[month].amount += Number(p.contract_amount) || 0;
  });
  const monthlyTrend = Object.entries(monthlyStats).sort(([a], [b]) => a.localeCompare(b))
    .map(([m, d]) => ({ month: m, projects: d.projects, amount: d.amount, total_amount: d.amount }));

  const expertStats = {};
  estimates.forEach(e => {
    const eid = e.expert_id;
    if (!expertStats[eid]) expertStats[eid] = { id: eid, name: e.expert_name, total_days: 0, projects: new Set() };
    expertStats[eid].total_days += Number(e.days || 0);
    expertStats[eid].projects.add(e.project_id);
  });
  const expertAnalysis = Object.values(expertStats).map(e => ({
    ...e, project_count: e.projects.size, avg_days_per_project: e.projects.size > 0 ? e.total_days / e.projects.size : 0
  }));

  res.json({
    version: '4.0', generated_at: new Date().toISOString(),
    overview: {
      total_projects: projects.length, total_sessions: sessions.length,
      total_files: files.length, total_estimates: estimates.length,
      completed_projects: projects.filter(p => p.status === 'completed').length,
      total_amount: projects.reduce((s, p) => s + Number(p.contract_amount || 0), 0)
    },
    sessions: sessionStats, departments: deptStats,
    deptAnalysis: computeDeptAnalysis(projects, files, sessions),
    file_categories: fileCategoryStats, status_distribution: statusDist,
    estimates: estimateStats, monthly_trend: monthlyTrend, experts: expertAnalysis
  });
});

app.post('/api/reports/generate', auth(['admin', 'rd']), async (req, res) => {
  try {
    const { type, format } = req.body;
    const stats = getDetailedStats(req.user);
    let content = '', mimeType = 'text/html';
    if (type === 'summary') { content = generateSummaryReport(stats, !!req.body.includeWorkReport); mimeType = 'text/html'; }
    else if (type === 'department') { content = generateDepartmentReport(stats, req.body.params); mimeType = 'text/html'; }
    else if (type === 'expert') { content = generateExpertReport(stats); mimeType = 'text/html'; }
    else return res.status(400).json({ error: '未知的报告类型' });
    res.json({ success: true, report_type: type, format, content, generated_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function generateSummaryReport(stats, includeWorkReport) {
  const { projects, sessions, files } = stats;
  const totalAmt = projects.reduce((s, p) => s + Number(p.contract_amount || 0), 0);
  let html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>经济评审汇总报告</title>' +
    '<style>body{font-family:Arial,sans-serif;margin:40px;}h1{color:#333;border-bottom:2px solid #667eea;padding-bottom:10px;}h2{margin-top:30px;color:#444;}h3{margin-top:20px;color:#555;}table{border-collapse:collapse;width:100%;margin:20px 0;}th,td{border:1px solid #ddd;padding:12px;text-align:left;}th{background:#667eea;color:white;}.metric{display:inline-block;margin:10px 20px;padding:15px 25px;background:#f0f4ff;border-radius:8px;}.metric-value{font-size:24px;font-weight:bold;color:#667eea;}.wr-table{border-collapse:collapse;width:100%;margin:10px 0;font-size:13px;}.wr-table th{border:1px solid #ccc;padding:6px;background:#667eea;color:#fff;}.wr-table td{border:1px solid #ccc;padding:6px;}</style>' +
    '</head><body><h1>经济评审汇总报告</h1><p>生成时间: ' + new Date().toLocaleString('zh-CN') + '</p>' +
    '<div class="metrics"><div class="metric"><div class="metric-value">' + projects.length + '</div><div>项目总数</div></div>' +
    '<div class="metric"><div class="metric-value">' + (totalAmt / 10000).toFixed(2) + '万</div><div>合同总金额</div></div>' +
    '<div class="metric"><div class="metric-value">' + sessions.length + '</div><div>评审批次</div></div>' +
    '<div class="metric"><div class="metric-value">' + files.length + '</div><div>上传文件</div></div></div>' +
    '<h2>批次列表</h2><table><tr><th>ID</th><th>名称</th><th>状态</th><th>项目数</th></tr>' +
    sessions.map(s => '<tr><td>' + esc(s.id) + '</td><td>' + esc(s.name || s.session_name || '-') + '</td><td>' + esc(s.status) + '</td><td>' + projects.filter(p => p.session_id === s.id).length + '</td></tr>').join('') +
    '</table>';
  if (includeWorkReport) {
    const meta = getWorkReportTitleDate();
    const saved = getSetting('work_report_text');
    let header = '', footer = '';
    if (saved != null) {
      try {
        const o = JSON.parse(saved);
        if (o && typeof o === 'object') { header = o.header || ''; footer = o.footer || ''; }
      } catch (e) {}
    }
    const wr = {
      title: meta.title,
      department: meta.department,
      date: meta.date,
      header,
      footer,
      tables: buildWorkReportTables(),
      stats: computeWorkReportStats()
    };
    html += '<div style="margin-top:40px;border-top:2px dashed #ccc;padding-top:20px">' +
      renderWorkReportHtml(wr) + '</div>';
  }
  html += '</body></html>';
  return html;
}
function generateDepartmentReport(stats, params) {
  const { projects } = stats;
  const dept = (params && params.department) || '';
  const deptProjects = dept ? projects.filter(p => p.biz_department === dept) : projects;
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>事业部分析报告</title>' +
    '<style>body{font-family:Arial;margin:40px;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:10px;}th{background:#667eea;color:white;}</style></head><body>' +
    '<h1>事业部经济评审分析报告</h1><p>部门: ' + esc(dept || '全部') + '</p><table><tr><th>ID</th><th>项目名称</th><th>金额</th><th>状态</th></tr>' +
    deptProjects.map(p => '<tr><td>' + esc(p.id) + '</td><td>' + esc(String(p.project_name || '').substring(0, 30)) + '</td><td>' + Number(p.contract_amount || 0).toLocaleString() + '</td><td>' + esc(p.status) + '</td></tr>').join('') +
    '</table><p>总计: ' + deptProjects.length + ' 个项目</p></body></html>';
}
function generateExpertReport(stats) {
  const { estimates } = stats;
  const expertMap = {};
  estimates.forEach(e => {
    if (!expertMap[e.expert_id]) expertMap[e.expert_id] = { name: e.expert_name, days: 0, projects: new Set() };
    expertMap[e.expert_id].days += Number(e.days || 0);
    expertMap[e.expert_id].projects.add(e.project_id);
  });
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>专家工作量报告</title>' +
    '<style>body{font-family:Arial;margin:40px;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:10px;}th{background:#10b981;color:white;}</style></head><body>' +
    '<h1>专家工作量评估报告</h1><p>生成时间: ' + new Date().toLocaleString('zh-CN') + '</p>' +
    '<table><tr><th>专家ID</th><th>姓名</th><th>项目数</th><th>总人天</th><th>平均人天</th></tr>' +
    Object.values(expertMap).map(e => '<tr><td>-</td><td>' + esc(e.name) + '</td><td>' + e.projects.size + '</td><td>' + e.days.toFixed(2) + '</td><td>' + (e.days / e.projects.size).toFixed(2) + '</td></tr>').join('') +
    '</table></body></html>';
}

// 将年终工作汇报（文字 + 7 张表）渲染为 HTML
function renderWorkReportHtml(wr) {
  if (!wr || !wr.title) return '';
  const tablesByIndex = {};
  (wr.tables || []).forEach(t => { if (t && t.index != null) tablesByIndex[t.index] = t; });
  let html = '<h2>' + esc(wr.title) + '</h2>';
  html += '<p style="color:#666">' + esc(wr.department || '') + ' ' + esc(wr.date || '') + '</p>';
  if (wr.header && wr.header.trim()) {
    html += '<div style="line-height:1.8;margin:8px 0;white-space:pre-wrap">' + esc(wr.header) + '</div>';
  }
  html += '<hr>';
  Object.keys(tablesByIndex).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).forEach(k => {
    const t = tablesByIndex[k];
    html += '<h3>' + esc(t.caption || ('表' + k)) + '</h3>';
    html += renderWorkReportTable(t);
  });
  if (wr.footer && wr.footer.trim()) {
    html += '<hr><div style="line-height:1.8;margin:8px 0;white-space:pre-wrap">' + esc(wr.footer) + '</div>';
  }
  return html;
}
function renderWorkReportTable(t) {
  if (!t || !Array.isArray(t.rows) || !t.rows.length) return '';
  const renderCell = s => esc(String(s == null ? '' : s)).split('\n').join('<br>');
  const norm = c => typeof c === 'string' ? { t: c } : c;
  let h = '<table class="wr-table"><thead>';
  // 优先使用 head 数组（支持 rowspan/colspan），否则退化为 rows[0] 作表头
  if (Array.isArray(t.head) && t.head.length) {
    t.head.forEach(row => {
      h += '<tr>';
      (row || []).forEach(c => {
        const cc = norm(c);
        const attr = (cc.r > 1 ? ' rowspan="' + cc.r + '"' : '') + (cc.c > 1 ? ' colspan="' + cc.c + '"' : '');
        h += '<th' + attr + '>' + renderCell(cc.t) + '</th>';
      });
      h += '</tr>';
    });
  } else {
    h += '<tr>';
    (t.rows[0] || []).forEach(c => h += '<th>' + renderCell(c) + '</th>');
    h += '</tr>';
  }
  h += '</thead><tbody>';
  t.rows.forEach(row => {
    h += '<tr>' + (row || []).map(c => '<td>' + renderCell(c) + '</td>').join('') + '</tr>';
  });
  h += '</tbody></table>';
  return h;
}

app.get('/api/stats/summary', auth(), (req, res) => {
  const s = db.store;
  const user = req.user;
  const totalCost = s.projects.reduce((sum, p) => sum + (parseFloat(p.contract_amount) || 0), 0);
  const payload = {
    total_sessions: s.reviewSessions.length,
    completed_sessions: s.reviewSessions.filter(x => x.status === 'completed').length,
    pending_sessions: s.reviewSessions.filter(x => x.status === 'pending').length,
    total_projects: s.projects.length,
    total_scores: s.expertEstimates.length,
    avg_score: s.expertEstimates.length ? Math.round(s.expertEstimates.reduce((a, e) => a + Number(e.days || 0), 0) / s.expertEstimates.length * 10) / 10 : 0,
    total_users: s.users.length,
    total_cost: totalCost,
    recent_activity: s.workflowLogs.slice(-5).reverse().map(l => ({
      at: l.created_at || l.operated_at || '',
      operator_name: l.operator_name || '',
      action: l.action || '',
      remark: l.remark || ''
    })),
    pending_tasks: s.projects.filter(p => p.status === 'pending' || p.status === 'reviewing').map(p => p.project_name)
  };
  // 角色专属数据（工作台按角色展示用）
  if (user.role === 'expert' || user.role === 'accountant') {
    const mySessIds = (s.sessionAssignments || []).filter(a => a.user_id === user.id).map(a => a.session_id);
    const myEvalProjIds = Array.from(new Set(s.expertEstimates.filter(e => e.expert_id === user.id).map(e => e.project_id)));
    const myVisibleProjIds = new Set(s.projects.filter(p => mySessIds.includes(p.session_id) || myEvalProjIds.includes(p.id)).map(p => p.id));
    payload.my_session_ids = mySessIds;
    payload.my_evaluated_project_ids = myEvalProjIds;
    payload.my_visible_project_ids = Array.from(myVisibleProjIds);
    payload.my_work_item_count = s.workItems.filter(w => myVisibleProjIds.has(w.project_id)).length;
    payload.my_recent_estimates = s.expertEstimates
      .filter(e => e.expert_id === user.id)
      .slice(-10)
      .reverse()
      .map(e => ({
        id: e.id, project_id: e.project_id, work_item_id: e.work_item_id,
        days: e.days, comment: e.comment, updated_at: e.updated_at || e.created_at || ''
      }));
  } else if (user.role === 'biz') {
    payload.biz_dept = user.business_dept || '';
  }
  res.json(payload);
});
app.get('/api/stats/cost-structure', auth(), (req, res) => {
  const labels = ['长期职工', '中实职工', '华兆职工', '人员外包', '专业分包', '采购', '差旅'];
  const data = [0, 0, 0, 0, 0, 0, 0];
  db.store.projects.forEach(p => {
    const ws = db.store.workItems.filter(w => w.project_id === p.id);
    const costs = calculateCategoryCost(ws);
    data[0] += costs.long_term || 0;
    data[1] += costs.zhongshi || 0;
    data[2] += costs.huazhao || 0;
    data[3] += costs.outsourcing || 0;
    data[4] += costs.subcontract || 0;
    const proc = db.store.procurementItems.filter(x => x.project_id === p.id);
    data[5] += proc.reduce((a, x) => a + (parseFloat(x.subtotal) || 0), 0);
    const trav = db.store.travelItems.filter(t => t.project_id === p.id);
    data[6] += trav.reduce((a, t) => a + ((parseFloat(t.hotel) || 0) + (parseFloat(t.per_diem) || 0) + (parseFloat(t.transport) || 0)), 0);
  });
  const total = data.reduce((a, b) => a + b, 0);
  res.json({ labels, data, total });
});

// 工作流日志（修复路由参数名）
app.get('/api/workflow/:projectId', auth(), (req, res) => {
  res.json(db.store.workflowLogs.filter(l => l.project_id === parseInt(req.params.projectId)));
});

// ==================== 批次下载（支持 ?token=）====================
function streamZip(res, session, sessionProjects, sessionFiles, zipName) {
  if (sessionFiles.length === 0) return res.status(400).json({ error: '该批次暂无可下载的文件' });
  const archive = archiver('zip', { zlib: { level: 9 } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  archive.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
  archive.pipe(res);
  sessionProjects.forEach(p => {
    const pFiles = sessionFiles.filter(f => f.project_id === p.id);
    pFiles.forEach(f => {
      const filePath = path.join(UPLOAD_DIR, f.filename);
      if (fs.existsSync(filePath)) {
        const folderName = `${p.id}-${(p.project_name || '').replace(/[\\/:*?"<>|]/g, '_').substring(0, 20)}`;
        archive.file(filePath, { name: `${folderName}/${f.file_seq || ''}-${f.originalname}` });
      }
    });
  });
  archive.finalize();
}
app.get('/api/sessions/:id/download-all', auth(['admin']), (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = db.store.reviewSessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: '批次不存在' });
  const sessionProjects = db.store.projects.filter(p => p.session_id === sessionId);
  const projectIds = sessionProjects.map(p => p.id);
  const sessionFiles = db.store.files.filter(f => projectIds.includes(f.project_id));
  streamZip(res, session, sessionProjects, sessionFiles, `批次${session.id}_全量文件_${new Date().toISOString().slice(0, 10)}.zip`);
});
app.get('/api/sessions/:id/download-estimation', auth(['admin']), (req, res) => {
  const sessionId = parseInt(req.params.id);
  const session = db.store.reviewSessions.find(s => s.id === sessionId);
  if (!session) return res.status(404).json({ error: '批次不存在' });
  const sessionProjects = db.store.projects.filter(p => p.session_id === sessionId);
  const projectIds = sessionProjects.map(p => p.id);
  const estFiles = db.store.files.filter(f => projectIds.includes(f.project_id) && f.file_category === 'estimation');
  streamZip(res, session, sessionProjects, estFiles, `批次${session.id}_成本估算表_${new Date().toISOString().slice(0, 10)}.zip`);
});

// ==================== 前端静态服务 ====================
// 禁止浏览器/代理/CDN 缓存 index.html，避免部署新前端后用户仍看到旧版
app.use((req, res, next) => {
  const p = req.path || '';
  if (req.method === 'GET' && !p.startsWith('/api/') && (p === '/' || p.endsWith('.html'))) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  else res.status(404).json({ error: 'Not found' });
});

// ==================== 全局错误处理（multer 文件大小/类型等返回 JSON）====================
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    let message = '文件上传失败';
    if (err.code === 'LIMIT_FILE_SIZE') message = '文件大小超过限制（单个最大 ' + config.maxFileSizeMB + 'MB）';
    else if (err.code === 'LIMIT_FILE_COUNT') message = '单次上传文件数量超过限制';
    else if (err.code === 'LIMIT_UNEXPECTED_FILE') message = '字段名不匹配，请使用 file 字段上传';
    else if (err.message) message = err.message;
    return res.status(400).json({ error: message });
  }
  if (err && err.message) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: err.message });
  }
  next(err);
});

function startServer() {
  app.listen(PORT, () => console.log(`✅ 经济评审后端 v4 已启动 (端口 ${PORT}, 驱动 ${config.dbDriver})`));
}
