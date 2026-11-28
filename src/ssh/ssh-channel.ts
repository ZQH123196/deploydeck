import { createHash } from 'node:crypto'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { ConfigError, DeploydeckError, SshError } from '../errors.js'
import type {
  SshConnectRequest,
  SshSession,
  SshSessionConnector,
  SshSessionExecHandlers,
  SshSessionExecOutcome,
} from './channel.js'
import type {
  InteractiveShellSession,
  OpenShellOptions,
  ShellSessionHandlers,
  ShellSessionOutcome,
  TerminalSize,
} from './ports.js'

/**
 * ssh2 适配层。
 *
 * 整个仓库只有这里 import `ssh2`。连接、认证、主机密钥校验、命令输出流
 * 都包在 `SshSession` 接口后面；编排层（channel.ts）不认识 ssh2。
 *
 * 未实测：本环境不连任何真实 SSH。认证方式与 ssh2 的握手流程按文档实现，
 * 真机验证由人工发起。
 */

/** 连接或命令中断的原因只用于错误消息，不含任何凭据。 */
interface Ssh2Failure {
  readonly level?: string
  readonly code?: string
}

export function createSsh2Connector(): SshSessionConnector {
  return { connect: connectWithSsh2 }
}

/**
 * 主机公钥的 OpenSSH 指纹。
 *
 * ssh2 的 `hostVerifier` 收到的是 SSH 线格式的公钥字节。OpenSSH 的
 * `SHA256:` 指纹就是对其做 sha256、取 base64、去掉尾部填充。
 * 指纹和密码一样由调用方在握手阶段校验：先验主机，再认证。
 */
export function toOpenSshSha256Fingerprint(hostPublicKey: Buffer): string {
  const digest = createHash('sha256').update(hostPublicKey).digest('base64').replace(/=+$/, '')
  return `SHA256:${digest}`
}

async function connectWithSsh2(request: SshConnectRequest): Promise<SshSession> {
  const client = new Client()
  // 主机密钥校验要读指纹文件，是异步的；ssh2 允许在 hostVerifier 里回调。
  let verificationFailure: unknown
  let connectionFailure: Error | undefined

  // 常驻错误监听必须在 connect 之前挂上：否则认证失败之后的 error 事件没人接，
  // EventEmitter 会把它升级成进程崩溃。
  client.on('error', (error: Error) => {
    connectionFailure ??= error
  })

  const connectConfig: ConnectConfig = {
    host: request.host,
    port: request.port,
    username: request.user,
    password: request.password,
    readyTimeout: request.timeoutMs,
    hostVerifier: (hostPublicKey: Buffer, verify: (valid: boolean) => void) => {
      const fingerprint = toOpenSshSha256Fingerprint(hostPublicKey)
      request.verifyHostKey(fingerprint).then(
        () => {
          verify(true)
        },
        (error: unknown) => {
          verificationFailure = error
          verify(false)
        },
      )
    },
  }

  const ready = new Promise<void>((resolve, reject) => {
    client.once('ready', () => {
      resolve()
    })
    client.once('error', (error: Error) => {
      reject(mapConnectFailure(error, request, verificationFailure))
    })
    client.once('close', () => {
      reject(new SshError('SSH_CONNECT_FAILED', `SSH 连接在认证完成前关闭：${formatTarget(request)}。`))
    })
    client.connect(connectConfig)
  })

  try {
    await ready
  } catch (error: unknown) {
    // 握手失败时把半开的连接彻底拆掉，避免 socket 泄漏。
    client.end()
    client.destroy()
    throw error
  }

  return createSsh2Session(client, () => connectionFailure)
}

function createSsh2Session(client: Client, getConnectionFailure: () => Error | undefined): SshSession {
  let closed = false

  return {
    async exec(command: string, handlers: SshSessionExecHandlers): Promise<SshSessionExecOutcome> {
      if (closed) {
        throw new SshError('SSH_CONNECT_FAILED', 'SSH 会话已关闭，不能执行命令。')
      }
      const earlyFailure = getConnectionFailure()
      if (earlyFailure !== undefined) {
        throw mapSessionFailure(earlyFailure)
      }

      return await new Promise<SshSessionExecOutcome>((resolve, reject) => {
        let settled = false
        const settle = (action: () => void): void => {
          if (settled) {
            return
          }
          settled = true
          action()
        }

        client.exec(command, (error: Error | undefined, channel: ClientChannel) => {
          if (error !== undefined) {
            settle(() => {
              reject(mapSessionFailure(error))
            })
            return
          }
          channel.on('data', (chunk: Buffer) => {
            handlers.onStdout(chunk)
          })
          channel.stderr.on('data', (chunk: Buffer) => {
            handlers.onStderr(chunk)
          })
          channel.on('error', (streamError: Error) => {
            settle(() => {
              reject(mapSessionFailure(streamError))
            })
          })
          // ssh2 的 close 事件带和 exit 相同的参数：
          // 正常结束时是数字退出码，被信号杀死时是 null，连接先断时是 undefined。
          channel.on('close', (code?: number | null) => {
            settle(() => {
              if (typeof code === 'number') {
                resolve({ exitCode: code })
                return
              }
              if (code === null) {
                resolve({ exitCode: null })
                return
              }
              // 没拿到退出码，说明连接在命令执行中中断。命令是否已经生效未知，
              // 所以这不是「退出码未知的正常结束」，必须报错。
              reject(
                new SshError(
                  'SSH_CONNECT_FAILED',
                  'SSH 连接在命令执行期间中断，无法确认命令是否生效。本步不重试，请人工核对实例状态。',
                ),
              )
            })
          })
        })
      })
    },

    async close(): Promise<void> {
      if (closed) {
        return
      }
      closed = true
      // 每个 step 一次会话，不会再复用。end 之后立刻 destroy：远端挂住时也能保证
      // 超时路径不会卡在等 TCP 关闭上。
      client.end()
      client.destroy()
    },
  }
}

function mapConnectFailure(
  error: Error,
  request: SshConnectRequest,
  verificationFailure: unknown,
): DeploydeckError {
  // 指纹校验失败的原因由调用方给出（HostKeyChangedError 等），必须原样上抛。
  if (verificationFailure instanceof DeploydeckError) {
    return verificationFailure
  }
  if (isAuthenticationFailure(error)) {
    return new SshError(
      'SSH_AUTH_FAILED',
      `SSH 认证失败：${formatTarget(request)}。` +
        '密码取自控制台 SSH 登录列；若密码已修改，请重新读取凭据后重试。密码不会出现在任何日志或错误消息里。',
    )
  }
  return new SshError(
    'SSH_CONNECT_FAILED',
    `SSH 连接失败：${formatTarget(request)}（${describeFailure(error)}）。`,
  )
}

function mapSessionFailure(error: Error): DeploydeckError {
  if (error instanceof DeploydeckError) {
    return error
  }
  return new SshError(
    'SSH_CONNECT_FAILED',
    `SSH 会话失败（${describeFailure(error)}）。本步不重试，请人工核对网络与实例状态。`,
  )
}

function isAuthenticationFailure(error: Error): boolean {
  const failure = error as Error & Ssh2Failure
  return failure.level === 'client-authentication'
}

/**
 * 失败摘要。
 *
 * 只输出 ssh2 的层级与错误码，不输出 error.message：消息文本不由本仓库控制，
 * 万一其中带上凭据就会泄漏。
 */
function describeFailure(error: Error): string {
  const failure = error as Error & Ssh2Failure
  const parts: string[] = []
  if (typeof failure.level === 'string') {
    parts.push(`level=${failure.level}`)
  }
  if (typeof failure.code === 'string') {
    parts.push(`code=${failure.code}`)
  }
  return parts.length === 0 ? '连接或握手失败' : parts.join('，')
}

function formatTarget(request: SshConnectRequest): string {
  // user 与 host 都不是秘密；密码永远不进来。
  return `${request.user}@${request.host}:${request.port}`
}

/* ------------------------------------------------------------------ */
/* 交互式 shell（PTY）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 打开一条带 PTY 的 shell 通道。
 *
 * 判据：PTY 是硬性要求，不允许 `shell(false)` 的降级形态。
 * 没有 PTY 时远端不会回显、不处理方向键、`sudo` 与 `apt install` 的确认提示全部走不通，
 * 那等于给用户一个看起来像终端、实际不能用的东西。
 */
export async function connectShellWithSsh2(
  request: SshConnectRequest,
  handlers: ShellSessionHandlers,
  options: OpenShellOptions,
): Promise<InteractiveShellSession> {
  assertTerminalSize(options.size)
  const client = new Client()
  let connectionFailure: Error | undefined
  let verificationFailure: unknown

  // 错误监听必须在 connect 之前挂上：认证失败后的 error 事件没人接会让进程崩。
  client.on('error', (error: Error) => {
    connectionFailure ??= error
  })

  const connectConfig: ConnectConfig = {
    host: request.host,
    port: request.port,
    username: request.user,
    password: request.password,
    readyTimeout: request.timeoutMs,
    hostVerifier: (hostPublicKey: Buffer, verify: (valid: boolean) => void) => {
      const fingerprint = toOpenSshSha256Fingerprint(hostPublicKey)
      request.verifyHostKey(fingerprint).then(
        () => {
          verify(true)
        },
        (error: unknown) => {
          verificationFailure = error
          verify(false)
        },
      )
    },
  }

  const ready = new Promise<void>((resolve, reject) => {
    client.once('ready', () => {
      resolve()
    })
    client.once('error', (error: Error) => {
      reject(mapConnectFailure(error, request, verificationFailure))
    })
    client.once('close', () => {
      reject(new SshError('SSH_CONNECT_FAILED', `SSH 连接在认证完成前关闭：${formatTarget(request)}。`))
    })
    client.connect(connectConfig)
  })

  try {
    await ready
  } catch (error: unknown) {
    client.end()
    client.destroy()
    throw error
  }

  const channel = await new Promise<ClientChannel>((resolve, reject) => {
    client.shell(
      {
        rows: options.size.rows,
        cols: options.size.columns,
        term: options.term,
      },
      (error: Error | undefined, shellChannel: ClientChannel) => {
        if (error !== undefined) {
          reject(mapSessionFailure(error))
          return
        }
        resolve(shellChannel)
      },
    )
  }).catch((error: unknown) => {
    client.end()
    client.destroy()
    throw error instanceof DeploydeckError
      ? error
      : mapSessionFailure(error instanceof Error ? error : new Error(String(error)))
  })

  return createShellSession(client, channel, handlers, () => connectionFailure)
}

function createShellSession(
  client: Client,
  channel: ClientChannel,
  handlers: ShellSessionHandlers,
  getConnectionFailure: () => Error | undefined,
): InteractiveShellSession {
  let exitCode: number | null = null
  let receivedExitStatus = false
  let transportFailure: string | null = null
  let settled = false
  let closed = false
  let resolveWait: (outcome: ShellSessionOutcome) => void = () => undefined
  const waitPromise = new Promise<ShellSessionOutcome>((resolve) => {
    resolveWait = resolve
  })

  const settle = (): void => {
    if (settled) {
      return
    }
    settled = true
    resolveWait({
      exitCode: receivedExitStatus ? exitCode : null,
      transportFailure,
    })
  }

  channel.on('data', (chunk: Buffer) => {
    handlers.onData(chunk)
  })
  // PTY 下 stderr 已经合流到 stdout 通道；这里仍然订阅，
  // 因为非 PTY 的极端情况下 ssh2 会把错误写进 stderr。
  channel.stderr.on('data', (chunk: Buffer) => {
    handlers.onData(chunk)
  })
  channel.on('exit', (code?: number | null) => {
    receivedExitStatus = true
    exitCode = typeof code === 'number' ? code : null
  })
  channel.on('close', () => {
    const failure = getConnectionFailure()
    if (failure !== undefined && !receivedExitStatus) {
      transportFailure = describeFailure(failure)
    }
    settle()
  })
  channel.on('error', (streamError: Error) => {
    transportFailure = describeFailure(streamError)
    settle()
  })

  const close = (): void => {
    if (closed) {
      return
    }
    closed = true
    channel.close()
    channel.destroy()
    client.end()
    client.destroy()
    // 关闭后连接中断可能不再触发 close，直接把终态交出，避免 wait 永远挂着。
    if (transportFailure === null && !receivedExitStatus) {
      transportFailure = '会话被本地主动关闭'
    }
    settle()
  }

  return {
    write(data: Buffer): void {
      if (closed) {
        return
      }
      channel.stdin.write(data)
    },
    resize(size: TerminalSize): void {
      if (closed) {
        return
      }
      assertTerminalSize(size)
      channel.setWindow(size.rows, size.columns, 0, 0)
    },
    async wait(): Promise<ShellSessionOutcome> {
      return await waitPromise
    },
    async close(): Promise<void> {
      close()
    },
  }
}

/** 窗口尺寸必须是正整数。0 列或 0 行会让远端排版出空终端。 */
function assertTerminalSize(size: TerminalSize): void {
  for (const [name, value] of [
    ['columns', size.columns],
    ['rows', size.rows],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new ConfigError(`终端 ${name} 必须是正整数，收到 ${String(value)}。`)
    }
  }
}
