import { isAbsolute } from 'node:path'
import { openConsoleSession, type ConsoleSession } from '../../console/channel-factory.js'
import { createCloneActions } from '../../console/clone.js'
import { createInstanceListActions } from '../../console/instance-list.js'
import type {
  ConsoleActionContext,
  ConsoleChannel,
  ConsoleRuntimeContext,
} from '../../console/ports.js'
import { createPowerActions } from '../../console/power.js'
import { createTeardownActions } from '../../console/release.js'
import { createPriceActions } from '../../console/timed-shutdown.js'
import { ConfigError } from '../../errors.js'
import type { Logger } from '../../logging/logger.js'
import type { Provider, ProviderCapabilities } from '../provider.js'
import { createSshPort } from '../../ssh/channel.js'
import { createShellPort, DEFAULT_SHELL_CONNECT_TIMEOUT_MS } from '../../ssh/shell-channel.js'
import type { SshShellPort } from '../../ssh/ports.js'
import type { Clock } from '../../util/clock.js'
import { assertPositiveInteger, isInsideOrEqual } from '../../util/validate.js'

/**
 * AutoDL provider 的真实装配。
 *
 * 顺序判据：先开控制面通道（`openConsoleSession`），建立后立刻判登录态
 * （未登录时任何控制台动作都只会得到「页面结构不符」这类误导性错误），
 * 再按 `ConsoleActionContext` / `ConsoleRuntimeContext` 装出五组控制台动作与 SSH 数据面，
 * 最后组合成 `Provider`。
 *
 * 本文件是唯一允许出现「AutoDL」这个名字与 CDP、SSH 库的地方（provider 工厂例外条款，
 * 见 docs/provider-contract.md 第 6 节）。执行引擎只认 `Provider`。
 */

/** provider id。上层不按它分支，只用来打日志与按能力询问。 */
export const AUTODL_PROVIDER_ID = 'autodl'

/**
 * AutoDL 的能力声明。
 *
 * `noGpuMode: true`：控制台「更多」里有「无卡模式开机」，deploydeck 能走这条路径。
 * 是否真的走它由部署配置的 `powerOnMode` 决定，引擎不得自行降级或升级。
 * 与 docs/provider-contract.md 第 2 节的能力表一致。
 *
 * `imageSnapshot: false`：控制台有「保存镜像」，但 Phase 2 不做镜像构建，端口也没有对应动作。
 * 能力声明回答的是「引擎能不能走这条路」，不是「控制台有没有这个功能」。
 */
export const AUTODL_CAPABILITIES: ProviderCapabilities = {
  create: true,
  powerCycle: true,
  noGpuMode: true,
  timedShutdown: true,
  accessInfo: true,
  imageSnapshot: false,
  clone: true,
}

/** 建立 SSH 连接（含握手与认证）的超时，毫秒。经验值：跨公网建连正常在 1 秒内。 */
const SSH_CONNECT_TIMEOUT_MS = 30_000

/** SSH 断线重连次数。本期固定 1，见 docs/specs/deploydeck-phase2.md 第 8 节。 */
const SSH_RECONNECT_ATTEMPTS = 1

export interface AutodlProviderOptions {
  /** 控制台地址。 */
  readonly consoleUrl: string
  /** 专用 Chrome 的 CDP 端口。 */
  readonly cdpPort: number
  /** 专用 Chrome 的 user-data-dir。登录态存在这里。 */
  readonly chromeProfileDir: string
  /** SSH 主机密钥指纹文件。必须落在状态目录内。 */
  readonly knownHostsPath: string
  /**
   * 控制面证据（步骤日志与截图）的落点。
   *
   * `Provider` 端口没有「按调用传 logDir」的位置，所以一个进程只能用同一个目录。
   * 按 run 分目录需要扩端口，属后续工作。
   */
  readonly logDir: string
  /** 状态目录。 */
  readonly stateDir: string
  /** 配置目录。人写，机器只读。 */
  readonly configDir: string
  /** 单次控制台动作的默认超时。 */
  readonly timeoutMs: number
  /** 等状态变化时的轮询间隔。 */
  readonly pollIntervalMs: number
  /** 启动 Chrome 时不抢前台。默认 false。真机测试必须置 true。 */
  readonly backgroundLaunch?: boolean
  /** 是否由 WSL 启动 Windows Chrome。真机测试必须显式给 true。 */
  readonly wsl?: boolean
  /** 注入时钟。测试用；真实运行不传。 */
  readonly clock?: Clock
  readonly logger?: Logger
}

export interface AutodlRuntime {
  readonly provider: Provider
  /**
   * 交互式终端端口。
   *
   * 它不进 `Provider`：`Provider` 是执行引擎的依赖，引擎只跑非交互命令。
   * 终端是给人用的入口，走自己的端口，引擎拿不到它也就不会误用。
   */
  readonly shell: SshShellPort
  readonly session: ConsoleSession
  /** 关闭通道。不关闭浏览器：登录态要留到下一次运行。 */
  close(): Promise<void>
}

/**
 * 打开 AutoDL provider。
 *
 * 未登录时抛 `LoginRequiredError`（退出码 2），且不装出任何端口：
 * 调用方拿不到 provider，就无从在未登录状态点任何按钮。
 */
export async function openAutodlProvider(options: AutodlProviderOptions): Promise<AutodlRuntime> {
  assertProviderOptions(options)

  const session = await openConsoleSession({
    consoleUrl: options.consoleUrl,
    port: options.cdpPort,
    chromeProfileDir: options.chromeProfileDir,
    backgroundLaunch: options.backgroundLaunch ?? false,
    ...(options.wsl === undefined ? {} : { wsl: options.wsl }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  try {
    await session.ensureLoggedIn()
  } catch (error: unknown) {
    await session.close()
    throw error
  }

  const provider = createAutodlProvider({
    channel: session.channel,
    logDir: options.logDir,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    knownHostsPath: options.knownHostsPath,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  const shellContext: ConsoleActionContext = {
    channel: session.channel,
    logDir: options.logDir,
    timeoutMs: options.timeoutMs,
    pollIntervalMs: options.pollIntervalMs,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }
  const shell = createShellPort({
    context: { ...shellContext, instances: createInstanceListActions(shellContext) },
    knownHostsPath: options.knownHostsPath,
    connectTimeoutMs: DEFAULT_SHELL_CONNECT_TIMEOUT_MS,
  })

  return {
    provider,
    shell,
    session,
    close: async () => {
      await session.close()
    },
  }
}

/** 装配 AutoDL provider 所需的边界。全部可替换，测试用假通道即可。 */
export interface AutodlProviderInput {
  readonly channel: ConsoleChannel
  readonly logDir: string
  readonly timeoutMs: number
  readonly pollIntervalMs: number
  readonly knownHostsPath: string
  readonly clock?: Clock
  /** 本次运行的日志器。控制台动作模块用它记运行日志。 */
  readonly logger?: Logger
}

/**
 * 把五组控制台动作与 SSH 数据面装成一个 `Provider`。
 *
 * 纯装配：不连浏览器、不判登录态。`openAutodlProvider` 在这一层之上补上通道与登录态。
 */
export function createAutodlProvider(input: AutodlProviderInput): Provider {
  const actionContext: ConsoleActionContext = {
    channel: input.channel,
    logDir: input.logDir,
    timeoutMs: input.timeoutMs,
    pollIntervalMs: input.pollIntervalMs,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  }
  // 控制台动作里有四组需要「先定位到某一行」，它们收带列表能力的运行时上下文。
  const runtimeContext: ConsoleRuntimeContext = {
    ...actionContext,
    instances: createInstanceListActions(actionContext),
  }

  const instances = runtimeContext.instances
  const power = createPowerActions(runtimeContext)
  const clone = createCloneActions(runtimeContext)
  const price = createPriceActions(runtimeContext)
  const teardown = createTeardownActions(runtimeContext)
  const ssh = createSshPort({
    context: runtimeContext,
    knownHostsPath: input.knownHostsPath,
    connectTimeoutMs: SSH_CONNECT_TIMEOUT_MS,
    reconnectAttempts: SSH_RECONNECT_ATTEMPTS,
  })

  // 端口对象的方法一律经箭头转发：端口实现内部即使将来用到 this，组合后也不会丢绑定。
  return {
    id: AUTODL_PROVIDER_ID,
    capabilities: AUTODL_CAPABILITIES,
    listInstances: async (options) => await instances.listInstances(options),
    powerOn: async (instanceId, mode) => await power.powerOn(instanceId, mode),
    powerOff: async (instanceId) => await power.powerOff(instanceId),
    readCloneQuota: async (sourceInstanceId) => await clone.readCloneQuota(sourceInstanceId),
    clone: async (request) => await clone.clone(request),
    readPriceQuote: async (instanceId, ttlMinutes) => await price.readPriceQuote(instanceId, ttlMinutes),
    setTimedShutdown: async (instanceId, shutdownAt) =>
      await price.setTimedShutdown(instanceId, shutdownAt),
    clearTimedShutdown: async (instanceId) => await price.clearTimedShutdown(instanceId),
    readBalance: async () => await price.readBalance(),
    destroy: async (instanceId) => await teardown.destroy(instanceId),
    waitUntilReady: async (instanceId, timeoutMs) => await ssh.waitUntilReady(instanceId, timeoutMs),
    exec: async (instanceId, command, options) => await ssh.exec(instanceId, command, options),
  }
}

/**
 * 选项校验。装配错误一律在这里崩：迟到的报错会伪装成控制台或 SSH 的问题。
 */
export function assertProviderOptions(options: AutodlProviderOptions): void {
  assertHttpUrl(options.consoleUrl, 'consoleUrl')
  if (!Number.isInteger(options.cdpPort) || options.cdpPort < 1 || options.cdpPort > 65535) {
    throw new ConfigError(`cdpPort 必须是 1-65535 的整数，当前值：${String(options.cdpPort)}。`)
  }
  assertAbsolutePath(options.chromeProfileDir, 'chromeProfileDir')
  assertAbsolutePath(options.knownHostsPath, 'knownHostsPath')
  assertAbsolutePath(options.logDir, 'logDir')
  assertAbsolutePath(options.stateDir, 'stateDir')
  assertAbsolutePath(options.configDir, 'configDir')
  assertPositiveInteger(options.timeoutMs, 'timeoutMs')
  assertPositiveInteger(options.pollIntervalMs, 'pollIntervalMs')

  // 主机密钥指纹是机器写的状态，必须落在状态目录内：落到别处等于绕过状态目录的并发约定。
  if (!isInsideOrEqual(options.stateDir, options.knownHostsPath)) {
    throw new ConfigError(
      `knownHostsPath 必须落在状态目录内：${options.knownHostsPath}（状态目录 ${options.stateDir}）。`,
    )
  }
  // 状态目录落在配置目录内，等于每一次状态写入都是写配置目录。
  if (isInsideOrEqual(options.configDir, options.stateDir)) {
    throw new ConfigError(
      `状态目录不能位于配置目录内：状态目录 ${options.stateDir}，配置目录 ${options.configDir}。` +
        '配置目录由人写，机器只读。',
    )
  }
}

function assertHttpUrl(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ConfigError(`${label} 不能为空。`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new ConfigError(`${label} 不是合法 URL：${value}。`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${label} 必须是 http 或 https 地址，当前协议：${parsed.protocol}。`)
  }
}

/** Windows 盘符绝对路径，例如 `C:\Users\x\y` 或 `C:/Users/x/y`。 */
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/

/**
 * WSL 下 Chrome 的 user-data-dir 必须落 Windows 本地磁盘，取值天然是 Windows 路径。
 * 用 POSIX 的 `isAbsolute` 判它恒为假，会把唯一可用的取值判成非法。
 * 判据：POSIX 绝对路径与 Windows 盘符路径都算绝对。
 */
function assertAbsolutePath(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new ConfigError(`${label} 不能为空。`)
  }
  if (!isAbsolute(value) && !WINDOWS_ABSOLUTE_PATH.test(value)) {
    throw new ConfigError(`${label} 必须是绝对路径，当前值：${value}。`)
  }
}

