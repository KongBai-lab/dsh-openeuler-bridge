# dsh-openeuler-bridge

让 DSHM 在**融合开发引擎（openEuler Linux 子系统）**里执行命令的 DSHM 原生插件。

- **宿主侧**：DSHM 插件，内嵌 TCP 网关（`lib/bridge.js`），不依赖 Python 网关进程；
- **guest 侧**：`guest/node_run.py`，仅用 Python 标准库，主动连宿主、断线自动重连；
- 协议为 JSONL over TCP，宿主与 guest 只交换一行行 JSON。

## 架构

```text
┌──────────────────────── DSHM Host（鸿蒙侧） ────────────────────────┐
│  lib/index.js  ──启动──>  BridgeServer (lib/bridge.js)             │
│                              ▲            TCP 19222, JSONL        │
│  lib/tools.js  ──注册──> openeuler_* 工具  │                        │
└──────────────────────────────┼──────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  guest  node_run.py │  主动连宿主，断线重连
                    └──────────┬──────────┘
                               │ fork / PTY
                    ┌──────────▼──────────┐
                    │  shell、python、git…│
                    └─────────────────────┘
       文件交换走宿主与 guest 的共享目录（guest 内通常为 /mnt/linux_share）
```

**为什么让 guest 主动连宿主**：融合开发引擎默认 NAT 网络，guest 出站到宿主网关稳定，反向（宿主直连 guest）不可靠。

## 工具

| 工具 | 作用 |
|---|---|
| `openeuler_run(command, cwd?, timeoutMs?, maxBytes?)` | 执行一次性命令，返回 stdout / stderr / 退出码 / 超时 / 截断 |
| `openeuler_status()` | 网关端口、已连接节点（名称 / 对端 IP / 并发上限）、最近错误 |
| `openeuler_shell_open(shell?, cols?, rows?, cwd?)` | 打开 PTY 会话（bash / python3 / vim / top / ssh…），返回 `sessionId` |
| `openeuler_shell_write(sessionId, data)` | 发送输入；控制字符用转义（Ctrl-C `\u0003`、Ctrl-D `\u0004`、Esc `\u001b`） |
| `openeuler_shell_read(sessionId, maxBytes?)` | 增量读取输出（保留 ANSI 转义，附 `eof` / `pending`） |
| `openeuler_shell_close(sessionId)` | 关闭会话并回收进程，返回退出码 |
| `openeuler_bg_start(command, cwd?)` | 启动后台任务，立即返回 `bgId`，输出流式写日志 |
| `openeuler_bg_log(bgId, offset?, maxBytes?)` | 增量读输出（`nextOffset` 续读、`eof`、`exitCode`） |
| `openeuler_bg_status(bgId?)` | 列出任务：pid / 是否运行 / 退出码 / 日志路径 |
| `openeuler_bg_stop(bgId)` | 杀进程组并返回退出码 |

## 目录结构

```text
dsh-openeuler-bridge/
├── lib/
│   ├── index.js      # 插件壳：Config、启动/停止网关、注册工具
│   ├── bridge.js     # 内嵌网关：监听、握手、token、并发、审计
│   └── tools.js      # 工具定义与返回渲染
├── guest/
│   ├── node_run.py       # guest 节点（仅标准库；exec / PTY / 后台任务）
│   ├── guest-autostart.sh # ~/.bashrc 自启
│   └── install-systemd.sh # systemd 开机自启
├── package.json
├── .gitignore
├── LICENSE
└── README.md
```

## 安装

### 1. 宿主侧（DSHM 插件）

```bash
# 复制插件到 DSHM profile 的 node_modules（$DSH_HOME 为 DSHM 数据目录）
PROFILE="$DSH_HOME/profiles/<profile>"
mkdir -p "$PROFILE/node_modules/dsh-openeuler-bridge"
cp -R lib package.json "$PROFILE/node_modules/dsh-openeuler-bridge/"
```

在 `$DSH_HOME/cordis.patch.yml` 末尾加入：

```yaml
- insert:
    - id: openeuler-bridge
      name: 'dsh-openeuler-bridge'
```

完全退出并重开 DSHM（cordis patch 在启动时生效）。重开后：

```text
openeuler_status()          → 端口 19222、节点 openeuler-guest
openeuler_run("uname -a")   → Linux ... aarch64
```

### 2. guest 侧（节点）

把 `guest/` 放进 guest 能读到的共享目录，在融合引擎终端执行：

```bash
python3 node_run.py --host <宿主内网 IP> --token-file <token 文件>
```

或使用自启脚本：

```bash
sh guest-autostart.sh          # 供 ~/.bashrc 调用，登录终端时自动拉起
sudo sh install-systemd.sh     # 装成 systemd 服务，开机自启
```

`node_run.py` 的常用参数：

| 参数 | 说明 |
|---|---|
| `--host` | 宿主网关地址；缺省 `127.0.0.1`，NAT 下通常是 `172.16.x.1` |
| `--port` | 网关端口，默认 `19222` |
| `--token-file` | 与宿主共用的 token 文件（推荐） |
| `--token` | 直接给 token（也可用环境变量 `DSHM_LINUX_TOKEN`） |
| `--name` | 节点名，默认 `<hostname>-<arch>` |
| `--max-concurrency` | 并发执行上限，默认 4 |
| `--bg-log-dir` | 后台任务日志目录，默认 `~/.dshm-bg` |

token 必须两端一致：插件首次启动时会在 `tokenFile` 指定的路径自动生成（权限 0600）；guest 侧用同一份文件（可复制到 guest 私有目录并 `chmod 600`）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `19222` | 网关监听端口 |
| `bind` | `0.0.0.0` | 监听地址；来源由 `allowCidr` 限制，同机部署可改 `127.0.0.1` |
| `allowCidr` | `127.0.0.0/8,172.16.0.0/12` | 允许的来源网段；**不要**放宽到 `0.0.0.0/0` |
| `tokenFile` | `$DSH_HOME/openeuler-bridge/bridge.token`（未设 `DSH_HOME` 时为 `~/.dsh/...`） | 与 guest 共用的 token；不存在则自动生成 |
| `auditFile` | `$DSH_HOME/openeuler-bridge/audit.log` | 审计日志；留空关闭 |
| `defaultTimeoutMs` | `60000` | 默认命令超时（毫秒） |

`tokenFile` 与 `auditFile` 均可用环境变量覆盖：`DSHM_OPENEULER_TOKEN_FILE`、`DSH_HOME`。

## 安全

- **token 由用户自建或网关首次启动时自动生成，不要提交到仓库**。仓库 `.gitignore` 已排除 `*.token` 与 `token*.txt`，以及 `*.log`。共享目录里的 token 文件建议 `chmod 600`，只在宿主与 guest 之间传递。
- **监听地址**：默认 `0.0.0.0` 是为了让 NAT 后的 guest 能连到宿主内网地址；来源默认只允许 `127.0.0.0/8` 与 `172.16.0.0/12`。若 guest 与宿主同机，把 `bind` 改为 `127.0.0.1`。**绝不要**同时使用 `0.0.0.0` + `0.0.0.0/0`。
- **审计日志**会记录命令与退出码（`audit.log`），可能含敏感参数；发布、分享日志前先脱敏。
- 插件与 DSHM Host 同进程，只做异步 I/O，不阻塞宿主事件循环。

## 协议

宿主 `bridge.js` 与 guest `node_run.py` 之间是 JSONL over TCP，一行一个 JSON：

- 握手：`hello`（带 token / role / name / meta）→ `welcome`
- 一次性命令：`exec` → `result`；取消：`cancel`
- 查询：`status` → `nodes`；保活：`ping` → `pong`
- 交互式会话：`shell.open` / `shell.write` / `shell.read` / `shell.resize` / `shell.close`
- 后台任务：`bg.start` / `bg.status` / `bg.log` / `bg.stop`

## 与 Python 版的关系

本仓库**只带 guest 节点** `guest/node_run.py`，宿主侧用插件内嵌网关，不需要 Python。

早期版本的 Python 网关（`gateway.py`、CLI `linux.py` / `linux-run`）是可选项，不随本仓库发布；协议与本插件完全兼容（`hello / welcome / exec / result / cancel / status / nodes / ping / pong`），如需可用按同一协议自行实现。注意端口互斥：插件网关与 Python 网关都监听 `19222`，同一时间只能起一个。

## 平台限制

- 插件与 DSHM Host 同进程：网络与定时器必须保持异步；`stop()` 已做超时兜底。
- 沙箱内无法单独运行 Node，插件行为只能通过 DSHM 加载后验证。
- 端口 `19222` 单实例；切换插件 / Python 网关时要先停一个。
- PTY 会话上限 8；空闲不自动清理，用完请 `openeuler_shell_close`。
- 后台任务数未设上限；node 断开时统一清理。日志为 stdout/stderr 合并流。
- 中断 / 取消语义：工具取消（AbortSignal）→ 插件给 node 发 `cancel`；client 断开 → 在途请求 reject。
- 已知限制：CLI 路径断开后 guest 会话不会自动清理；工具路径不经过 client，不受影响。

## 运行环境（DSHM / DSH）

- **DSHM（鸿蒙端侧）**：本插件是 DSHM 插件，安装方式见上一节（`profiles/<profile>/node_modules/` + `$DSH_HOME/cordis.patch.yml` 的 `insert` 段），改完需完全退出并重开 DSHM。
- **DSH 桌面版**：插件目录与安装器按对应版本文档；`cordis.patch.yml` 的挂载机制相同，但 profile 路径不同。
- 插件依赖的 openEuler guest 节点（`guest/node_run.py`）与宿主平台无关，两种环境都能用。

## 版权、第三方依赖与商标

- **本项目**：MIT，见 [LICENSE](LICENSE)。示例图、示例数据由本项目程序生成，随 MIT 许可发布。
- **第三方依赖**：Node.js 内置模块（Node License）；无第三方 npm 依赖。
- **字体与图片**：本仓库不含字体文件、不含第三方图片素材。
- **商标与归属**：DSH、DSHM、DeepSeek Harness 是其各自所有者的产品名或商标；本项目是独立的第三方开源工具，与官方无隶属、赞助或背书关系。GitHub 为其所有者商标。
- **代码来源**：本仓库代码为原创实现；如果后续引入第三方代码，会在此列出其来源与许可。

## 问题反馈

- 优先在 [Issues](https://github.com/KongBai-lab/dsh-openeuler-bridge/issues) 提交，便于公开跟踪。
- 不便公开时（含安全问题），发邮件到 **KongBaiLab@yeah.net**。

## 许可

MIT，见 [LICENSE](LICENSE)。
