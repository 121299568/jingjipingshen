# 经济评审管理系统

国网冀北电力经济评审管理系统，支持项目资料上传、专家工作量评估、成本核算全流程管理。

## 📦 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js 18+ / Express 4 / JWT认证 / Multer文件上传 |
| 数据库 | 内存存储（JSON持久化），开发模式无需额外数据库 |
| 前端 | HTML5 + CSS3 + Bootstrap 5 + Chart.js（单页应用） |
| Excel解析 | SheetJS (xlsx) 处理合并单元格与公式缓存值 |

## 🚀 快速开始

### 环境准备

```powershell
# 确认 Node.js 已安装
node --version   # 需要 v18+
npm --version
```

### 启动服务

```powershell
# 1. 进入后端目录
cd backend

# 2. 安装依赖
npm install

# 3. 启动后端服务（同时提供静态文件和API）
node server.js
```

访问 http://localhost:3000

### 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 管理员（全部权限） |

## 📋 功能模块

### 1. 评审批次管理
- 创建评审批次，设置评审时间
- 批次状态流转：待开始 → 进行中 → 已完成归档
- 归档后批次收缩展示，历史数据可追溯

### 2. 项目资料管理（批次抽屉视图）
- 按评审批次分组，第一批/第二批/第三批...
- 进行中批次默认展开，归档批次默认收缩
- 估算表为核心资料，其他为参考资料
- 缺失估算表提醒

### 3. Excel批量导入
- 支持国网标准格式xlsx文件（12个工作表）
- 自动解析合并单元格与公式值
- 导入时自动关联评审批次

### 4. 工作量评估流程
- 专家根据"人员外包"和"专业分包"sheet逐项评估人天
- 系统自动计算5位专家平均值作为最终成本依据
- 完整的审计日志记录

### 5. RBAC权限体系

| 角色 | 权限范围 |
|------|---------|
| admin | 全部功能，包括用户管理 |
| rd | 批此管理、项目导入、数据导出 |
| biz | 本事业部项目资料上传 |
| expert | 分配到的项目工作量评估 |
| accountant | 评审结果确认、财务统计 |

### 6. 统计分析

#### 工作台
- 评审批次数、项目总数、缺少估算表项目数
- 各类资料上传进度图

#### 统计分析页
- 成本结构柱状图
- **资料完整度饼图**：齐全项目数 / 总项目数
- 月度趋势分析

#### 综合分析页
- 事业部分布饼图（合同金额占比）
- 月度趋势折线图（项目数量 + 合同金额）
- 资料上传情况对比图
- 批次完成进度堆叠柱状图
- **事业部排名表**：含完整率列（按完整率排序）

### 7. 用户管理
- 新建用户，分配角色和部门
- 数据隔离：各角色只能看到本部门数据

## 📁 项目结构

```
jingjipingshen/
├── backend/                          # 后端服务
│   ├── server.js          ← 主入口（Express API + 静态服务）
│   ├── parse-excel.js     ← Excel解析器（处理合并单元格与公式）
│   ├── gen-seed.js        ← 种子数据生成器
│   ├── data/              ← JSON数据存储目录
│   └── uploads/           ← 用户上传文件目录
│
├── frontend/                         # 前端应用
│   ├── index.html         ← 单页应用（HTML+CSS+JS全部内联）
│   └── package.json
│
├── README.md                        ← 本文档
├── BUSINESS_LOGIC.md                ← 业务逻辑设计
├── DEPLOYMENT.md                    ← 部署指南
├── DOCKER.md                        ← Docker部署说明
└── commit_push.cmd                  ← Git推送脚本
```

## 🔌 API接口

### 认证
- `POST /api/auth/login` - 用户登录，返回JWT token

### 评审批次
- `GET /api/sessions` - 获取批次列表
- `POST /api/sessions` - 创建新批次
- `PATCH /api/sessions/:id` - 更新批次状态

### 项目资料
- `GET /api/projects` - 获取项目列表（按角色数据隔离）
- `POST /api/projects` - 新建项目
- `POST /api/projects/import-excel` - Excel批量导入项目
- `POST /api/projects/:id/files` - 上传项目资料
- `GET /api/projects/:id/files` - 获取项目所有资料

### 工作量评估
- `GET /api/projects/:id/cost` - 获取项目成本详情（含评估人天）
- `POST /api/estimates` - 提交专家评估人天

### 统计分析
- `GET /api/stats/summary` - 全局统计数据
- `GET /api/stats/cost-structure` - 成本结构分析
- `GET /api/stats/detailed` - 综合统计分析（含完整率）

## 📊 Excel导入格式

系统支持国网标准格式的12个工作表：
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

## ⚠️ 注意事项

1. **首次使用**：系统无数据，请先创建评审批次，再导入Excel或手动创建项目
2. **归档逻辑**：批次归档后，项目资料进入只读状态，便于历史追溯
3. **浏览器兼容性**：推荐使用Chrome/Edge最新版，不支持IE
4. **文件上传**：支持pdf/docx/xlsx/jpeg/png格式，单文件上限50MB
5. **数据持久化**：使用JSON文件存储，重启服务数据不丢失

## 🐛 常见问题排查

### 登录无反应
1. 打开浏览器控制台(F12)查看JavaScript错误
2. 确认后端服务已启动：访问 http://localhost:3000/api/sessions
3. 检查console是否有语法错误

### 图表不显示
1. 检查Chart.js CDN是否加载成功
2. 确认canvas元素存在且尺寸合理

### 导入Excel失败
1. 确认文件格式为.xlsx或.xls
2. 检查是否包含必需的工作表

## 🚀 生产环境部署

将系统部署到生产服务器，使用真实数据库（MySQL），请参考：

- **完整部署指南**: [PRODUCTION_DEPLOY.md](PRODUCTION_DEPLOY.md)
- **Docker部署**: [DOCKER.md](DOCKER.md)

### 部署步骤概览

1. **服务器准备**：安装 Node.js、MySQL、Nginx、PM2
2. **数据库配置**：创建数据库和用户，导入表结构
3. **代码修改**：添加MySQL连接支持，配置环境变量
4. **数据迁移**：运行迁移脚本将JSON数据导入MySQL
5. **启动服务**：使用PM2管理进程
6. **配置反向代理**：Nginx + SSL证书
7. **备份监控**：设置定时备份和健康检查

---

## 📝 版本历史

- **v1.0**: 初始版本，基础CRUD功能
- **v1.1**: 增加专家评审打分流程
- **v1.2**: 完善RBAC权限体系
- **v1.3**: 新增资料完整度统计，优化图表展示
- **v1.4**: 修复登录问题，清理HTML结构

## 📄 许可证

MIT License

## 👥 开发团队

- 项目负责人: 121299568
- 技术支持: Agnes AI Assistant

---

**GitHub仓库**: https://github.com/121299568/jingjipingshen
