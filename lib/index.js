/**
 * dsh-openeuler-bridge —— 插件壳（内嵌网关）。
 *
 * 结构：
 *   - 本文件只声明 Config、启动/停止网关、注册工具；
 *   - 网关与工具实现分别在 bridge.js / tools.js（改实现不必改本文件，但仍需重启 DSHM 才加载新 entry）。
 *
 * 为什么是内嵌网关：
 *   - 不依赖 Python 网关进程，插件 disable 即停；
 *   - 工具直接持有 guest 节点连接，取消/超时语义更直接。
 * 代价：需要重启 DSHM 验证（沙箱内无法独立运行 Node）。
 *
 * 路径全部参数化：token 文件与审计日志默认落在当前用户目录下，
 * 可用 Config 或环境变量覆盖，不写死任何本机绝对路径。
 */
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BridgeServer } from './bridge.js'
import { createTools } from './tools.js'

export const name = 'openeuler-bridge'

const DEFAULT_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DEFAULT_TOKEN_FILE =
  process.env.DSHM_OPENEULER_TOKEN_FILE ||
  path.join(DEFAULT_HOME, 'openeuler-bridge', 'bridge.token')
const DEFAULT_AUDIT_FILE = path.join(DEFAULT_HOME, 'openeuler-bridge', 'audit.log')

export const Config = z.object({
  port: z.number().default(19222).description('网关监听端口（guest 节点连它）'),
  bind: z.string().default('0.0.0.0').description('监听地址；来源由 allowCidr 限制，同机部署可改 127.0.0.1'),
  allowCidr: z.string().default('127.0.0.0/8,172.16.0.0/12').description('允许的来源网段（逗号分隔）'),
  tokenFile: z
    .string()
    .default(DEFAULT_TOKEN_FILE)
    .description('共享 token 文件（必须与 guest 节点使用的一致；不存在时自动生成）'),
  auditFile: z
    .string()
    .default(DEFAULT_AUDIT_FILE)
    .description('审计日志路径；留空关闭'),
  defaultTimeoutMs: z.number().default(60000).description('默认命令超时（毫秒）'),
})

export const inject = ['tools']

export function apply(ctx, config) {
  const server = new BridgeServer({
    port: config.port,
    bind: config.bind,
    allowCidr: config.allowCidr,
    tokenFile: config.tokenFile,
    auditFile: config.auditFile,
  })

  server.start().catch((err) => {
    server.startError = err
    try {
      console.error('[openeuler-bridge] start failed:', err && err.message ? err.message : err)
    } catch {
      /* ignore */
    }
  })

  const dispose = () => {
    server.stop().catch(() => {})
  }
  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', dispose)
    else if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
  } catch {
    /* ignore */
  }

  for (const tool of createTools(server, config)) {
    try {
      ctx.tools.register(defineTool(tool))
    } catch (err) {
      try {
        console.error('[openeuler-bridge] register tool failed:', err && err.message ? err.message : err)
      } catch {
        /* ignore */
      }
    }
  }
}
