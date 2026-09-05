// 经济评审管理系统后端 v3 (工作量评估流程)
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 数据存储 ====================
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function defaultStore() {
  return {
    users: [
      { id: 1, username: 'admin', password: 'admin123', real_name: '系统管理员', role: 'admin', department: 'IT部', business_dept: null },
      { id: 2, username: 'biz_gdw', password: '123456', real_name: '电网事业部经办人', role: 'biz', department: '电网事业部', business_dept: '电网事业部' },
      { id: 3, username: 'biz_xt', password: '123456', real_name: '系统集成事业部经办人', role: 'biz', department: '系统集成事业部', business_dept: '系统集成事业部' },
      { id: 4, username: 'rd_staff', password: '123456', real_name: '研发中心员工', role: 'rd', department: '研发中心', business_dept: null },
      { id: 5, username: 'expert01', password: '123456', real_name: '评审专家A', role: 'expert', department: '评审专家库', business_dept: null },
      { id: 6, username: 'cpa01', password: '123456', real_name: '会计师事务所专家甲', role: 'accountant', department: '外部会计师事务所', business_dept: null }
    ],
    reviewSessions: [
      { id: 1, name: '2026年度Q3经济评审', status: 'in_progress', review_time: '2026-09-15 09:00', creator_id: 1, note: '示例批次', created_at: new Date().toISOString() }
    ],
    projects: [],
    workItems: [],
    procurementItems: [],
    travelItems: [],
    expertEstimates: [],
    confirmations: [],
    files: [],
    workflowLogs: []
  };
}

function loadStore() {
  if (!fs.existsSync(STORE_FILE)) {
    const s = defaultStore();
    saveStore(s);
    return s;
  }
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
}

function saveStore(s) { fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2), 'utf8'); }

const store = loadStore();

// ==================== 中间件 ====================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

// Token签名
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', 'economic-review-secret').update(body).digest('base64url');
  return body + '.' + sig;
}

function verify(token) {
  try {
    const [body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', 'economic-review-secret').update(body).digest('base64url');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch { return null; }
}

// ==================== 权限验证 ====================
function auth(requiredRoles) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const user = h.startsWith('Bearer ') ? verify(h.slice(7)) : null;
    if (!user) return res.status(401).json({ error: '未登录或token过期' });
    req.user = user;
    if (requiredRoles && !requiredRoles.includes(user.role)) {
      return res.status(403).json({ error: '无权限操作' });
    }
    next();
  };
}

function filterByDept(store, key, user) {
  if (user.role === 'admin' || user.role === 'rd') return store[key];
  if (user.role === 'biz' && user.business_dept) {
    return store[key].filter(item => item.business_dept === user.business_dept || !item.business_dept);
  }
  if (user.role === 'expert' || user.role === 'accountant') {
    const assignedProjectIds = store.expertEstimates.filter(e => e.expert_id === user.id).map(e => e.project_id);
    return store[key].filter(item => assignedProjectIds.includes(item.id) || !item.business_dept);
  }
  return store[key];
}

function logWorkflow(projectId, action, remark, userId) {
  const user = store.users.find(u => u.id === userId);
  store.workflowLogs.push({
    id: store.workflowLogs.length + 1,
    project_id: projectId,
    operator_id: userId,
    operator_role: user?.role || 'unknown',
    operator_name: user?.real_name || '未知',
    action, remark,
    created_at: new Date().toISOString()
  });
  saveStore(store);
}

// Multer配置
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const fileFilter = (req, file, cb) => {
  const allowed = /\.(xlsx|xls|pdf|docx?|jpg|jpeg|png)$/i;
  if (allowed.test(file.originalname)) cb(null, true);
  else cb(new Error('不支持的文件类型'));
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

// ==================== API路由 ====================

// 登录
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = store.users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (user.password !== password) return res.status(401).json({ error: '密码错误' });
  const token = sign({ id: user.id, username: user.username, role: user.role, business_dept: user.business_dept });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, department: user.department, real_name: user.real_name, business_dept: user.business_dept } });
});

// 用户管理
app.get('/api/users', auth(), (req, res) => {
  res.json(store.users.map(({ password, ...u }) => u));
});
app.post('/api/users', auth(['admin']), (req, res) => {
  const u = { id: store.users.length + 1, ...req.body, password: req.body.password || '123456' };
  store.users.push(u);
  saveStore(store);
  res.json({ ...u, password: undefined });
});

// 评审批次
app.get('/api/sessions', auth(), (req, res) => {
  const list = store.reviewSessions.map(s => ({
    ...s,
    project_count: store.projects.filter(p => p.session_id === s.id).length
  }));
  res.json(list);
});
app.post('/api/sessions', auth(['admin', 'rd']), (req, res) => {
  const s = { id: store.reviewSessions.length + 1, status: 'pending', created_at: new Date().toISOString(), creator_id: req.user.id, ...req.body };
  store.reviewSessions.push(s);
  saveStore(store);
  res.json(s);
});

// 更新评审批次状态（管理员或RD可归档/启动）
app.patch('/api/sessions/:id', auth(['admin', 'rd']), (req, res) => {
  const idx = store.reviewSessions.findIndex(x => x.id === parseInt(req.params.id));
  if (idx < 0) return res.status(404).json({ error: '批次不存在' });
  const allowed = ['pending', 'in_progress', 'completed'];
  const newStatus = req.body.status;
  if (!newStatus || !allowed.includes(newStatus)) {
    return res.status(400).json({ error: '无效状态，可选: pending/in_progress/completed' });
  }
  store.reviewSessions[idx].status = newStatus;
  if (newStatus === 'completed') {
    store.reviewSessions[idx].completed_at = new Date().toISOString();
  }
  saveStore(store);
  console.log('[SESSION] Batch #' + req.params.id + ' status -> ' + newStatus);
  res.json(store.reviewSessions[idx]);
});

// 项目
app.get('/api/projects', auth(), (req, res) => {
  const list = filterByDept(store, 'projects', req.user);
  res.json(list);
});

app.get('/api/projects/:id', auth(), (req, res) => {
  const p = store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'biz' && req.user.business_dept !== p.business_dept && req.user.id !== p.creator_id) {
    return res.status(403).json({ error: '无权查看该项目' });
  }
  res.json({
    ...p,
    work_items: store.workItems.filter(w => w.project_id === p.id),
    procurement_items: store.procurementItems.filter(x => x.project_id === p.id),
    travel_items: store.travelItems.filter(t => t.project_id === p.id),
    files: store.files.filter(f => f.project_id === p.id),
    expert_estimates: store.expertEstimates.filter(e => e.project_id === p.id),
    confirmations: store.confirmations.filter(c => c.project_id === p.id)
  });
});

app.post('/api/projects', auth(['admin', 'rd', 'biz']), (req, res) => {
  const p = { id: store.projects.length + 1, status: 'draft', created_at: new Date().toISOString(), creator_id: req.user.id, ...req.body };
  store.projects.push(p);
  saveStore(store);
  logWorkflow(p.id, 'create_project', `创建项目：${p.project_name}`, req.user.id);
  res.json(p);
});

// Excel导入
app.post('/api/projects/import-excel', auth(['admin', 'rd', 'biz']), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  try {
    const { parseProjectExcel } = require('./parse-excel');
    const parsed = parseProjectExcel(req.file.path);
    const p = {
      id: store.projects.length + 1,
      status: 'reviewing',
      source_file: req.file.originalname,
      source_path: req.file.path,
      business_dept: req.body.business_dept || null,
      session_id: req.body.session_id || null,
      ...parsed.project,
      cost_summary: parsed.cost_summary,
      created_at: new Date().toISOString(),
      creator_id: req.user.id
    };
    store.projects.push(p);
    parsed.work_items.forEach((w, i) => store.workItems.push({ id: store.workItems.length + 1, project_id: p.id, ...w }));
    parsed.procurement_items.forEach((x, i) => store.procurementItems.push({ id: store.procurementItems.length + 1, project_id: p.id, ...x }));
    parsed.travel_items.forEach((t, i) => store.travelItems.push({ id: store.travelItems.length + 1, project_id: p.id, ...t }));
    saveStore(store);
    logWorkflow(p.id, 'excel_import', `Excel导入项目：${p.project_name}`, req.user.id);
    res.json({
      project: p,
      stats: { work_items: parsed.work_items.length, procurement_items: parsed.procurement_items.length, travel_items: parsed.travel_items.length, total_cost: parsed.cost_summary.total_cost, contract_amount: parsed.project.contract_amount || 0 }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 项目文件上传
app.post('/api/projects/:id/files', auth(), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择文件' });
  const projectId = parseInt(req.params.id);
  const project = store.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  if (req.user.role === 'biz' && req.user.business_dept !== project.business_dept) {
    return res.status(403).json({ error: '无权上传该项目文件' });
  }
  const file = {
    id: store.files.length + 1,
    project_id: projectId,
    filename: req.file.filename,
    originalname: req.file.originalname,
    file_type: path.extname(req.file.originalname).slice(1),
    file_category: req.body.category || 'other',
    uploader_id: req.user.id,
    url: `/uploads/${req.file.filename}`,
    description: req.body.description || '',
    upload_time: new Date().toISOString()
  };
  store.files.push(file);
  saveStore(store);
  logWorkflow(projectId, 'upload_file', `上传${file.file_category}文件：${file.originalname}`, req.user.id);
  res.json(file);
});

app.get('/api/projects/:id/files', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const project = store.projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const fileData = store.files.filter(f => f.project_id === projectId);
  if (req.user.role === 'expert' || req.user.role === 'accountant') {
    const assignedProjectIds = store.expertEstimates.filter(e => e.expert_id === req.user.id).map(e => e.project_id);
    if (!assignedProjectIds.includes(projectId)) {
      return res.status(403).json({ error: '无权查看该项目文件' });
    }
  }
  res.json(fileData);
});

// ==================== 工作量评估接口 ====================

app.get('/api/projects/:id/estimates', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const estimates = store.expertEstimates.filter(e => e.project_id === projectId);
  if (req.user.role === 'expert' || req.user.role === 'accountant') {
    res.json(estimates.filter(e => e.expert_id === req.user.id));
  } else {
    const summary = {};
    estimates.forEach(e => {
      if (!summary[e.work_item_id]) summary[e.work_item_id] = { count: 0, total: 0 };
      summary[e.work_item_id].count++;
      summary[e.work_item_id].total += e.days;
    });
    const result = [];
    for (const [workItemId, data] of Object.entries(summary)) {
      result.push({
        work_item_id: parseInt(workItemId),
        avg_days: data.count > 0 ? Math.round(data.total / data.count * 10) / 10 : 0,
        submitted_count: data.count
      });
    }
    res.json(result);
  }
});

app.post('/api/estimates', auth(['expert', 'accountant']), (req, res) => {
  const { project_id, work_item_id, days, comment } = req.body;
  if (!project_id || !work_item_id || days === undefined) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  const existing = store.expertEstimates.find(e => e.expert_id === req.user.id && e.project_id === project_id && e.work_item_id === work_item_id);
  if (existing) {
    return res.status(400).json({ error: '您已经提交过该项评估' });
  }
  const estimate = {
    id: store.expertEstimates.length + 1,
    project_id,
    work_item_id,
    expert_id: req.user.id,
    expert_name: req.user.real_name,
    days,
    comment: comment || '',
    submitted_at: new Date().toISOString()
  };
  store.expertEstimates.push(estimate);
  saveStore(store);
  logWorkflow(project_id, 'submit_estimate', `专家${estimate.expert_name}评估工作项${work_item_id}: ${days}人天`, req.user.id);
  res.json(estimate);
});

app.get('/api/projects/:id/estimate-summary', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const estimates = store.expertEstimates.filter(e => e.project_id === projectId);
  if (estimates.length === 0) {
    return res.json({ message: '暂无专家评估数据' });
  }
  const summary = {};
  estimates.forEach(e => {
    if (!summary[e.work_item_id]) {
      summary[e.work_item_id] = { items: [], total: 0, count: 0 };
    }
    summary[e.work_item_id].items.push(e.days);
    summary[e.work_item_id].total += e.days;
    summary[e.work_item_id].count++;
  });
  const result = Object.entries(summary).map(([workItemId, data]) => ({
    work_item_id: parseInt(workItemId),
    days_list: data.items,
    avg_days: Math.round(data.total / data.count * 10) / 10,
    expert_count: data.count,
    max_days: Math.max(...data.items),
    min_days: Math.min(...data.items)
  }));
  res.json(result);
});

app.post('/api/confirmations', auth(['expert', 'accountant']), (req, res) => {
  const { project_id, work_item_id, confirmed } = req.body;
  if (!project_id || !work_item_id || confirmed === undefined) {
    return res.status(400).json({ error: '缺少必要参数' });
  }
  const confirmation = {
    id: store.confirmations.length + 1,
    project_id,
    work_item_id,
    expert_id: req.user.id,
    expert_name: req.user.real_name,
    confirmed,
    comment: req.body.comment || '',
    confirmed_at: new Date().toISOString()
  };
  store.confirmations.push(confirmation);
  saveStore(store);
  logWorkflow(project_id, confirmed ? 'confirm_estimate' : 'reject_estimate',
    `专家${confirmation.expert_name}${confirmed ? '确认' : '驳回'}工作项${work_item_id}的平均值`, req.user.id);
  res.json(confirmation);
});

app.get('/api/projects/:id/confirmations', auth(), (req, res) => {
  const projectId = parseInt(req.params.id);
  const confirmations = store.confirmations.filter(c => c.project_id === projectId);
  if (req.user.role === 'expert' || req.user.role === 'accountant') {
    res.json(confirmations.filter(c => c.expert_id === req.user.id));
  } else {
    res.json(confirmations);
  }
});

// 成本明细
app.get('/api/projects/:id/cost', auth(), (req, res) => {
  const p = store.projects.find(x => x.id === parseInt(req.params.id));
  if (!p) return res.status(404).json({ error: '项目不存在' });
  const estimateSummary = store.expertEstimates
    .filter(e => e.project_id === p.id)
    .reduce((acc, e) => {
      if (!acc[e.work_item_id]) acc[e.work_item_id] = [];
      acc[e.work_item_id].push(e.days);
      return acc;
    }, {});
  res.json({
    work_items: store.workItems.filter(w => w.project_id === p.id).map(w => ({
      ...w,
      expert_days_list: estimateSummary[w.id] || [],
      expert_days_avg: estimateSummary[w.id] ? Math.round(estimateSummary[w.id].reduce((a,b)=>a+b,0)/estimateSummary[w.id].length*10)/10 : w.expert_days_avg,
      adjusted_cost: estimateSummary[w.id] ? Math.round(estimateSummary[w.id].reduce((a,b)=>a+b,0)/estimateSummary[w.id].length * (w.cost/w.person_days||0) * 10) / 10 : w.adjusted_cost
    })),
    procurement_items: store.procurementItems.filter(x => x.project_id === p.id),
    travel_items: store.travelItems.filter(t => t.project_id === p.id),
    category_cost: calculateCategoryCost(store.workItems.filter(w => w.project_id === p.id)),
    estimate_stats: {
      total_experts: Object.keys(estimateSummary).length,
      avg_days_by_item: estimateSummary
    }
  });
});

function calculateCategoryCost(items) {
  const cost = { long_term: 0, zhongshi: 0, huazhao: 0, outsourcing: 0, subcontract: 0 };
  items.forEach(w => { if (cost[w.category] !== undefined) cost[w.category] += Number(w.cost || 0); });
  return cost;
}

// 统计

// ==================== 高级统计分析 ====================
app.get('/api/stats/detailed', auth(), (req, res) => {
  const user = req.user;
  const projects = filterByDept(store, 'projects', user);
  const files = store.projectFiles || [];
  const sessions = store.reviewSessions || [];
  const estimates = store.expertEstimates || [];
  
  // 1. 批次统计
  const sessionStats = sessions.map(s => ({
    ...s,
    project_count: projects.filter(p => p.session_id === s.id).length,
    completed_projects: projects.filter(p => p.session_id === s.id && p.status === 'completed').length,
    files_count: files.filter(f => projects.some(p => p.id === f.project_id && p.session_id === s.id)).length
  }));
  
  // 2. 事业部统计
  const deptMap = {};
  projects.forEach(p => {
    const dept = p.biz_department || '未分类';
    if (!deptMap[dept]) deptMap[dept] = { count: 0, total_amount: 0 };
    deptMap[dept].count++;
    deptMap[dept].total_amount += Number(p.contract_amount) || 0;
  });
  const deptStats = Object.entries(deptMap).map(([name, data]) => ({
    name, ...data, avg_amount: data.count > 0 ? data.total_amount / data.count : 0
  })).sort((a, b) => b.total_amount - a.total_amount);
  
  // 3. 资料上传统计
  const categories = ['estimation', 'feasibility', 'bid', 'award', 'contract', 'profit', 'subcontract'];
  const fileCategoryStats = {};
  categories.forEach(cat => {
    const catFiles = files.filter(f => f.file_category === cat);
    fileCategoryStats[cat] = { count: catFiles.length, projects_with_file: new Set(catFiles.map(f => f.project_id)).size };
  });
  
  // 4. 项目状态分布
  const statusDist = {};
  projects.forEach(p => { const s = p.status || 'draft'; statusDist[s] = (statusDist[s] || 0) + 1; });
  
  // 5. 评估统计
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
  
  // 6. 时间趋势
  const monthlyStats = {};
  projects.forEach(p => {
    const month = new Date(p.created_at).toISOString().slice(0, 7);
    if (!monthlyStats[month]) monthlyStats[month] = { projects: 0, amount: 0 };
    monthlyStats[month].projects++;
    monthlyStats[month].amount += Number(p.contract_amount) || 0;
  });
  const monthlyTrend = Object.entries(monthlyStats).sort(([a], [b]) => a.localeCompare(b)).map(([m, d]) => ({ month: m, ...d }));
  
  // 7. 专家工作量
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
    version: '2.0', generated_at: new Date().toISOString(),
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
    const stats = await getDetailedStats(req.user);
    let content = '', mimeType = 'text/html';
    
    if (type === 'summary') { content = generateSummaryReport(stats); mimeType = 'text/html'; }
    else if (type === 'department') { content = generateDepartmentReport(stats, req.body.params); mimeType = 'text/html'; }
    else if (type === 'expert') { content = generateExpertReport(stats); mimeType = 'text/html'; }
    else { return res.status(400).json({ error: '未知的报告类型' }); }
    
    res.json({ success: true, report_type: type, format, content, generated_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function getDetailedStats(user) {
  const projects = filterByDept(store, 'projects', user);
  const files = store.projectFiles || [];
  const sessions = store.reviewSessions || [];
  const estimates = store.expertEstimates || [];
  return { projects, files, sessions, estimates };
}

function generateSummaryReport(stats) {
  const { projects, sessions, files, estimates } = stats;
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>经济评审汇总报告</title>' +
    '<style>body{font-family:Arial,sans-serif;margin:40px;}h1{color:#333;border-bottom:2px solid #667eea;padding-bottom:10px;}table{border-collapse:collapse;width:100%;margin:20px 0;}th,td{border:1px solid #ddd;padding:12px;text-align:left;}th{background:#667eea;color:white;}.metric{display:inline-block;margin:10px 20px;padding:15px 25px;background:#f0f4ff;border-radius:8px;}.metric-value{font-size:24px;font-weight:bold;color:#667eea;}</style>' +
    '</head><body><h1>经济评审汇总报告</h1><p>生成时间: ' + new Date().toLocaleString('zh-CN') + '</p>' +
    '<div class="metrics"><div class="metric"><div class="metric-value">' + projects.length + '</div><div>项目总数</div></div>' +
    '<div class="metric"><div class="metric-value">' + (projects.reduce((s,p) => s + Number(p.contract_amount||0), 0)/10000).toFixed(2) + '万</div><div>合同总金额</div></div>' +
    '<div class="metric"><div class="metric-value">' + sessions.length + '</div><div>评审批次</div></div>' +
    '<div class="metric"><div class="metric-value">' + files.length + '</div><div>上传文件</div></div></div>' +
    '<h2>批此列表</h2><table><tr><th>ID</th><th>名称</th><th>状态</th><th>项目数</th></tr>' +
    sessions.map(s => '<tr><td>' + s.id + '</td><td>' + (s.name||s.session_name||'-') + '</td><td>' + s.status + '</td><td>' + projects.filter(p=>p.session_id===s.id).length + '</td></tr>').join('') + '</table></body></html>';
}

function generateDepartmentReport(stats, params) {
  const { projects } = stats;
  const dept = params.department || '';
  const deptProjects = dept ? projects.filter(p => p.biz_department === dept) : projects;
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>事业部分析报告</title>' +
    '<style>body{font-family:Arial;margin:40px;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:10px;}th{background:#667eea;color:white;}</style></head><body>' +
    '<h1>事业部经济评审分析报告</h1><p>部门: ' + (dept||'全部') + '</p><table><tr><th>ID</th><th>项目名称</th><th>金额</th><th>状态</th></tr>' +
    deptProjects.map(p => '<tr><td>' + p.id + '</td><td>' + String(p.project_name||'').substring(0,30) + '</td><td>' + Number(p.contract_amount||0).toLocaleString() + '</td><td>' + p.status + '</td></tr>').join('') +
    '</table><p>总计: ' + deptProjects.length + ' 个项目</p></body></html>';
}

function generateExpertReport(stats) {
  const { estimates, projects } = stats;
  const expertMap = {};
  estimates.forEach(e => {
    const eid = e.expert_id;
    if (!expertMap[eid]) expertMap[eid] = { name: e.expert_name, days: 0, projects: new Set() };
    expertMap[eid].days += Number(e.days || 0);
    expertMap[eid].projects.add(e.project_id);
  });
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>专家工作量报告</title>' +
    '<style>body{font-family:Arial;margin:40px;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ddd;padding:10px;}th{background:#10b981;color:white;}</style></head><body>' +
    '<h1>专家工作量评估报告</h1><p>生成时间: ' + new Date().toLocaleString('zh-CN') + '</p>' +
    '<table><tr><th>专家ID</th><th>姓名</th><th>项目数</th><th>总人天</th><th>平均人天</th></tr>' +
    Object.values(expertMap).map(e => '<tr><td>-</td><td>' + e.name + '</td><td>' + e.projects.size + '</td><td>' + e.days.toFixed(2) + '</td><td>' + (e.days/e.projects.size).toFixed(2) + '</td></tr>').join('') +
    '</table></body></html>';
}


app.get('/api/stats/summary', auth(), (req, res) => {
  const s = store;
  const totalCost = s.projects.reduce((sum, p) => sum + (parseFloat(p.contract_amount) || 0), 0);
  res.json({
    total_sessions: s.reviewSessions.length,
    completed_sessions: s.reviewSessions.filter(x => x.status === 'completed').length,
    pending_sessions: s.reviewSessions.filter(x => x.status === 'pending').length,
    total_projects: s.projects.length,
    total_scores: s.expertEstimates.length,
    avg_score: s.expertEstimates.length ? Math.round(s.expertEstimates.reduce((a, e) => a + e.days, 0) / s.expertEstimates.length * 10) / 10 : 0,
    total_users: s.users.length,
    total_cost: totalCost,
    recent_activity: s.workflowLogs.slice(-5).reverse().map(l => `${l.operator_name} ${l.action}: ${l.remark}`),
    pending_tasks: s.projects.filter(p => p.status === 'pending' || p.status === 'reviewing').map(p => p.project_name)
  });
});
app.get('/api/stats/cost-structure', auth(), (req, res) => {
  const labels = ['长期职工', '中实职工', '华兆职工', '人员外包', '专业分包', '采购', '差旅'];
  const data = [0, 0, 0, 0, 0, 0, 0];
  store.projects.forEach(p => {
    const ws = store.workItems.filter(w => w.project_id === p.id);
    const costs = calculateCategoryCost(ws);
    data[0] += costs.long_term || 0;
    data[1] += costs.zhongshi || 0;
    data[2] += costs.huazhao || 0;
    data[3] += costs.outsourcing || 0;
    data[4] += costs.subcontract || 0;
    const proc = store.procurementItems.filter(x => x.project_id === p.id);
    data[5] += proc.reduce((a, x) => a + (parseFloat(x.subtotal) || 0), 0);
    const trav = store.travelItems.filter(t => t.project_id === p.id);
    data[6] += trav.reduce((a, t) => a + (parseFloat(t.hotel) + parseFloat(t.per_diem) + parseFloat(t.transport) || 0), 0);
  });
  const total = data.reduce((a, b) => a + b, 0);
  res.json({ labels, data, total });
});

// 工作流日志
app.get('/api/workflow/:projectId', auth(), (req, res) => {
  const logs = store.workflowLogs.filter(l => l.project_id === parseInt(req.params.id));
  res.json(logs);
});

// ==================== 前端静态文件服务 ====================
app.use(express.static(FRONTEND_DIR));

// 根路径返回index.html
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
