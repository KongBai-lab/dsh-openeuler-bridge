/**
 * openeuler-bridge / bridge.js —— 插件内嵌网关（Node，仅标准库）。
 *
 * 与 Python 版 gateway.py 协议兼容（JSONL over TCP）：
 *   hello / welcome / exec / result / cancel / status / nodes / ping / pong
 * 因此 guest 侧现有的 node_run.py 不用改，CLI linux.py 也仍可连。
 *
 * 设计约束（对应 engineering-discipline 十门槛）：
 *   - 不阻塞 Host：全部异步 I/O；不做同步长任务
 *   - 可取消：runCommand 接受 AbortSignal，取消时给 node 发 cancel
 *   - 硬超时：请求级定时器（含排队），到点 cancel + reject
 *   - 生命周期：start/stop 成对；stop 关闭所有连接与在途请求
 *   - 失败可见：结构化 BridgeError(code/message/hint)，审计日志落盘
 *   - 一键停用：插件 disable 即 stop
 */
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PROTOCOL = 'dshm-linux-bridge/0.1'
export const DEFAULT_PORT = 19222
export const MAX_LINE = 4 * 1024 * 1024
const CLIENT_SHELL_REQUESTS = new Set(['shell.open', 'shell.write', 'shell.read', 'shell.resize', 'shell.close'])
const CLIENT_BG_REQUESTS = new Set(['bg.start', 'bg.status', 'bg.log', 'bg.stop'])

export class BridgeError extends Error {
  constructor(code, message, hint = '') {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.hint = hint
  }
}

function normalizeIp(raw) {
  let ip = String(raw || '').trim()
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip === '::1') return '127.0.0.1'
  return ip
}

function ipv4ToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    value = (value << 8) + n
  }
  return value >>> 0
}

function ipInCidr(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/')
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw)
  const a = ipv4ToInt(ip)
  const b = ipv4ToInt(base)
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

function formatResult(msg) {
  return {
    ok: msg.ok !== false,
    exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null,
    stdout: String(msg.stdout || ''),
    stderr: String(msg.stderr || ''),
    truncated: msg.truncated === true,
    timedOut: msg.timedOut === true,
    error: msg.error || null,
    durationMs: Number(msg.durationMs) || 0,
  }
}

class Peer {
  constructor(socket, remote) {
    this.socket = socket
    this.remote = remote
    this.role = ''
    this.name = ''
    this.meta = {}
    this.alive = true
    this.connectedAt = Date.now()
    this.buf = ''
    this.handshakeTimer = null
    this.shells = new Set()
  }

  send(obj) {
    if (!this.alive) return
    try {
      this.socket.write(JSON.stringify(obj) + '\n')
    } catch {
      this.close()
    }
  }

  sendAndClose(obj) {
    if (!this.alive) return
    this.alive = false
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    try {
      this.socket.end(JSON.stringify(obj) + '\n')
    } catch {
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  close() {
    if (!this.alive) return
    this.alive = false
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
  }
}

export class BridgeServer {
  constructor(opts = {}) {
    this.port = Number(opts.port) || DEFAULT_PORT
    this.bind = opts.bind || '0.0.0.0'
    this.tokenFile = opts.tokenFile || ''
    this.tokenOverride = opts.token || ''
    this.allowNets = String(opts.allowCidr || '127.0.0.0/8,172.16.0.0/12')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    this.auditFile = opts.auditFile || ''
    this.maxLine = Number(opts.maxLine) || MAX_LINE
    this.log = opts.log || ((...args) => console.error('[openeuler-bridge]', ...args))
    this.server = null
    this.nodes = new Map()
    this.defaultNode = null
    this.pending = new Map()
    this.nextId = 1
    this.token = ''
    this.startedAt = 0
    this.startError = null
  }

  async start() {
    if (this.server) return
    this.token = this._loadToken()
    if (this.auditFile) {
      try {
        fs.mkdirSync(path.dirname(this.auditFile), { recursive: true })
      } catch {
        /* ignore */
      }
    }
    const server = net.createServer((socket) => this._onConnection(socket))
    this.server = server
    server.on('error', (err) => {
      this.startError = err
      this.log('server error:', err && err.message ? err.message : err)
    })
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off('listening', onListening)
          reject(err)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.port, this.bind)
      })
    } catch (err) {
      try {
        server.close()
      } catch {
        /* ignore */
      }
      this.server = null
      this.startError = err
      throw err
    }
    this.startedAt = Date.now()
    this.startError = null
    this.log(`listening on ${this.bind}:${this.port} (protocol ${PROTOCOL})`)
  }

  async stop() {
    for (const peer of this.nodes.values()) peer.close()
    this.nodes.clear()
    this.defaultNode = null
    for (const entry of this.pending.values()) {
      if (!entry.done) {
        entry.done = true
        clearTimeout(entry.timer)
        entry.reject(new BridgeError('SERVER_DOWN', 'openEuler 网关已停止'))
      }
    }
    this.pending.clear()
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise((resolve) => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          resolve()
        }
        try {
          server.close(done)
        } catch {
          done()
        }
        setTimeout(done, 1000).unref?.()
      })
    }
    this.startedAt = 0
    this.log('stopped')
  }

  status() {
    return {
      running: !!this.server,
      port: this.port,
      bind: this.bind,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      defaultNode: this.defaultNode,
      nodes: [...this.nodes.values()].map((n) => ({
        name: n.name,
        ip: n.remote,
        connectedAt: n.connectedAt,
        meta: n.meta || {},
        default: n.name === this.defaultNode,
      })),
      tokenFile: this.tokenFile,
      lastError: this.startError ? String(this.startError.message || this.startError) : null,
    }
  }

  /**
   * 执行一条命令。工具层与 CLI 兼容层都走这里。
   * @returns {Promise<object>} formatResult(...)
   */
  async runCommand({ cmd, cwd, timeoutMs = 60000, maxBytes = 1024 * 1024, signal, node } = {}) {
    if (!this.server) {
      throw new BridgeError('SERVER_DOWN', 'openEuler 网关未启动', '检查插件端口占用/配置后重启 DSHM')
    }
    const name = node || this.defaultNode
    const target = name ? this.nodes.get(name) : null
    if (!target) {
      throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点', '启动融合开发引擎，确认 guest-autostart.sh 已运行')
    }
    if (typeof cmd !== 'string' || !cmd.trim()) {
      throw new BridgeError('BAD_REQUEST', 'command 不能为空')
    }
    const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 60000, 600000))
    const id = this.nextId++
    const entry = { done: false, node: name, signal: signal || null, onAbort: null }
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    const finish = (fn, value) => {
      if (entry.done) return
      entry.done = true
      clearTimeout(entry.timer)
      this.pending.delete(id)
      if (entry.onAbort && signal) {
        try {
          signal.removeEventListener('abort', entry.onAbort)
        } catch {
          /* ignore */
        }
      }
      fn(value)
    }
    entry.timer = setTimeout(() => {
      target.send({ type: 'cancel', id })
      finish(entry.reject, new BridgeError(
        'TIMEOUT',
        `openEuler 命令在 ${Math.round(timeout / 1000)} 秒内未返回`,
        '拆小命令或提高 timeoutMs（上限 600000）',
      ))
    }, timeout + 500)
    if (signal) {
      if (signal.aborted) {
        finish(entry.reject, new BridgeError('CANCELLED', '命令已取消'))
      } else {
        entry.onAbort = () => {
          target.send({ type: 'cancel', id })
          finish(entry.reject, new BridgeError('CANCELLED', '命令已取消'))
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
    }
    this.pending.set(id, entry)
    target.send({ type: 'exec', id, cmd, cwd: cwd || undefined, timeoutMs: timeout, maxBytes })
    this._audit({ event: 'exec', id, node: name, cmd: cmd.slice(0, 200), cwd: cwd || null })

    const msg = await promise
    const result = formatResult(msg)
    this._audit({
      event: 'done',
      id,
      node: name,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      truncated: result.truncated,
      timedOut: result.timedOut,
    })
    return result
  }

  _defaultNode() {
    const name = this.defaultNode
    return name ? this.nodes.get(name) : null
  }

  _requestNode(node, msg, timeoutMs = 10000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const entry = { done: false, node: node.name, timer: null }
      entry.resolve = resolve
      entry.reject = reject
      entry.timer = setTimeout(() => {
        if (entry.done) return
        entry.done = true
        this.pending.delete(id)
        reject(new BridgeError('TIMEOUT', `openEuler 会话请求超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs)
      this.pending.set(id, entry)
      node.send({ ...msg, id })
    })
  }

  async shellOpen({ shell = 'bash', cols = 120, rows = 30, cwd } = {}) {
    const node = this._defaultNode()
    if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点', '启动融合开发引擎并确认 guest-autostart.sh')
    const msg = await this._requestNode(node, { type: 'shell.open', shell, cols, rows, cwd }, 10000)
    return { sessionId: msg.sessionId, pid: msg.pid, cols: msg.cols, rows: msg.rows }
  }

  async shellWrite({ sessionId, data } = {}) {
    if (!sessionId) throw new BridgeError('BAD_REQUEST', 'sessionId 不能为空')
    const node = this._defaultNode()
    if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
    const msg = await this._requestNode(node, { type: 'shell.write', sessionId, data: String(data ?? '') }, 10000)
    return { sessionId, written: typeof msg.written === 'number' ? msg.written : 0 }
  }

  async shellRead({ sessionId, maxBytes = 65536 } = {}) {
    if (!sessionId) throw new BridgeError('BAD_REQUEST', 'sessionId 不能为空')
    const node = this._defaultNode()
    if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
    const msg = await this._requestNode(node, { type: 'shell.read', sessionId, maxBytes }, 10000)
    return {
      data: Buffer.from(String(msg.data || ''), 'base64').toString('utf8'),
      eof: msg.eof === true,
      pending: typeof msg.pending === 'number' ? msg.pending : 0,
    }
  }

  async bgStart({ cmd, cwd } = {}) {
    const node = this._defaultNode()
    if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
    const msg = await this._requestNode(node, { type: 'bg.start', cmd: String(cmd || ''), cwd }, 10000)
    return { bgId: msg.bgId, pid: msg.pid, logPath: msg.logPath, startedAt: msg.startedAt }
  }

  async bgStatus({ bgId } = {}) {
    const node = this._defaultNode()
    if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
    return await this._requestNode(node, { type: 'bg.status', bgId }, 10000)
  }

  async bgLog({ bgId, offset = 0, maxBytes = 65536 } = {}) {
    const node = this._defaultNode()
    if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
    const msg = await this._requestNode(node, { type: 'bg.log', bgId, offset, maxBytes }, 10000)
    return {
      bgId: msg.bgId,
      data: Buffer.from(String(msg.data || ''), 'base64').toString('utf8'),
      nextOffset: typeof msg.nextOffset === 'number' ? msg.nextOffset : 0,
      size: typeof msg.size === 'number' ? msg.size : 0,
      eof: msg.eof === true,
      exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null,
    }
  }

  async bgStop({ bgId } = {}) {
    const node = this._defaultNode()
    if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
    const msg = await this._requestNode(node, { type: 'bg.stop', bgId }, 10000)
    return { bgId, exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null }
  }

  async shellClose({ sessionId } = {}) {
    if (!sessionId) throw new BridgeError('BAD_REQUEST', 'sessionId 不能为空')
    const node = this._defaultNode()
    if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
    const msg = await this._requestNode(node, { type: 'shell.close', sessionId }, 10000)
    return { sessionId, exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null }
  }

  _onConnection(socket) {
    const remote = normalizeIp(socket.remoteAddress || '')
    if (!this._allowed(remote)) {
      this.log(`reject connection from ${remote} (not in allow list)`)
      socket.destroy()
      return
    }
    const peer = new Peer(socket, remote)
    peer.handshakeTimer = setTimeout(() => {
      this.log(`hello timeout from ${remote}`)
      peer.close()
    }, 10000)
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      try {
        this._consume(peer, chunk)
      } catch (err) {
        this.log('message error:', err && err.message ? err.message : err)
        peer.close()
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => this._onClose(peer))
  }

  _consume(peer, chunk) {
    peer.buf += chunk
      let idx
      while ((idx = peer.buf.indexOf('\n')) >= 0) {
        const line = peer.buf.slice(0, idx)
        peer.buf = peer.buf.slice(idx + 1)
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          this.log(`bad json from ${remote}; closing`)
          peer.close()
          return
        }
        this._onMessage(peer, msg)
        if (!peer.alive) return
      }
    if (peer.buf.length > this.maxLine) {
      this.log(`line too long from ${peer.remote}; closing`)
      peer.close()
    }
  }

  _onClose(peer) {
    if (peer.role === 'client') {
      const node = this._defaultNode()
      if (node && peer.shells.size) {
        for (const sid of peer.shells) {
          try {
            node.send({ type: 'shell.close', id: this.nextId++, sessionId: sid })
          } catch {
            /* ignore */
          }
        }
      }
      peer.shells.clear()
    }
    if (peer.role === 'node') {
      if (this.nodes.get(peer.name) === peer) {
        this.nodes.delete(peer.name)
        if (this.defaultNode === peer.name) this.defaultNode = null
      }
      for (const [id, entry] of this.pending) {
        if (entry.node === peer.name && !entry.done) {
          entry.done = true
          clearTimeout(entry.timer)
          this.pending.delete(id)
          entry.reject(new BridgeError('NODE_ERROR', `openEuler 节点 ${peer.name} 已断开`))
        }
      }
      this.log(`node disconnected: ${peer.name}`)
    }
  }

  _onMessage(peer, msg) {
    if (!peer.role) {
      if (!msg || msg.type !== 'hello') {
        peer.close()
        return
      }
      this._handleHello(peer, msg)
      return
    }
    if (msg.type === 'result') {
      const entry = this.pending.get(msg.id)
      if (entry && !entry.done) {
        entry.done = true
        clearTimeout(entry.timer)
        this.pending.delete(msg.id)
        if (entry.onAbort && entry.signal) {
          try {
            entry.signal.removeEventListener('abort', entry.onAbort)
          } catch {
            /* ignore */
          }
        }
        entry.resolve(msg)
      }
      return
    }
    if (peer.role === 'node' && typeof msg.type === 'string' && (msg.type.startsWith('shell.') || msg.type.startsWith('bg.'))) {
      const entry = this.pending.get(msg.id)
      if (entry && !entry.done) {
        entry.done = true
        clearTimeout(entry.timer)
        this.pending.delete(msg.id)
        if (msg.type === 'shell.error') {
          entry.reject(new BridgeError(msg.code || 'SHELL_ERROR', msg.message || 'openEuler 会话错误'))
        } else {
          entry.resolve(msg)
        }
      }
      return
    }
    if (msg.type === 'ping') {
      peer.send({ type: 'pong', t: Date.now() })
      return
    }
    if (msg.type === 'pong') return
    if (peer.role === 'client' && CLIENT_SHELL_REQUESTS.has(msg.type)) {
      this._clientShell(peer, msg)
      return
    }
    if (peer.role === 'client' && CLIENT_BG_REQUESTS.has(msg.type)) {
      this._clientBg(peer, msg)
      return
    }
    if (peer.role === 'client' && msg.type === 'exec') {
      this._clientExec(peer, msg)
      return
    }
    if (peer.role === 'client' && msg.type === 'status') {
      peer.send({ type: 'nodes', id: msg.id, nodes: this.status().nodes, uptimeMs: this.status().uptimeMs })
      return
    }
    peer.send({ type: 'error', id: msg.id, code: 'BAD_REQUEST', message: `unknown message type: ${msg.type}` })
  }

  _handleHello(peer, msg) {
    if (!this._validToken(String(msg.token || ''))) {
      this.log(`reject connection from ${peer.remote}: bad token`)
      peer.sendAndClose({ type: 'error', code: 'BAD_TOKEN', message: 'token 不正确；请使用与网关一致的 token 文件' })
      return
    }
    const role = msg.role
    if (role !== 'node' && role !== 'client') {
      peer.send({ type: 'error', code: 'BAD_REQUEST', message: 'role 必须是 node 或 client' })
      peer.close()
      return
    }
    if (peer.handshakeTimer) {
      clearTimeout(peer.handshakeTimer)
      peer.handshakeTimer = null
    }
    peer.role = role
    peer.name = String(msg.name || (role === 'node' ? 'node' : 'client'))
    peer.meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {}
    if (role === 'node') {
      const old = this.nodes.get(peer.name)
      if (old && old !== peer) old.close()
      this.nodes.set(peer.name, peer)
      this.defaultNode = peer.name
      peer.send({ type: 'welcome', ok: true, role: 'node', protocol: PROTOCOL, name: peer.name, serverTime: Date.now() })
      this.log(`node connected: ${peer.name} from ${peer.remote}`)
    } else {
      peer.send({ type: 'welcome', ok: true, role: 'client', protocol: PROTOCOL, serverTime: Date.now(), nodes: [...this.nodes.keys()] })
      this.log(`client connected from ${peer.remote}`)
    }
  }

  async _clientShell(peer, msg) {
    const id = msg.id
    const node = this._defaultNode()
    try {
      if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
      const payload = { ...msg }
      delete payload.id
      const response = await this._requestNode(node, payload, 10000)
      if (response.type === 'shell.opened' && response.sessionId) peer.shells.add(response.sessionId)
      if (response.type === 'shell.closed' && msg.sessionId) peer.shells.delete(msg.sessionId)
      this._audit({
        event: 'shell',
        op: msg.type,
        sessionId: msg.sessionId || response.sessionId || null,
        client: peer.remote,
      })
      peer.send({ ...response, id })
    } catch (err) {
      this._audit({
        event: 'shell_error',
        op: msg.type,
        sessionId: msg.sessionId || null,
        client: peer.remote,
        message: err instanceof Error ? err.message : String(err),
      })
      peer.send({
        type: 'shell.error',
        id,
        code: err instanceof BridgeError ? err.code : 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async _clientBg(peer, msg) {
    const id = msg.id
    const node = this._defaultNode()
    try {
      if (!node) throw new BridgeError('NO_NODE', '没有已连接的 openEuler 节点')
      const payload = { ...msg }
      delete payload.id
      const response = await this._requestNode(node, payload, 10000)
      this._audit({ event: 'bg', op: msg.type, bgId: msg.bgId || response.bgId || null, client: peer.remote })
      peer.send({ ...response, id })
    } catch (err) {
      peer.send({
        type: 'shell.error',
        id,
        code: err instanceof BridgeError ? err.code : 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async _clientExec(peer, msg) {
    const id = msg.id
    try {
      const result = await this.runCommand({
        cmd: String(msg.cmd || ''),
        cwd: msg.cwd || undefined,
        timeoutMs: msg.timeoutMs,
        maxBytes: msg.maxBytes,
      })
      peer.send({ type: 'result', id, ...result })
    } catch (err) {
      const code = err instanceof BridgeError ? err.code : 'INTERNAL'
      peer.send({ type: 'error', id, code, message: err instanceof Error ? err.message : String(err) })
    }
  }

  _allowed(ip) {
    if (ip === '127.0.0.1' || ip === '::1') return true
    if (!this.allowNets.length) return true
    return this.allowNets.some((cidr) => ipInCidr(ip, cidr))
  }

  _validToken(token) {
    if (!this.token) return false
    const a = Buffer.from(token)
    const b = Buffer.from(this.token)
    if (a.length !== b.length) return false
    try {
      return crypto.timingSafeEqual(a, b)
    } catch {
      return false
    }
  }

  _loadToken() {
    if (this.tokenOverride) return this.tokenOverride
    if (this.tokenFile) {
      try {
        const token = fs.readFileSync(this.tokenFile, 'utf8').trim()
        if (token) return token
      } catch {
        /* fall through */
      }
      try {
        const token = crypto.randomBytes(32).toString('base64url')
        fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true })
        fs.writeFileSync(this.tokenFile, token + '\n', { mode: 0o600 })
        this.log(`generated token at ${this.tokenFile}`)
        return token
      } catch (err) {
        this.log('token read/write failed:', err && err.message ? err.message : err)
      }
    }
    this.log('no token file configured; generating in-memory token')
    return crypto.randomBytes(32).toString('base64url')
  }

  _audit(entry) {
    if (!this.auditFile) return
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
      fs.promises.appendFile(this.auditFile, line).catch(() => {})
    } catch {
      /* ignore */
    }
  }
}
