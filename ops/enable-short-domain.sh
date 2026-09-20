#!/usr/bin/env bash
# ============================================================================
# 专家评估短链 —— 一键切到独立短域（默认 e.mjumju.com）
#
# 目标：专家拿到的链接不再出现主站域名 lnsoft.mjumju.com
#   切换前：https://lnsoft.mjumju.com/e/kf7mQ2
#   切换后：https://e.mjumju.com/kf7mQ2        （短域根路径，少 2 个字符）
#
# 前置（只有这一步需要人工）：在火山引擎 DNS 给短域加一条 A 记录指向本机
#   主机记录 e   类型 A   记录值 47.94.59.129
#
# 用法：bash enable-short-domain.sh [短域名]
# 幂等：可重复执行（重跑只会重新签发/重装证书）
# ============================================================================
set -euo pipefail

DOMAIN="${1:-e.mjumju.com}"
MAIN_DOMAIN="lnsoft.mjumju.com"   # 主站域名：后端拿它做「短域不得等于主站」的硬防护
HOSTPART="${DOMAIN%%.*}"
CONF_AVAIL="/etc/nginx/sites-available/mjumju-short.conf"
CONF_ENAB="/etc/nginx/sites-enabled/mjumju-short.conf"
ENVF="/opt/jingjipingshen/backend/.env"
ACME="/root/.acme.sh/acme.sh"

# 本机公网 IP（阿里云元数据，走内网很快）
SERVER_IP="$(curl -s -m 5 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || true)"
[ -n "$SERVER_IP" ] || SERVER_IP="$(curl -s -m 8 https://api.ipify.org 2>/dev/null || true)"
[ -n "$SERVER_IP" ] || SERVER_IP="47.94.59.129"

echo "== 短域接入：$DOMAIN （本机公网 IP $SERVER_IP）"

# ---------- 0) 备份在用的 nginx 配置（放 backups/，别放 sites-enabled/ 里，会被 include 造成重复 server 块）----------
mkdir -p /etc/nginx/backups
stamp="$(date +%Y%m%d-%H%M%S)"
for f in /etc/nginx/sites-available/mjumju-internal.conf /etc/nginx/sites-available/mjumju.conf; do
  [ -f "$f" ] && cp -a "$f" "/etc/nginx/backups/$(basename "$f").$stamp"
done
cp -a "$ENVF" "/root/env.bak-shortdomain-$stamp"

# ---------- 1) 解析校验：没解析就停下来，别把链接生成成打不开的域 ----------
resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"
if [ "$resolved" != "$SERVER_IP" ]; then
  echo "✗ $DOMAIN 当前解析为『${resolved:-空}』，与本机公网 IP 不一致。"
  echo "  请先在【火山引擎 → 云解析 DNS → mjumju.com】新增记录："
  echo "      主机记录：$HOSTPART"
  echo "      记录类型：A"
  echo "      记录值  ：$SERVER_IP"
  echo "  等 1~2 分钟生效后重新执行本脚本。"
  exit 1
fi
echo "√ 解析校验通过：$DOMAIN → $resolved"

# ---------- 2) 先只上 80 端口块：ACME HTTP-01 校验需要它先生效 ----------
cat > "$CONF_AVAIL" <<EOF
# 专家评估短链独立短域 · $DOMAIN
# 由 enable-short-domain.sh 生成（$stamp）
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; }
    location / { return 301 https://\$host\$request_uri; }
}
EOF
ln -sfn "$CONF_AVAIL" "$CONF_ENAB"
nginx -t && nginx -s reload
echo "√ 80 端口块已生效"

# ---------- 3) 签发并安装证书（Let's Encrypt，ECC，自动续期）----------
"$ACME" --issue -d "$DOMAIN" --webroot /var/www/html --keylength ec-256 --server letsencrypt
"$ACME" --install-cert -d "$DOMAIN" \
  --key-file       /etc/nginx/ssl/short.key \
  --fullchain-file /etc/nginx/ssl/short.fullchain.cer \
  --reloadcmd      "nginx -s reload"
echo "√ 证书已签发并安装"

# ---------- 4) 写入完整块：只放行短链必需路径，其余一律 404 ----------
# 关键：这个域是公网可匿名访问的，绝不能顺手把内部系统的 /api/、/uploads/、
#       前端页面暴露出来。只开 —— 落地页（/ 与 /<code> 与 /e/<code>）+ /api/e/ 接口。
cat > "$CONF_AVAIL" <<EOF
# 专家评估短链独立短域 · $DOMAIN
# 由 enable-short-domain.sh 生成（$stamp）
#
# 对外唯一形态：https://$DOMAIN/<6位短码>   （页面 + 接口都在这个短域下，全程不出现主站域名）
# 安全边界：只放行短链落地页与免登录评估接口 /api/e/，其它路径一律 404。
#           本域**不做 Basic Auth**（专家没有内部凭证），保护由「短码即凭据 + 30 天有效期 + 撤销 + 限流」承担。
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/nginx/ssl/short.fullchain.cer;
    ssl_certificate_key /etc/nginx/ssl/short.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 8m;
    server_tokens off;
    access_log /var/log/nginx/short.access.log;
    add_header X-Robots-Tag "noindex, nofollow" always;

    # ① 免登录评估接口（只放 /api/e/，其余 /api/ 404）
    location /api/e/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }

    # ② 落地页：根路径（不带码，页面自会提示缺令牌）与老式 /e/<code>
    location = / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
    location /e/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }

    # ③ 根路径短码 /<code>
    location ~ "^/[A-Za-z0-9_-]{4,80}\$" {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }

    # ④ 其余一律拒绝
    location / { return 404; }
}
EOF
nginx -t && nginx -s reload
echo "√ 短域已上线：https://$DOMAIN/<短码>"

# ---------- 5) 后端切基地址（短码改挂根路径）----------
if grep -q '^EXPERT_SHORT_BASE=' "$ENVF"; then
  sed -i "s|^EXPERT_SHORT_BASE=.*|EXPERT_SHORT_BASE=https://$DOMAIN|" "$ENVF"
else
  echo "EXPERT_SHORT_BASE=https://$DOMAIN" >> "$ENVF"
fi
# ⚠️ EXPERT_SHORT_ROOT 必须写「短域域名」而不是 1：
#    server.js 会校验它 ≠ 主站域名才允许根路径接管，写成 1 时取 EXPERT_SHORT_BASE 的 host（等价但不直观）。
if grep -q '^EXPERT_SHORT_ROOT=' "$ENVF"; then
  sed -i "s|^EXPERT_SHORT_ROOT=.*|EXPERT_SHORT_ROOT=$DOMAIN|" "$ENVF"
else
  echo "EXPERT_SHORT_ROOT=$DOMAIN" >> "$ENVF"
fi
# 主站域名显式声明：让后端能做「短域 ≠ 主站」的拦截（同时让长链基地址不再依赖请求头）
if ! grep -q '^PUBLIC_BASE_URL=' "$ENVF"; then
  echo "PUBLIC_BASE_URL=https://$MAIN_DOMAIN" >> "$ENVF"
fi
pm2 restart jingjipingshen --update-env >/dev/null 2>&1
sleep 3
echo "√ 后端已切短域（EXPERT_SHORT_BASE + EXPERT_SHORT_ROOT=$DOMAIN）"
grep -E '^EXPERT_SHORT|^PUBLIC_BASE_URL' "$ENVF" | sed 's/^/    /'

# ---------- 6) 上线自检 ----------
echo "== 自检"
printf '  短域首页      %s (期望 200)\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/")"
printf '  短域 /api 白名单外 %s (期望 404)\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/sessions")"
printf '  主站仍受保护  %s (期望 401)\n' "$(curl -s -o /dev/null -w '%{http_code}' 'https://lnsoft.mjumju.com/')"
printf '  主站短链兼容  %s (期望 200)\n' "$(curl -s -o /dev/null -w '%{http_code}' 'https://lnsoft.mjumju.com/e/zzzznotexist')"
echo "== 完成。回主站专家邀请弹窗重新生成/复制，拿到的就是 https://$DOMAIN/<短码>"
