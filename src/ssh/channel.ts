import { once } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { finished } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import type { ConsoleRuntimeContext } from '../console/ports.js'
import { ConfigError, DeploydeckError, HostKeyChangedError, SshError } from '../errors.js'
import { systemClock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'
import { assertPositiveInteger } from '../util/validate.js'
import { readSshCredentials } from './credentials.js'
import { createKnownHosts } from './known-hosts.js'
import type { SshCredentials, SshExecOptions, SshExecResult, SshPort } from './ports.js'
import { createSsh2Connector } from './ssh-channel.js'

/**
 * SSH 数据面实现。
 *
 * 本文件负责编排：取凭据、建连接、跑命令、落盘、超时、重连。
 * 真实 `ssh2` 只在 `ssh-channel.ts` 的适配层出现；这里只依赖最小的 `SshSession` 接口，
 * 单测用它注入假连接，验证超时、落盘、重连与指纹校验。
 *
 * 每个 step 一次会话：`exec` 自己建连接，跑完就关。
 */

/**
 * 摘要保留的行数。尾部长摘要给人快速看到最后发生了什么，完整输出在日志文件里。
 * 改这个值必须同时改工单 07 与 spec 第 8 节的约定。
 */
export const TAIL_LINE_COUNT = 200

/**
 * 单行保留字符上限。
 *
 * 尾部只用于摘要。命令如果刷出一行几十兆的日志，整行留在内存里等于没有上限，
 * 所以保留下来的行超长即截断并加标记。
 */
const TAIL_LINE_MAX_CHARS = 4096
const LINE_TRUNCATION_MARKER = '…[本行超长，已截断]'

/** 建立一条 SSH 连接所需的事实。密码只在内存里传。 */
export interface SshConnectRequest {
  readonly instanceId: string
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  /** 连接建立（含握手与认证）的超时，毫秒。 */
  readonly timeoutMs: number
  /**
   * 校验主机密钥的 sha256 指纹。
   *
   * 必须在发送密码之前调用。抛错即拒绝连接；实现必须原样把它传给调用方，
   * 不能吞掉，否则指纹变化会退化成普通连接失败。
   */
  readonly verifyHostKey: (fingerprint: string) => Promise<void>
}

/** 命令输出回调。按到达顺序调用，每次一个数据块。 */
export interface SshSessionExecHandlers {
  onStdout(chunk: Buffer): void
  onStderr(chunk: Buffer): void
}

/** 命令结束的回执。被信号杀死时退出码为 null。 */
export interface SshSessionExecOutcome {
  readonly exitCode: number | null
}

/**
 * 最小连接接口。
 *
 * 真实实现在 `ssh-channel.ts`；单测用假实现。这里不出现 `ssh2` 的任何类型。
 */
export interface SshSession {
  /**
   * 执行一条命令。连接中断时 reject。
   *
   * `env` 只进本命令进程的环境，不拼进 `command`。实现方经 SSH 的 `env` 请求下发。
   *
   * 边界：注入是否成功**不可观测**。服务端可以按 `AcceptEnv` 白名单丢弃 `env` 请求，
   * 客户端收不到错误；ssh2 的 `reqEnv` 也不进排队，`reqExec` 紧随其后发出。
   * 所以实现方不得承诺「注入失败会报错」，调用方也不得依赖这个信号。
   * 需要判据时由命令自己以变量在场为前置条件（见 `PlannedStep.envNames` 的消费者）。
   */
  exec(
    command: string,
    handlers: SshSessionExecHandlers,
    env?: Readonly<Record<string, string>>,
  ): Promise<SshSessionExecOutcome>
  /** 关闭连接。重复调用必须安全。 */
  close(): Promise<void>
}

export interface SshSessionConnector {
  /** 建立一条已认证、已校验主机密钥的会话。 */
  connect(request: SshConnectRequest): Promise<SshSession>
}

export interface SshChannelOptions {
  readonly context: ConsoleRuntimeContext
  /** known-hosts 文件绝对路径。由装配方给出。 */
  readonly knownHostsPath: string
  readonly connectTimeoutMs: number
  /** 断线重连次数。本期固定 1。 */
  readonly reconnectAttempts: number
}

/**
 * 单测替换点。
 *
 * 生产装配只用 `createSshPort`：它把连接器固定成 `ssh2`。
 * 本入口导出是为了让单测注入假连接与假凭据读取，验证超时、落盘与重连策略。
 */
export interface SshChannelOverrides {
  readonly connector: SshSessionConnector
  /** 替换凭据来源。默认从控制台 SSH 登录列读。 */
  readonly readCredentials?: (instanceId: string) => Promise<SshCredentials>
}

/**
 * 创建 SSH 数据面。
 *
 * 配置在这里一次校验完：路径必须是绝对路径，超时与重连次数必须是正整数。
 * 猜默认值会让装配错误推迟到第一次连接才暴露。
 */
export function createSshPort(options: SshChannelOptions): SshPort {
  return createSshPortWithOverrides(options, { connector: createSsh2Connector() })
}

export function createSshPortWithOverrides(
  options: SshChannelOptions,
  overrides: SshChannelOverrides,
): SshPort {
  assertPositiveInteger(options.connectTimeoutMs, 'connectTimeoutMs')
  assertNonNegativeInteger(options.reconnectAttempts, 'reconnectAttempts')
  assertAbsolutePath(options.knownHostsPath, 'knownHostsPath')
  assertPositiveInteger(options.context.pollIntervalMs, 'context.pollIntervalMs')
  assertPositiveInteger(options.context.timeoutMs, 'context.timeoutMs')

  const context = options.context
  const connector = overrides.connector
  const knownHosts = createKnownHosts({ filePath: options.knownHostsPath })
  const readCredentials =
    overrides.readCredentials ?? (async (instanceId: string) => await readSshCredentials(context, instanceId))
  // 凭据只放内存：同一个实例的多个 step 不重复跑控制台。密码不落盘。
  const credentialsByInstance = new Map<string, SshCredentials>()
  const clock = context.clock ?? systemClock

  async function resolveCredentials(instanceId: string): Promise<SshCredentials> {
    const cached = credentialsByInstance.get(instanceId)
    if (cached !== undefined) {
      return cached
    }
    const credentials = await readCredentials(instanceId)
    credentialsByInstance.set(instanceId, credentials)
    return credentials
  }

  async function connectOnce(instanceId: string, credentials: SshCredentials): Promise<SshSession> {
    return await connector.connect({
      instanceId,
      host: credentials.host,
      port: credentials.port,
      user: credentials.user,
      password: credentials.password,
      timeoutMs: options.connectTimeoutMs,
      verifyHostKey: async (fingerprint: string) => {
        await knownHosts.verify({
          instanceId,
          host: credentials.host,
          port: credentials.port,
          fingerprint,
        })
      },
    })
  }

  /**
   * 建连接，失败按 `reconnectAttempts` 重试。
   *
   * 只重试「连接建立失败」。命令一旦开始执行就不重试：命令可能已经在远端跑过，
   * 重放会把它跑第二次。指纹变化与认证失败是确定性失败，不重试。
   */
  async function connectWithRetry(instanceId: string, credentials: SshCredentials): Promise<SshSession> {
    let attempt = 0
    for (;;) {
      attempt += 1
      try {
        return await connectOnce(instanceId, credentials)
      } catch (error: unknown) {
        if (!isRetryableConnectFailure(error) || attempt > options.reconnectAttempts) {
          throw error
        }
      }
    }
  }

  async function exec(
    instanceId: string,
    command: string,
    execOptions: SshExecOptions,
  ): Promise<SshExecResult> {
    assertNonEmptyText(instanceId, 'instanceId')
    assertNonEmptyText(command, 'command')
    assertPositiveNumber(execOptions.timeoutSeconds, 'options.timeoutSeconds')
    assertNonEmptyText(execOptions.logPath, 'options.logPath')

    const credentials = await resolveCredentials(instanceId)
    let session: SshSession
    try {
      session = await connectWithRetry(instanceId, credentials)
    } catch (error: unknown) {
      if (isAuthFailure(error)) {
        // 密码可能在控制台被改过。丢掉缓存，下一次 step 重新读，不在本次重试。
        credentialsByInstance.delete(instanceId)
      }
      throw error
    }

    const outputLog = await openOutputLog(execOptions.logPath)
    const stdoutTailBuffer = new TailBuffer(TAIL_LINE_COUNT)
    const stderrTailBuffer = new TailBuffer(TAIL_LINE_COUNT)
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdoutBytes = 0
    let stderrBytes = 0
    const startedAt = Date.now()

    let timeoutTimer: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutTimer = setTimeout(() => {
        resolve()
      }, execOptions.timeoutSeconds * 1000)
    })

    const execPromise = session.exec(
      command,
      {
        onStdout: (chunk: Buffer) => {
          stdoutBytes += chunk.length
          outputLog.write(chunk)
          stdoutTailBuffer.push(stdoutDecoder.write(chunk))
        },
        onStderr: (chunk: Buffer) => {
          stderrBytes += chunk.length
          outputLog.write(chunk)
          stderrTailBuffer.push(stderrDecoder.write(chunk))
        },
      },
      execOptions.env,
    )
    // 超时分支可能先返回，连接关闭后 execPromise 才会失败。先挂一个处理函数，避免未处理拒绝。
    execPromise.catch(() => undefined)

    let exitCode: number | null = null
    let didTimeOut = false
    try {
      const outcome = await Promise.race([
        execPromise.then((value) => ({ kind: 'completed' as const, value })),
        timeoutPromise.then(() => ({ kind: 'timeout' as const })),
      ])
      if (outcome.kind === 'completed') {
        exitCode = outcome.value.exitCode
      } else {
        didTimeOut = true
      }
    } catch (error: unknown) {
      // 命令执行中连接断了。不重连、不重放：命令可能已经生效，重放会把副作用做两遍。
      await closeSessionQuietly(session)
      await outputLog.close()
      throw error
    } finally {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer)
      }
    }

    // 每个 step 一次会话，跑完就关。超时分支同样走到这里：连接已被强杀，
    // 不在这里等 execPromise 收起（连接断了它可能永远不结束），迟到的输出由日志关闭标记挡掉。
    await closeSessionQuietly(session)

    const result: SshExecResult = {
      exitCode: didTimeOut ? null : exitCode,
      stdoutTail: finishTail(stdoutTailBuffer, stdoutDecoder),
      stderrTail: finishTail(stderrTailBuffer, stderrDecoder),
      stdoutBytes,
      stderrBytes,
      durationMs: Date.now() - startedAt,
      timedOut: didTimeOut,
    }
    await outputLog.close()
    return result
  }

  async function waitUntilReady(instanceId: string, timeoutMs: number): Promise<void> {
    assertNonEmptyText(instanceId, 'instanceId')
    assertPositiveInteger(timeoutMs, 'timeoutMs')
    let lastFailure = '尚未尝试连接'

    const outcome = await pollUntil<true>({
      description: `等待实例 ${instanceId} 的 SSH 就绪`,
      timeoutMs,
      intervalMs: context.pollIntervalMs,
      now: () => clock.now(),
      sleep: async (milliseconds: number) => {
        await clock.sleep(milliseconds)
      },
      probe: async () => {
        try {
          const credentials = await resolveCredentials(instanceId)
          const session = await connectOnce(instanceId, credentials)
          await closeSessionQuietly(session)
          return true
        } catch (error: unknown) {
          // 指纹变化不是「还没就绪」，它是需要人看的确定结论，立即上抛。
          if (error instanceof HostKeyChangedError) {
            throw error
          }
          lastFailure = describeFailure(error)
          // 上一次读到的凭据可能已经过期（实例重建会换端口，改密会换密码）。
          // 每次重试都重新读控制台：等待就绪本来就意味着「还没拿到可用凭据」。
          credentialsByInstance.delete(instanceId)
          return undefined
        }
      },
    })

    if (outcome.status === 'timeout') {
      throw new SshError(
        'SSH_CONNECT_FAILED',
        `实例 ${instanceId} 的 SSH 在 ${timeoutMs}ms 内未就绪。最后一次失败：${lastFailure}`,
      )
    }
  }

  return { exec, waitUntilReady }
}

/**
 * 尾部摘要。
 *
 * 只保留最后 `maxLines` 行。完整输出由 `OutputLog` 流式写盘，这里不攒全量。
 */
class TailBuffer {
  private readonly lines: string[] = []
  private partial = ''

  constructor(private readonly maxLines: number) {
    if (!Number.isInteger(maxLines) || maxLines <= 0) {
      throw new RangeError(`尾部行数必须是正整数，收到 ${maxLines}。`)
    }
  }

  push(text: string): void {
    if (text.length === 0) {
      return
    }
    let remaining = text
    for (;;) {
      const newlineIndex = remaining.indexOf('\n')
      if (newlineIndex < 0) {
        this.partial = appendCapped(this.partial, remaining)
        return
      }
      this.appendLine(this.partial + remaining.slice(0, newlineIndex))
      this.partial = ''
      remaining = remaining.slice(newlineIndex + 1)
      if (remaining.length === 0) {
        return
      }
    }
  }

  toText(): string {
    if (this.partial.length > 0) {
      this.appendLine(this.partial)
      this.partial = ''
    }
    return this.lines.join('\n')
  }

  private appendLine(line: string): void {
    this.lines.push(
      line.length > TAIL_LINE_MAX_CHARS
        ? `${line.slice(0, TAIL_LINE_MAX_CHARS)}${LINE_TRUNCATION_MARKER}`
        : line,
    )
    while (this.lines.length > this.maxLines) {
      this.lines.shift()
    }
  }
}

function appendCapped(current: string, addition: string): string {
  if (current.length >= TAIL_LINE_MAX_CHARS) {
    return current
  }
  const combined = current + addition
  return combined.length > TAIL_LINE_MAX_CHARS ? combined.slice(0, TAIL_LINE_MAX_CHARS) : combined
}

function finishTail(buffer: TailBuffer, decoder: StringDecoder): string {
  buffer.push(decoder.end())
  return buffer.toText()
}

interface OutputLog {
  write(chunk: Buffer): void
  close(): Promise<void>
}

/**
 * 打开完整输出日志。
 *
 * 流式写：每个数据块到达即写，不先攒在内存里。写盘失败在 `close` 时上抛，
 * 不能静默丢日志：日志是这一步的唯一现场。
 *
 * stdout 与 stderr 写进同一个文件，按到达顺序排列，不加任何前后缀：
 * 文件就是「这一步在远端屏幕上看到的全部输出」。要区分两路时读返回值的两个尾部。
 */
async function openOutputLog(logPath: string): Promise<OutputLog> {
  await mkdir(dirname(logPath), { recursive: true })
  const stream = createWriteStream(logPath)
  // `events.once` 在等待 open 时会因 error 事件 reject，打开失败能立即暴露。
  await once(stream, 'open')

  let failure: Error | undefined
  let ended = false
  stream.on('error', (error: Error) => {
    failure ??= error
  })

  return {
    write(chunk: Buffer): void {
      if (ended || failure !== undefined) {
        return
      }
      stream.write(chunk)
    },
    async close(): Promise<void> {
      if (ended) {
        return
      }
      ended = true
      if (failure === undefined) {
        stream.end()
        try {
          await finished(stream)
        } catch (error: unknown) {
          failure = error instanceof Error ? error : new Error(String(error))
        }
      } else {
        stream.destroy()
      }
      if (failure !== undefined) {
        throw new Error(`SSH 完整输出落盘失败：${logPath}（${failure.message}）`)
      }
    },
  }
}

async function closeSessionQuietly(session: SshSession): Promise<void> {
  try {
    await session.close()
  } catch {
    // 连接可能已经断开。关闭失败不改变本步结论，也不该盖住真正的失败原因。
  }
}

function isRetryableConnectFailure(error: unknown): boolean {
  // 指纹变化必须交给人工判断，重试只会再撞一次。
  if (error instanceof HostKeyChangedError) {
    return false
  }
  // 认证失败是确定性的：密码错就是错，重试不会变对，还可能触发平台限流。
  if (error instanceof DeploydeckError) {
    return error.code !== 'SSH_AUTH_FAILED'
  }
  return true
}

function isAuthFailure(error: unknown): boolean {
  return error instanceof DeploydeckError && error.code === 'SSH_AUTH_FAILED'
}

function describeFailure(error: unknown): string {
  if (error instanceof DeploydeckError) {
    return `${error.code}：${error.message}`
  }
  return '连接或凭据读取失败'
}

function assertAbsolutePath(value: string, name: string): void {
  if (value.length === 0 || !isAbsolute(value)) {
    throw new ConfigError(`${name} 必须是绝对路径，收到 ${JSON.stringify(value)}。`)
  }
}

function assertNonEmptyText(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new ConfigError(`${name} 不能为空。`)
  }
}


function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${name} 必须是非负整数，收到 ${value}。`)
  }
}

function assertPositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} 必须是正数，收到 ${value}。`)
  }
}
