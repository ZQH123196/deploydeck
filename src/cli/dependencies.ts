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
import {
  createInstanceListActions,
  readInstanceStatus,
  type InstanceStatusProbe,
} from '../console/instance-list.js'
import type { ConsoleRuntimeContext } from '../console/ports.js'
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
import { createSshPort } from '../ssh/channel.js'
import {
  createCredentialsPort,
  readSshCredentials,
  type CredentialsPort,
} from '../ssh/credentials.js'
import { createKnownHosts } from '../ssh/known-hosts.js'
import { forwardPortWithSsh2, type ForwardedPort } from '../ssh/ssh-channel.js'
import type { SshExecOptions, SshExecResult, SshShellPort } from '../ssh/ports.js'
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

/**
 * 建立 SSH 连接（含握手与认证）的超时，毫秒。
 *
 * 与 provider 装配里的同一个取值：`shell -- <command>` 与 `run` 的每一步走同一条数据面，
 * 两条入口对「建连多久算失败」不该给出不同答案。
 */
export const SSH_CONNECT_TIMEOUT_MS = 30_000

/** SSH 断线重连次数。本期固定 1，与 provider 装配同源。 */
export const SSH_RECONNECT_ATTEMPTS = 1

/** 一次 provider 会话。`close` 只关通道，不关浏览器：登录态要留到下一次运行。 */
export interface ProviderSession {
  readonly provider: Provider
  close(): Promise<void>
}

/**
 * 一次终端通道会话。
 *
 * `shell` 的交互形态只提供「开一条 shell」这一个动作。关闭会话即释放浏览器通道；
 * SSH 会话本身的关闭由返回的 `InteractiveShellSession.close()` 负责。
 *
 * `exec` 是同一批凭据下的数据面出口。它给非交互形态用：非交互形态不需要 PTY，
 * 需要的是「跑完一条命令拿退出码」。
 *
 * `readInstanceStatus` 是同一批凭据下的实例状态读数。非交互形态在 `exec` 之前用它判
 * 「实例在运行中」：`exec` 通道不带这条判断，而终端通道带了。判据只有一条
 * 「只连运行中的实例」，两种形态各自守一遍，读数走同一个控制台动作。
 */
export interface ShellSession {
  readonly shell: SshShellPort
  /** 与交互形态同一套凭据与指纹校验的数据面出口。 */
  exec(instanceId: string, command: string, options: SshExecOptions): Promise<SshExecResult>
  /** 读实例状态。不在列表里即抛 `InstanceNotFoundError`。 */
  readInstanceStatus(instanceId: string): Promise<InstanceStatusProbe>
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
   * 返回的 `exec` 是非交互形态的数据面出口，与 `shell` 共用一套凭据与指纹校验。
   */
  openShell(options: { readonly logDir: string; readonly term: string }): Promise<ShellSession>
  /**
   * 打开只读凭据通道。`creds` 命令经它取 SSH 登录信息。
   *
   * 与 `openShell` 共用同一个控制台会话入口：开控制台、判登录只有一份实现。
   * 调用方拿到端口后在 `finally` 里 `close()`。
   */
  openCredentials(options: { readonly logDir: string }): Promise<CredentialsPort>
  /**
   * 打开本地端口转发。`tunnel` 命令经它把远端端口接到本机。
   *
   * 凭据来源与主机密钥校验和 `exec`、`shell` 同源。`signal` 中止时实现方关掉通道。
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
  /**
   * 在一条 provider 会话里跑一段动作。开、调、关三件事只在这里发生一次。
   *
   * 判据（会话生命周期只有一个来源）：命令不自己 `openProvider`/`close`。
   * 否则迟早有一条命令忘了关，或者关了两次。
   */
  withProvider<Result>(
    logDir: string,
    action: (provider: Provider) => Promise<Result>,
  ): Promise<Result>
  /**
   * 不带 run 的命令的证据目录：`<stateDir>/<命令名>/<instanceId>`。
   *
   * 判据：`runs/` 下只允许有 `<runId>` 一级目录。命令证据塞进 `runs/` 会让
   * 「runs 目录里有什么」这个判据失去意义。
   */
  commandEvidenceDir(command: string, instanceId: string): Promise<string>
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

    /**
     * 开一次已登录的控制台会话。
     *
     * 判据（三处共用，不各写一套）：
     * 1. 它只负责「开控制台、判登录、给出运转上下文」，不建任何具体端口。
     *    端口由调用方按需建（`shell` 建终端与数据面端口，`creds` 建凭据端口，`tunnel` 建转发）。
     * 2. 它返回可关闭的会话。调用方必须在 `finally` 里关它：关了一个另一个还开着，
     *    就会在同一个登录态上留下两个 Chrome 标签页。
     * 3. 一次命令调用只调一次。同一条命令开两次等于两个标签页，第二个容易读到脏状态。
     */
    const openConsoleActionSession = async (
      logDir: string,
    ): Promise<{ readonly context: ConsoleRuntimeContext; close(): Promise<void> }> => {
      const session = await openConsoleSession({
        consoleUrl: CONSOLE_INSTANCE_LIST_URL,
        port: resolveCdpPort(env),
        chromeProfileDir: await resolveChromeProfileDir(),
        backgroundLaunch,
        logger,
      })
      // 未登录时直接抛 LoginRequiredError：此时不返回端口，调用方无从建立任何连接。
      await session.ensureLoggedIn()
      const context: ConsoleRuntimeContext = {
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
      }
      return {
        context,
        close: async () => {
          await session.close()
        },
      }
    }

    const realOpenProvider = async (logDir: string): Promise<ProviderSession> => {
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
    }

  return {
    configDir,
    stateDir,
    consoleUrl: CONSOLE_INSTANCE_LIST_URL,
    clock,
    logger,
    stdout,
    stderr,

    openProvider: async ({ logDir }) => await realOpenProvider(logDir),

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
      const session = await openConsoleActionSession(logDir)
      const shellContext = session.context
      const shell = createShellPort({
        context: shellContext,
        knownHostsPath: resolveKnownHostsPath(stateDir),
        connectTimeoutMs: DEFAULT_SHELL_CONNECT_TIMEOUT_MS,
        term,
      })
      // 非交互形态走数据面：与终端通道同一套凭据来源、同一份 known-hosts。
      const ssh = createSshPort({
        context: shellContext,
        knownHostsPath: resolveKnownHostsPath(stateDir),
        connectTimeoutMs: SSH_CONNECT_TIMEOUT_MS,
        reconnectAttempts: SSH_RECONNECT_ATTEMPTS,
      })
      return {
        shell,
        exec: async (instanceId, command, execOptions) =>
          await ssh.exec(instanceId, command, execOptions),
        // 与终端通道同一条状态读数：`createShellPort` 里的运行中判断用的就是它，
        // 这里把它交出去，非交互形态才不会绕过这条判据。
        readInstanceStatus: async (instanceId) =>
          await readInstanceStatus(shellContext.channel, instanceId),
        close: async () => {
          await session.close()
        },
      }
    },

    /**
     * 开一次控制台会话，交给调用方取凭据。`creds` 命令经它读 SSH 登录信息。
     *
     * 端口从这里按需建：本函数只管会话与凭据读取，不决定命令要拿凭据做什么。
     */
    openCredentials: async ({ logDir }) => {
      const session = await openConsoleActionSession(logDir)
      const port = createCredentialsPort(
        async (instanceId) => await readSshCredentials(session.context, instanceId),
        async () => {
          await session.close()
        },
      )
      return port
    },

    /**
     * 开一次本地端口转发。`tunnel` 命令经它把远端端口接到本机。
     *
     * 判据：
     * - 凭据来源与 `shell`/`creds` 同一个：`readSshCredentials` 读控制台 SSH 登录列。
     * - 主机密钥指纹校验用同一份 known-hosts 文件，与 `exec`、`shell` 完全一致。
     *   转发等于把远端当成本地可信网络，不验指纹就是把自己的一半网络交给不确定的主机。
     * - 端口被占用由实现方翻译成 `TunnelLocalPortInUseError`，这里不再二次判定。
     */
    openForward: async (request) => {
      const session = await openConsoleActionSession(request.logDir)
      let forwarded: ForwardedPort
      try {
        const credentials = await readSshCredentials(session.context, request.instanceId)
        const knownHosts = createKnownHosts({ filePath: resolveKnownHostsPath(stateDir) })
        forwarded = await forwardPortWithSsh2({
          instanceId: request.instanceId,
          host: credentials.host,
          port: credentials.port,
          user: credentials.user,
          password: credentials.password,
          timeoutMs: SSH_CONNECT_TIMEOUT_MS,
          verifyHostKey: async (fingerprint: string) => {
            await knownHosts.verify({
              instanceId: request.instanceId,
              host: credentials.host,
              port: credentials.port,
              fingerprint,
            })
          },
          listenHost: request.listenHost,
          localPort: request.localPort,
          remoteHost: request.remoteHost,
          remotePort: request.remotePort,
          signal: request.signal,
        })
      } catch (error: unknown) {
        await session.close()
        throw error
      }
      // 凭据到手、转发建好，浏览器会话立刻关：转发是独立的 SSH 连接，不需要控制台。
      // 判据：让 Chrome 跟着转发一直挂着，等于把登录态暴露在整个转发会话期间，
      // 而转发本身把远端当成本地可信网络 —— 那段时间留着浏览器没有任何用处，只是风险面。
      // 所以 `ForwardedPort` 的生命周期不等于 `ConsoleSession` 的生命周期。
      await session.close()
      return forwarded
    },

    /**
     * 在一条 provider 会话里跑一段动作。
     *
     * 判据（会话生命周期只有一个来源）：开、调、关三件事只在装配方发生一次。
     * 命令只给 `logDir` 与动作函数，不自己 `open`/`close` ——
     * 否则迟早有一条命令忘了关，或者关了两次。
     */
    withProvider: async (logDir, action) => {
      const session = await realOpenProvider(logDir)
      try {
        return await action(session.provider)
      } finally {
        await session.close()
      }
    },

    /**
     * 不带 run 的命令的证据目录：`<stateDir>/<命令名>/<instanceId>`。
     *
     * 判据：`runs/` 下只允许有 `<runId>` 一级目录，那里是「一次 run 执行的现场」。
     * 命令证据塞进 `runs/` 会把「runs 目录里有什么」这个判据弄脏。
     */
    commandEvidenceDir: async (command, instanceId) => {
      assertEvidenceCommandName(command)
      return await createStateStore({
        stateDir,
        configDir,
        lockTimeoutMs: STATE_LOCK_TIMEOUT_MS,
        lockRetryIntervalMs: STATE_LOCK_RETRY_INTERVAL_MS,
        now: () => clock.now(),
        sleep: (milliseconds) => clock.sleep(milliseconds),
      }).resolve(`${command}/${instanceId}`)
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

/**
 * 证据目录的命令名只允许单段文件名。
 *
 * 判据：命令名会拼进状态路径，出现路径分隔符或 `..` 就会写到状态目录之外。
 * 取值来自本文件里的常量（`power`、`switch` 等），这里防的是以后有人用外部输入拼它。
 */
function assertEvidenceCommandName(command: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(command)) {
    throw new ConfigError(
      `证据目录的命令名只允许小写字母、数字与连字符，当前值：${JSON.stringify(command)}。`,
    )
  }
}
