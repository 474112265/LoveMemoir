#!/bin/bash

set -e
APP_DIR="/www/wwwroot/106.52.180.78_520"
APP_NAME="love-diary"
PORT=520

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err()   { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  恋爱记事簿 - 502修复 & 一键部署脚本${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

log_info "检查 PM2 是否安装..."
if ! command -v pm2 &>/dev/null; then
  log_warn "PM2 未正在安装，尝试全局安装..."
  npm install -g pm2 || { log_err "PM2 安装失败"; exit 1; }
fi
log_ok "PM2 已就绪: $(pm2 --version)"

log_info "创建日志目录..."
mkdir -p "$APP_DIR/logs"

log_info "检查端口 $PORT 占用情况..."
if lsof -i :$PORT >/dev/null 2>&1; then
  log_warn "端口 $PORT 被占用，准备释放..."
  fuser -k $PORT/tcp 2>/dev/null || true
  sleep 1
fi
log_ok "端口 $PORT 已释放"

log_info "重新安装依赖（解决 better-sqlite3 编译问题）..."
cd "$APP_DIR"
npm install --build-from-source 2>&1 | tail -5
log_ok "依赖安装完成"

log_info "修复 Nginx 配置（添加超时 + 健康检查）..."
NGINX_CONF=""
for candidate in \
  "/www/server/panel/vhost/nginx/$(basename $APP_DIR).conf" \
  "/www/server/panel/vhost/nginx/106.52.180.78_520.conf" \
  "$(ls /www/server/panel/vhost/nginx/*.conf 2>/dev/null | head -1)" \
  "/etc/nginx/sites-enabled/default"; do
  if [ -f "$candidate" ]; then
    NGINX_CONF="$candidate"
    break
  fi
done

if [ -z "$NGINX_CONF" ]; then
  log_err "未找到 Nginx 配置文件！"
  log_info "请手动确认 Nginx 配置路径后重试"
else
  log_ok "找到 Nginx 配置: $NGINX_CONF"

  BACKUP="${NGINX_CONF}.bak.$(date +%Y%m%d%H%M%S)"
  cp "$NGINX_CONF" "$BACKUP"
  log_info "已备份原配置到: $BACKUP"

  python3 << 'PYEOF'
import sys, re, os

conf_path = os.environ.get("NGINX_CONF", "")
port = os.environ.get("PORT", "520")

with open(conf_path, 'r') as f:
    content = f.read()

proxy_block = """    proxy_pass http://127.0.0.1:{port};
    
    # ===== 502 防护配置 =====
    proxy_connect_timeout 5s;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
    proxy_buffering on;
    proxy_buffer_size 4k;
    proxy_buffers 8 4k;
    proxy_busy_buffers_size 8k;

    # 上游失败自动重试
    proxy_next_upstream error timeout http_502 http_503 http_504;
    proxy_next_upstream_tries 3;
    proxy_next_upstream_timeout 10s;

    # WebSocket 支持（长轮询需要）
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection \"upgrade\";

    # 头部转发
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
""".format(port=port)

pattern = r'(\s*proxy_pass\s+http://[^;]+;)'
replacement = proxy_block

new_content = re.sub(pattern, replacement, content)

if new_content != content:
    with open(conf_path, 'w') as f:
        f.write(new_content)
    print(f"[OK] Nginx 配置已更新")
else:
    print("[WARN] 未找到 proxy_pass 行，请手动检查配置")
PYEOF

  log_info "测试 Nginx 配置语法..."
  nginx -t 2>&1 && log_ok "Nginx 配置语法正确" || { log_err "Nginx 配置有误，已恢复备份"; cp "$BACKUP" "$NGINX_CONF"; exit 1; }

  log_info "重载 Nginx..."
  systemctl reload nginx 2>/dev/null || nginx -s reload 2>/dev/null || service nginx reload 2>/dev/null
  log_ok "Nginx 已重载"
fi

log_info "使用 PM2 graceful reload 启动服务..."
cd "$APP_DIR"

if pm2 list | grep -q "$APP_NAME"; then
  log_info "检测到已有进程，执行优雅重启..."
  pm2 reload "$APP_NAME" --update-env 2>&1 || {
    log_warn "reload 失败，尝试 delete 后 restart..."
    pm2 delete "$APP_NAME" 2>/dev/null || true
    sleep 1
    pm2 start ecosystem.config.cjs 2>&1
  }
else
  log_info "首次启动..."
  pm2 start ecosystem.config.cjs 2>&1
fi

sleep 2

log_info "保存 PM2 进程列表（开机自启）..."
pm2 save 2>&1 | tail -1

log_info "验证服务状态..."
pm2 status "$APP_NAME" 2>&1 | grep -E "status|uptime|restart|cpu|mem"

sleep 2

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$PORT/ 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
  log_ok "✅ 服务运行正常! HTTP $HTTP_CODE"
elif [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "301" ]; then
  log_ok "✅ 服务运行正常! HTTP $HTTP_CODE (重定向)"
else
  log_warn "⚠️ HTTP 状态码: $HTTP_CODE (可能还在启动中...)"
  log_info "查看日志: pm2 logs $APP_NAME --lines 20"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  ${BLUE}常用命令:${NC}"
echo -e "  ${YELLOW}pm2 logs $APP_NAME${NC}        查看实时日志"
echo -e "  ${YELLOW}pm2 reload $APP_NAME${NC}       优雅重启(不502)"
echo -e "  ${YELLOW}pm2 restart $APP_NAME${NC}      强制重启(可能短暂502)"
echo -e "  ${YELLOW}pm2 monit${NC}                   监控面板"
echo -e "  ${YELLOW}pm2 status${NC}                  查看状态"
echo ""
echo -e "  ${BLUE}访问地址:${NC}  ${GREEN}http://106.52.180.78/${NC}"
echo ""
