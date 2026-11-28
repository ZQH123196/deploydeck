import { loadProfiles } from '../config/loader.js'
import {
  probeWindowsProfileRoot,
  readProcessEnv,
  resolveBalanceWarnBelowYuan,
  resolveCdpPort,
  resolveChromeBackgroundLaunch,
  resolveChromeProfileDirForChrome,
  resolveConfigDir,
  resolveKnownHostsPath,
  resolveProfilesDir,
  resolveProjectsDir,
  resolveStateDir,
} from '../config/paths.js'
import { loadProject } from '../config/project-loader.js'
import { openConsoleSession, type ConsoleSession } from '../console/channel-factory.js'
import { createInstanceListActions } from '../console/instance-list.js'
import { CONSOLE_INSTANCE_LIST_URL } from '../console/selectors.js'
import type { Profile } from '../domain/profile.js'
import type { Project } from '../domain/project.js'
import { ConfigError } from '../errors.js'
import { createStderrLogger, type Logger } from '../logging/logger.js'
import { AUTODL_CAPABILITIES, AUTODL_PROVIDER_ID, openAutodlProvider } from '../providers/autodl/runtime.js'
import type { Provider, ProviderCapabilities } from '../providers/provider.js'
import {
  createShellPort,
  DEFAULT_SHELL_CONNECT_TIMEOUT_MS,
} from '../ssh/shell-channel.js'
import type { SshShellPort } from '../ssh/ports.js'
import type { StateStore } from '../state/ports.js'
import { createStateStore } from '../state/store.js'
import { systemClock, type Clock } from '../util/clock.js'
import type { OutputStream } from './output.js'

/**
 * CLI 的依赖装配点。
 *
 * 命令实现只依赖这个接口：打开 provider、创建状态存储、时钟、输出流、配置目录与状态目录。
 * 测试注入假实现，命令的业务逻辑（计划校验、执行编排、账本结算）照常跑。
 *
 * 判据：命令实现不直接 `new` 外部依赖，也不直接读 `process.env`；
 * 环境变量只在 `src/config/paths.ts` 一处读取。
 */

/** 控制台动作的默认超时，毫秒。经验值：一次页面动作加等待状态变化远小于 2 分钟。 */
export const CONSOLE_ACTION_TIMEOUT_MS = 120_000

/** 等控制台状态变化的默认轮询间隔，毫秒。列表页不会自动刷新，轮询时每轮都点刷新。 */
export const CONSOLE_POLL_INTERVAL_MS = 2_000

/** CLI 取状态锁的总等待上限，毫秒。 */
export const STATE_LOCK_TIMEOUT_MS = 10_000

/** CLI 取状态锁失败后的重试间隔，毫秒。 */
export const STATE_LOCK_RETRY_INTERVAL_MS = 50

/** 一次 provider 会话。`close` 只关通道，不关浏览器：登录态要留到下一次运行。 */
export interface ProviderSession {
  readonly provider: Provider
  close(): Promise<void>
}

/**
 * 一次终端通道会话。
 *
 * `shell` 只提供「开一条 shell」这一个动作。关闭会话即释放浏览器通道；
 * SSH 会话本身的关闭由返回的 `InteractiveShellSession.close()` 负责。
 */
export interface ShellSession {
  readonly shell: SshShellPort
  close(): Promise<void>
}

/** provider 的静态能力声明。它不打开浏览器，`plan create` 靠它做前置校验。 */
export interface ProviderCapabilityDeclaration {
  readonly id: string
  readonly capabilities: ProviderCapabilities
}

export interface CliDependencies {
  /** 配置目录。人写，机器只读。 */
  readonly configDir: string
  /** 状态目录。机器写。 */
  readonly stateDir: string
  /** 控制台地址。`login` 与 provider 装配共用这一个来源。 */
  readonly consoleUrl: string
  /** 注入时钟。测试用假时钟。 */
  readonly clock: Clock
  /** 结构化日志。人读进度与引擎日志都走它（stderr）。 */
  readonly logger: Logger
  /** JSON 结果与人类可读结果的出口。 */
  readonly stdout: OutputStream
  /** 进度、日志与错误信息的出口。 */
  readonly stderr: OutputStream
  /**
   * 打开 provider。
   *
   * `logDir` 是本次动作的控制面证据落点。未登录抛 `LoginRequiredError`（退出码 2），
   * 此时不返回 provider：调用方拿不到端口，就无从在未登录状态点任何按钮。
   */
  openProvider(options: { readonly logDir: string }): Promise<ProviderSession>
  /** 打开控制台通道，只给 `login` 用。 */
  openConsoleSession(): Promise<ConsoleSession>
  /**
   * 打开交互式终端通道。
   *
   * 每调用一次都要给定本次会话的证据目录与终端类型。它内部会先读实例状态，
   * 实例不在运行中即抛 `InstanceNotRunningError`（退出码 1），不建立 SSH 连接。
   */
  openShell(options: { readonly logDir: string; readonly term: string }): Promise<ShellSession>
  /** 读 provider 能力声明。不连浏览器。未知 provider 即抛错。 */
  readProviderCapabilities(providerId: string): ProviderCapabilityDeclaration
  /** 创建状态存储。每次调用一个新实例，全部指向同一个状态目录。 */
  createStateStore(): StateStore
  /** 读全部部署配置。目录不存在或任一文件非法即抛错。 */
  loadProfiles(): Promise<readonly Profile[]>
  /** 按 id 读一份项目清单。找不到即抛错。 */
  loadProject(projectId: string): Promise<Project>
  /**
   * 守护进程的余额告警阈值，元。
   *
   * 只有 `guard` 调它。没配置时抛 `ConfigError`（退出码 2），信息里写清要配哪个变量。
   */
  readBalanceWarnBelowYuan(): number
}

export interface RealCliDependenciesOptions {
  /** 注入环境变量。测试用；真实运行不传。 */
  readonly env?: NodeJS.ProcessEnv
  /** 注入时钟。测试用；真实运行不传。 */
  readonly clock?: Clock
  readonly stdout?: OutputStream
  readonly stderr?: OutputStream
  readonly logger?: Logger
}

/** 默认依赖：真实路径。全部环境变量读取都经 `src/config/paths.ts`。 */
export function createRealCliDependencies(
  options: RealCliDependenciesOptions = {},
): CliDependencies {
  const env = options.env ?? readProcessEnv()
  const configDir = resolveConfigDir(env)
  const stateDir = resolveStateDir(env)
  const clock = options.clock ?? systemClock
  const logger = options.logger ?? createStderrLogger()
  const stdout = options.stdout ?? {
    write: (text: string) => {
      process.stdout.write(text)
    },
  }
  const stderr = options.stderr ?? {
    write: (text: string) => {
      process.stderr.write(text)
    },
  }

  // WSL 下 profile 要落 Windows 本地磁盘。Windows 目录只能问一次 cmd.exe，结果缓存起来。
  let chromeProfileDirPromise: Promise<string> | undefined
  const resolveChromeProfileDir = (): Promise<string> => {
    chromeProfileDirPromise ??= probeWindowsProfileRoot(env).then((windowsRoot) =>
      resolveChromeProfileDirForChrome(env, process.platform, windowsRoot),
    )
    return chromeProfileDirPromise
  }
  // 启动期校验：非法取值在这里崩，不等到第一次开浏览器。
  const backgroundLaunch = resolveChromeBackgroundLaunch(env)

  return {
    configDir,
    stateDir,
    consoleUrl: CONSOLE_INSTANCE_LIST_URL,
    clock,
    logger,
    stdout,
    stderr,

    openProvider: async ({ logDir }) => {
      const runtime = await openAutodlProvider({
        consoleUrl: CONSOLE_INSTANCE_LIST_URL,
        cdpPort: resolveCdpPort(env),
        chromeProfileDir: await resolveChromeProfileDir(),
        backgroundLaunch,
        knownHostsPath: resolveKnownHostsPath(stateDir),
        logDir,
        stateDir,
        configDir,
        timeoutMs: CONSOLE_ACTION_TIMEOUT_MS,
        pollIntervalMs: CONSOLE_POLL_INTERVAL_MS,
        clock,
        logger,
      })
      return {
        provider: runtime.provider,
        close: async () => {
          await runtime.close()
        },
      }
    },

    openConsoleSession: async () => {
      return await openConsoleSession({
        consoleUrl: CONSOLE_INSTANCE_LIST_URL,
        port: resolveCdpPort(env),
        chromeProfileDir: await resolveChromeProfileDir(),
        backgroundLaunch,
        logger,
      })
    },

    openShell: async ({ logDir, term }) => {
      const session = await openConsoleSession({
        consoleUrl: CONSOLE_INSTANCE_LIST_URL,
        port: resolveCdpPort(env),
        chromeProfileDir: await resolveChromeProfileDir(),
        backgroundLaunch,
        logger,
      })
      // 未登录时直接抛 LoginRequiredError：此时不返回端口，调用方无从建立任何连接。
      await session.ensureLoggedIn()
      const shell = createShellPort({
        context: {
          channel: session.channel,
          logDir,
          timeoutMs: CONSOLE_ACTION_TIMEOUT_MS,
          pollIntervalMs: CONSOLE_POLL_INTERVAL_MS,
          clock,
          logger,
          instances: createInstanceListActions({
            channel: session.channel,
            logDir,
            timeoutMs: CONSOLE_ACTION_TIMEOUT_MS,
            pollIntervalMs: CONSOLE_POLL_INTERVAL_MS,
            clock,
            logger,
          }),
        },
        knownHostsPath: resolveKnownHostsPath(stateDir),
        connectTimeoutMs: DEFAULT_SHELL_CONNECT_TIMEOUT_MS,
        term,
      })
      return {
        shell,
        close: async () => {
          await session.close()
        },
      }
    },

    readProviderCapabilities: (providerId) => {
      if (providerId === AUTODL_PROVIDER_ID) {
        return { id: AUTODL_PROVIDER_ID, capabilities: AUTODL_CAPABILITIES }
      }
      throw new ConfigError(
        `未知的 provider：${providerId}。当前只接入了 ${AUTODL_PROVIDER_ID}。` +
          '部署配置的 provider 字段必须指向一个已接入的实现。',
      )
    },

    createStateStore: () =>
      createStateStore({
        stateDir,
        configDir,
        lockTimeoutMs: STATE_LOCK_TIMEOUT_MS,
        lockRetryIntervalMs: STATE_LOCK_RETRY_INTERVAL_MS,
        now: () => clock.now(),
        sleep: (milliseconds) => clock.sleep(milliseconds),
      }),

    loadProfiles: async () => {
      const result = await loadProfiles(resolveProfilesDir(configDir))
      return result.profiles
    },

    loadProject: async (projectId) =>
      await loadProject(resolveProjectsDir(configDir), projectId),

    readBalanceWarnBelowYuan: () => resolveBalanceWarnBelowYuan(env),
  }
}
