# 经济评审管理系统

## 项目简介
经济评审管理系统，支持从Excel项目成本估算表自动导入数据，实现项目评审全流程管理。采用前后端分离架构，后端Express + MySQL，前端Vue.js + Bootstrap 5。

## 核心功能模块

### 1. 评审批次管理
- **批次创建**：管理员/研发可创建评审批次，设置评审时间和备注
- **批次状态流转**：`待开始(pending)` → `进行中(in_progress)` → `已完成归档(completed)`
- **归档操作**：进行中批次点击"归档"按钮完成评审流程，批次锁定并收缩展示
- **权限控制**：仅admin和rd角色可操作批此状态变更

### 2. 项目资料管理（批次抽屉视图）
- **按评审批次分组**：项目资料页按批次id升序自动编号为"第一批/第二批/第三批..."
- **抽屉交互设计**：
  - 进行中批次默认**展开**，直接查看项目明细
  - 已完成归档批次默认**收缩**，点击表头可展开查看历史数据
  - 未开始批次默认收缩
- **项目状态跟踪**：每张批次表显示项目总数、估算表上传进度（如"估算表 0/2"）
- **资料上传**：支持上传估算表、可研报告、招标文件、中标文件、合同、投标利润率评审表、分包申请等
- **缺失提醒**：顶部显示有多少项目尚未上传估算表

### 3. Excel批量导入
- 支持国网标准格式xlsx文件（12个工作表）
- 自动解析合并单元格与公式值
- 导入时可关联评审批次，自动生成项目记录

### 4. 工作量评估
- 专家在线评估人天工作量（非打分制）
- 系统自动计算平均值作为最终成本依据
- 完整的审计日志记录

### 5. RBAC权限体系
| 角色 | 权限范围 |
|------|---------|
| admin | 全部功能，包括用户管理 |
| rd | 批此管理、项目导入、数据导出 |
| biz | 本事业部项目资料上传、估算 |
| expert | 分配到的项目工作量评估 |
| accountant | 评审结果确认、财务统计 |

### 6. 统计分析
- 成本结构可视化（人员/采购/差旅占比）
- 多维度数据透视
- 导出Excel报表

---

## 技术栈

| 层 | 技术 |
|-----|------|
| 后端 | Node.js 18+ / Express 4 / JWT认证 / Multer文件上传 |
| 数据库 | MySQL 8.0 / 数据持久化至 JSON文件（开发模式） |
| 前端 | HTML5 / CSS3 / Bootstrap 5 / Chart.js / SheetJS xlsx |
| Excel解析 | xlsx库处理合并单元格、公式缓存值 |

---

## 快速开始

### 环境准备
```bash
# 安装依赖
cd backend
npm install

cd ../frontend
npm install
```

### 启动服务
```bash
# 后端服务（端口 3000）
cd backend
node server.js

# 访问 http://localhost:3000
```

### 默认账号
| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 管理员 |
| demo | demo123 | 业务员 |

---

## API接口说明

### 认证
- `POST /api/auth/login` - 用户登录，返回JWT token

### 评审批次
- `GET /api/sessions` - 获取批次列表
- `POST /api/sessions` - 创建新批次
- `PATCH /api/sessions/:id` - 更新批次状态（pending ↔ in_progress ↔ completed）

### 项目资料
- `GET /api/projects` - 获取项目列表（按角色数据隔离）
- `POST /api/projects/import-excel` - Excel批量导入项目
- `POST /api/projects/:id/files` - 上传项目资料
- `GET /api/projects/:id/files` - 获取项目所有资料

### 工作量评估
- `GET /api/projects/:id/estimates` - 获取项目评估明细
- `POST /api/estimates` - 提交专家评估人天
- `GET /api/projects/:id/estimate-summary` - 获取评估统计（平均值）

### 统计分析
- `GET /api/stats/summary` - 全局统计数据
- `GET /api/stats/cost-structure` - 成本结构分析
- `GET /api/workflow/:projectId` - 项目审计日志

---

## Excel导入格式要求

系统支持国网系统标准格式的12个工作表：
1. 项目基本信息
2. 长期职工成本估算
3. 中实职工成本估算
4. 华兆职工成本估算
5. 人员外包成本估算
6. 专业分包成本估算（含5位专家列）
7. 采购成本估算
8. 差旅费估算

导入后系统自动：
- 创建项目记录并关联批次
- 解析各成本项明细
- 生成评估任务列表供专家填写

---

## 目录结构
```
jingjipingshen/
├── backend/
│   ├── server.js          # 主入口，Express路由与中间件
│   ├── parse-excel.js     # Excel解析器（处理合并单元格与公式）
│   ├── data/              # JSON数据存储目录
│   └── uploads/           # 用户上传文件目录
├── frontend/
│   ├── index.html         # 单页应用（HTML+CSS+JS一体）
│   ├── assets/            # 静态资源
│   └── node_modules/
└── README.md
```

---

## 开发与部署

### 开发模式
```bash
# 后端热重载（需要nodemon）
npm run dev

# 前端开发服务器（可选，默认后端已提供静态服务）
cd frontend
npm run dev
```

### Docker部署
参考 `DOCKER.md` 文档

### GitHub Actions CI/CD
自动构建APK并推送发布版（参见 `.github/workflows/`）

---

## 注意事项

1. **首次使用**：系统无数据，请先创建评审批次，再导入Excel或手动创建项目
2. **归档逻辑**：批次归档后，项目资料进入只读状态，便于历史追溯
3. **浏览器兼容性**：推荐使用Chrome/Edge最新版，不支持IE
4. **文件上传**：支持pdf/docx/xlsx/jpeg/png格式，单文件上限50MB
