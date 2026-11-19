/**
 * openeuler-bridge / tools.js —— 工具定义（openeuler_run / openeuler_status）。
 *
 * 工具只做参数校验与渲染；执行逻辑在 bridge.js 的 runCommand。
 * 错误统一返回结构化 value（ok:false + code + hint），不抛裸异常，方便模型读懂。
 */
import { BridgeError } from './bridge.js'

function fail(err) {
  const code = err instanceof BridgeError ? err.code : 'INTERNAL'
  const hint = err instanceof BridgeError ? err.hint : ''
  return {
    ok: false,
    code,
    message: err instanceof Error ? err.message : String(err),
    hint,
    exitCode: null,
    stdout: '',
    stderr: '',
    truncated: false,
    timedOut: false,
    durationMs: 0,
  }
}

function renderRun(value) {
  const v = value || {}
  const parts = []
  if (v.ok === false) parts.push(`[${v.code || 'ERROR'}] ${v.message || '执行失败'}${v.hint ? ' — ' + v.hint : ''}`)
  if (v.stdout) parts.push(v.stdout)
  if (v.stderr) parts.push('[stderr]\n' + v.stderr)
  if (typeof v.exitCode === 'number' || v.timedOut) {
    parts.push(`[exit ${v.exitCode ?? '?'}${v.truncated ? ', truncated' : ''}${v.timedOut ? ', timed out' : ''}]`)
  }
  return parts.join('\n') || '(无输出)'
}

function renderStatus(value) {
  const v = value || {}
  const lines = [
    `openEuler 桥: ${v.running ? '运行中' : '未运行'}  端口 ${v.port ?? '?'}  运行 ${Math.round((v.uptimeMs || 0) / 1000)}s`,
  ]
  if (v.lastError) lines.push(`最近错误: ${v.lastError}`)
  const nodes = Array.isArray(v.nodes) ? v.nodes : []
  if (!nodes.length) {
    lines.push('节点: 无（启动融合开发引擎；guest 里跑 guest-autostart.sh）')
  } else {
    for (const n of nodes) {
      const meta = n.meta && typeof n.meta === 'object' ? n.meta : {}
      lines.push(`节点: ${n.name}  ${n.ip}${n.default ? '  [默认]' : ''}  并发=${meta.maxConcurrency ?? '?'}`)
    }
  }
  return lines.join('\n')
}

function shellFail(err) {
  return {
    ok: false,
    code: err instanceof BridgeError ? err.code : 'INTERNAL',
    message: err instanceof Error ? err.message : String(err),
    hint: err instanceof BridgeError ? err.hint : '',
  }
}

function renderShell(value, kind) {
  const v = value || {}
  if (v.ok === false) return `[${v.code || 'ERROR'}] ${v.message || '会话操作失败'}${v.hint ? ' — ' + v.hint : ''}`
  if (kind === 'open') return `已打开交互会话 ${v.sessionId}（pid=${v.pid}, ${v.cols}x${v.rows}）`
  if (kind === 'write') return `已发送 ${v.written} 字符到 ${v.sessionId}`
  if (kind === 'close') return `会话 ${v.sessionId} 已关闭（exit=${v.exitCode ?? '?'}）`
  const tail = []
  if (v.eof) tail.push('[eof]')
  if (v.pending) tail.push(`[pending ${v.pending}B]`)
  return (v.data || '') + (tail.length ? '\n' + tail.join(' ') : '')
}

function renderBg(value, kind) {
  const v = value || {}
  if (v.ok === false) return `[${v.code || 'ERROR'}] ${v.message || '后台任务操作失败'}`
  if (kind === 'start') return `后台任务 ${v.bgId} 已启动（pid=${v.pid}，日志 ${v.logPath}）`
  if (kind === 'stop') return `后台任务 ${v.bgId} 已停止（exit=${v.exitCode ?? '?'}）`
  if (kind === 'status') {
    const tasks = Array.isArray(v.tasks) ? v.tasks : []
    if (!tasks.length) return '没有后台任务'
    return tasks
      .map((t) => `${t.bgId} pid=${t.pid} ${t.running ? '运行中' : '已结束 exit=' + (t.exitCode ?? '?')} 日志=${t.logPath}`)
      .join('\n')
  }
  const tail = []
  if (v.eof) tail.push('[eof]')
  if (typeof v.exitCode === 'number') tail.push(`[exit ${v.exitCode}]`)
  if (typeof v.nextOffset === 'number') tail.push(`[offset ${v.nextOffset}/${v.size || 0}]`)
  return (v.data || '') + (tail.length ? '\n' + tail.join(' ') : '')
}

export function createTools(server, config) {
  const defaultTimeout = Number(config && config.defaultTimeoutMs) || 60000
  return [
    {
      name: 'openeuler_run',
      description:
        '在「融合开发引擎」（openEuler Linux 子系统）里执行 shell 命令，返回 stdout/stderr/退出码。' +
        '用于编译、git、podman、长任务等鸿蒙宿主没有的 Linux 工具链；文件交换走共享目录（guest 内 /mnt/linux_share）。' +
        '前提：融合引擎已启动且 guest 节点在线（先用 openeuler_status 查）。',
      parameters: {
        command: { type: 'string', required: true, description: '要执行的命令（经 /bin/sh -c）' },
        cwd: { type: 'string', description: '工作目录（guest 路径，默认 guest 家目录）' },
        timeoutMs: { type: 'number', description: '超时毫秒（含排队），默认 60000，上限 600000' },
        maxBytes: { type: 'number', description: 'stdout/stderr 截断字节，默认 1 MiB' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderRun(value) }],
      },
      timeoutMs: 620000,
      async execute(args, exec) {
        try {
          return await server.runCommand({
            cmd: String(args?.command ?? ''),
            cwd: typeof args?.cwd === 'string' && args.cwd ? args.cwd : undefined,
            timeoutMs: args?.timeoutMs ?? defaultTimeout,
            maxBytes: args?.maxBytes,
            signal: exec?.signal,
          })
        } catch (err) {
          return fail(err)
        }
      },
    },
    {
      name: 'openeuler_status',
      description:
        '查看 openEuler 桥状态：网关端口、已连接的 guest 节点（名称/IP/并发上限）、默认节点、最近错误。' +
        '排查「没有节点」时先调它。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
      },
      async execute() {
        return server.status()
      },
    },
    {
      name: 'openeuler_shell_open',
      description:
        '打开一个 openEuler 交互式终端会话（PTY），支持 bash、python -i、vim、top、ssh 等交互式程序。' +
        '返回 sessionId；随后用 openeuler_shell_write 发送输入、openeuler_shell_read 读取输出、openeuler_shell_close 关闭。',
      parameters: {
        shell: { type: 'string', description: '启动的 shell/命令（默认 bash；也可 python3、vim 等）' },
        cols: { type: 'number', description: '终端列数，默认 120' },
        rows: { type: 'number', description: '终端行数，默认 30' },
        cwd: { type: 'string', description: '工作目录（guest 路径）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderShell(value, 'open') }],
      },
      timeoutMs: 30000,
      async execute(args) {
        try {
          return await server.shellOpen({
            shell: args?.shell || 'bash',
            cols: args?.cols,
            rows: args?.rows,
            cwd: typeof args?.cwd === 'string' && args.cwd ? args.cwd : undefined,
          })
        } catch (err) {
          return shellFail(err)
        }
      },
    },
    {
      name: 'openeuler_shell_write',
      description:
        '向 openEuler 交互式会话（sessionId）发送输入。普通文本直接写；控制字符用转义：Ctrl-C "\\u0003"、Ctrl-D "\\u0004"、Esc "\\u001b"。',
      parameters: {
        sessionId: { type: 'string', required: true, description: 'openeuler_shell_open 返回的会话 id' },
        data: { type: 'string', required: true, description: '要发送的文本/按键（可含控制字符）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderShell(value, 'write') }],
      },
      timeoutMs: 30000,
      async execute(args) {
        try {
          return await server.shellWrite({ sessionId: String(args?.sessionId || ''), data: String(args?.data ?? '') })
        } catch (err) {
          return shellFail(err)
        }
      },
    },
    {
      name: 'openeuler_shell_read',
      description:
        '读取 openEuler 交互式会话（sessionId）的增量输出。返回已解码文本（保留终端转义序列）与 eof 标记；' +
        '交互程序通常需要 write 后稍等再 read，必要时连续 read 几次。',
      parameters: {
        sessionId: { type: 'string', required: true, description: '会话 id' },
        maxBytes: { type: 'number', description: '单次最多读取字节数（默认 65536）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderShell(value, 'read') }],
      },
      timeoutMs: 30000,
      async execute(args) {
        try {
          return await server.shellRead({ sessionId: String(args?.sessionId || ''), maxBytes: args?.maxBytes })
        } catch (err) {
          return shellFail(err)
        }
      },
    },
    {
      name: 'openeuler_shell_close',
      description: '关闭 openEuler 交互式会话（sessionId）并回收进程；返回退出码。用完务必关闭，避免会话泄漏。',
      parameters: {
        sessionId: { type: 'string', required: true, description: '会话 id' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderShell(value, 'close') }],
      },
      timeoutMs: 30000,
      async execute(args) {
        try {
          return await server.shellClose({ sessionId: String(args?.sessionId || '') })
        } catch (err) {
          return shellFail(err)
        }
      },
    },
    {
      name: 'openeuler_bg_start',
      description:
        '在 openEuler 里启动一个后台任务（流式写日志），立即返回 bgId；随后用 openeuler_bg_log 增量读取输出、' +
        'openeuler_bg_status 查状态、openeuler_bg_stop 停止。适合 make/pip/podman build/训练等长任务。',
      parameters: {
        command: { type: 'string', required: true, description: '要执行的命令（/bin/sh -c）' },
        cwd: { type: 'string', description: '工作目录（guest 路径）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderBg(value, 'start') }],
      },
      timeoutMs: 30000,
      async execute(args) {
        try {
          return await server.bgStart({ cmd: String(args?.command ?? ''), cwd: args?.cwd })
        } catch (err) {
          return shellFail(err)
        }
      },
    },
    {
      name: 'openeuler_bg_log',
      description:
        '增量读取后台任务输出（从 offset 开始）。返回文本、nextOffset、eof、exitCode；反复调用即可“边跑边看”。',
      parameters: {
        bgId: { type: 'string', required: true, description: 'openeuler_bg_start 返回的 bgId' },
        offset: { type: 'number', description: '从第几字节开始读（默认 0；用上次返回的 nextOffset 续读）' },
        maxBytes: { type: 'number', description: '单次最多字节（默认 65536）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderBg(value, 'log') }],
      },
      timeoutMs: 30000,
      async execute(args) {
        try {
          return await server.bgLog({
            bgId: String(args?.bgId || ''),
            offset: args?.offset ?? 0,
            maxBytes: args?.maxBytes,
          })
        } catch (err) {
          return shellFail(err)
        }
      },
    },
    {
      name: 'openeuler_bg_status',
      description: '列出 openEuler 后台任务（或指定 bgId）：pid、是否运行中、退出码、日志路径。',
      parameters: {
        bgId: { type: 'string', description: '只查这个任务（可选）' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderBg(value, 'status') }],
      },
      timeoutMs: 30000,
      async execute(args) {
        try {
          return await server.bgStatus({ bgId: args?.bgId })
        } catch (err) {
          return shellFail(err)
        }
      },
    },
    {
      name: 'openeuler_bg_stop',
      description: '停止 openEuler 后台任务（杀进程组），返回退出码。',
      parameters: {
        bgId: { type: 'string', required: true, description: '要停止的 bgId' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: renderBg(value, 'stop') }],
      },
      timeoutMs: 30000,
      async execute(args) {
        try {
          return await server.bgStop({ bgId: String(args?.bgId || '') })
        } catch (err) {
          return shellFail(err)
        }
      },
    },
  ]
}
