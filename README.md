# 经济评审管理系统 - jingjipingshen

> 企业级经济评审全流程管理平台

## 🚀 快速开始

### 1. 后端启动
```bash
cd backend
npm install
npm start
```
访问 http://localhost:3000

### 2. 前端启动
```bash
cd frontend
npm install
npm run dev
```
访问 http://localhost:5173

---

## 📁 项目结构

```
jingjipingshen/
├── backend/                 # Node.js 后端 (Express)
│   ├── server.js           # 主服务器
│   ├── package.json        # 依赖配置
│   └── db.sql              # 数据库表结构
├── frontend/               # Vue.js 前端
│   ├── index.html         # 主页面
│   └── app.js             # 应用逻辑
└── README.md
```

---

## 🔐 默认账号

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 系统管理员 | admin | admin123 |
| 各事业部 | biz_dept | biz123 |
| 研发中心 | rd_staff | rd123 |
| 评审专家 | expert01 | expert123 |
| 会计师事务所 | accountant | acct123 |

---

## ✨ 核心功能

### 1. 评审批次管理
- 新建/编辑/删除评审批次
- Excel批量导入
- 批次状态跟踪：待开始 → 进行中 → 已完成

### 2. 权限分配
- 四级角色权限控制
- 数据隔离与共享配置
- 操作日志记录

### 3. 项目资料管理
- 多格式文件上传 (PDF/Word/Excel/图片)
- 在线预览与下载
- AI辅助分析集成点

### 4. 现场批注
- PDF标注工具
- 文字批注、高亮标记
- 批注历史追溯

### 5. 专家评审打分
- 多维度评分模型
- 自动计算加权平均分
- 评分偏差检测

### 6. 结果汇总
- 实时统计仪表盘
- 时间维度趋势分析
- 导出Excel/PDF报告

### 7. AI辅助
- 智能分析接入点
- 数据分析建议
- 风险识别提示

---

## 🗄️ 数据库设计

### 主要数据表
1. **users** - 用户表
2. **review_sessions** - 评审批次表
3. **projects** - 项目表
4. **project_files** - 项目资料表
5. **expert_scores** - 专家评审打分表
6. **review_comments** - 评审意见批注表
7. **workflow_logs** - 工作流记录表
8. **ai_analysis_results** - AI分析记录表

详细SQL见 `backend/db.sql`

---

## 🌐 工作流程

```
各事业部          研发中心           评审专家         外部会计师事务所
    │                │                  │                    │
    └─▶ 提交申请 ──▶ 预审核 ──▶ 组织评审会 ──▶ 现场打分 ──▶ 结果校核
         │            │              │                   │
         └────────────┴──────────────┘                   │
                        │                                │
         ◀──── 确认结果 ─────────────────────────────────┘
                            │
                        ◀── 导入
```

---

## 🔧 API 接口

### 认证
- `POST /api/auth/login` - 登录
- `GET /api/auth/profile` - 获取当前用户

### 评审批次
- `GET /api/sessions` - 列表
- `POST /api/sessions` - 创建
- `PUT /api/sessions/:id` - 更新
- `DELETE /api/sessions/:id` - 删除

### 项目
- `GET /api/projects` - 列表
- `POST /api/projects` - 创建
- `POST /api/projects/:id/upload` - 上传文件

### 评审打分
- `GET /api/scores` - 列表
- `POST /api/scores` - 提交评分
- `GET /api/scores/stats` - 统计汇总

### 批注
- `GET /api/comments` - 列表
- `POST /api/comments` - 创建批注

### 统计
- `GET /api/stats/summary` - 总体统计
- `GET /api/stats/trend` - 趋势分析

---

## 📝 后续开发计划

- [ ] 完整Vue.js前端重构
- [ ] MySQL数据库集成
- [ ] Redis缓存层
- [ ] JWT认证增强
- [ ] PDF在线预览组件
- [ ] AI分析接口对接
- [ ] 移动端适配
- [ ] Docker容器化部署

---

## 📄 许可证

MIT License

---

## 👥 联系

GitHub: https://github.com/121299568/jingjipingshen
