const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Mock Database (替换为MySQL)
let users = [
  { id: 1, username: 'admin', password: '$2a$10$...', role: 'admin', department: '研发中心' },
  { id: 2, username: 'biz_dept', password: '$2a$10$...', role: 'biz', department: '各事业部' },
  { id: 3, username: 'expert', password: '$2a$10$...', role: 'expert', department: '评审专家' },
  { id: 4, username: 'accountant', password: '$2a$10$...', role: 'accountant', department: '外部会计师事务所' }
];

let reviewSessions = [];
let projects = [];
let scores = [];
let comments = [];

// API Routes

// ==================== 认证 ====================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = users.find(u => u.username === username);
  
  if (!user) {
    return res.status(401).json({ error: '用户不存在' });
  }
  
  // 简化验证，实际应使用bcrypt
  const token = Buffer.from(JSON.stringify(user)).toString('base64');
  res.json({ 
    token, 
    user: { id: user.id, username: user.username, role: user.role, department: user.department } 
  });
});

// ==================== 用户管理 ====================
app.get('/api/users', (req, res) => {
  res.json(users.map(({ password, ...u }) => u));
});

app.post('/api/users', (req, res) => {
  const newUser = {
    id: users.length + 1,
    ...req.body,
    password: req.body.password || 'default123'
  };
  users.push(newUser);
  res.json({ id: newUser.id, ...newUser });
});

// ==================== 评审批次 ====================
app.get('/api/sessions', (req, res) => {
  res.json(reviewSessions);
});

app.post('/api/sessions', (req, res) => {
  const session = {
    id: reviewSessions.length + 1,
    created_at: new Date().toISOString(),
    status: 'pending',
    ...req.body
  };
  reviewSessions.push(session);
  res.json(session);
});

app.put('/api/sessions/:id', (req, res) => {
  const idx = reviewSessions.findIndex(s => s.id === parseInt(req.params.id));
  if (idx >= 0) {
    reviewSessions[idx] = { ...reviewSessions[idx], ...req.body };
    res.json(reviewSessions[idx]);
  } else {
    res.status(404).json({ error: '评审批次不存在' });
  }
});

// ==================== 项目资料 ====================
app.get('/api/projects', (req, res) => {
  res.json(projects);
});

app.post('/api/projects', (req, res) => {
  const project = {
    id: projects.length + 1,
    created_at: new Date().toISOString(),
    ...req.body
  };
  projects.push(project);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const idx = projects.findIndex(p => p.id === parseInt(req.params.id));
  if (idx >= 0) {
    projects[idx] = { ...projects[idx], ...req.body };
    res.json(projects[idx]);
  } else {
    res.status(404).json({ error: '项目不存在' });
  }
});

// ==================== 专家评审打分 ====================
app.get('/api/scores', (req, res) => {
  res.json(scores);
});

app.post('/api/scores', (req, res) => {
  const score = {
    id: scores.length + 1,
    created_at: new Date().toISOString(),
    ...req.body
  };
  scores.push(score);
  res.json(score);
});

// ==================== 批注功能 ====================
app.get('/api/comments', (req, res) => {
  res.json(comments);
});

app.post('/api/comments', (req, res) => {
  const comment = {
    id: comments.length + 1,
    created_at: new Date().toISOString(),
    ...req.body
  };
  comments.push(comment);
  res.json(comment);
});

// ==================== 统计分析 ====================
app.get('/api/stats/summary', (req, res) => {
  const startDate = req.query.start_date;
  const endDate = req.query.end_date;
  
  // 统计逻辑
  const stats = {
    total_sessions: reviewSessions.length,
    completed_sessions: reviewSessions.filter(s => s.status === 'completed').length,
    pending_sessions: reviewSessions.filter(s => s.status === 'pending').length,
    avg_score: scores.length > 0 ? (scores.reduce((a, b) => a + b.score, 0) / scores.length).toFixed(2) : 0
  };
  
  res.json(stats);
});

app.get('/api/stats/trend', (req, res) => {
  // 时间趋势统计
  res.json([]);
});

// ==================== 文件上传 ====================
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

app.post('/api/upload', upload.single('file'), (req, res) => {
  res.json({
    id: Date.now(),
    filename: req.file.filename,
    originalname: req.file.originalname,
    url: `/uploads/${req.file.filename}`
  });
});

// ==================== AI辅助 ====================
app.post('/api/ai/analyze', (req, res) => {
  // 调用AI分析接口
  res.json({
    analysis: 'AI分析报告',
    suggestions: ['建议1', '建议2']
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`经济评审系统后端运行在 http://localhost:${PORT}`);
});
