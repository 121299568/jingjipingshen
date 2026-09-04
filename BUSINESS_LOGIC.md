# 经济评审管理系统 - 业务逻辑设计

## 📋 核心业务流程

### 1. 批次管理（Review Session）
- 创建评审批次，设定评审时间、范围
- 导入项目明细（从Excel批量导入）
- 邀请评审专家（每批次5名）
- 分配审核任务给各角色

### 2. 项目管理（Project）
- 各项目关联到批次
- 事业部上传项目资料（作为评分依据）
- 资料包括：工作量清单、成本预算等
- 支持多格式（Excel/Word/PDF）

### 3. 专家评审打分（Expert Scoring）
- 专家查看项目资料
- 根据"人员外包"和"专业外包"sheet页逐项评估
- 填写工作量评分表
- 提交评分

### 4. 结果汇总（Score Aggregation）
- 自动计算5名专家的平均分
- 生成最终工作量评估
- 成本核算（工作量 × 单价）
- 导出评审报告

---

## 🗄️ 数据库设计

### 1. 用户表（users）
```sql
- id: 用户ID
- username: 用户名
- password: 密码（加密）
- real_name: 真实姓名
- role: 角色（admin/biz/rd/expert/accountant）
- department: 部门
- status: 状态（active/inactive）
```

### 2. 评审批次表（review_sessions）
```sql
- id: 批次ID
- session_name: 批次名称
- session_code: 批次编号
- status: 状态（pending/in_progress/completed/cancelled）
- review_time: 计划评审时间
- start_time: 开始时间
- end_time: 结束时间
- creator_id: 创建人ID
- note: 备注
- created_at: 创建时间
- updated_at: 更新时间
```

### 3. 项目表（projects）
```sql
- id: 项目ID
- project_name: 项目名称
- project_code: 项目编号
- session_id: 所属批次ID
- biz_department: 所属事业部
- rd_department: 负责研发中心
- status: 状态（draft/submitted/reviewing/completed/rejected）
- submission_date: 提交日期
- reviewer_id: 预审员ID
- note: 备注
- created_at: 创建时间
- updated_at: 更新时间
```

### 4. 项目资料表（project_files）
```sql
- id: 资料ID
- project_id: 项目ID
- file_name: 文件名
- file_path: 存储路径
- file_type: 文件类型（excel/word/pdf）
- file_size: 文件大小
- uploader_id: 上传者ID
- upload_time: 上传时间
- is_public: 是否公开
```

### 5. 专家打分表（expert_scores）
```sql
- id: 打分ID
- session_id: 批次ID
- project_id: 项目ID
- expert_id: 专家ID
- item_id: 工作项ID（关联工作量清单）
- workload_score: 工作量评分（1-100）
- quality_score: 质量评分（1-100）
- difficulty_score: 难度评分（1-100）
- comment: 评价意见
- submitted_at: 提交时间
```

### 6. 工作项表（work_items）
```sql
- id: 工作项ID
- project_id: 项目ID
- item_name: 工作项名称
- item_type: 类型（人员外包/专业外包/其他）
- unit: 单位（人天/项/批）
- planned_quantity: 计划数量
- unit_price: 单价
- total_price: 总价
- description: 描述
```

### 7. 批注表（comments）
```sql
- id: 批注ID
- session_id: 批次ID
- project_id: 项目ID
- expert_id: 专家ID
- content: 批注内容
- page_number: 页码（PDF）
- x_position: X坐标
- y_position: Y坐标
- comment_type: 类型（text/highlight/stamp）
- created_at: 创建时间
```

### 8. 工作流日志表（workflow_logs）
```sql
- id: 日志ID
- project_id: 项目ID
- from_role: 原角色
- to_role: 目标角色
- action: 操作（submit/review/approve/reject）
- operator_id: 操作人ID
- remark: 备注
- created_at: 创建时间
```

---

## 🔧 前端功能模块

### 1. 登录认证
- 用户登录（用户名/密码/角色选择）
- JWT Token 认证
- 权限校验

### 2. 工作台（Dashboard）
- 统计卡片：评审批次数、项目数、评分记录、用户数
- 趋势图表：月度评审趋势、评分分布
- 最近活动列表
- 待办事项提醒

### 3. 评审批次管理
- 批次列表（表格展示）
- 新建批次（表单）
- 编辑批次信息
- 删除批次（软删除）
- 导入项目明细（Excel批量导入）
- 状态流转：待开始 → 进行中 → 已完成

### 4. 项目资料管理
- 项目列表（表格展示）
- 新建项目（表单）
- 上传资料（支持多文件）
- 在线预览（PDF/图片）
- 下载资料
- AI辅助分析（调用API）
- 状态流转：草稿 → 已提交 → 预审中 → 评审中 → 已完成

### 5. 专家评审打分
- 评分任务列表（按专家筛选）
- 查看项目资料
- 填写评分表（工作量/质量/难度）
- 提交评分
- 查看评分结果（平均分、最高分、最低分）
- 评分偏差检测

### 6. 批注管理
- 批注列表
- PDF在线标注
- 高亮标记
- 文字批注
- 批注历史追溯

### 7. 统计分析
- 时间维度筛选（日/周/月/季度/年）
- 评审通过率趋势图
- 各部门参与统计
- 专家评分分布
- 导出Excel/PDF报告

### 8. 用户管理
- 用户列表
- 新建用户
- 编辑用户信息
- 角色分配
- 禁用/启用账号

---

## 📊 Excel 导入导出功能

### 导入项目明细（Excel模板）
| 项目名称 | 项目编号 | 所属事业部 | 负责研发 | 备注 |
|---------|---------|-----------|---------|------|

### 导入工作项（Excel模板）
| 工作项名称 | 类型 | 单位 | 计划数量 | 单价 | 总价 | 描述 |
|-----------|------|------|---------|------|------|------|

### 导出评分结果
| 项目名称 | 专家A | 专家B | 专家C | 专家D | 专家E | 平均分 | 最终成本 |
|---------|------|------|------|------|------|-------|---------|

---

## 🎯 核心算法

### 1. 平均工作量计算
```javascript
function calculateAverageScore(scores) {
    // scores: [92, 88, 85, 90, 87]
    const sum = scores.reduce((a, b) => a + b, 0);
    const avg = sum / scores.length;
    return Math.round(avg * 100) / 100; // 保留两位小数
}
```

### 2. 成本核算
```javascript
function calculateCost(workItems, avgScores) {
    // workItems: [{quantity: 100, unitPrice: 500}, ...]
    // avgScores: {workload: 85, quality: 90, difficulty: 75}
    
    let totalCost = 0;
    workItems.forEach(item => {
        const adjustedQuantity = item.quantity * (avgScores.workload / 100);
        const difficultyMultiplier = avgScores.difficulty / 100;
        totalCost += adjustedQuantity * item.unitPrice * difficultyMultiplier;
    });
    
    return Math.round(totalCost * 100) / 100;
}
```

### 3. 评分偏差检测
```javascript
function detectAnomaly(scores) {
    // scores: [92, 88, 85, 90, 87]
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, score) => sum + Math.pow(score - avg, 2), 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev > 10) {
        return { anomaly: true, message: '评分差异较大，请复核' };
    }
    return { anomaly: false, message: '评分正常' };
}
```

---

## 🔐 权限控制

| 角色 | 评审批次 | 项目资料 | 专家评审 | 批注管理 | 统计分析 | 用户管理 |
|------|---------|---------|---------|---------|---------|---------|
| admin | ✅ 全部 | ✅ 全部 | ✅ 全部 | ✅ 全部 | ✅ 全部 | ✅ 全部 |
| biz | ✅ 查看 | ✅ 上传/编辑 | ❌ | ❌ | ✅ 查看 | ❌ |
| rd | ✅ 管理 | ✅ 审核 | ❌ | ❌ | ✅ 查看 | ❌ |
| expert | ❌ | ✅ 查看 | ✅ 评分 | ✅ 批注 | ❌ | ❌ |
| accountant | ✅ 查看 | ✅ 查看 | ✅ 校核 | ❌ | ✅ 查看全部 | ❌ |

---

## 🚀 部署方案

### 开发环境
- Node.js + Express（后端）
- Vue 3 + Element Plus（前端）
- MySQL 8.0（数据库）
- Redis（缓存）

### 生产环境
- Docker Compose 一键部署
- Nginx 反向代理
- HTTPS 证书（Let's Encrypt）
- 定时备份脚本

---

## 📝 后续开发计划

### Phase 1: MVP版本（2周）
- [ ] 基础CRUD功能
- [ ] 用户认证授权
- [ ] 评审批次管理
- [ ] 项目资料上传下载
- [ ] 专家评审打分（简化版）

### Phase 2: 完整功能（1个月）
- [ ] Excel导入导出
- [ ] PDF在线预览
- [ ] 批注功能
- [ ] 统计分析图表
- [ ] AI辅助分析

### Phase 3: 高级功能（3个月）
- [ ] 实时通知（WebSocket）
- [ ] 电子签章
- [ ] 区块链存证
- [ ] 移动端适配
- [ ] 多语言支持
