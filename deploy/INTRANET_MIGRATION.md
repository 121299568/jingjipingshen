# 经济评审管理平台 · 内网（无互联网出口）迁移方案

> 目标：把现有系统完整搬到贵单位**内网服务器**（无互联网出口、仅内网可访问），
> 做到**断网也能完整运行**。本文给出阻塞点分析、一键部署脚本用法、数据迁移、网络隔离与安全、回滚方法。

---

## 一、离线能不能跑？——阻塞点分析

原系统在生产（阿里云）运行良好，但有几处**强依赖互联网**，内网断网会直接白屏/功能失效：

| 阻塞点 | 原实现 | 内网后果 | 本方案解决 |
|---|---|---|---|
| **前端 CDN** | `index.html` 引了 jsDelivr 的 Bootstrap / Bootstrap Icons / Chart.js | 断网后样式与图表全崩、页面白屏 | ✅ 已把 4 个资源**下载到 `frontend/vendor/`**，并改为本地 `/vendor/...` 引用 |
| **Node 依赖** | `npm install` 需访问 npm 源 | 断网无法安装依赖 | ✅ 已打包 `backend/deps/node_modules.tar.gz`，脚本自动解压，**无需 npm** |
| **数据库** | 生产用 MySQL | 内网若无 MySQL 则起不来 | ✅ 系统**默认 `json` 文件驱动**（零外部数据库），一条命令即可跑；MySQL 改为可选项 |
| **JWT 密钥** | 无（每次随机） | 重启登录态全失效 | ✅ 脚本生成 `.env` 写入随机 `JWT_SECRET`，稳定且各实例独立 |
| **字体/其他外链** | 仅系统字体，无 Google Fonts | 无影响 | ✅ 已复核，除上面 4 个 CDN 外无其它外链 |

**结论**：改造后整个仓库自包含，拷到内网服务器即可离线运行。

---

## 二、环境准备（内网服务器）

1. **操作系统**：Linux（CentOS 7+/Rocky/Ubuntu 20.04+ 均可）。Windows Server 亦可但需自行改启动方式。
2. **Node.js ≥ 18**：内网无法 `apt/yum install`，请**提前在有网的机器下载 Node 二进制**（官网 `node-vXX-linux-x64.tar.xz`），拷到内网后解压并把 `bin/node` 放入 `PATH`，或部署前 `export NODE_BIN=/path/to/node`。
   - 验证：`node -v` 应显示 v18+。
3. **（可选）MySQL**：若希望用 MySQL 而非默认 json 驱动，需内网已有 MySQL 8（同样需离线预装/由单位提供），并创建库与用户。详见第七节。
4. **拷贝项目**：把整个 `经济评审管理平台` 项目目录（含 `frontend/`、`backend/`、`deploy/`）通过 U 盘 / 内网文件服务 / 安全摆渡拷到内网服务器，例如 `/opt/economic-review/`。

> ⚠️ 务必连 `backend/deps/node_modules.tar.gz` 和 `frontend/vendor/` 一起拷过去，它们是离线运行的关键。

---

## 三、一键部署（推荐）

以 root（想开机自启）或普通用户（nohup 方式）执行：

```bash
cd /opt/economic-review/deploy
chmod +x setup-intranet.sh
./setup-intranet.sh            # = install：解压依赖 + 生成 .env + 启动
```

脚本会自动完成：
1. 检查 Node 版本（≥18）；
2. 解压 `node_modules.tar.gz` 到 `backend/node_modules`（已存在则跳过）；
3. 建 `data/`、`uploads/`、`logs/` 目录；
4. 生成 `backend/.env`（随机 `JWT_SECRET`、`DB_DRIVER=json`、端口 3000）；
5. **若有 systemd 且用 root 运行** → 注册开机自启服务并启动；
   **否则** → 用 `nohup` 后台启动并记录 PID；
6. 做健康检查，打印**内网访问地址**（如 `http://10.1.2.3:3000`）。

常用子命令：

```bash
./setup-intranet.sh start      # 启动
./setup-intranet.sh stop       # 停止
./setup-intranet.sh restart    # 重启
./setup-intranet.sh status     # 查看运行状态 + 健康检查
```

首次访问用默认账号登录：**admin / admin123**。请登录后立即修改密码，并把 `.env` 中
`SEED_DEFAULT_USERS=true` 改为 `false` 后重启（`SEED_DEFAULT_USERS=false ./setup-intranet.sh restart`）。

---

## 四、网络隔离：只允许单位内网访问

系统本身监听 `0.0.0.0:3000`。要做到“仅内网可访问”，在**网络层**收口（应用层不负责这个）：

- **防火墙/安全组**：仅放行单位内网网段（如 `10.0.0.0/8`、`192.168.0.0/16`、`172.16.0.0/12`）到 `3000` 端口的 **入站** TCP；默认拒绝其余来源。
- 服务器**不配置公网 IP / 不出互联网**即可天然隔离。
- 若内网有反向代理（Nginx），可再加一层，但非必须。

示例（firewalld）：
```bash
firewall-cmd --permanent --add-port=3000/tcp
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.0.0.0/8 port port=3000 protocol=tcp accept'
firewall-cmd --reload
```
示例（iptables，仅允许内网）：
```bash
iptables -A INPUT -p tcp --dport 3000 -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -s 192.168.0.0/16 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

---

## 五、数据迁移：把现有数据搬过来

> 由于内网无互联网出口，**不能**让内网服务器直接连阿里云拉数据。请在“还能联网”的环境先把数据导出，再拷进内网。

### 方案 A（推荐、最稳）：重新导入汇总表
现有系统的“评审汇总表 Excel 导入”功能已支持**按表创建批次 + 自动建项目条目**。
在内网实例上：评审批次页 → 「Excel导入（评审汇总表）」→ 选你之前的汇总表 → 创建新批次即可重建全部项目。
用户账号在内网实例首次启动时由 `SEED_DEFAULT_USERS` 自动建好，再按需增删人员即可。

### 方案 B（可选、保留全部历史）：MySQL → JSON 导出后再导入
若想连历史评估、文件记录一起迁，可先在**能联网侧**把阿里云 MySQL 导出为 `data/store.json`：
1. 在有网机器上配置 `.env`（指向阿里云 MySQL），运行仓库内置 `migrate.js` 的反向导出脚本
   （或临时把驱动切到 mysql 后用 `node -e` 读取 `db.store` 写入 `store.json`）；
2. 把 `store.json` 拷到内网 `backend/data/store.json`；
3. 内网实例保持 `DB_DRIVER=json`，启动即加载该数据。

> 注意：json 驱动与 mysql 驱动的数据结构一致（都是统一的 `store` 对象），迁移无损耗；
> 但 json 驱动为单文件，不适合超高并发写入，内网几十人小范围评审完全够用。

---

## 六、安全与运维要点

- **JWT 密钥**：每台内网实例用脚本生成的随机 `JWT_SECRET`，与公网实例不同，互不可伪造。
- **默认口令**：`admin/admin123` 仅为首次便捷，**务必改密**并关闭 `SEED_DEFAULT_USERS`。
- **数据备份**：json 驱动下，定期备份 `backend/data/store.json` 与 `backend/uploads/`（上传的 Excel/附件）即可。
- **日志**：nohup 模式在 `backend/logs/app.log`；systemd 模式用 `journalctl -u economic-review`。
- **升级**：后续更新只需把新代码（含 `frontend/index.html`、`backend/server.js` 等）覆盖后 `./setup-intranet.sh restart`。`node_modules.tar.gz` 仅在依赖变更时需重新打包。

---

## 七、进阶：改用 MySQL 驱动（可选）

如单位要求用 MySQL 统一存储：

1. 内网准备好 MySQL 8，建库建用户：
   ```sql
   CREATE DATABASE economic_review CHARACTER SET utf8mb4;
   CREATE USER 'review_app'@'%' IDENTIFIED BY '强密码';
   GRANT ALL ON economic_review.* TO 'review_app'@'%';
   ```
2. 部署前设置环境变量后运行脚本：
   ```bash
   export DB_DRIVER=mysql DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=review_app DB_NAME=economic_review DB_PASSWORD='强密码'
   ./setup-intranet.sh install
   ```
3. 脚本启动后，`ensureSchema` 会**自动建表**（无需手工迁移），旧表结构变更也会自动补列。
4. 若要从 json 切到 mysql：先把 `data/store.json` 用 `migrate.js` 导入 MySQL，再切 `DB_DRIVER=mysql` 重启。

---

## 八、回滚 / 卸载

- **停止服务**：`./setup-intranet.sh stop`（systemd 则 `systemctl stop economic-review`）。
- **彻底卸载**：停止服务 → 删除项目目录 `/opt/economic-review`；若注册过 systemd，`rm /etc/systemd/system/economic-review.service && systemctl daemon-reload`。
- **数据保留**：卸载前请备份 `backend/data/` 与 `backend/uploads/`。

---

## 九、故障排查

| 现象 | 排查 |
|---|---|
| 页面白屏 / 无样式 | 确认 `frontend/vendor/` 已随项目拷贝；访问 `http://IP:3000/vendor/bootstrap.min.css` 应返回 CSS |
| 启动报 `Cannot find module` | `backend/node_modules` 缺失，确认 `deps/node_modules.tar.gz` 已拷到内网并已解压 |
| 启动报 Node 版本过低 | `node -v` 须 ≥18，离线准备 Node 二进制并 `export NODE_BIN=...` |
| 健康检查 `/api/health` 非 200 | 看 `logs/app.log` / `journalctl`；多半是 `.env` 中 `JWT_SECRET` 未设（production 强制要求） |
| 内网其他机器访问不了 | 检查防火墙/安全组是否只放行了内网网段；确认服务器监听 `0.0.0.0:3000`（`ss -ltnp | grep 3000`） |

---

## 十、交付清单（随项目自带，无需联网）

```
经济评审管理平台/
├── frontend/
│   ├── index.html              # 已改为本地 /vendor 引用
│   └── vendor/                 # ✅ 离线资源（Bootstrap/Icons/Chart.js + 字体）
│       ├── bootstrap.min.css
│       ├── bootstrap.bundle.min.js
│       ├── chart.umd.js
│       ├── bootstrap-icons.css
│       └── fonts/bootstrap-icons.woff(.2)
├── backend/
│   ├── server.js / src/ ...
│   ├── deps/
│   │   └── node_modules.tar.gz # ✅ 离线依赖包（脚本自动解压）
│   └── data/ uploads/          # 运行时生成
└── deploy/
    ├── setup-intranet.sh       # ✅ 一键部署脚本（install/start/stop/restart/status）
    ├── .env.intranet           # 配置模板（参考）
    ├── economic-review.service # systemd 单元模板
    └── INTRANET_MIGRATION.md   # 本文档
```
