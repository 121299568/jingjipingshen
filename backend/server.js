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

const config = require('./src/config');
const db = require('./src/db');

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
  if (/估算|概算|预算|成本.*表|cost.*estimat|estimat/i.test(name)) return 'estimation';
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
    const assigned = db.store.expertEstimates.some(e => e.project_id === file.project_id && e.expert_id === user.id);
    if (assigned) return next();
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
      department: user.department, real_name: user.real_name, business_dept: user.business_dept
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
  const { permissions } = req.body;
  if (!Array.isArray(permissions)) return res.status(400).json({ error: '权限必须是数组' });
  let perm = db.store.userPermissions.find(p => p.user_id === userId);
  if (perm) perm.permissions = permissions;
  else db.store.userPermissions.push({ id: db.nextId(db.store.userPermissions), user_id: userId, permissions });
  db.save();
  res.json(perm);
});
app.get('/api/users/:id/permissions', auth(['admin']), (req, res) => {
  const perm = db.store.userPermissions.find(p => p.user_id === parseInt(req.params.id));
  res.json(perm ? perm.permissions : []);
});
app.get('/api/permission-options', auth(), (req, res) => res.json([
  { code: 'view_projects', name: '查看项目', default_roles: ['admin', 'biz', 'rd', 'expert', 'accountant'] },
  { code: 'upload_files', name: '上传资料', default_roles: ['admin', 'biz', 'rd'] },
  { code: 'download_files', name: '下载单文件', default_roles: ['admin', 'biz', 'rd', 'expert', 'accountant'] },
  { code: 'download_batch', name: '批次全量下载', default_roles: ['admin'] },
  { code: 'import_excel', name: 'Excel导入项目', default_roles: ['admin', 'biz', 'rd'] },
  { code: 'manage_sessions', name: '管理评审批次', default_roles: ['admin', 'rd'] },
  { code: 'submit_estimate', name: '提交工作量评估', default_roles: ['expert', 'accountant'] },
  { code: 'confirm_estimate', name: '确认/驳回评估', default_roles: ['expert', 'accountant'] },
  { code: 'manage_users', name: '用户管理', default_roles: ['admin'] },
  { code: 'view_stats', name: '查看统计分析', default_roles: ['admin', 'rd', 'biz'] }
]));

// ==================== 评审批次 ====================
app.get('/api/sessions', auth(), (req, res) => {
  res.json(db.store.reviewSessions.map(s => ({
    ...s,
    project_count: db.store.projects.filter(p => p.session_id === s.id).length
  })));
});
app.post('/api/sessions', auth(['admin', 'rd']), (req, res) => {
  const allowed = ['name', 'review_time', 'note', 'status'];
  const body = pick(req.body, allowed);
  const validStatus = ['pending', 'in_progress', 'completed'];
  const s = {
    id: db.nextId(db.store.reviewSessions),
    name: body.name || '未命名批次',
    review_time: body.review_time || null,
    note: body.note || '',
    status: body.status && validStatus.includes(body.status) ? body.status : 'pending',
    creator_id: req.user.id,
    created_at: new Date().toISOString()
  };
  db.store.reviewSessions.push(s);
  db.save();
  res.json(s);
});
app.patch('/api/sessions/:id', auth(['admin', 'rd']), (req, res) => {
  const idx = db.store.reviewSessions.findIndex(x => x.id === parseInt(req.params.id));
  if (idx < 0) return res.status(404).json({ error: '批次不存在' });
  const allowed = ['pending', 'in_progress', 'completed'];
  const newStatus = req.body.status;
  if (!newStatus || !allowed.includes(newStatus)) {
    return res.status(400).json({ error: '无效状态，可选: pending/in_progress/completed' });
  }
  db.store.reviewSessions[idx].status = newStatus;
  if (newStatus === 'completed') db.store.reviewSessions[idx].completed_at = new Date().toISOString();
  db.save();
  res.json(db.store.reviewSessions[idx]);
});

// ==================== 项目 ====================
app.get('/api/projects', auth(), (req, res) => {
  res.json(db.filterByDept('projects', req.user));
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
    const assigned = db.store.expertEstimates.some(e => e.project_id === p.id && e.expert_id === req.user.id);
    if (!assigned) return res.status(403).json({ error: '无权查看该项目' });
  }
  res.json({
    ...p,
    work_items: db.store.workItems.filter(w => w.project_id === p.id),
    procurement_items: db.store.procurementItems.filter(x => x.project_id === p.id),
    travel_items: db.store.travelItems.filter(t => t.project_id === p.id),
    files: db.store.files.filter(f => f.project_id === p.id),
    expert_estimates: db.store.expertEstimates.filter(e => e.project_id === p.id),
    confirmations: db.store.confirmations.filter(c => c.project_id === p.id)
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
  if (body.biz_department !== undefined) p.biz_department = body.biz_department;
  Object.keys(body).forEach(k => { if (k !== 'biz_department') p[k] = body[k]; });
  p.updated_at = new Date().toISOString();
  db.save();
  db.logWorkflow(p.id, 'update_project', `更新项目：${p.project_name}`, req.user.id);
  res.json(p);
});

app.delete('/api/projects/:id', auth(['admin', 'rd']), (req, res) => {
  const projectId = parseInt(req.params.id);
  const idx = db.store.projects.findIndex(x => x.id === projectId);
  if (idx < 0) return res.status(404).json({ error: '项目不存在' });
  // 级联清理
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
  db.store.projects.splice(idx, 1);
  db.save();
  res.json({ success: true });
});

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

// ==================== 项目文件 ====================
app.post('/api/projects/:id/files', auth(), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const projectId = parseInt(req.params.id);
  const project = db.store.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'biz' && req.user.business_dept !== project.biz_department) {
    return res.status(403).json({ error: '无权上传该项目文件' });
  }
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

  const file = {
    id: db.nextId(db.store.files),
    project_id: projectId,
    filename: newFilename,
    originalname: realOriginalName,
    file_seq: seq,
    file_type: ext.slice(1),
    file_category: autoCategory,
    auto_detected: !clientCategory || clientCategory === 'auto',
    uploader_id: req.user.id,
    uploader_name: req.user.real_name || req.user.username,
    url: `/uploads/${newFilename}`,
    description: req.body.description || '',
    upload_time: new Date().toISOString()
  };
  db.store.files.push(file);
  db.save();
  db.logWorkflow(projectId, 'upload_file', `上传${getFileCategoryName(autoCategory)}文件[${seq}]: ${file.originalname}`, req.user.id);
  res.json(file);
});

app.get('/api/projects/:id/files', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = db.store.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'expert' || req.user.role === 'accountant') {
    const assigned = db.store.expertEstimates.some(e => e.project_id === projectId && e.expert_id === req.user.id);
    if (!assigned) return res.status(403).json({ error: '无权查看该项目文件' });
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
    submitted_count: d.count
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
  const project = db.store.projects.find(p => p.id === parseInt(project_id));
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const existing = db.store.expertEstimates.find(e => e.expert_id === req.user.id && e.project_id === parseInt(project_id) && e.work_item_id === parseInt(work_item_id));
  if (existing) return res.status(400).json({ error: '您已经提交过该项评估' });
  const estimate = {
    id: db.nextId(db.store.expertEstimates),
    project_id: parseInt(project_id),
    work_item_id: parseInt(work_item_id),
    expert_id: req.user.id,
    expert_name: req.user.real_name,
    days: daysNum,
    comment: comment || '',
    submitted_at: new Date().toISOString()
  };
  db.store.expertEstimates.push(estimate);
  db.save();
  db.logWorkflow(parseInt(project_id), 'submit_estimate', `专家${estimate.expert_name}评估工作项${work_item_id}: ${daysNum}人天`, req.user.id);
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

// ==================== 成本明细 ====================
app.get('/api/projects/:id/cost', auth(), (req, res) => {
  const p = db.store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const estimateSummary = db.store.expertEstimates
    .filter(e => e.project_id === p.id)
    .reduce((acc, e) => { (acc[e.work_item_id] = acc[e.work_item_id] || []).push(e.days); return acc; }, {});
  res.json({
    work_items: db.store.workItems.filter(w => w.project_id === p.id).map(w => ({
      ...w,
      expert_days_list: estimateSummary[w.id] || [],
      expert_days_avg: estimateSummary[w.id]
        ? Math.round(estimateSummary[w.id].reduce((a, b) => a + b, 0) / estimateSummary[w.id].length * 10) / 10
        : (w.expert_days_avg || 0),
      adjusted_cost: estimateSummary[w.id]
        ? Math.round(estimateSummary[w.id].reduce((a, b) => a + b, 0) / estimateSummary[w.id].length * (Number(w.cost) / (Number(w.person_days) || 1)) * 10) / 10
        : (w.adjusted_cost || 0)
    })),
    procurement_items: db.store.procurementItems.filter(x => x.project_id === p.id),
    travel_items: db.store.travelItems.filter(t => t.project_id === p.id),
    category_cost: calculateCategoryCost(db.store.workItems.filter(w => w.project_id === p.id)),
    estimate_stats: {
      total_experts: Object.keys(estimateSummary).length,
      avg_days_by_item: estimateSummary
    }
  });
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
    file_categories: fileCategoryStats, status_distribution: statusDist,
    estimates: estimateStats, monthly_trend: monthlyTrend, experts: expertAnalysis
  });
});

app.post('/api/reports/generate', auth(['admin', 'rd']), async (req, res) => {
  try {
    const { type, format } = req.body;
    const stats = getDetailedStats(req.user);
    let content = '', mimeType = 'text/html';
    if (type === 'summary') { content = generateSummaryReport(stats); mimeType = 'text/html'; }
    else if (type === 'department') { content = generateDepartmentReport(stats, req.body.params); mimeType = 'text/html'; }
    else if (type === 'expert') { content = generateExpertReport(stats); mimeType = 'text/html'; }
    else return res.status(400).json({ error: '未知的报告类型' });
    res.json({ success: true, report_type: type, format, content, generated_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function generateSummaryReport(stats) {
  const { projects, sessions, files } = stats;
  const totalAmt = projects.reduce((s, p) => s + Number(p.contract_amount || 0), 0);
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>经济评审汇总报告</title>' +
    '<style>body{font-family:Arial,sans-serif;margin:40px;}h1{color:#333;border-bottom:2px solid #667eea;padding-bottom:10px;}table{border-collapse:collapse;width:100%;margin:20px 0;}th,td{border:1px solid #ddd;padding:12px;text-align:left;}th{background:#667eea;color:white;}.metric{display:inline-block;margin:10px 20px;padding:15px 25px;background:#f0f4ff;border-radius:8px;}.metric-value{font-size:24px;font-weight:bold;color:#667eea;}</style>' +
    '</head><body><h1>经济评审汇总报告</h1><p>生成时间: ' + new Date().toLocaleString('zh-CN') + '</p>' +
    '<div class="metrics"><div class="metric"><div class="metric-value">' + projects.length + '</div><div>项目总数</div></div>' +
    '<div class="metric"><div class="metric-value">' + (totalAmt / 10000).toFixed(2) + '万</div><div>合同总金额</div></div>' +
    '<div class="metric"><div class="metric-value">' + sessions.length + '</div><div>评审批次</div></div>' +
    '<div class="metric"><div class="metric-value">' + files.length + '</div><div>上传文件</div></div></div>' +
    '<h2>批次列表</h2><table><tr><th>ID</th><th>名称</th><th>状态</th><th>项目数</th></tr>' +
    sessions.map(s => '<tr><td>' + esc(s.id) + '</td><td>' + esc(s.name || s.session_name || '-') + '</td><td>' + esc(s.status) + '</td><td>' + projects.filter(p => p.session_id === s.id).length + '</td></tr>').join('') +
    '</table></body></html>';
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

app.get('/api/stats/summary', auth(), (req, res) => {
  const s = db.store;
  const totalCost = s.projects.reduce((sum, p) => sum + (parseFloat(p.contract_amount) || 0), 0);
  res.json({
    total_sessions: s.reviewSessions.length,
    completed_sessions: s.reviewSessions.filter(x => x.status === 'completed').length,
    pending_sessions: s.reviewSessions.filter(x => x.status === 'pending').length,
    total_projects: s.projects.length,
    total_scores: s.expertEstimates.length,
    avg_score: s.expertEstimates.length ? Math.round(s.expertEstimates.reduce((a, e) => a + Number(e.days || 0), 0) / s.expertEstimates.length * 10) / 10 : 0,
    total_users: s.users.length,
    total_cost: totalCost,
    recent_activity: s.workflowLogs.slice(-5).reverse().map(l => `${l.operator_name} ${l.action}: ${l.remark}`),
    pending_tasks: s.projects.filter(p => p.status === 'pending' || p.status === 'reviewing').map(p => p.project_name)
  });
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
app.use(express.static(FRONTEND_DIR));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  else res.status(404).json({ error: 'Not found' });
});

function startServer() {
  app.listen(PORT, () => console.log(`✅ 经济评审后端 v4 已启动 (端口 ${PORT}, 驱动 ${config.dbDriver})`));
}
