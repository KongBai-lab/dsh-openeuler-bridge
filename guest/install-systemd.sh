#!/bin/sh
# 安装 openEuler 桥节点的 systemd 开机自启服务（在 guest 内以 root 执行）。
#
# 用法：
#   sudo sh install-systemd.sh
#   或： sudo DSHM_BRIDGE_DIR=/mnt/linux_share/dsh-openeuler-bridge/guest sh install-systemd.sh
#
# 可选环境变量：
#   DSHM_BRIDGE_DIR   节点文件所在目录（默认按本脚本位置推断）
#   DSHM_GUEST_USER   运行节点服务的用户（默认当前 sudo 用户）
#   DSHM_PYTHON       Python 解释器（默认 command -v python3）
#   DSHM_NODE_PORT    网关端口（默认 19222）
#
# 回滚：
#   systemctl disable --now dshm-openeuler-bridge.service
#   rm -f /etc/systemd/system/dshm-openeuler-bridge.service /usr/local/lib/dshm/node_run.py
set -eu

SRC=${DSHM_BRIDGE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
[ -f "$SRC/node_run.py" ] || { echo "找不到 $SRC/node_run.py" >&2; exit 1; }

GUEST_USER=${DSHM_GUEST_USER:-${SUDO_USER:-$(id -un)}}
GUEST_HOME=$(getent passwd "$GUEST_USER" 2>/dev/null | cut -d: -f6)
[ -n "$GUEST_HOME" ] || GUEST_HOME="/home/$GUEST_USER"
PY=${DSHM_PYTHON:-$(command -v python3 || echo /usr/bin/python3)}
PORT=${DSHM_NODE_PORT:-19222}
TOKEN_FILE="$GUEST_HOME/.dshm-openeuler-token"

install -d -m 755 /usr/local/lib/dshm
install -m 644 "$SRC/node_run.py" /usr/local/lib/dshm/node_run.py

# token：由网关首次启动生成（0600）。若共享目录里已有 bridge.token 且用户主目录没有，则复制一份。
# token 属敏感信息，不要提交到仓库。
if [ -f "$SRC/bridge.token" ] && [ ! -f "$TOKEN_FILE" ]; then
  install -m 600 -o "$GUEST_USER" -g "$GUEST_USER" "$SRC/bridge.token" "$TOKEN_FILE"
fi
[ -f "$TOKEN_FILE" ] || echo "WARN: 未找到 $TOKEN_FILE；请把网关生成的 token 放到该路径（chmod 600）" >&2

cat > /usr/local/lib/dshm/node-service.sh <<'EOF'
#!/bin/sh
LOCAL=/usr/local/lib/dshm/node_run.py
PORT=${DSHM_NODE_PORT:-19222}
TOKEN=${DSHM_NODE_TOKEN:-$HOME/.dshm-openeuler-token}
GW=${DSHM_GW:-$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')}
[ -n "$GW" ] || { echo "no default route; set DSHM_GW" >&2; exit 1; }
exec "${DSHM_PYTHON:-python3}" "$LOCAL" --host "$GW" --port "$PORT" \
    --token-file "$TOKEN" --name "${DSHM_NODE_NAME:-openeuler-guest}"
EOF
chmod 755 /usr/local/lib/dshm/node-service.sh

cat > /etc/systemd/system/dshm-openeuler-bridge.service <<EOF
[Unit]
Description=openEuler bridge node (dsh-openeuler-bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$GUEST_USER
Environment=HOME=$GUEST_HOME
Environment=DSHM_PYTHON=$PY
Environment=DSHM_NODE_PORT=$PORT
Environment=DSHM_NODE_TOKEN=$TOKEN_FILE
ExecStart=/bin/sh /usr/local/lib/dshm/node-service.sh
Restart=always
RestartSec=5
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
pkill -f "[n]ode_run.py" || true
sleep 1
systemctl enable --now dshm-openeuler-bridge.service
sleep 2
systemctl status dshm-openeuler-bridge --no-pager | head -12
echo "--- 回滚：systemctl disable --now dshm-openeuler-bridge.service ---"
