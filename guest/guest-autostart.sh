#!/bin/sh
# dsh-openeuler-bridge：guest 侧节点自启脚本（供 ~/.bashrc 调用）
#
# 作用：每次打开融合引擎终端时，若节点未运行则后台拉起；已运行则直接返回。
# 回滚：删掉 ~/.bashrc 里调用本脚本的那一行即可（本文件可保留）。
#
# 安装（在 guest 终端执行一次；B 改成共享目录下本仓库的 guest/ 路径）：
#   B=/mnt/linux_share/dsh-openeuler-bridge/guest
#   chmod +x "$B/guest-autostart.sh" "$B/node_run.py"
#   grep -q dshm-openeuler-bridge ~/.bashrc 2>/dev/null || \
#     echo "[ -f '$B/guest-autostart.sh' ] && sh '$B/guest-autostart.sh' 2>/dev/null" >> ~/.bashrc
#
# 可用环境变量：
#   DSHM_BRIDGE_DIR   本脚本与 node_run.py 所在目录（默认按脚本位置推断）
#   DSHM_GW           宿主网关地址（默认取 guest 默认路由的下一跳）
#   DSHM_NODE_TOKEN   token 文件路径（默认 ~/.dshm-openeuler-token，其次 $B/bridge.token）
#   DSHM_NODE_PORT    网关端口（默认 19222）
#   DSHM_NODE_NAME    guest 节点名（默认 openeuler-guest）

B=${DSHM_BRIDGE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
PORT=${DSHM_NODE_PORT:-19222}

[ -f "$B/node_run.py" ] || { echo "dsh-openeuler-bridge: 找不到 $B/node_run.py，跳过自启" >&2; exit 0; }

# 进程存在且确实连着网关才跳过；进程在但没有 ESTABLISHED = 卡死/重连中，杀掉重来
if pgrep -f "$B/node_run.py" >/dev/null 2>&1; then
    if ss -tn 2>/dev/null | grep ":$PORT" | grep -q "ESTAB"; then
        exit 0
    fi
    pkill -f "$B/node_run.py" 2>/dev/null
    sleep 1
fi

# 宿主地址 = guest 默认路由的下一跳（NAT 下通常是 172.16.x.1；IP 变化时自动适配）
GW=${DSHM_GW:-$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')}
[ -n "$GW" ] || { echo "dsh-openeuler-bridge: 读不到默认路由，请设置 DSHM_GW" >&2; exit 0; }

# token 优先用私有副本，读不到再退回共享目录
TOKEN=${DSHM_NODE_TOKEN:-$HOME/.dshm-openeuler-token}
[ -r "$TOKEN" ] || TOKEN="$B/bridge.token"

nohup python3 "$B/node_run.py" --host "$GW" --port "$PORT" --token-file "$TOKEN" \
    --name "${DSHM_NODE_NAME:-openeuler-guest}" >> "$HOME/.dshm-openeuler-node.log" 2>&1 &
echo "dsh-openeuler-bridge: node 已在后台启动（host=$GW，日志 ~/.dshm-openeuler-node.log）"
