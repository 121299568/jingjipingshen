# 经济评审管理系统 - 完整部署指南

## 环境准备

### 1. 安装 Node.js (必需)

#### Windows 系统：
1. 访问 https://nodejs.org/zh-cn/download
2. 下载 **LTS 版本** (推荐)
3. 运行安装程序，一路点击"下一步"
4. 安装完成后打开新的命令行窗口，验证安装：
   ```powershell
   node --version
   npm --version
   ```
   应该显示类似：
   ```
   v20.10.0
   10.2.3
   ```

#### macOS 系统：
```bash
brew install node
```

#### Linux 系统 (Ubuntu/Debian):
```bash
sudo apt update
sudo apt install nodejs npm
```

---

### 2. 安装 MySQL (必需)

#### Windows:
1. 访问 https://dev.mysql.com/downloads/mysql/
2. 下载 **MySQL Installer for Windows**
3. 运行安装程序，选择"Developer Default"
4. 设置 root 密码（记住这个密码！）
5. 安装完成后验证：
   ```powershell
   mysql --version
   ```

#### macOS:
```bash
brew install mysql
mysql.server start
```

#### Linux:
```bash
sudo apt update
sudo apt install mysql-server
sudo systemctl start mysql
sudo mysql_secure_installation
```

---

### 3. 安装 Redis (可选，用于缓存)

```bash
# Windows (使用 WSL 或 Docker)
# macOS
brew install redis
redis-server

# Linux
sudo apt install redis-server
sudo systemctl start redis
```

---

## 数据库配置

### 步骤 1: 创建数据库
```sql
-- 登录 MySQL
mysql -u root -p

-- 创建数据库
CREATE DATABASE economic_review CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建用户并授权
CREATE USER 'review_user'@'localhost' IDENTIFIED BY 'ReviewPass123!';
GRANT ALL PRIVILEGES ON economic_review.* TO 'review_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 步骤 2: 导入表结构
```bash
# 导入 SQL 文件
mysql -u root -p economic_review < backend/db.sql
```

### 步骤 3: 修改后端配置
编辑 `backend/server.js` 文件，找到数据库配置部分：

```javascript
// 修改前
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'economic_review'
};

// 修改后（根据你的实际情况）
const dbConfig = {
  host: 'localhost',
  user: 'review_user',
  password: 'ReviewPass123!',
  database: 'economic_review'
};
```

---

## 后端部署

### 步骤 1: 进入后端目录
```bash
cd C:\Users\12129\.agnes\temporary\2026-08-29\20260829_2\work\jingjipingshen\backend
```

### 步骤 2: 安装依赖
```bash
npm install
```

如果没有 npm，请确保 Node.js 已正确安装并在 PATH 中。

### 步骤 3: 启动服务
```bash
# 开发模式
npm run dev

# 生产模式
npm start
```

### 步骤 4: 验证 API
打开浏览器访问：http://localhost:3000/api/sessions

如果看到 JSON 响应，说明后端运行正常。

---

## 前端部署

### 方法 A: 直接运行（开发模式）

#### 方式 1: 使用 Live Server（推荐）
1. 在 VS Code 中安装 "Live Server" 扩展
2. 右键 `frontend/index.html`，选择 "Open with Live Server"
3. 自动打开 http://localhost:5500

#### 方式 2: 使用 Node.js 简单服务器
```bash
cd C:\Users\12129\.agnes\temporary\2026-08-29\20260829_2\work\jingjipingshen\frontend
npx serve .
```

然后访问 http://localhost:3000

### 方法 B: 构建生产版本

```bash
cd frontend
npm install vue@3 vue-router@4 axios echarts
npm run build
```

构建完成后，将 `dist` 文件夹部署到 Web 服务器。

---

## 功能完善计划

### 1. 真实数据持久化

当前使用内存存储，需要集成 MySQL：

#### 安装 mysql2 驱动
```bash
cd backend
npm install mysql2 bcryptjs jsonwebtoken
```

#### 修改 server.js 数据库连接
```javascript
const mysql = require('mysql2/promise');

// 创建连接池
const pool = mysql.createPool({
  host: 'localhost',
  user: 'review_user',
  password: 'ReviewPass123!',
  database: 'economic_review',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 测试连接
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('数据库连接成功!');
    connection.release();
  } catch (error) {
    console.error('数据库连接失败:', error.message);
  }
}

testConnection();
```

---

### 2. PDF 在线预览

#### 前端集成 PDF.js
在 `frontend/index.html` 中添加：
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
</script>
```

#### 创建 PDF 预览组件
```javascript
// frontend/components/PdfViewer.vue
<template>
  <div class="pdf-viewer">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import * as pdfjsLib from 'pdfjs-dist';

const props = defineProps(['fileUrl']);
const canvasRef = ref(null);

onMounted(async () => {
  const pdf = await pdfjsLib.getDocument(props.fileUrl).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.5 });
  
  const canvas = canvasRef.value;
  canvas.height = viewport.height;
  canvas.width = viewport.width;
  
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
});
</script>
```

---

### 3. AI 分析服务对接

#### 后端 API 示例
```javascript
// backend/server.js
const axios = require('axios');

app.post('/api/ai/analyze', async (req, res) => {
  const { projectData, analysisType } = req.body;
  
  try {
    // 调用外部 AI API
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4',
      messages: [
        { role: 'system', content: '你是一个专业的经济评审助手' },
        { role: 'user', content: `请分析以下项目数据：${JSON.stringify(projectData)}` }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      }
    });
    
    res.json({
      success: true,
      data: response.data.choices[0].message.content,
      suggestions: extractSuggestions(response.data.choices[0].message.content)
    });
  } catch (error) {
    res.status(500).json({ error: 'AI 分析失败', details: error.message });
  }
});
```

---

### 4. Excel 导入导出

#### 安装依赖
```bash
cd backend
npm install exceljs xlsx
cd ../frontend
npm install xlsx file-saver
```

#### 后端导出接口
```javascript
const ExcelJS = require('exceljs');

app.get('/api/export/scores', async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('评审得分');
  
  // 添加表头
  worksheet.addRow(['项目名称', '评审专家', '工作量评分', '质量评分', '总分', '评审时间']);
  
  // 添加数据
  const scores = await getScoresFromDB();
  scores.forEach(score => {
    worksheet.addRow([
      score.project_name,
      score.expert_name,
      score.workload_score,
      score.quality_score,
      score.total_score,
      score.submitted_at
    ]);
  });
  
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename=scores.xlsx');
  await workbook.xlsx.write(res);
  res.end();
});
```

---

## 常见问题排查

### Q1: npm install 报错 "找不到命令"
**A:** 重新安装 Node.js，安装时勾选 "Add to PATH"

### Q2: 数据库连接失败
**A:** 
1. 检查 MySQL 服务是否运行：`sudo systemctl status mysql`
2. 检查用户名密码是否正确
3. 检查数据库是否存在

### Q3: 前端页面显示空白
**A:** 
1. 按 F12 打开开发者工具查看控制台错误
2. 确保 API 地址正确（默认 http://localhost:3000）
3. 检查网络连接

### Q4: CORS 跨域错误
**A:** 在后端添加 CORS 中间件：
```javascript
const cors = require('cors');
app.use(cors());
```

---

## 性能优化建议

1. **启用 Gzip 压缩**
```javascript
const compression = require('compression');
app.use(compression());
```

2. **使用 Redis 缓存热点数据**
```bash
npm install redis
```

3. **数据库索引优化**
```sql
CREATE INDEX idx_project_status ON projects(status);
CREATE INDEX idx_session_status ON review_sessions(status);
CREATE INDEX idx_score_expert ON expert_scores(expert_id);
```

---

## 安全加固

1. **HTTPS 证书**
   - 使用 Let's Encrypt 免费证书
   - 配置 Nginx SSL

2. **API 限流**
```bash
npm install express-rate-limit
```

3. **SQL 注入防护**
   - 使用参数化查询
   - 输入验证和过滤

4. **敏感信息保护**
   - 使用环境变量管理密钥
   - .env 文件加入 .gitignore

---

## 监控与维护

### 日志记录
```javascript
const winston = require('winston');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});
```

### 健康检查
```javascript
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});
```

---

## 联系支持

如遇问题，请查看：
1. 控制台错误日志
2. 浏览器开发者工具 Network 标签
3. 后端终端输出

GitHub Issues: https://github.com/121299568/jingjipingshen/issues
