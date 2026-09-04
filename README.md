# 经济评审管理系统

基于 Flask + Vue.js 的企业级经济评审全流程管理平台

## 系统特性

### 核心功能
- ✅ **评审批次管理** - 支持批量导入、状态跟踪
- ✅ **权限分配** - 四级角色：事业部、研发中心、专家评审、会计师事务所
- ✅ **项目资料管理** - 上传/下载/在线预览/AI辅助分析
- ✅ **现场批注** - PDF标注、意见批注、高亮标记
- ✅ **专家评审打分** - 多维度评分、自动汇总统计
- ✅ **结果汇总** - 实时统计、趋势分析、导出报告
- ✅ **时间维度分析** - 按时间段统计评审趋势

### 工作流支持
```
资料预审阶段 → 现场评审阶段 → 成果确认阶段
```

## 技术栈

### 后端
- Python 3.11+
- Flask / FastAPI
- SQLAlchemy (ORM)
- MySQL 8.0
- Redis (缓存)
- Celery (异步任务)

### 前端
- Vue 3 + Vite
- Element Plus UI
- ECharts 图表
- PDF.js (在线查看)
- Cropper.js (图片处理)

## 快速开始

### 环境要求
- Python 3.11+
- Node.js 18+
- MySQL 8.0+
- Redis 7.0+

### 1. 克隆项目
```bash
git clone https://github.com/121299568/jingjipingshen.git
cd jingjipingshen
```

### 2. 后端部署
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
# 编辑 .env 配置数据库连接
python db_setup.py
python server.py
```

### 3. 前端部署
```bash
cd frontend
npm install
npm run dev
```

访问 http://localhost:5173

## 默认账号

| 角色 | 用户名 | 密码 |
|------|--------|------|
| 管理员 | admin | admin123 |
| 事业部 | biz_dept | biz123 |
| 研发中心 | rd_staff | rd123 |
| 专家 | expert01 | expert123 |
| 会计师 | accountant | acct123 |

## 功能模块详解

### 1. 评审批次管理
- 新建批次的完整表单
- Excel 批量导入功能
- 批次状态流转（待开始→进行中→已完成）
- 邀请专家、分配项目

### 2. 项目资料管理
- 多格式文件上传（PDF/Word/Excel/图片）
- 在线预览与下载
- AI 辅助分析（成本估算、风险识别）
- 版本控制

### 3. 专家评审打分
- 多维度评分模型
- 盲审模式（隐藏申报方信息）
- 评分偏差自动检测
- 自动计算加权平均分

### 4. 现场批注
- PDF 标注工具
- 文字批注、高亮、印章
- 批注与打分关联
- 批注历史追溯

### 5. 统计分析
- 时间维度筛选（日/周/月/季度/年）
- 评审通过率趋势图
- 各部门参与统计
- 专家评分分布
- 导出 Excel/PDF 报告

## 目录结构
```
jingjipingshen/
├── backend/                 # 后端服务
│   ├── app/                # 应用主目录
│   │   ├── api/            # API 路由
│   │   ├── models/         # 数据模型
│   │   ├── services/       # 业务逻辑
│   │   └── utils/          # 工具函数
│   ├── config/             # 配置文件
│   ├── tests/              # 测试用例
│   └── requirements.txt
├── frontend/               # 前端应用
│   ├── src/
│   │   ├── views/          # 页面组件
│   │   ├── components/     # 公共组件
│   │   ├── store/          # Pinia 状态管理
│   │   └── router/         # 路由配置
│   ├── public/             # 静态资源
│   └── package.json
├── docs/                   # 文档
├── docker-compose.yml      # Docker 编排
└── README.md
```

## API 接口

### 认证
```
POST /api/auth/login      # 登录
POST /api/auth/logout     # 登出
GET  /api/auth/profile    # 获取当前用户信息
```

### 评审批次
```
GET    /api/sessions           # 列表
POST   /api/sessions           # 创建
GET    /api/sessions/:id       # 详情
PUT    /api/sessions/:id       # 更新
DELETE /api/sessions/:id       # 删除
POST   /api/sessions/:id/import # 导入项目
```

### 项目
```
GET    /api/projects           # 列表
POST   /api/projects           # 创建
GET    /api/projects/:id       # 详情
PUT    /api/projects/:id       # 更新
POST   /api/projects/:id/upload # 上传文件
GET    /api/projects/:id/files # 获取文件列表
```

### 评审打分
```
GET    /api/scores              # 列表
POST   /api/scores              # 提交评分
GET    /api/scores/stats        # 统计汇总
GET    /api/scores/export       # 导出报告
```

### 批注
```
GET    /api/comments            # 获取批注列表
POST   /api/comments            # 创建批注
DELETE /api/comments/:id        # 删除批注
```

### 统计
```
GET /api/stats/summary         # 总体统计
GET /api/stats/trend           # 趋势分析
GET /api/stats/departments     # 部门统计
GET /api/stats/experts         # 专家统计
```

## 部署

### Docker 一键部署
```bash
docker-compose up -d
```

### 生产环境
参考 `docs/deployment.md`

## 开发计划

- [ ] 移动端适配
- [ ] 消息推送通知
- [ ] 电子签章集成
- [ ] 区块链存证
- [ ] 多语言支持

## 许可证

MIT License

## 联系方式

如有问题请提交 Issue 或联系开发团队
