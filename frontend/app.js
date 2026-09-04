// 全局状态
let currentUser = null;
const API_BASE = 'http://localhost:3000/api';

// 初始化
document.addEventListener('DOMContentLoaded', function() {
  initLogin();
  initNavigation();
});

// 登录逻辑
function initLogin() {
  const loginForm = document.getElementById('loginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', function(e) {
      e.preventDefault();
      handleLogin();
    });
  }
  
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
}

async function handleLogin() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const role = document.getElementById('role').value;
  
  try {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    });
    
    const data = await response.json();
    
    if (data.token) {
      currentUser = data.user;
      localStorage.setItem('currentUser', JSON.stringify(currentUser));
      showMainApp();
    } else {
      alert('用户名或密码错误');
    }
  } catch (error) {
    console.error('Login error:', error);
    // 模拟登录（演示用）
    currentUser = { username, role, department: '研发中心' };
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    showMainApp();
  }
}

function handleLogout() {
  currentUser = null;
  localStorage.removeItem('currentUser');
  document.getElementById('loginPage').style.display = 'flex';
  document.getElementById('mainApp').style.display = 'none';
}

function showMainApp() {
  document.getElementById('loginPage').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('userDisplay').textContent = `${currentUser.username} (${currentUser.role})`;
  loadDashboard();
}

// 导航
function initNavigation() {
  document.querySelectorAll('.nav-link[data-page]').forEach(link => {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      const page = this.getAttribute('data-page');
      navigateToPage(page);
    });
  });
}

function navigateToPage(page) {
  document.querySelectorAll('.page-content').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  
  const targetPage = document.getElementById(`page-${page}`);
  if (targetPage) {
    targetPage.style.display = 'block';
  }
  
  event.target.closest('.nav-link').classList.add('active');
  
  // 加载对应页面数据
  switch(page) {
    case 'dashboard': loadDashboard(); break;
    case 'review-sessions': loadSessions(); break;
    case 'projects': loadProjects(); break;
    case 'scoring': loadScores(); break;
    case 'stats': loadStats(); break;
  }
}

// 仪表盘
async function loadDashboard() {
  try {
    const response = await fetch(`${API_BASE}/stats/summary`);
    const stats = await response.json();
    
    document.getElementById('stat-sessions').textContent = stats.total_sessions || 0;
    document.getElementById('stat-projects').textContent = stats.total_projects || 0;
    document.getElementById('stat-scores').textContent = stats.total_scores || 0;
    document.getElementById('stat-users').textContent = stats.total_users || 0;
    
    updateRecentActivity(stats.recent_activity);
    updateTodoList(stats.pending_tasks);
  } catch (error) {
    console.error('Load dashboard error:', error);
  }
}

function updateRecentActivity(activities) {
  const container = document.getElementById('recentActivity');
  if (!activities || activities.length === 0) {
    container.innerHTML = '<p class="text-muted">暂无活动记录</p>';
    return;
  }
  
  container.innerHTML = activities.map(a => `
    <div class="d-flex align-items-center mb-2">
      <i class="bi bi-circle-fill text-primary me-2"></i>
      <span>${a}</span>
    </div>
  `).join('');
}

function updateTodoList(tasks) {
  const container = document.getElementById('todoList');
  if (!tasks || tasks.length === 0) {
    container.innerHTML = '<li class="list-group-item text-muted">暂无待办事项</li>';
    return;
  }
  
  container.innerHTML = tasks.map(t => `
    <li class="list-group-item d-flex justify-content-between align-items-center">
      ${t}
      <span class="badge bg-primary rounded-pill">新</span>
    </li>
  `).join('');
}

// 评审批次管理
async function loadSessions() {
  try {
    const response = await fetch(`${API_BASE}/sessions`);
    const sessions = await response.json();
    
    const tbody = document.getElementById('sessionTableBody');
    tbody.innerHTML = sessions.map(s => `
      <tr>
        <td>${s.id}</td>
        <td>${s.name}</td>
        <td><span class="badge bg-${getStatusColor(s.status)}">${getStatusLabel(s.status)}</span></td>
        <td>${new Date(s.created_at).toLocaleString()}</td>
        <td>${s.project_count || 0}</td>
        <td>
          <button class="btn btn-sm btn-primary me-1"><i class="bi bi-eye"></i></button>
          <button class="btn btn-sm btn-warning me-1"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-danger"><i class="bi bi-trash"></i></button>
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Load sessions error:', error);
  }
}

function getStatusColor(status) {
  const colors = { pending: 'warning', in_progress: 'info', completed: 'success', cancelled: 'danger' };
  return colors[status] || 'secondary';
}

function getStatusLabel(status) {
  const labels = { pending: '待开始', in_progress: '进行中', completed: '已完成', cancelled: '已取消' };
  return labels[status] || status;
}

// 项目资料管理
async function loadProjects() {
  try {
    const response = await fetch(`${API_BASE}/projects`);
    const projects = await response.json();
    
    const tbody = document.getElementById('projectTableBody');
    tbody.innerHTML = projects.map(p => `
      <tr>
        <td>${p.id}</td>
        <td>${p.name}</td>
        <td>${p.department}</td>
        <td>${new Date(p.created_at).toLocaleString()}</td>
        <td><span class="badge bg-${getStatusColor(p.status)}">${getStatusLabel(p.status)}</span></td>
        <td>
          <button class="btn btn-sm btn-info me-1" title="下载资料"><i class="bi bi-download"></i></button>
          <button class="btn btn-sm btn-primary me-1" title="在线查看"><i class="bi bi-eye"></i></button>
          <button class="btn btn-sm btn-success me-1" title="AI辅助分析"><i class="bi bi-robot"></i></button>
          <button class="btn btn-sm btn-warning"><i class="bi bi-pencil"></i></button>
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Load projects error:', error);
  }
}

// 专家评审打分
async function loadScores() {
  try {
    const response = await fetch(`${API_BASE}/scores`);
    const scores = await response.json();
    
    const tbody = document.getElementById('scoreTableBody');
    tbody.innerHTML = scores.map(s => `
      <tr>
        <td>${s.id}</td>
        <td>${s.project_name}</td>
        <td>${s.expert_name}</td>
        <td>${s.workload_score}</td>
        <td>${s.quality_score}</td>
        <td><strong>${s.total_score}</strong></td>
        <td>
          <button class="btn btn-sm btn-primary me-1"><i class="bi bi-eye"></i></button>
          <button class="btn btn-sm btn-warning"><i class="bi bi-pencil"></i></button>
        </td>
      </tr>
    `).join('');
  } catch (error) {
    console.error('Load scores error:', error);
  }
}

// 统计分析
async function loadStats() {
  try {
    const response = await fetch(`${API_BASE}/stats/trend`);
    const trendData = await response.json();
    
    renderTrendChart(trendData);
    renderScoreChart();
  } catch (error) {
    console.error('Load stats error:', error);
  }
}

function renderTrendChart(data) {
  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.labels || ['1月', '2月', '3月', '4月', '5月', '6月'],
      datasets: [{
        label: '评审批次',
        data: data.sessions || [5, 8, 6, 10, 12, 8],
        borderColor: '#667eea',
        tension: 0.4
      }, {
        label: '通过项目',
        data: data.projects || [3, 6, 5, 8, 10, 7],
        borderColor: '#27ae60',
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' }
      }
    }
  });
}

function renderScoreChart() {
  const ctx = document.getElementById('scoreChart');
  if (!ctx) return;
  
  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['优秀', '良好', '合格', '不合格'],
      datasets: [{
        data: [30, 45, 20, 5],
        backgroundColor: ['#27ae60', '#3498db', '#f39c12', '#e74c3c']
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom' }
      }
    }
  });
}

// 保存评审批次
async function saveSession() {
  const name = document.getElementById('sessionName').value;
  const time = document.getElementById('sessionTime').value;
  const note = document.getElementById('sessionNote').value;
  
  if (!name || !time) {
    alert('请填写必填项');
    return;
  }
  
  try {
    await fetch(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, review_time: time, note })
    });
    
    // 关闭模态框并刷新列表
    bootstrap.Modal.getInstance(document.getElementById('addSessionModal')).hide();
    loadSessions();
  } catch (error) {
    console.error('Save session error:', error);
    alert('保存失败，请重试');
  }
}

// 导出功能
function exportToExcel(data, filename) {
  const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
