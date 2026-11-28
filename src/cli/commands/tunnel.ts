import { ConfigError } from '../../errors.js'
import type { ForwardedPort } from '../../ssh/ssh-channel.js'
import { writeJson, writeLine } from '../output.js'
import type { CommandContext } from './shared.js'

/**
 * `tunnel <instanceId> <本地端口>:<远端端口>`：SSH 本地端口转发。
 *
 * 判据：
 * - 端口号必须是 1–65535 的十进制整数。非法即抛 `ConfigError`，不猜、不纠正、不退回默认端口。
 * - 本地端口已被占用时报 `TunnelLocalPortInUseError`，不静默重试、不换端口。
 *   占用只有一个判据：真实监听的 `EADDRINUSE`。本命令**不做**预检试绑：
 *   「先试绑、关掉、再监听」的两次 `listen` 之间端口可以被别人抢走，预检只降低概率，
 *   构不成判据，还会让占用看起来像是本命令自己检出来的。
 * - 一次命令调用只开一次浏览器会话。凭据读取、主机指纹校验与转发都归 `openForward`：
 *   本命令不开凭据通道。同一条命令开两次浏览器等于两个标签页，第二个容易读到脏状态。
 * - 本命令只负责编排：开转发 → 等中止 → 清理。
 * - 前台运行。收到 `SIGINT`（Ctrl+C）或 `SIGTERM` 时先关转发，然后正常返回。
 *   Ctrl+C 是这个命令的正常退出方式，不是失败。
 * - 再来的重复信号被忽略：一次退出只清理一次，避免清理到一半被打断。
 *
 * 观察到的边界：每个本地连接开一条转发。临时连一次数据库或调试端口够用，
 * 不承担长期服务。转发异常断开即报错，不静默保持一个断掉的监听。
 */

/**
 * 转发证据目录名。它落在状态目录下。
 *
 * 控制台证据（取凭据时的两张截图）由 `openForward` 的装配写在这里，
 * 本命令不直接写这个目录。
 */
export const TUNNEL_EVIDENCE_DIRECTORY = 'tunnel'

/** 只监听回环地址。转发不得暴露到局域网，这是判据，不是可配置默认值。 */
export const TUNNEL_LISTEN_HOST = '127.0.0.1'

/**
 * 转发目标恒为实例自己的回环地址。
 *
 * 判据：本地端口转发按定义把「远端实例的回环」接到本机。放开远端主机等于把它变成
 * 一台通用的跳板机，那属于另一种命令，不在本命令范围内。
 */
export const TUNNEL_REMOTE_HOST = '127.0.0.1'

export interface TunnelCommandOptions {
  /** 目标实例 ID。 */
  readonly instanceId: string
  /** 转发说明，形如 `<本地端口>:<远端端口>`。 */
  readonly portsSpec: string
}

/** 解析后的端口对。 */
export interface TunnelPorts {
  readonly localPort: number
  readonly remotePort: number
}

/** `tunnel` 的启动输出。前台命令没有最终结果，所以启动时输出一次。 */
export interface TunnelCommandResult {
  readonly instanceId: string
  readonly localPort: number
  readonly remotePort: number
  readonly listenHost: string
  readonly remoteHost: string
}

/**
 * 解析一个端口号。
 *
 * 判据：纯十进制数字、1–65535。`+22`、` 22`、`0x16`、`0022` 以外的写法都不是合法输入：
 * 端口号是用户意图，纠正它就是替用户猜另一种意图。
 */
export function parsePort(raw: string, optionName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${optionName} 必须是十进制整数端口号，当前值：${JSON.stringify(raw)}。`)
  }
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${optionName} 必须在 1–65535 之间，当前值：${JSON.stringify(raw)}。`)
  }
  return port
}

/**
 * 解析 `<本地端口>:<远端端口>`。
 *
 * 判据：只接受恰好一个冒号。三段输入（`a:b:c`）与空段都不是本命令的参数形式，
 * 含糊的输入立即报错，不取其中一部分。
 */
export function parseTunnelPorts(spec: string): TunnelPorts {
  const parts = spec.split(':')
  if (parts.length !== 2) {
    throw new ConfigError(`端口转发参数必须是 <本地端口>:<远端端口>，当前值：${JSON.stringify(spec)}。`)
  }
  return {
    localPort: parsePort(parts[0] ?? '', '本地端口'),
    remotePort: parsePort(parts[1] ?? '', '远端端口'),
  }
}

/**
 * 一次转发的全部外部依赖。
 *
 * 拆出来是为了让编排（开转发 → 等中止 → 清理）能单测：
 * 自动测试不得建立真实 SSH 连接，也不得真的占用端口。
 *
 * 这里没有「端口预检」也没有「凭据通道」：前者是竞态，后者会开第二个浏览器标签页。
 */
export interface TunnelDependencies {
  /**
   * 打开转发。这是本命令唯一一次控制台会话。
   *
   * 判据：端口被占用由实现方翻译成 `TunnelLocalPortInUseError`；凭据在实现方内部读取。
   * `signal` 中止时实现方负责关掉通道。
   */
  openForward(request: {
    readonly instanceId: string
    readonly localPort: number
    readonly remotePort: number
    readonly listenHost: string
    readonly remoteHost: string
    readonly logDir: string
    readonly signal: AbortSignal
  }): Promise<ForwardedPort>
  /** 注册信号监听。返回的 `dispose` 必须能安全地解绑。 */
  onSignal(signal: NodeJS.Signals, handler: () => void): () => void
}

/**
 * 转发编排。
 *
 * 顺序判据：先注册信号、再开转发、然后等中止、最后清理。
 * 端口占用与实例状态都由 `openForward` 在第一次控制台会话里判出来，
 * 本命令不再另做一次判断：判两次等于两个事实来源。
 */
export async function runTunnel(
  context: CommandContext,
  options: TunnelCommandOptions,
  deps: TunnelDependencies,
): Promise<void> {
  const ports = parseTunnelPorts(options.portsSpec)
  // 证据目录口径：不带 run 的命令一律 <stateDir>/<命令名>/<instanceId>。
  // 路径解析的单一入口是 `commandEvidenceDir`，命令不自己拼。
  const logDir = await context.deps.commandEvidenceDir(
    TUNNEL_EVIDENCE_DIRECTORY,
    options.instanceId,
  )

  const controller = new AbortController()
  const stop = (): void => {
    if (controller.signal.aborted) {
      return
    }
    controller.abort()
  }
  const disposers = [deps.onSignal('SIGINT', stop), deps.onSignal('SIGTERM', stop)]

  let forwarding: ForwardedPort
  try {
    forwarding = await deps.openForward({
      instanceId: options.instanceId,
      localPort: ports.localPort,
      remotePort: ports.remotePort,
      listenHost: TUNNEL_LISTEN_HOST,
      remoteHost: TUNNEL_REMOTE_HOST,
      logDir,
      signal: controller.signal,
    })
  } catch (error: unknown) {
    for (const dispose of disposers) {
      dispose()
    }
    throw error
  }

  const result: TunnelCommandResult = {
    instanceId: options.instanceId,
    localPort: ports.localPort,
    remotePort: ports.remotePort,
    listenHost: TUNNEL_LISTEN_HOST,
    remoteHost: TUNNEL_REMOTE_HOST,
  }
  context.deps.logger.info('tunnel.open', {
    instanceId: result.instanceId,
    localPort: result.localPort,
    remotePort: result.remotePort,
  })
  emitTunnelResult(context, result)

  try {
    await forwarding.wait()
  } finally {
    for (const dispose of disposers) {
      dispose()
    }
    await forwarding.close()
    context.deps.logger.info('tunnel.closed', {
      instanceId: options.instanceId,
      localPort: ports.localPort,
    })
  }
}

function emitTunnelResult(context: CommandContext, result: TunnelCommandResult): void {
  if (context.json) {
    writeJson(context.deps.stdout, result)
    return
  }
  writeLine(
    context.deps.stdout,
    `端口转发已建立：本地 ${result.listenHost}:${String(result.localPort)} → ` +
      `实例 ${result.instanceId} 的 ${result.remoteHost}:${String(result.remotePort)}。按 Ctrl+C 退出。`,
  )
}
