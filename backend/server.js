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
db.load().then(startServer).catch(err => {
  console.error('[启动失败] 数据加载出错，服务未启动:', err && err.message);
  process.exit(1);
});

// ==================== 中间件 ====================
// Helmet 默认 CSP 为 script-src 'self' + script-src-attr 'none'，会拦截本系统的内联脚本、
// 内联事件处理器(onclick) 以及 jsdelivr CDN 脚本，导致页面能显示但 JS 全不执行。
// 这里关闭默认策略并显式放行：内联脚本/事件 + jsdelivr CDN（bootstrap/chart.js）。
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
  if (/合同|协议|contract|agreement/i.test(name)) return 'contract';
  if (/分包|subcontract|外包/i.test(name)) return 'subcontract';
  if (/技术.*规范|规范.*书|技术.*规格|tech.*spec|specif/i.test(name)) return 'tech_spec';
  return 'other';
}
function getFileCategoryName(cat) {
  const map = {
    estimation: '估算表', feasibility: '可研报告', bid: '招标文件',
    award: '中标通知书', contract: '合同文件', profit: '利润率评审表',
    subcontract: '分包申请表', tech_spec: '技术规范书', other: '其他'
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
  if (!proj) return res.status(403).json({ error: '无权访问' });
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
  'biz_department', 'session_id', 'description', 'contract_party', 'remark'
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
    // ===== 双数字校验：与导入评审汇总表的基线字段比对 =====
    const vIssues = [];
    const pContract = project.contract_amount != null ? Number(project.contract_amount) : null;
    const eContract = parsed.project.contract_amount != null ? Number(parsed.project.contract_amount) : null;
    if (pContract != null && eContract != null && Math.abs(pContract - eContract) > 1) {
      vIssues.push(`合同额不一致：本次成本估算表为 ¥${eContract.toLocaleString()}，汇总表基线为 ¥${pContract.toLocaleString()}`);
    }
    const estCost = parsed.cost_summary && parsed.cost_summary.total_cost != null ? Number(parsed.cost_summary.total_cost) : null;
    const internalCost = project.internal_estimated_cost != null ? Number(project.internal_estimated_cost) : null;
    if (internalCost != null && estCost != null && estCost >= internalCost) {
      vIssues.push(`估算成本 ¥${estCost.toLocaleString()} 不小于汇总表「内部信息系统填报预估成本」 ¥${internalCost.toLocaleString()}，不能通过`);
    }
    if (vIssues.length) {
      try { fs.unlinkSync(newPath); } catch (_) {}
      db.store.files = db.store.files.filter(f => f.id !== file.id);
      return res.status(400).json({ error: '成本估算表校验未通过：' + vIssues.join('；'), validation: vIssues });
    }
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
  db.save();
  db.logWorkflow(projectId, 'upload_file', `上传${getFileCategoryName(autoCategory)}文件[${seq}]: ${file.originalname}`, req.user.id);
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
app.post('/api/projects/:id/initiate-confirmation', auth(['admin', 'rd']), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (p.status !== 'reviewing') return res.status(400).json({ error: '仅评审中项目可发起确认（当前：' + p.status + '）' });
  const estCount = db.store.expertEstimates.filter(e => e.project_id === p.id).length;
  if (estCount === 0) return res.status(400).json({ error: '尚无专家/会计师评估数据，请先组织评审会并收集评估' });
  p.status = 'pending_confirm';
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, 'initiate_confirmation', '研发中心汇总结果并发起成果确认', req.user.id);
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
      cost_summary: cs,
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

// 导出某批次「项目经济评审结果汇总表」为 xlsx（与前端 21 列一致，含合计行）
app.get('/api/sessions/:id/workload-summary/export', auth(['admin', 'rd']), (req, res) => {
  const sid = parseInt(req.params.id);
  const data = buildWorkloadSummary(sid, req.user);
  if (!data) return res.status(404).json({ error: '批次不存在' });
  const headers = ['序号', '项目名称', '项目承建部门', '项目类型', '合同额', '项目总成本估算',
    '项目估算利润率(%)', '长期职工成本估算', '中实职工成本估算', '华兆职工成本估算', '人员外包估算',
    '专业分包估算', '分包占比(%)', '采购估算', '差旅费估算', '第三方测试估算', '知识产权估算',
    '是否属于数字化', '业务方向', '业务子方向', '产品方向'];
  const moneyKeys = ['contract_amount', 'total_cost', 'long_term_cost', 'zhongshi_cost', 'huazhao_cost',
    'outsourcing_cost', 'subcontract_cost', 'procurement_cost', 'travel_cost', 'third_party_test_cost', 'ip_cost'];
  const totals = {}; moneyKeys.forEach(k => totals[k] = 0);
  const rows = (data.projects || []).map((p, idx) => {
    const cs = p.cost_summary || {};
    const tc = Number(cs.total_cost) || 0, sub = Number(cs.subcontract_cost) || 0;
    const row = {
      idx: idx + 1, project_name: p.project_name, biz_department: p.biz_department, project_type: p.project_type,
      contract_amount: Number(p.contract_amount) || 0, total_cost: tc,
      profit_rate: cs.profit_rate != null ? Math.round(Number(cs.profit_rate) * 100 * 100) / 100 : null,
      long_term_cost: Number(cs.long_term_cost) || 0, zhongshi_cost: Number(cs.zhongshi_cost) || 0,
      huazhao_cost: Number(cs.huazhao_cost) || 0, outsourcing_cost: Number(cs.outsourcing_cost) || 0,
      subcontract_cost: sub, subcontract_ratio: tc > 0 ? Math.round(sub / tc * 100 * 100) / 100 : null,
      procurement_cost: Number(cs.procurement_cost) || 0, travel_cost: Number(cs.travel_cost) || 0,
      third_party_test_cost: Number(cs.third_party_test_cost) || 0, ip_cost: Number(cs.ip_cost) || 0,
      is_digital: p.is_digital ? '是' : '否', business_direction: p.business_direction || '',
      business_sub_direction: p.business_sub_direction || '', product_direction: p.product_direction || ''
    };
    moneyKeys.forEach(k => totals[k] += Number(row[k]) || 0);
    return [row.idx, row.project_name, row.biz_department, row.project_type, row.contract_amount, row.total_cost,
      row.profit_rate, row.long_term_cost, row.zhongshi_cost, row.huazhao_cost, row.outsourcing_cost,
      row.subcontract_cost, row.subcontract_ratio, row.procurement_cost, row.travel_cost,
      row.third_party_test_cost, row.ip_cost, row.is_digital, row.business_direction,
      row.business_sub_direction, row.product_direction];
  });
  const totalRow = ['', '合计', '', '', totals.contract_amount, totals.total_cost, null,
    totals.long_term_cost, totals.zhongshi_cost, totals.huazhao_cost, totals.outsourcing_cost,
    totals.subcontract_cost, totals.total_cost > 0 ? Math.round(totals.subcontract_cost / totals.total_cost * 100 * 100) / 100 : null,
    totals.procurement_cost, totals.travel_cost, totals.third_party_test_cost, totals.ip_cost, '', '', '', ''];
  const aoa = [headers, ...rows, totalRow];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wscols = headers.map((h, i) => ({ wch: i === 1 ? 28 : (i === 18 || i === 19 || i === 20 ? 16 : 12) }));
  ws['!cols'] = wscols;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '项目经济评审结果汇总表');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `批次${sid}_项目经济评审结果汇总表_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="batch_${sid}_summary.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
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
          completeness_at_start: completenessAtStart
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
      rows.push({
        dept, project_count: deptProjects.length,
        review_req_duration_avg: avg('review_req_duration'),
        review_req_met_count: projMetrics.filter(m => m.review_req_met).length,
        archive_duration_avg: avg('archive_duration'),
        archive_met_count: projMetrics.filter(m => m.archive_met).length,
        completeness_at_start: cellCompleteness,
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
