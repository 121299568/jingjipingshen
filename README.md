# 经济评审管理平台

经济评审管理平台 —— 覆盖**评审批次管理、项目资料与成本估算、专家工作量评估、评审结果汇总与导出、评审流程状态机、RBAC 权限、统计分析**的全流程系统。无构建步骤，前端为单文件内联应用，后端基于 Node.js / Express，支持 `json`（默认、零数据库）/ `memory` / `mysql` 三种数据驱动。

> 前端已做 **CDN 本地化**（`frontend/vendor/`，断网可用）；后端依赖已打包为离线包（`backend/deps/node_modules.tar.gz`）。**整套系统可在无互联网出口的内网服务器上离线运行**，详见独立的 [INTRANET_DEPLOY.md](INTRANET_DEPLOY.md)。

---

## 📦 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Node.js 18+ / Express 4 / JWT 认证 / Multer 文件上传 |
| 数据驱动 | `json`（默认，文件持久化，零外部数据库）/ `memory`（纯内存，测试用）/ `mysql`（生产可选，启动自动建表） |
| 前端 | 单文件 `frontend/index.html`（HTML+CSS+JS 全内联，无构建、无打包）；Bootstrap 5 + Bootstrap Icons + Chart.js（均为本地 `/vendor` 引用） |
| Excel 解析 | SheetJS (xlsx)，支持合并单元格、公式缓存值、表头模糊匹配与自动探测 |

---

## 🚀 快速开始

### 环境准备

```bash
node --version   # 需要 v18+
```

### 启动（默认 json 驱动，零数据库）

```bash
cd backend
npm install                 # 联网环境：安装依赖；内网环境请用 backend/deps/node_modules.tar.gz 离线包
node server.js
```

访问 http://localhost:3000

- 默认数据驱动为 `json`，数据落盘于 `backend/data/store.json`，重启不丢。
- 想跑一个**不污染磁盘**的测试实例：`DB_DRIVER=memory node server.js`。
- 想用 MySQL：`DB_DRIVER=mysql` 并配置 `DB_*` 环境变量（详见 [PRODUCTION_DEPLOY.md](PRODUCTION_DEPLOY.md)）。

### 默认账号

首次启动由种子数据自动创建（生产环境默认 `SEED_DEFAULT_USERS=true`，上线后请改密并置为 `false`）：

| 用户名 | 密码 | 角色 | 说明 |
|--------|------|------|------|
| admin | admin123 | 管理员 | 全部权限，含用户管理 |
| rd_staff | 123456 | 研发中心 | 批次管理、预审、分配、发起确认、归档、导出 |
| biz_gdw | 123456 | 事业部（电网） | 本事业部项目资料上传、事业部确认 |
| biz_xt | 123456 | 事业部（系统集成） | 本事业部项目资料上传、事业部确认 |
| expert01 | 123456 | 评审专家 | 分配到批次后的工作量评估、结果校核 |
| cpa01 | 123456 | 会计师事务所 | 同具专家评估角色，可参与评估与校核 |

---

## 📋 功能模块

### 1. 评审批次管理
- 创建评审批次、设置评审时间、地点、会议议程、下发评审清单。
- 批次状态机：`待开始(pending)` → `启动评审(in_progress)` → `已归档(completed)`。
- 批次级**分配评审人员**（专家 + 会计师事务所），分配后该批次下全部项目对评审人可见。
- 归档前校验：置 `in_progress` 需全部项目已传估算表；置 `completed` 需全部项目已完成。

### 2. 项目资料管理（按批次分组）
- 项目按所属批次分组展示，序号**从 01 开始（每批次各自编号）**，界面不暴露数据库 id。
- 项目文件上传：资料类 + 成本估算表（估算表上传时自动抽取工作项 / 采购 / 差旅明细）。
- 成本估算表**双数字校验**：① 合同额须等于该批次评审汇总表登记合同额；② 估算成本须小于汇总表登记的"内部信息系统填报预估成本"。任一不通过则拒收并提示。

### 3. 评审汇总表 Excel 导入（评审批次页）
- 入口在「评审批次」页的「Excel导入（评审汇总表）」按钮，模板参考真实「经济评审汇总表」格式。
- 两种模式：
  - **挂接已有批次**：把汇总表里的项目明细导入到指定批次；
  - **按表创建新批次**：以表内标题行作为批次名，自动建批次 + 自动建项目条目。
- 同批次内相同项目编号 / 同名项目自动去重跳过。
- 支持下载导入模板（`GET /api/template/summary-xlsx`）。

### 4. 工作量评估（专家协同）
- 分配到批次的专家 / 会计师事务所，对批次内项目的工作项填写**人天**。
- 5 人协同：取批次分配的专家 / 会计师前 5 人，各自填写人天 → 系统计算**算术平均人天** → **调整后费用 = 平均人天 × 单人天单价**。
- 已提交的评估可**重新修改并保存**（覆盖更新，受归档锁约束）。
- 顶部序号快滤：仅显示**已启动评审（in_progress）**批次下的项目；已提交 / 未提交以颜色区分。

### 5. 评估汇总页（评审结果汇总表）
- 顶部按**批次**过滤，默认展示最近批次（含进行中批次）。
- 渲染「项目经济评审结果汇总表」：21 列（序号 / 项目名称 / 承建部门 / 项目类型 / 合同额 / 总成本估算 / 利润率 / 长期职工 / 中实 / 华兆 / 人员外包 / 专业分包 / 分包占比 / 采购 / 差旅 / 第三方测试 / 知识产权 / 是否数字化 / 业务方向 / 业务子方向 / 产品方向）+ 合计行。
- 支持**按当前批次导出 xlsx**（`GET /api/sessions/:id/workload-summary/export`）。

### 6. 评审流程状态机
- 项目状态：`草稿(draft)` → `预审中(reviewing)` → `待确认(pending_confirm)` → `已归档(completed)`，`退回(rejected)` 为退回分支。
- 关键动作（均受状态机与权限约束）：
  - `POST /pre-review` 研发中心预审（退回须填原因）；
  - `POST /sessions/:id/assign` 批次级分配评审人员；
  - `POST /estimates` 专家 / 会计师提交（或重估）工作量；
  - `POST /verify` 结果校核（认可 / 调整 / 不认可，非认可须填说明）；
  - `POST /initiate-confirmation` 研发发起确认（须已有评估）；
  - `POST /projects/:id/confirm` 事业部项目级确认（限本事业部）；
  - `POST /finalize` 研发归档（须事业部已确认；批次内全部完成则联动归档批次）。
- **归档锁**：项目或所属批次归档后，禁止再提交评估 / 上传资料。

### 7. RBAC 权限体系

| 角色 | 权限范围 |
|------|---------|
| admin | 全部功能，含用户 / 权限管理 |
| rd（研发中心） | 批次管理、项目导入、预审、分配人员、发起确认、归档、数据导出 |
| biz（事业部） | 本事业部项目资料上传、事业部成果确认 |
| expert（专家） | 分配到批次后的工作量评估、结果校核 |
| accountant（会计师事务所） | 同具专家评估角色，可参与评估与校核 |

> 数据隔离：事业部仅见本事业部项目；专家 / 会计师仅见**分配到批次**的项目（含已有评估记录的历史项目，兼容旧数据）。

### 8. 统计分析
- **工作台**：评审批次数、项目总数、缺少估算表项目数、资料上传进度。
- **统计分析页**：成本结构柱状图、资料完整度饼图、月度趋势。
- **综合分析页**：事业部分布、月度趋势、批次完成进度、事业部完整率排名表。

### 9. 用户与权限管理
- 新建 / 编辑 / 删除用户，分配角色与部门；用户组分权；自定义权限点。

---

## 📁 项目结构

```
jingjipingshen/
├── backend/                          # 后端服务
│   ├── server.js                     # 主入口（Express API + 静态服务）
│   ├── src/                          # 配置 / 数据适配器（json / memory / mysql）
│   ├── parse-excel.js                # 成本估算簿解析（12 表结构，模糊匹配 + 表头探测）
│   ├── parse-summary-excel.js        # 评审汇总表解析（按表建批次 + 抽项目明细）
│   ├── template-summary-xlsx.js      # 评审汇总表导入模板生成
│   ├── template-xlsx.js              # 成本估算簿模板生成
│   ├── db.sql / migrate.js           # MySQL 表结构与迁移脚本
│   ├── deps/
│   │   └── node_modules.tar.gz       # ✅ 离线依赖包（内网解压即用，无需 npm）
│   ├── data/                         # json 驱动数据目录（运行时生成）
│   └── uploads/                      # 用户上传文件目录（运行时生成）
│
├── frontend/                         # 前端应用
│   ├── index.html                    # 单页应用（HTML+CSS+JS 全内联，无构建）
│   └── vendor/                       # ✅ 离线静态资源（Bootstrap / Icons / Chart.js + 字体）
│
├── deploy/                           # 部署脚本与模板
│   ├── setup-intranet.sh             # 内网一键部署脚本（install/start/stop/restart/status）
│   ├── setup-aliyun.sh               # 阿里云部署脚本
│   ├── .env.intranet                 # 内网配置模板
│   └── economic-review.service       # systemd 单元模板
│
├── README.md                         # 本文档
├── INTRANET_DEPLOY.md                # ✅ 内网离线部署方案（独立文档）
├── PRODUCTION_DEPLOY.md              # 生产（公网 / MySQL）部署指南
├── DEPLOYMENT.md / DOCKER.md         # 通用部署 / Docker 部署
├── BUSINESS_LOGIC.md                 # 业务逻辑设计
└── workflow-permissions-audit-*.md   # 流程与权限审计
```

---

## 🔌 API 接口（节选）

> 所有接口除 `/api/health`、`/api/auth/login` 外均需 `Authorization: Bearer <token>`。

### 认证
- `POST /api/auth/login` - 登录，返回 JWT（含防爆破限流：20 次 / 15 分钟 / IP）

### 评审批次
- `GET /api/sessions` - 批次列表
- `POST /api/sessions` - 新建批次（`admin`/`rd`）
- `PATCH /api/sessions/:id` - 更新批次状态 / 设置（评审时间、地点、议程、清单）
- `POST /api/sessions/:id/assign` - 批次级分配评审人员
- `GET /api/sessions/:id/assignments` - 查看分配
- `POST /api/sessions/import-summary` - 导入评审汇总表（挂接 / 新建批次 + 自动建项目）
- `GET /api/sessions/:id/workload-summary` - 批次评估汇总（21 列）
- `GET /api/sessions/:id/workload-summary/export` - 导出批次汇总 xlsx（`admin`/`rd`）
- `GET /api/sessions/:id/download-all` / `download-estimation` - 批次文件打包下载

### 项目与资料
- `GET /api/projects` - 项目列表（按角色数据隔离）
- `POST /api/projects` - 新建项目（`admin`/`rd`/`biz`）
- `PATCH /api/projects/:id` - 更新项目（含状态机流转，`admin`/`rd`）
- `POST /api/projects/:id/files` - 上传资料 / 成本估算表（估算表触发解析 + 双校验）
- `GET /api/projects/:id/files` - 项目资料列表

### 工作量评估与流程
- `GET /api/projects/:id/cost` - 项目成本详情（含评估人天、专家 1-5、平均、调整后费用）
- `POST /api/estimates` - 提交 / 重估工作量（`expert`/`accountant`）
- `POST /api/projects/:id/pre-review` - 研发中心预审
- `POST /api/projects/:id/verify` - 结果校核（`expert`/`accountant`）
- `POST /api/projects/:id/initiate-confirmation` - 发起确认（`rd`）
- `POST /api/projects/:id/confirm` - 事业部确认（`biz`，限本事业部）
- `POST /api/projects/:id/finalize` - 归档（`rd`）

### 统计分析
- `GET /api/stats/summary` - 全局统计
- `GET /api/stats/cost-structure` - 成本结构
- `GET /api/stats/detailed` - 综合分析（含完整率）

### 用户与权限
- `GET/POST/PUT/DELETE /api/users` - 用户管理（`admin`）
- `GET/POST/PUT/DELETE /api/user-groups` - 用户组
- `GET/PUT /api/users/:id/permissions` - 权限点

> 说明：`POST /api/projects/import-excel` 与 `GET /api/template/import-xlsx`（单项目成本估算簿导入）仍保留，前端当前主推「评审批次页 · 评审汇总表导入」。

---

## 🗄️ 数据驱动切换

通过环境变量 `DB_DRIVER` 切换（默认 `json`）：

| 驱动 | 用途 | 说明 |
|------|------|------|
| `json` | 生产默认 | 单文件 `data/store.json` 持久化，零外部数据库，适合内网小范围评审 |
| `memory` | 测试 | 纯内存、不落盘、重启复原，仅供上线前冒烟 |
| `mysql` | 生产可选 | 连接 MySQL 8，`ensureSchema` 启动自动建表 / 补列，无需手工迁移 |

---

## 🖥️ 部署

| 场景 | 文档 |
|------|------|
| **内网离线（无互联网出口，仅内网访问）** | [INTRANET_DEPLOY.md](INTRANET_DEPLOY.md)（含一键脚本 `deploy/setup-intranet.sh`） |
| 公网 / 阿里云 + MySQL | [PRODUCTION_DEPLOY.md](PRODUCTION_DEPLOY.md) / `deploy/setup-aliyun.sh` |
| Docker | [DOCKER.md](DOCKER.md) |
| 通用部署 | [DEPLOYMENT.md](DEPLOYMENT.md) |

---

## ⚠️ 注意事项

1. **前端无构建**：改 `frontend/index.html` 直接推 / 覆盖即生效；因是单文件内联脚本，改动后建议做语法体检（`node --check`），一处语法错误会导致整段前端 JS 失效。
2. **首次使用**：系统无数据，请先创建评审批次，再用「评审汇总表导入」或手动建项目。
3. **归档只读**：批次 / 项目归档后进入只读，便于历史追溯。
4. **文件上传**：支持 pdf/docx/xlsx/jpeg/png，单文件上限 50MB（可配 `MAX_FILE_SIZE_MB`）。
5. **安全**：默认 `admin/admin123` 等仅为首次便捷，生产务必改密并关闭 `SEED_DEFAULT_USERS`；JWT 密钥由 `JWT_SECRET` 环境变量提供，生产强制要求配置。

---

## 🐛 常见问题排查

- **页面白屏 / 无样式**：确认 `frontend/vendor/` 已随项目部署；访问 `http://IP:3000/vendor/bootstrap.min.css` 应返回 CSS。
- **登录无反应**：打开浏览器控制台看 JS 报错；确认后端 `/api/sessions` 可访问；多半是前端内联脚本语法错误。
- **图表不显示**：确认 `vendor/chart.umd.js` 已加载。
- **导入 Excel 失败**：确认格式为 `.xlsx`；评审汇总表导入请用「评审批次页」入口与对应模板。
- **后端起不来**：查 `backend/logs/app.log`（nohup）或 `journalctl -u economic-review`（systemd）；多半是 `JWT_SECRET` 未配或 `node` 版本 < 18。

---

## 📄 许可证

内部系统，仅供授权单位使用。

---

**GitHub 仓库**: https://github.com/121299568/jingjipingshen
