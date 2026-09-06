# 经济评审管理系统 — 全仓源码审查报告

> 审查时间：2026-09-06　审查人：儿子
> 代码基线：`main` @ `c825a8c`（后端 971 行 / 前端 1228 行 / 解析器 284 行）
> 方法：全量通读源码 + 线上 Render 实例实测 + 本地隔离实例复现（不污染线上数据）
> 标注 **[实测]** 的条目均已被真实请求验证，不是静态推断。

---

## 〇、先说结论

**现在这套代码不能直接上正式服务器。** 有三个硬阻塞：

1. **任何人都能伪造管理员身份**（仓库是 public，JWT 密钥硬编码在源码里）——[实测] 我没用密码就拿到了全部 9 个用户的账号信息。
2. **数据隔离形同虚设**——[实测] 事业部用户、评审专家、会计师，登录后都能看到全部 8 个项目，专家还能打开任意项目的完整成本/采购/差旅明细。
3. **接数据库的代码一行都没写**——`db.sql`、`migrate.js`、`PRODUCTION_DEPLOY.md` 都齐了，但 `server.js` 里没有任何 MySQL 代码，而且数据库表结构和代码的数据模型已经严重对不上。

另外有一批功能"看着有、其实是坏的"，下面按严重度列。

---

## 一、P0 — 上线前必须修（安全 / 数据安全）

### 1. JWT 签名密钥硬编码在公开仓库 —— 可伪造任意身份
`backend/server.js:79` 和 `:86`

```js
crypto.createHmac('sha256', 'economic-review-secret')
```

仓库是 **public**，密钥等于公开。攻击者用这个密钥自己签一个 `role: admin` 的 token 就能接管系统。

**[实测]** 我用硬编码密钥自签了一个 admin token，**没有用任何密码**就调通了 `/api/users`，返回：

```
admin/admin, biz_gdw/biz, biz_xt/biz, rd_staff/rd, expert01/expert,
expert02/expert, cpa01/accountant, test_expert_1788575394791/expert, test_expert/expert
```

雪上加霜的是：
- token **没有过期时间**（payload 里只有 id/username/role/business_dept，无 `exp`），签一次永久有效；
- **无法注销**，改密码、删用户都不影响已签发的 token；
- `render.yaml` 里配了 `JWT_SECRET: generateValue: true`，`.env.example` 也写了，**但 `server.js` 根本没读这个环境变量** —— 你以为配了，其实没生效。

**修法**：`process.env.JWT_SECRET` + 启动时校验非空 + 用 `jsonwebtoken` 库带 `exp`；密钥轮换一次（旧 token 全部失效）。

---

### 2. 密码明文存储 + 默认弱口令
`server.js:25-30`（默认账号）、`:199`（明文比对）、`:219`（新建用户默认密码 `123456`）

```js
if (user.password !== password) ...   // 明文比对，无 bcrypt
```

默认口令 `admin123` / `123456` 已经躺在公开仓库里。`store.json` 里也是明文。

**[实测]** `admin/admin123`、`expert01/123456`、`cpa01/123456` 全部一次登录成功。

**修法**：bcrypt 哈希（cost ≥ 12）+ 强制首次登录改密 + 默认账号在初始化时生成随机密码打到日志。

---

### 3. 数据隔离完全失效 —— 越权可见全部项目
`server.js:106-116` `filterByDept()`

```js
if (user.role === 'biz' && user.business_dept) {
  return store[key].filter(item => item.business_dept === user.business_dept || !item.business_dept);
}
```

根因是**两套字段名混用**：
- Excel 导入的项目只有 `biz_department`（`parse-excel.js:78` 写的）
- 手动新建的项目只有 `biz_department`（前端 `saveProject` 传的）
- **没有任何一条路径写入 `business_dept`**

于是所有项目的 `business_dept` 都是 `null` → `!item.business_dept` 恒为 `true` → **过滤条件等于没过滤**。

专家/会计师分支同理：`assignedProjectIds.includes(item.id) || !item.business_dept` → 全部放行。

**[实测]** 三个账号看到的项目数：

| 账号 | 角色 | 可见项目数 | 打开 /projects/1 详情 |
|---|---|---|---|
| biz_gdw | 电网事业部 | **8 / 8** | 403 |
| expert01 | 评审专家 | **8 / 8** | **200**（全量成本明细） |
| cpa01 | 会计师事务所 | **8 / 8** | **200**（全量成本明细） |

顺带：`GET /api/users` 的中间件是 `auth()` **不带任何角色**，任何登录用户都能拉全部用户列表（实测 9 条）。

**修法**：统一字段为 `business_dept` 并回填存量数据；`|| !item.business_dept` 这个兜底删掉；`GET /api/users` 改 `auth(['admin'])`。

---

### 4. 批量字段注入（Mass Assignment）—— 可伪造 id / 状态 / 归属人
`server.js:393`、`:345`

```js
const p = { id: nextId(...), status: 'draft', creator_id: req.user.id, ...req.body };
```

`...req.body` 在**最后**，客户端传的字段会**覆盖**前面所有值。

**[实测]** 我在本地隔离实例发了一个普通建项目请求，body 里塞 `id: 99999, status: "completed", creator_id: 8888`：

```
HTTP 200 | 落库 id=99999  status=completed  creator_id=8888
```

批次的 `POST /api/sessions` 同样中招（实测注入 `id: 77777, status: "completed"` 成功）。

**能干什么**：把一个新建项目直接标成"已完成"跳过评审流程；伪造 creator_id 栽赃/冒领；把 id 设成别人的造成主键冲突、后续 `nextId` 错乱。

**修法**：显式白名单取字段，别 spread `req.body`。

---

### 5. 上传的文件目录无任何鉴权
`server.js:74`

```js
app.use('/uploads', express.static(UPLOAD_DIR));   // 在所有 auth 中间件之前
```

只要知道文件名就能直接下载，不需要登录。而文件名规则是可枚举的：`{项目ID}-{两位序号}-{原文件名}`（`server.js:456`）。

> 说明：我用 `/uploads/test.pdf` 探测返回的是 200，但那是被 SPA 兜底 `app.get('*')` 返回了 index.html（content-type: text/html），不能算"实测下载到文件"。漏洞本身从代码上确定成立，但**我没在真实文件上验证过**，这里如实标注。

---

### 6. 数据全在临时磁盘 + 单文件 JSON，会丢也会崩

三个叠加问题：

**(a) Render 免费层文件系统是临时的** —— 重启、重新部署，`backend/data/store.json` 和 `backend/uploads/` 全部归零。而且 `.gitignore` 把这两个目录忽略了，数据根本不进版本库。**现在的线上数据随时可能蒸发。**

**(b) 文件损坏 → 服务直接起不来** `server.js:54` 的 `JSON.parse` 没有 try/catch，在顶层 `loadStore()` 里调用。

**[实测]** 我人为截断 store.json（模拟写一半进程被杀）后启动：

```
SyntaxError: Unterminated string in JSON at position 32
    at JSON.parse (<anonymous>)
    at loadStore (server.js:54:23)
    at Object.<anonymous> (server.js:69:15)
```

进程直接退出，无自动恢复、无备份回滚。

**(c) 每次写都全量重写整个 store**（`saveStore` 用 `writeFileSync`），数据量大起来会越来越慢，50MB 上传也会触发全量重写。

> 补充：我做了 30 并发创建项目的测试，**没有出现丢数据**（Node 单线程 + 全同步写，没有 await 让出点）。所以"并发覆盖"在当前单进程模型下不成立，真实风险是**多进程部署（PM2 cluster / 多实例）时各进程内存数据分叉互相覆盖**。

---

## 二、P1 — 功能"看着有，其实是坏的"

### 7. 批次全量下载 / 估算表下载 —— 按钮点了必然失败
前端 `index.html:781` 把 token 放 URL 参数：

```js
window.location.href = API + '/sessions/' + sessionId + '/download-all?token=' + ...;
```

后端 `auth()` 只读 `Authorization` header（`server.js:95`），**根本不看 query**。

**[实测]**
```
GET /api/sessions/1/download-all?token=<真实token>   → 401 未登录或token过期
GET /api/sessions/1/download-all  (带 header)        → 200 application/zip
```

**用户点了下载会跳到一个写着"未登录"的 JSON 页面。**

---

### 8. 审计日志接口永远返回空
`server.js:881`

```js
app.get('/api/workflow/:projectId', auth(), (req, res) => {
  const logs = store.workflowLogs.filter(l => l.project_id === parseInt(req.params.id));
```

路由参数是 `:projectId`，代码却读 `req.params.id`（`undefined`）→ `parseInt(undefined)` = `NaN` → 永远匹配不上。

**[实测]** 线上和本地都返回 `[]`。而且前端**从来没调用过这个接口** —— 也就是说 `logWorkflow()` 辛苦记的审计日志，既存不进去也查不出来，等于没有。

---

### 9. 统计页"月度趋势"的金额线全是 NaN
后端返回字段是 `amount`（`server.js:751`），前端读的是 `t.total_amount`（`index.html:952`）。

**[实测]** 线上返回：
```json
[{"month":"2026-09","projects":7,"amount":283664}, ...]
```
前端 `(t.total_amount/10000).toFixed(1)` → `NaN`。折线图第二条线是废的。

---

### 10. 权限配置界面是摆设
`server.js:291-334` 建了 `userPermissions` 表、`/api/permission-options` 列了 10 个权限项，前端也有完整的勾选界面。

**但所有接口的鉴权都只看 `role`**（`auth(requiredRoles)` → `requiredRoles.includes(user.role)`），**完全没有读 `userPermissions`**。

结果：勾了不选不生效，全不选也不影响任何操作。用户分组（`group_id`）同理，只在列表里显示，不参与任何判断。

---

### 11. 报告生成的 `format` 参数是死的
`server.js:781` 接收 `format` 但**从未使用**，永远返回 HTML（`mimeType = 'text/html'`）。前端"下载报告"下的也是 `.html` 文件。另 `generateExpertReport:839` 里专家 ID 列硬编码成 `<td>-</td>`。

---

### 12. 项目无法删除，也无法编辑
**[实测]** `DELETE /api/projects/1` → `Cannot DELETE /api/projects/1`（404）。
整个后端**没有项目的删除和编辑接口**。录错了只能去服务器上手工改 `store.json`。

---

### 13. Excel 导入失败也提示"导入成功"
`index.html:1208`

```js
.then(data => { statusEl.innerHTML = '<div class="alert alert-success">导入成功！</div>'; ... })
```

完全不检查 `data.error`。后端解析失败返回 500 + 错误信息时，用户看到的是绿油油的"导入成功"。

---

### 14. 重复提交评估，前端照样提示成功
`server.js:562` 对重复提交返回 400「您已经提交过该项评估」，但 `index.html:894` 的提交循环不检查响应状态码，完了一律 `alert('评估提交成功！')`。

另外 `index.html:844` 有个逻辑错误：`expDays.indexOf(currentUser.id)` —— `expDays` 是**人天数值数组**（如 `[3, 5]`），不是专家 ID 数组，这个判断恒为 `-1`，等于没写。

---

### 15. 成本结构接口是死代码
`/api/stats/cost-structure` 后端实现完好（[实测] 正常返回 7 类成本），但**前端从未调用**。README 里宣称的"成本结构柱状图"在界面上找不到。

---

## 三、P1 — 接入正式服务器 / 正式数据库的硬阻塞

### 16. `server.js` 里一行数据库代码都没有
`db.sql`（207 行）、`migrate.js`（288 行）、`PRODUCTION_DEPLOY.md`（15KB）都写了，但 `server.js` **完全没有 MySQL 依赖**，`package.json` 里也没有 `mysql2`。迁移脚本最后自己都承认：

> `console.log('1. 修改 server.js 使用数据库连接');`

也就是说 **"支持 MySQL"目前只是文档，不是能力**。

---

### 17. `migrate.js` 直接跑不起来
它 `require('dotenv')` 和 `require('mysql2/promise')`，但 `backend/package.json` 两个都没装。运行即 `Cannot find module`。

---

### 18. `migrate.js` 的文件迁移是 0 条
`migrate.js:251` 读的是 `store.projectFiles`，而 `server.js` 里实际字段名是 **`files`**（`defaultStore()` 第 41 行）。

```js
if (store.projectFiles && store.projectFiles.length > 0) {   // 恒为 undefined
```

文件记录一条都迁不过去，而且**不报错**（条件直接跳过）。

---

### 19. `db.sql` 和代码的数据模型已经严重对不上

| 代码里的实体 | db.sql 有没有表 |
|---|---|
| `expertEstimates`（专家评估） | ❌ **没有** |
| `confirmations`（确认/驳回） | ❌ **没有** |
| `userGroups`（用户分组） | ❌ **没有** |
| `userPermissions`（权限配置） | ❌ **没有** |
| `projects.creator_id` | ❌ **字段都没有** |

反过来，`db.sql` 里有 `expert_scores`（打分）、`review_comments`（批注）两张表，**代码里完全没实现** —— 这是 DEMO.md 里吹的"专家评审打分""批注管理"，v3 已经砍掉了，文档没同步。

**结论：照现在的 db.sql 迁，评估数据会全丢。**

---

### 20. 迁移后没人能登录
`db.sql:190` 初始化用户的密码是网传的 bcrypt 示例 hash（`$2a$10$N9qo8uLOickgx2ZMRZoMye...`，对应明文 `password`），但 `server.js:199` 是**明文比对**。迁完数据库，所有账号都登不进去。

---

### 21. 环境变量配了不生效
`render.yaml` 配了 `JWT_SECRET`，`.env.example` 配了 `JWT_SECRET`、`FRONTEND_URL`、`DB_*`、`MAX_FILE_SIZE`……但 `server.js` 只读了 `process.env.PORT`，其他**一个都没读**。CORS 也是裸 `app.use(cors())` 全开（`:72`），没按 `FRONTEND_URL` 限制来源。

---

### 22. Docker 起不来
- `docker-compose.yml:6` 的 `web` 服务 `build: ./frontend` —— **frontend 目录没有 Dockerfile**。
- `api` 服务映射 `3001:3001`，但 `server.js` 默认监听 `3000`（且 compose 没传 `PORT`）→ 端口对不上。
- Redis 起了但代码没用；phpMyAdmin 暴露 8080。
- 默认密码 `RootPass123!` / `ReviewPass123!` 硬编码在公开仓库。

---

### 23. 没有健康检查端点
`/api/health` → 404；`/health` → 返回前端 index.html。容器编排、负载均衡、监控都没法接。

---

### 24. `xlsx@0.18.5` 有已知安全漏洞
SheetJS 0.18.5 存在原型污染（CVE-2023-30533）和 ReDoS，且官方已不在 npm 发布，需从 `https://cdn.sheetjs.com/xlsx-0.20.x/xlsx-0.20.x.tgz` 安装。这是**处理用户上传 Excel 的组件**，风险敞口直接对着外部输入。

---

## 四、P2 — 代码质量与稳定性

| # | 位置 | 问题 |
|---|---|---|
| 25 | `server.js:694-710` | `deptMap[dept]` 初始化时漏了 `est_count`，后面 `est_count++` → `undefined++` = **NaN**。[实测] 线上返回 `"est_count": null` |
| 26 | `server.js:709-710` | `completeness` 在对象字面量里**定义了两次**，后者静默覆盖前者，第一个计算是死代码 |
| 27 | `server.js:874` | `parseFloat(a)+parseFloat(b)+parseFloat(c) \|\| 0` 优先级错误，任一字段缺失 → 整个差旅费静默算 0 |
| 28 | `server.js:654` | `w.cost / w.person_days` 未防 `person_days=0` → Infinity → NaN |
| 29 | `server.js:660` | `estimate_stats.total_experts` 统计的是"有评估的工作项数"，不是专家人数，字段名误导 |
| 30 | `server.js:405` | Excel 导入后的临时文件**从未删除**，`uploads/` 会持续堆积 |
| 31 | `server.js:184-189` | multer `fileFilter` 用 `cb(new Error(...))` 拒绝，没有错误处理中间件 → 返回 500 HTML 而非 JSON |
| 32 | `index.html:474-487` | `loadFiles()` 是 **N+1 请求**（每个项目各发一次详情请求），项目一多首屏就卡死 |
| 33 | `index.html` 全文 | 大量 `innerHTML` 直接拼接 `project_name` / `real_name` / `originalname` 等用户输入 → **存储型 XSS** |
| 34 | `index.html:512` | token 存 `localStorage`，配合上一条 XSS 可被直接窃取 |
| 35 | `server.js` 全文 | 无 `helmet`、无限流（登录可暴力破解）、无请求日志、列表接口无分页 |
| 36 | `gen-seed.js` | 硬编码 Windows 绝对路径 `C:/Users/12129/...`，换台机器直接报错，是开发机残留 |
| 37 | `parse-excel.js` | 完全依赖固定行列号（如 `r=1..15`、`c=0..3`），模板一改就**静默产出空数据**，只在 `warnings` 里记一笔，不报错 |
| 38 | `.github/workflows/deploy.yml` | 只部署 `./frontend`，根目录 `index.html` 跳转页没上传 → 访问 `/jingjipingshen/` 会 404 |
| 39 | `server.js:1019` | `estimate_stats` 之外，`POST /api/estimates` 不校验专家是否被分配到该项目，[实测] 专家可对任意项目提交；`days` 也不校验范围，[实测] `-99999` 被接受并入库 |

---

## 五、建议的修复顺序

**第一批（止血，1-2 天）**
1. JWT 密钥改环境变量 + 加 `exp` + 轮换一次
2. 密码改 bcrypt
3. `filterByDept` 修好 + 统一 `business_dept` 字段并回填存量
4. 去掉 `...req.body` 的 spread，改字段白名单
5. 批次下载改走 header 传 token（或后端支持 query）
6. `/uploads` 加鉴权

**第二批（功能补全，3-5 天）**
7. 修 `workflow` 路由参数、月度趋势字段、est_count NaN
8. 导入/评估的失败提示接上后端错误
9. 权限配置要么真正接入鉴权，要么从界面上撤掉
10. 补项目编辑/删除接口

**第三批（上正式环境，1-2 周）**
11. 选数据库方案（MySQL / PostgreSQL），按**代码里的实际实体**重做表结构（补 `expert_estimates`、`confirmations`、`user_groups`、`user_permissions`、`projects.creator_id`）
12. 引入 ORM（Prisma / Sequelize）+ 迁移工具，替换 JSON 存储
13. 上传文件改对象存储（COS/OSS/S3），别放本地磁盘
14. 补健康检查 `/api/health`、日志、监控、备份
15. 升 `xlsx` 到 0.20+、加 `helmet` + 限流 + CORS 白名单
16. 修 Docker（补 frontend Dockerfile、对齐端口、去掉默认密码）

---

*本报告基于 2026-09-06 的 `c825a8c` 版本。所有 [实测] 结论均可通过文中步骤复现。*
