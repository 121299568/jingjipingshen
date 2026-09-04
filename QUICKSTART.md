# 经济评审管理系统 - 快速开始指南

## 🚀 一键启动（推荐）

### 方式一：Docker 部署（最简单）

```bash
# 1. 进入项目目录
cd C:\Users\12129\.agnes\temporary\2026-08-29\20260829_2\work\jingjipingshen

# 2. 创建环境变量文件
copy .env.example .env

# 3. 启动所有服务
docker-compose up -d

# 4. 查看日志
docker-compose logs -f api

# 5. 访问系统
# 前端: http://localhost:3000
# API: http://localhost:3001
# phpMyAdmin: http://localhost:8080
```

**默认账号:** admin / admin123

---

### 方式二：本地安装（需要 Node.js + MySQL）

#### 步骤 1: 安装依赖

**后端：**
```powershell
cd backend
npm install
```

**前端：**
```powershell
cd frontend  
npm install vue@3 vue-router@4 axios echarts chart.js element-plus
```

#### 步骤 2: 配置数据库

1. **安装 MySQL** (如果未安装)
   - Windows: https://dev.mysql.com/downloads/installer/
   - macOS: `brew install mysql`
   - Linux: `sudo apt install mysql-server`

2. **创建数据库**
```sql
CREATE DATABASE economic_review CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'review_user'@'localhost' IDENTIFIED BY 'ReviewPass123!';
GRANT ALL PRIVILEGES ON economic_review.* TO 'review_user'@'localhost';
FLUSH PRIVILEGES;
```

3. **导入数据表**
```bash
mysql -u review_user -p economic_review < backend/db.sql
```

#### 步骤 3: 修改配置

编辑 `backend/server.js`，更新数据库连接：
```javascript
const dbConfig = {
  host: 'localhost',
  user: 'review_user',
  password: 'ReviewPass123!',  // 修改为你的密码
  database: 'economic_review'
};
```

#### 步骤 4: 启动服务

**后端：**
```powershell
cd backend
npm start
# 或开发模式: npm run dev
```

**前端：**
```powershell
cd frontend
npx serve .
# 或: npm run dev
```

**访问:** http://localhost:3000

---

## 📋 功能清单

### ✅ 已完成
- [x] 用户认证与权限管理
- [x] 评审批次 CRUD
- [x] 项目管理
- [x] 专家评审打分
- [x] 批注功能
- [x] 统计分析图表
- [x] RESTful API

### 🔧 待完善
- [ ] MySQL 持久化集成
- [ ] PDF.js 在线预览
- [ ] AI 分析接口对接
- [ ] Excel 导入导出
- [ ] WebSocket 实时通知
- [ ] 文件上传与存储
- [ ] 操作日志记录
- [ ] 移动端适配

---

## 🔑 测试账号

| 角色 | 用户名 | 密码 | 权限 |
|------|--------|------|------|
| 管理员 | admin | admin123 | 全部权限 |
| 事业部 | biz_dept | biz123 | 提交申请 |
| 研发中心 | rd_staff | rd123 | 预审材料 |
| 专家A | expert01 | expert123 | 评分打分 |
| 专家B | expert02 | expert123 | 评分打分 |
| 会计师 | accountant | acct123 | 结果校核 |

---

## 🛠️ 常见问题

### Q: npm 命令找不到？
**A:** 需要先安装 Node.js
- 下载地址: https://nodejs.org/
- 选择 LTS 版本安装
- 安装后重启终端

### Q: 数据库连接失败？
**A:** 
1. 确认 MySQL 服务已启动
2. 检查用户名密码是否正确
3. 确认数据库已创建

### Q: 前端页面空白？
**A:**
1. 按 F12 查看控制台错误
2. 确认后端 API 地址正确（默认 http://localhost:3001）
3. 检查网络连接

### Q: CORS 跨域错误？
**A:** 后端已启用 CORS，确保使用正确的 API 地址

---

## 📞 技术支持

- GitHub Issues: https://github.com/121299568/jingjipingshen/issues
- Email: support@example.com
