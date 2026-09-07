#!/usr/bin/env bash
#
# 经济评审管理平台 · 内网一键部署脚本（无互联网环境专用）
# ------------------------------------------------------------------
# 适用场景：目标服务器“无互联网出口”，仅允许单位内网访问。
# 设计原则：
#   1) 前端 CDN 资源已本地化到 frontend/vendor（无需联网）。
#   2) Node 依赖已打包到 backend/deps/node_modules.tar.gz（无需 npm install）。
#   3) 默认使用 json 文件驱动（DB_DRIVER=json），零外部数据库依赖，
#      一条命令即可跑起来；如需 MySQL 见脚本下方“MySQL 模式”说明。
#
# 用法：
#   ./setup-intranet.sh            # 首次安装并启动（默认动作 = install）
#   ./setup-intranet.sh install    # 同上
#   ./setup-intranet.sh start      # 仅启动
#   ./setup-intranet.sh stop       # 停止
#   ./setup-intranet.sh restart    # 重启
#   ./setup-intranet.sh status     # 查看运行状态
#
# 可用环境变量覆盖（部署前 export 即可）：
#   APP_PORT=8080  DB_DRIVER=mysql  DB_HOST=127.0.0.1  DB_PORT=3306
#   DB_USER=review_app  DB_NAME=economic_review  DB_PASSWORD=****  BIND_HOST=0.0.0.0
#
set -euo pipefail

# ============================ 路径 ============================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
DATA_DIR="$BACKEND/data"
UPLOAD_DIR="$BACKEND/uploads"
LOG_DIR="$BACKEND/logs"
PID_FILE="$BACKEND/.intranet.pid"
ENV_FILE="$BACKEND/.env"
DEPS_TAR="$BACKEND/deps/node_modules.tar.gz"
SERVICE_NAME="economic-review"
SYSTEMD_UNIT="/etc/systemd/system/${SERVICE_NAME}.service"

# ============================ 可配置项 ============================
APP_PORT="${APP_PORT:-3000}"
DB_DRIVER="${DB_DRIVER:-json}"        # json(默认,零依赖) | mysql
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-review_app}"
DB_NAME="${DB_NAME:-economic_review}"
DB_PASSWORD="${DB_PASSWORD:-}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

# ============================ 颜色 ============================
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info(){ echo -e "${GREEN}[INFO]${NC} $*"; }
warn(){ echo -e "${YELLOW}[WARN]${NC} $*"; }
err(){  echo -e "${RED}[ERROR]${NC} $*"; }

# ============================ 工具函数 ============================
need_root_for_systemd(){
  if [ "$(id -u)" -ne 0 ]; then
    err "安装 systemd 开机自启服务需要 root 权限，请用 sudo 运行，或改用非 systemd 模式（直接 nohup 启动）。"
    exit 1
  fi
}

detect_systemd(){ [ -d /run/systemd/system ]; }

gen_secret(){
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48
  else
    "$NODE_BIN" -e 'console.log(require("crypto").randomBytes(48).toString("base64"))'
  fi
}

# 生成 backend/.env（仅在不存在时）
ensure_env(){
  if [ -f "$ENV_FILE" ]; then
    info ".env 已存在，保留现有配置（如需重置请手动删除 $ENV_FILE）。"
    return
  fi
  local secret; secret="$(gen_secret)"
  cat > "$ENV_FILE" <<EOF
# ===== 经济评审管理平台 · 内网部署配置（由 setup-intranet.sh 生成）=====
NODE_ENV=production

# 监听端口（内网访问地址：http://<本机内网IP>:${APP_PORT}）
PORT=${APP_PORT}

# 安全：每次部署随机生成，重启后旧登录态失效；如需固定可手动改为固定字符串
JWT_SECRET=${secret}
JWT_EXPIRES_IN=28800

# CORS：内网同源部署留空即可（只允许同源）
CORS_ORIGINS=

# 数据层驱动：json=文件驱动(零依赖,推荐内网) | mysql=需单独准备 MySQL
DB_DRIVER=${DB_DRIVER}
DB_HOST=${DB_HOST}
DB_PORT=${DB_PORT}
DB_USER=${DB_USER}
DB_NAME=${DB_NAME}
DB_PASSWORD=${DB_PASSWORD}

# 首次启动是否创建默认账号(admin/admin123)，建议首次启动后改密并设为 false
SEED_DEFAULT_USERS=true

# 上传/数据目录（相对 backend）
UPLOAD_DIR=${UPLOAD_DIR}
DATA_DIR=${DATA_DIR}

# 登录限流（按 IP）：15 分钟内最多 20 次
LOGIN_RATE_WINDOW_MS=900000
LOGIN_RATE_MAX=20
EOF
  info "已生成 $ENV_FILE（DB_DRIVER=${DB_DRIVER}）"
  if [ "$DB_DRIVER" = "mysql" ]; then
    warn "你选择了 mysql 驱动，请确认内网已存在可访问的 MySQL 实例，且 DB_PASSWORD 已设置；否则请改用 DB_DRIVER=json。"
  fi
}

extract_deps(){
  if [ -d "$BACKEND/node_modules" ] && [ -f "$BACKEND/node_modules/express/package.json" ]; then
    info "node_modules 已存在，跳过解压。"
    return
  fi
  if [ ! -f "$DEPS_TAR" ]; then
    err "离线依赖包缺失：$DEPS_TAR 。请在能联网的机器上重新打包后随项目一并拷贝到内网。"
    exit 1
  fi
  info "解压离线依赖包 node_modules.tar.gz ..."
  mkdir -p "$BACKEND"
  tar -xzf "$DEPS_TAR" -C "$BACKEND"
  info "依赖解压完成。"
}

ensure_dirs(){
  mkdir -p "$DATA_DIR" "$UPLOAD_DIR" "$LOG_DIR"
}

check_node(){
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    err "未找到 node（>=18）。内网无互联网无法自动安装，请提前将 Node.js 二进制放到 PATH，"
    err "或部署前 export NODE_BIN=/path/to/node 指向已准备好的 Node 可执行文件。"
    exit 1
  fi
  local ver; ver="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//;s/\..*//')"
  if [ "${ver:-0}" -lt 18 ]; then
    err "Node 版本过低（当前 $("$NODE_BIN" -v)），需 >= 18。请升级 Node 后重试。"
    exit 1
  fi
  info "Node 版本检查通过：$("$NODE_BIN" -v)"
}

# 写 systemd 单元并启用
install_systemd(){
  need_root_for_systemd
  info "检测到 systemd，注册开机自启服务 $SERVICE_NAME ..."
  cat > "$SYSTEMD_UNIT" <<EOF
[Unit]
Description=经济评审管理平台 (Economic Review)
After=network.target

[Service]
Type=simple
WorkingDirectory=${BACKEND}
ExecStart=${NODE_BIN} ${BACKEND}/server.js
Restart=on-failure
RestartSec=3
User=$(whoami)
Environment=NODE_ENV=production
# 如需指定 env 文件，可在此追加：EnvironmentFile=${ENV_FILE}

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  sleep 2
  systemctl is-active --quiet "$SERVICE_NAME" && info "systemd 服务已启动并设为开机自启。" || err "systemd 服务启动失败，查看：journalctl -u $SERVICE_NAME"
}

# 直接 nohup 启动（无 systemd 时）
start_nohup(){
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    warn "服务似乎已在运行（PID $(cat "$PID_FILE")）。如需重启请先 stop。"
    return
  fi
  nohup "$NODE_BIN" "$BACKEND/server.js" > "$LOG_DIR/app.log" 2>&1 &
  echo $! > "$PID_FILE"
  sleep 2
  if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    info "服务已启动（PID $(cat "$PID_FILE")），日志：$LOG_DIR/app.log"
  else
    err "启动失败，查看日志：$LOG_DIR/app.log"
    tail -n 20 "$LOG_DIR/app.log" 2>/dev/null
    exit 1
  fi
}

stop_nohup(){
  if [ -f "$PID_FILE" ]; then
    local pid; pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid"; info "已停止服务（PID $pid）。"; fi
    rm -f "$PID_FILE"
  else
    warn "未找到 PID 文件，可能未以 nohup 方式运行。"
  fi
}

do_start(){
  ensure_dirs
  if detect_systemd; then
    if [ "$(id -u)" -eq 0 ]; then
      systemctl restart "$SERVICE_NAME" 2>/dev/null && { info "systemd 服务已重启。"; return; }
    fi
  fi
  start_nohup
  health_check
}

do_stop(){
  if detect_systemd && [ "$(id -u)" -eq 0 ] && systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    systemctl stop "$SERVICE_NAME"; info "systemd 服务已停止。"
  else
    stop_nohup
  fi
}

do_status(){
  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "----------------------------------------------------"
  echo " 项目根目录 : $ROOT"
  echo " 监听端口   : $APP_PORT"
  echo " 数据驱动   : $DB_DRIVER"
  echo " 内网访问   : http://${ip:-<本机内网IP>}:$APP_PORT"
  echo "----------------------------------------------------"
  if detect_systemd && systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo -e "${GREEN}systemd 服务状态：运行中${NC}"
  elif [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo -e "${GREEN}nohup 进程状态：运行中（PID $(cat "$PID_FILE"))${NC}"
  else
    echo -e "${YELLOW}服务未运行${NC}"
  fi
  if command -v curl >/dev/null 2>&1; then
    local code; code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/api/health" || true)"
    [ "$code" = "200" ] && echo -e "${GREEN}/api/health 返回 200 ✅${NC}" || echo -e "${YELLOW}/api/health 返回 $code（服务可能尚未就绪）${NC}"
  fi
}

health_check(){
  if command -v curl >/dev/null 2>&1; then
    local i=0 code=""
    for i in 1 2 3 4 5; do
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/api/health" || true)"
      [ "$code" = "200" ] && break
      sleep 1
    done
    if [ "$code" = "200" ]; then
      local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
      info "健康检查通过 ✅  内网访问地址： http://${ip:-<本机内网IP>}:$APP_PORT"
    else
      warn "健康检查未通过（HTTP $code）。查看日志排查：$LOG_DIR/app.log 或 journalctl -u $SERVICE_NAME"
    fi
  fi
}

do_install(){
  echo "===================================================="
  echo "  经济评审管理平台 · 内网一键部署"
  echo "  驱动模式：$DB_DRIVER | 端口：$APP_PORT"
  echo "===================================================="
  check_node
  extract_deps
  ensure_dirs
  ensure_env
  if detect_systemd && [ "$(id -u)" -eq 0 ]; then
    install_systemd
    health_check
  else
    if detect_systemd && [ "$(id -u)" -ne 0 ]; then
      warn "检测到 systemd 但当前非 root，将使用 nohup 方式启动（重启后不会自启）。如需开机自启请用 sudo 运行本脚本。"
    fi
    do_start
  fi
  echo
  echo -e "${GREEN}部署完成。${NC}默认管理员账号： admin / admin123 （首次登录后请尽快修改密码，"
  echo "并将 .env 中 SEED_DEFAULT_USERS 改为 false 后重启）。"
  echo "记得在防火墙/安全组仅放行内网网段对 $APP_PORT 的访问。"
}

# ============================ 入口 ============================
ACTION="${1:-install}"
case "$ACTION" in
  install) do_install ;;
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status)  do_status ;;
  *)
    err "未知动作：$ACTION"
    echo "用法: $0 [install|start|stop|restart|status]"
    exit 1
    ;;
esac
