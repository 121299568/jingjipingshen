# 经济评审管理系统

## 项目简介
经济评审管理系统，支持从Excel项目成本估算表自动导入数据，实现项目评审全流程管理。

## 功能模块
1. **评审批次管理** - 创建和管理评审批次
2. **项目资料管理** - 项目信息管理、Excel批量导入
3. **成本结构分析** - 可视化展示成本构成（人员/采购/差旅）
4. **专家评审打分** - 专家在线评分与偏差检测
5. **统计分析** - 多维度数据统计与图表展示

## 快速开始

### 后端服务
```bash
cd backend
npm install
node server.js
# 访问 http://localhost:3000
```

### 前端服务
```bash
cd frontend
npm install
npm start
# 访问 http://localhost:5173
```

## Excel导入说明
系统支持国网系统标准格式的项目成本估算汇总表（xlsx），包含以下工作表：
- 项目基本信息
- 长期职工成本估算
- 中实职工成本估算  
- 华兆职工成本估算
- 人员外包成本估算
- 专业分包成本估算
- 采购成本估算
- 差旅费估算

导入后自动生成项目记录及成本明细。

## API接口
- `POST /api/auth/login` - 用户登录
- `GET /api/projects` - 获取项目列表
- `POST /api/projects/import-excel` - Excel导入项目
- `GET /api/projects/:id/cost` - 获取项目成本明细
- `GET /api/stats/cost-structure` - 成本结构统计
