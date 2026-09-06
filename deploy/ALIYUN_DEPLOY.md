# 阿里云部署指南（MySQL 落库，单端口同源）

目标：把经济评审管理平台部署到 `http://<公网IP>:3000`，所有数据（项目、成本、专家评估、文件元数据、用户、权限）**真正落入 MySQL**，重启不丢。

## 架构

```
浏览器 ── http://<IP>:3000/  ──┐
                               ├─ 后端 Node(Express)  :3000
浏览器 ── http://<IP>:3000/api ─┘      ├─ 静态托管 frontend/index.html（同源，免 CORS）
                                       └─ MySQL（DB_DRIVER=mysql，启动时自动建表）
```

- 前后端同端口同源，前端 API 基地址自动取 `window.location.origin + '/api'`（GitHub Pages 仍走 Render，互不影响）。
- 数据层默认 `json`（文件）或 `memory`（测试）；生产用 `mysql`，落库真正持久化。

## 前置条件（在服务器上）

1. Ubuntu / CentOS / Debian，已装 **MySQL / MariaDB**（本脚本假定已存在；若未装见下方「附：装 MySQL」）。
2. 开放安全组：**3000 端口入方向 TCP**（阿里云控制台 → 安全组）。
3. 知悉以下之一：
   - MySQL root 密码（脚本帮你建库建用户）；或
   - 已存在的业务库账号（DB_USER / DB_PASSWORD / DB_NAME）。

## 一键部署

把 `deploy/setup-aliyun.sh` 拷到服务器（或从仓库取），以 root 执行：

```bash
# 情况 A：用 root 自动建库建用户
export MYSQL_ROOT_PASSWORD='你的root密码'
export DB_NAME=economic_review DB_USER=review_app DB_PASSWORD='你的库密码'
bash setup-aliyun.sh

# 情况 B：库和账号已存在，直接复用
export DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=review_app DB_PASSWORD='你的库密码' DB_NAME=economic_review
bash setup-aliyun.sh
```

脚本会：装 Node20 + pm2 → 拉取 GitHub 仓库 → 装依赖 → 建库(可选) → 生成 `backend/.env`（权限 600，随机 JWT 密钥）→ pm2 启动并设开机自启 → 放行防火墙。

## 验证

```bash
# 健康检查
curl http://127.0.0.1:3000/api/health

# 登录拿 token
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).token))')

# 创建项目（应落入 MySQL）
curl -s -X POST "http://127.0.0.1:3000/api/projects?token=$TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"project_name":"上线验证项目","biz_department":"电网事业部","contract_amount":1000000,"session_id":1,"status":"draft"}'

# 重启进程后数据仍在：
pm2 restart jingjipingshen
curl "http://127.0.0.1:3000/api/projects?token=$TOKEN"   # 应能看到上面创建的项目
```

## 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 管理员 |
| biz_gdw | 123456 | 电网事业部经办人 |
| biz_xt | 123456 | 系统集成事业部经办人 |
| rd_staff | 123456 | 研发中心 |
| expert01 | 123456 | 评审专家 |
| cpa01 | 123456 | 会计师事务所专家 |

> 上线后请立即在「系统管理 → 用户」中修改默认密码，或删掉不用的演示账号。

## 日常运维

```bash
pm2 status / pm2 logs jingjipingshen / pm2 restart jingjipingshen
# 升级：cd /opt/jingjipingshen && git pull && cd backend && npm install --omit=dev && pm2 restart jingjipingshen
```

## 附：服务器还没装 MySQL 时

```bash
# Ubuntu
apt-get update && apt-get install -y mysql-server
systemctl enable --now mysql
mysql_secure_installation   # 设置 root 密码
# 然后回到上面的「情况 A」
```

## 回退到文件存储（不推荐生产）

`backend/.env` 中 `DB_DRIVER=json` 即可切回文件存储（注意 Render/临时文件系统下重启可能丢数据）。
