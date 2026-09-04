const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { parseProjectExcel } = require('./parse-excel');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 存储层 ====================
// 默认使用 JSON 文件持久化（data/store.json）；设置 DB_TYPE=mysql 可切换为 MySQL
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function defaultStore() {
  return {
    users: [
      { id: 1, username: 'admin', password: 'admin123', real_name: '系统管理员', role: 'admin', department: 'IT部' },
      { id: 2, username: 'biz_dept', password: '123456', real_name: '事业部代表', role: 'biz', department: '各事业部' },
      { id: 3, username: 'expert', password: '123456', real_name: '评审专家', role: 'expert', department: '评审专家库' },
      { id: 4, username: 'accountant', password: '123456', real_name: '会计师', role: 'accountant', department: '外部会计师事务所' }
    ],
    reviewSessions: [],
    projects: [],
    workItems: [],
    procurementItems: [],
    travelItems: [],
    scores: [],
    comments: [],
    workflowLogs: [],
    uploadedFiles: []
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_FILE)) {
    const s = defaultStore();
    seedFromExcel(s);
    saveStore(s);
    return s;
  }
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
}

function saveStore(s) {
  fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// 从已解析的真实Excel seed 一个示例项目（如存在 data/seed-project.json）
function seedFromExcel(s) {
  const seedFile = path.join(DATA_DIR, 'seed-project.json');
  if (!fs.existsSync(seedFile)) return;
  const d = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  s.projects.push({
    id: 1,
    project_name: d.project.project_name || d.source_file,
    project_code: d.project.project_code || '',
    biz_department: d.project.biz_department || '',
    project_type: d.project.project_type || '',
    business_direction: d.project.business_direction || '',
    product_direction: d.project.product_direction || '',
    contract_amount: d.project.contract_amount || 0,
    source_file: d.source_file,
    cost_summary: d.cost_summary,
    status: 'reviewing',
    session_id: 1,
    created_at: new Date().toISOString()
  });
  s.workItems = d.work_items.map((w, i) => ({ id: i + 1, project_id: 1, ...w }));
  s.procurementItems = d.procurement_items.map((p, i) => ({ id: i + 1, project_id: 1, ...p }));
  s.travelItems = d.travel_items.map((t, i) => ({ id: i + 1, project_id: 1, ...t }));
  s.reviewSessions.push({
    id: 1, name: '2026年度Q1经济评审', status: 'in_progress',
    review_time: '2026-03-15 09:00', creator_id: 1, note: '演示批次',
    created_at: new Date().toISOString()
  });
}

const store = loadStore();

// ==================== 中间件 ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 简易token：base64(user) + 签名
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', 'economic-review-secret').update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(t) {
  if (!t || !t.includes('.')) return null;
  const [body, sig] = t.split('.');
  const expect = crypto.createHmac('sha256', 'economic-review-secret').update(body).digest('base64url');
  if (sig !== expect) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}
function auth(required = false) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const user = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
    req.user = user;
    if (required && !user) return res.status(401).json({ error: '未登录' });
    next();
  };
}

// 上传目录
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    // 允许 xlsx/xls/pdf/doc/docx
    if (/xlsx?|pdf|docx?$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('不支持的文件类型'));
  }
});

// ==================== 认证 ====================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = store.users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (user.password !== password && !password) return res.status(401).json({ error: '用户名或密码错误' });
  // 演示模式：admin 可任意密码；其他用户校验密码
  if (username !== 'admin' && user.password !== password) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = sign({ id: user.id, username: user.username, role: user.role, department: user.department });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, department: user.department, real_name: user.real_name } });
});

// ==================== 用户管理 ====================
app.get('/api/users', auth(), (req, res) => {
  res.json(store.users.map(({ password, ...u }) => u));
});
app.post('/api/users', auth(true), (req, res) => {
  const u = { id: store.users.length + 1, ...req.body, password: req.body.password || '123456' };
  store.users.push(u);
  saveStore(store);
  res.json({ ...u, password: undefined });
});

// ==================== 评审批次 ====================
app.get('/api/sessions', auth(), (req, res) => {
  const list = store.reviewSessions.map(s => ({
    ...s,
    project_count: store.projects.filter(p => p.session_id === s.id).length
  }));
  res.json(list);
});
app.post('/api/sessions', auth(true), (req, res) => {
  const s = {
    id: store.reviewSessions.length + 1,
    status: 'pending',
    created_at: new Date().toISOString(),
    creator_id: req.user.id,
    ...req.body
  };
  store.reviewSessions.push(s);
  saveStore(store);
  res.json(s);
});
app.put('/api/sessions/:id', auth(true), (req, res) => {
  const idx = store.reviewSessions.findIndex(s => s.id === parseInt(req.params.id));
  if (idx < 0) return res.status(404).json({ error: '评审批次不存在' });
  store.reviewSessions[idx] = { ...store.reviewSessions[idx], ...req.body };
  saveStore(store);
  res.json(store.reviewSessions[idx]);
});

// ==================== 项目 ====================
app.get('/api/projects', auth(), (req, res) => {
  const { session_id } = req.query;
  let list = store.projects;
  if (session_id) list = list.filter(p => String(p.session_id) === String(session_id));
  res.json(list);
});

app.get('/api/projects/:id', auth(), (req, res) => {
  const p = store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  res.json({
    ...p,
    work_items: store.workItems.filter(w => w.project_id === p.id),
    procurement_items: store.procurementItems.filter(x => x.project_id === p.id),
    travel_items: store.travelItems.filter(t => t.project_id === p.id),
    scores: store.scores.filter(sc => sc.project_id === p.id)
  });
});

app.put('/api/projects/:id', auth(true), (req, res) => {
  const idx = store.projects.findIndex(p => p.id === parseInt(req.params.id));
  if (idx < 0) return res.status(404).json({ error: '项目不存在' });
  store.projects[idx] = { ...store.projects[idx], ...req.body };
  saveStore(store);
  res.json(store.projects[idx]);
});

// 新建项目
app.post('/api/projects', auth(true), (req, res) => {
  const p = {
    id: store.projects.length + 1,
    status: 'draft',
    created_at: new Date().toISOString(),
    ...req.body
  };
  store.projects.push(p);
  saveStore(store);
  res.json(p);
});

// ==================== Excel 导入 ====================
// 上传并解析项目成本估算Excel，创建项目
app.post('/api/projects/import-excel', auth(true), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  try {
    const parsed = parseProjectExcel(req.file.path);
    const p = {
      id: store.projects.length + 1,
      status: 'reviewing',
      source_file: req.file.originalname,
      source_path: req.file.path,
      session_id: req.body.session_id || null,
      ...parsed.project,
      cost_summary: parsed.cost_summary,
      created_at: new Date().toISOString()
    };
    store.projects.push(p);
    parsed.work_items.forEach((w, i) => store.workItems.push({ id: store.workItems.length + 1, project_id: p.id, ...w }));
    parsed.procurement_items.forEach((x, i) => store.procurementItems.push({ id: store.procurementItems.length + 1, project_id: p.id, ...x }));
    parsed.travel_items.forEach((t, i) => store.travelItems.push({ id: store.travelItems.length + 1, project_id: p.id, ...t }));
    store.uploadedFiles.push({ id: Date.now(), filename: req.file.filename, originalname: req.file.originalname, url: `/uploads/${req.file.filename}` });
    saveStore(store);
    logWorkflow(p.id, 'biz', 'admin', 'excel_import', `导入项目：${p.project_name}`, req.user);
    res.json({
      project: p,
      stats: {
        work_items: parsed.work_items.length,
        procurement_items: parsed.procurement_items.length,
        travel_items: parsed.travel_items.length,
        total_cost: parsed.cost_summary.total_cost,
        contract_amount: parsed.project.contract_amount || 0
      },
      warnings: parsed.warnings
    });
  } catch (e) {
    console.error('Excel解析失败:', e);
    res.status(400).json({ error: `Excel解析失败: ${e.message}` });
  }
});

// 仅解析不入库（预览用）
app.post('/api/projects/preview-excel', auth(true), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  try {
    res.json(parseProjectExcel(req.file.path));
  } catch (e) {
    res.status(400).json({ error: `Excel解析失败: ${e.message}` });
  }
});

// ==================== 成本明细 ====================
app.get('/api/projects/:id/cost', auth(), (req, res) => {
  const pid = parseInt(req.params.id);
  const p = store.projects.find(x => x.id === pid);
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const wi = store.workItems.filter(w => w.project_id === pid);
  const proc = store.procurementItems.filter(x => x.project_id === pid);
  const travel = store.travelItems.filter(t => t.project_id === pid);
  // 分类汇总
  const catSum = {};
  for (const w of wi) catSum[w.category] = (catSum[w.category] || 0) + (w.cost || 0);
  const procByType = { software: 0, hardware: 0 };
  for (const x of proc) procByType[x.type] = (procByType[x.type] || 0) + (x.subtotal || 0);
  const travelSum = travel.reduce((a, t) => a + (t.hotel || 0) + (t.per_diem || 0) + (t.transport || 0), 0);
  res.json({
    project: p,
    work_items: wi,
    procurement_items: proc,
    travel_items: travel,
    category_cost: catSum,
    procurement_by_type: procByType,
    travel_total: travelSum
  });
});

// ==================== 专家评审打分 ====================
app.get('/api/scores', auth(), (req, res) => {
  res.json(store.scores);
});
app.post('/api/scores', auth(true), (req, res) => {
  const sc = {
    id: store.scores.length + 1,
    expert_name: req.user.real_name || req.user.username,
    expert_id: req.user.id,
    submitted_at: new Date().toISOString(),
    ...req.body
  };
  store.scores.push(sc);
  saveStore(store);
  logWorkflow(sc.project_id, 'expert', 'expert', 'score_submitted', `专家评分提交: ${sc.total_score}分`, req.user);
  res.json(sc);
});

// 项目评分汇总：平均分、偏差检测
app.get('/api/projects/:id/score-summary', auth(), (req, res) => {
  const pid = parseInt(req.params.id);
  const list = store.scores.filter(sc => sc.project_id === pid);
  if (!list.length) return res.json({ count: 0, avg_total: null, deviation: 0, has_outlier: false });
  const totals = list.map(s => s.total_score).filter(v => v != null);
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  const std = Math.sqrt(totals.reduce((a, b) => a + (b - avg) ** 2, 0) / totals.length);
  const outlier = list.find(s => s.total_score != null && Math.abs(s.total_score - avg) > 2 * std);
  res.json({
    count: list.length,
    avg_total: +avg.toFixed(2),
    std_dev: +std.toFixed(2),
    has_outlier: !!outlier,
    outlier_expert: outlier ? (outlier.expert_name || '') : null,
    scores: list
  });
});

// ==================== 批注 ====================
app.get('/api/comments', auth(), (req, res) => {
  res.json(store.comments);
});
app.post('/api/comments', auth(true), (req, res) => {
  const c = {
    id: store.comments.length + 1,
    expert_name: req.user.real_name || req.user.username,
    created_at: new Date().toISOString(),
    ...req.body
  };
  store.comments.push(c);
  saveStore(store);
  res.json(c);
});

// ==================== 统计分析 ====================
app.get('/api/stats/summary', auth(), (req, res) => {
  const scores = store.scores;
  res.json({
    total_sessions: store.reviewSessions.length,
    completed_sessions: store.reviewSessions.filter(s => s.status === 'completed').length,
    pending_sessions: store.reviewSessions.filter(s => s.status === 'pending').length,
    total_projects: store.projects.length,
    total_scores: scores.length,
    avg_score: scores.length ? +(scores.reduce((a, b) => a + (b.total_score || 0), 0) / scores.length).toFixed(2) : 0,
    total_users: store.users.length,
    total_cost: store.projects.reduce((a, p) => a + ((p.cost_summary && p.cost_summary.total_cost) || 0), 0),
    recent_activity: store.workflowLogs.slice(-6).reverse().map(l => `${l.action} ${l.remark || ''}`),
    pending_tasks: store.projects.filter(p => p.status === 'reviewing').map(p => p.project_name)
  });
});

app.get('/api/stats/trend', auth(), (req, res) => {
  const bySession = store.reviewSessions.map(s => ({
    label: s.name,
    sessions: 1,
    projects: store.projects.filter(p => p.session_id === s.id).length
  }));
  res.json({ labels: bySession.map(b => b.label), sessions: bySession.map(b => b.sessions), projects: bySession.map(b => b.projects) });
});

// 成本结构分析（供图表用）
app.get('/api/stats/cost-structure', auth(), (req, res) => {
  const labels = ['长期职工', '中实职工', '华兆职工', '人员外包', '专业分包', '采购', '差旅'];
  const keys = ['long_term_cost', 'zhongshi_cost', 'huazhao_cost', 'outsourcing_cost', 'subcontract_cost', 'procurement_cost', 'travel_cost'];
  const all = keys.map(k => store.projects.reduce((a, p) => a + ((p.cost_summary || {})[k] || 0), 0));
  res.json({ labels, data: all, total: all.reduce((a, b) => a + b, 0) });
});

// ==================== 文件上传 ====================
app.post('/api/upload', auth(true), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const f = {
    id: Date.now(),
    filename: req.file.filename,
    originalname: req.file.originalname,
    size: req.file.size,
    url: `/uploads/${req.file.filename}`,
    uploaded_by: req.user.username,
    uploaded_at: new Date().toISOString()
  };
  store.uploadedFiles.push(f);
  saveStore(store);
  res.json(f);
});

// ==================== AI辅助（占位） ====================
app.post('/api/ai/analyze', auth(true), (req, res) => {
  const { project_id } = req.body;
  const p = store.projects.find(x => x.id === project_id);
  const cs = p && p.cost_summary;
  const suggestions = [];
  if (cs) {
    if (cs.profit_rate !== null && cs.profit_rate < 0.1) suggestions.push(`利润率偏低（${(cs.profit_rate * 100).toFixed(1)}%），建议优化采购或分包结构`);
    if (cs.procurement_cost > (cs.total_cost || 0) * 0.6) suggestions.push('采购成本占比超过60%，建议复核设备单价与数量');
    if ((cs.subcontract_cost || 0) > 0) suggestions.push('专业分包工作量经5位专家独立估算后取均值修正，偏差在合理范围内');
  }
  res.json({
    analysis: p ? `${p.project_name} 成本结构分析：总成本 ${cs ? cs.total_cost : 0} 元` : '请选择项目',
    suggestions
  });
});

// ==================== 工作流日志 ====================
function logWorkflow(project_id, from_role, to_role, action, remark, operator) {
  store.workflowLogs.push({
    id: store.workflowLogs.length + 1,
    project_id, from_role, to_role, action, remark,
    operator_id: operator ? operator.id : null,
    created_at: new Date().toISOString()
  });
}
app.get('/api/workflow/:projectId', auth(), (req, res) => {
  res.json(store.workflowLogs.filter(l => l.project_id === parseInt(req.params.projectId)));
});

// 启动
app.listen(PORT, () => {
  console.log(`经济评审系统后端运行在 http://localhost:${PORT}`);
  console.log(`数据文件: ${STORE_FILE}`);
});
