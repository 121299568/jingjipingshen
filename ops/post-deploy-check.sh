#!/bin/bash
# 修复后自检：主站 Host 下必须返回系统首页，短链必须仍是专家页
set -u
echo "== 0) 启动日志（短链模式自检）=="
tail -4 /root/.pm2/logs/jingjipingshen-out.log
echo
echo "== 1) 主站 Host 下的 / （期望 252913 / 系统首页）=="
curl -s -o /tmp/h1 -w 'code=%{http_code}  size=%{size_download}\n' -H 'Host: lnsoft.mjumju.com' http://127.0.0.1:3000/
grep -o '<title>[^<]*</title>' /tmp/h1 || echo '(无 title)'
echo
echo "== 2) 主站 Host 下未知单段路径（期望系统首页兜底，不是专家页）=="
curl -s -o /tmp/h2 -w 'code=%{http_code}  size=%{size_download}\n' -H 'Host: lnsoft.mjumju.com' http://127.0.0.1:3000/notarealcode
grep -o '<title>[^<]*</title>' /tmp/h2 || echo '(无 title)'
echo
echo "== 3) 短链落地页（期望 200 + 专家工作量评估）=="
curl -s -o /tmp/h3 -w 'code=%{http_code}  size=%{size_download}\n' -H 'Host: lnsoft.mjumju.com' http://127.0.0.1:3000/e/kf7mQ2
grep -o '<title>[^<]*</title>' /tmp/h3 || echo '(无 title)'
echo
echo "== 4) 无 Host（内网健康检查）=="
curl -s -o /dev/null -w 'code=%{http_code}  size=%{size_download}\n' http://127.0.0.1:3000/
echo
echo "== 5) 短链接口（无效码期望 410）=="
curl -s -o /dev/null -w 'code=%{http_code}\n' -H 'Host: lnsoft.mjumju.com' http://127.0.0.1:3000/api/e/kf7mQ2
echo
echo "== 6) 清除临时诊断账号 =="
if [ -f /root/htpasswd-internal.bak-diag ]; then
  cp -a /root/htpasswd-internal.bak-diag /etc/nginx/.htpasswd-internal
  grep -q '^diagtmp:' /etc/nginx/.htpasswd-internal && echo '⚠️ 仍存在' || echo '√ diagtmp 已移除'
fi
