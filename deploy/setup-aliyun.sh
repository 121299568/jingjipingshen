#!/usr/bin/env bash
#
# 经济评审管理平台 —— 阿里云一键部署脚本（CentOS/Ubuntu/Debian 通用）
#
# 用法（在服务器上以 root 执行，生产账号请用 DB_* 环境变量传入）：
#
#   export DB_HOST=127.0.0.1 DB_PORT=3306 \
#          DB_USER=review_app DB_PASSWORD='你的库密码' DB_NAME=economic_review
#   # 若 MySQL 已有对应库与账号，可不传 MYSQL_ROOT_PASSWORD；
#   # 否则传入 root 密码，脚本会帮你建库建用户：
#   export MYSQL_ROOT_PASSWORD='你的root密码'
#   bash setup-aliyun.sh
#
# 说明：
#   - 代码从 GitHub 公开仓库拉取（无需 token）：https://github.com/121299568/jingjipingshen
#   - 用 pm2 托管后端，保证进程常驻、崩溃自启、开机自启
#   - 后端在同一端口 :3000 既提供 API 又静态托管前端，单端口同源，免 CORS
#   - 数据层使用 MySQL（DB_DRIVER=mysql），服务端启动时自动建表（ensureSchema）

set -euo pipefail

APP_DIR=/opt/jingjipingshen
REPO=https://github.com/121299568/jingjipingshen.git
BRANCH=main
PORT=3000

echo "==> [1/7] 安装基础依赖（git / curl / Node 20）"
if ! command -v git >/dev/null 2>&1; then
  (command -v apt-get >/dev/null && apt-get update -y && apt-get install -y git curl) || \
  (command -v yum >/dev/null && yum install -y git curl)
fi

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  echo "    Node 缺失或过旧，安装 Node 20（NodeSource）..."
  curl -fsSL https://rpm.nodesource.com/setup_20.x -o /tmp/ns.sh 2>/dev/null && bash /tmp/ns.sh || \
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  (command -v apt-get >/dev/null && apt-get install -y nodejs) || (command -v yum >/dev/null && yum install -y nodejs)
fi
node -v; npm -v

echo "==> [2/7] 拉取代码"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull --ff-only
else
  git clone -b "$BRANCH" "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

echo "==> [3/7] 安装后端依赖"
cd "$APP_DIR/backend"
npm install --omit=dev
# 前端无需构建（单文件 index.html），直接由后端静态托管

echo "==> [4/7] 准备 MySQL 库与账号（如提供 MYSQL_ROOT_PASSWORD）"
if [ -n "${MYSQL_ROOT_PASSWORD:-}" ]; then
  DB_USER=${DB_USER:-review_app}
  DB_NAME=${DB_NAME:-economic_review}
  DB_PASSWORD=${DB_PASSWORD:-$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 20)}
  echo "    使用 root 创建库/用户：db=$DB_NAME user=$DB_USER"
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
  echo "    DB_PASSWORD=$DB_PASSWORD  （请记好，已写入 .env）"
else
  echo "    未提供 MYSQL_ROOT_PASSWORD，假定 DB_* 已存在，直接复用。"
  DB_PASSWORD=${DB_PASSWORD:-}
fi

echo "==> [5/7] 写入 .env（生产配置）"
JWT_SECRET=${JWT_SECRET:-$(openssl rand -base64 48 | tr -d '\n')}
cat > "$APP_DIR/backend/.env" <<ENV
NODE_ENV=production
PORT=$PORT
DB_DRIVER=mysql
DB_HOST=${DB_HOST:-127.0.0.1}
DB_PORT=${DB_PORT:-3306}
DB_USER=${DB_USER:-review_app}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME:-economic_review}
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=28800
BCRYPT_ROUNDS=12
CORS_ORIGINS=
MAX_FILE_SIZE_MB=50
SEED_DEFAULT_USERS=false
ENV
chmod 600 "$APP_DIR/backend/.env"
echo "    .env 已生成（权限 600）"

echo "==> [6/7] 安装并启动 pm2"
npm install -g pm2
cd "$APP_DIR/backend"
pm2 delete jingjipingshen 2>/dev/null || true
pm2 start server.js --name jingjipingshen --env production
pm2 save
pm2 startup 2>/dev/null | tail -3 || true

echo "==> [7/7] 开放防火墙端口 $PORT（若启用 ufw）"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow "$PORT"/tcp || true
fi
echo "    注意：阿里云安全组需在控制台手动放行 $PORT 入方向（TCP）。"

echo "==> 完成！健康检查："
sleep 2
curl -s --noproxy '*' http://127.0.0.1:$PORT/api/health || true
echo
echo "    前端访问： http://<服务器公网IP>:$PORT/"
