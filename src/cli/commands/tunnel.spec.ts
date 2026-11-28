import { createServer, type Server } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, TunnelLocalPortInUseError } from '../../errors.js'
import type { CredentialsPort } from '../../ssh/credentials.js'
import type { ForwardedPort } from '../../ssh/ssh-channel.js'
import { createStateStore } from '../../state/store.js'
import type { CliDependencies } from '../dependencies.js'
import type { OutputStream } from '../output.js'
import {
  parseTunnelPorts,
  runTunnel,
  TUNNEL_EVIDENCE_DIRECTORY,
  TUNNEL_LISTEN_HOST,
  TUNNEL_REMOTE_HOST,
  type TunnelCommandResult,
  type TunnelDependencies,
} from './tunnel.js'

/**
 * `tunnel` 命令的行为用例。
 *
 * 判据：
 * - 端口号必须是 1–65535 的十进制整数，非法即 `ConfigError`。
 * - 本地端口已被占用时立即报错，不静默重试、不换端口。这里用真实的回环监听占一个端口：
 *   它不发出任何网络流量，只是让 `EADDRINUSE` 真的出现，比模拟 errno 更能守住判据。
 * - 收到 SIGINT 时关转发、关凭据通道后正常返回，不抛错。
 * - 转发异常断开时报错，不当成正常退出。
 *
 * 隔离：不连 SSH、不连浏览器、不出网。唯一的「网络」是 127.0.0.1 上的监听与试绑。
 */

const INSTANCE_ID = 'af9c49bd44-8ee624d7'

const temporaryParents: string[] = []
const openServers: Server[] = []

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop()
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    }
  }
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

function createOutput(): { stream: OutputStream; text: () => string } {
  const parts: string[] = []
  return {
    stream: { write: (chunk: string) => parts.push(chunk) },
    text: () => parts.join(''),
  }
}

async function createTemporaryStateStore(): Promise<{
  readonly deps: CliDependencies
  readonly stdout: ReturnType<typeof createOutput>
  readonly logLines: string[]
}> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'tunnel-spec-'))
  temporaryParents.push(parent)
  const store = createStateStore({
    stateDir: join(parent, 'state'),
    configDir: join(parent, 'config'),
    lockTimeoutMs: 2000,
    lockRetryIntervalMs: 2,
  })
  const stdout = createOutput()
  const logLines: string[] = []
  const deps = {
    stateDir: join(parent, 'state'),
    clock: { now: () => Date.parse('2026-11-28T11:00:00+08:00'), sleep: async () => undefined },
    logger: {
      info: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
      warn: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
      error: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
    },
    stdout: stdout.stream,
    stderr: createOutput().stream,
    // 与真实装配同形：路径解析走 `commandEvidenceDir`，命令不自己拼。
    commandEvidenceDir: async (command: string, instanceId: string) =>
      await store.resolve(`${command}/${instanceId}`),
    createStateStore: () => store,
  } as unknown as CliDependencies
  return { deps, stdout, logLines }
}

/** 真占一个回环端口，返回端口号。用完由 afterEach 关闭。 */
async function occupyLocalPort(): Promise<number> {
  const server = createServer()
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: TUNNEL_LISTEN_HOST, port: 0 }, () => {
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('试占用端口后读不到端口号。')
  }
  return address.port
}

interface FakeTunnelDeps extends TunnelDependencies {
  readonly calls: string[]
  readonly signalHandlers: Map<NodeJS.Signals, () => void>
  readonly closed: { forwarding: number; credentials: number }
  readonly forwarded: Array<{
    instanceId: string
    localPort: number
    remotePort: number
    listenHost: string
    remoteHost: string
    logDir: string
  }>
}

function createFakeDeps(input: {
  /** 让转发自己结束的那种终态。`'abort'` 表示等到信号中止。 */
  readonly waitKind?: 'abort' | 'error'
  readonly failListen?: boolean
  readonly forwardError?: Error
}): FakeTunnelDeps {
  const calls: string[] = []
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  const closed = { forwarding: 0, credentials: 0 }
  const forwarded: FakeTunnelDeps['forwarded'] = []

  const credentials: CredentialsPort = {
    readCredentials: async () => ({
      host: 'region-44.autodl.com',
      port: 23456,
      user: 'root',
      password: 'zq7Kp2mNxR4t',
    }),
    close: async () => {
      closed.credentials += 1
      calls.push('credentials.close')
    },
  }

  return {
    calls,
    signalHandlers,
    closed,
    forwarded,
    assertLocalPortFree: async (localPort: number) => {
      calls.push(`assertLocalPortFree:${String(localPort)}`)
      if (input.failListen === true) {
        throw new TunnelLocalPortInUseError(localPort, `127.0.0.1:5432`)
      }
    },
    openCredentials: async () => {
      calls.push('openCredentials')
      return credentials
    },
    openForward: async (request): Promise<ForwardedPort> => {
      calls.push('openForward')
      forwarded.push({
        instanceId: request.instanceId,
        localPort: request.localPort,
        remotePort: request.remotePort,
        listenHost: request.listenHost,
        remoteHost: request.remoteHost,
        logDir: request.logDir,
      })
      if (input.forwardError !== undefined) {
        throw input.forwardError
      }
      return {
        localPort: request.localPort,
        wait: async () => {
          if (input.waitKind === 'error') {
            throw new Error('SSH 通道中断')
          }
          await new Promise<void>((resolve) => {
            request.signal.addEventListener('abort', () => {
              resolve()
            })
          })
        },
        close: async () => {
          closed.forwarding += 1
          calls.push('forward.close')
        },
      }
    },
    onSignal: (signal, handler) => {
      calls.push(`onSignal:${signal}`)
      signalHandlers.set(signal, handler)
      return () => {
        signalHandlers.delete(signal)
      }
    },
  }
}

describe('tunnel：端口参数校验', () => {
  it('端口必须是十进制整数且落在 1–65535', () => {
    for (const spec of ['0:5432', '5432:65536', '-1:5432', '5432:x', '5432:', ':5432', '1:2:3', '+22:22', ' 22:22']) {
      expect(() => parseTunnelPorts(spec), spec).toThrow(ConfigError)
    }
  })

  it('合法输入解析成本地端口与远端端口', () => {
    expect(parseTunnelPorts('5432:3306')).toEqual({ localPort: 5432, remotePort: 3306 })
  })
})

describe('tunnel：本地端口占用', () => {
  it('本地端口已被占用时立即报错，不开凭据通道、不重试', async () => {
    // Arrange：真占一个回环端口。
    const occupiedPort = await occupyLocalPort()
    const harness = await createTemporaryStateStore()
    const deps = createFakeDeps({})
    // 用真实占用检测覆盖假检测：判据是「占用即报错」，不是「假端口会报错」。
    const realDeps: TunnelDependencies = {
      ...deps,
      assertLocalPortFree: async (localPort, remotePort) => {
        const { createServer: create } = await import('node:net')
        const probe = create()
        try {
          await new Promise<void>((resolve, reject) => {
            probe.once('error', (error: NodeJS.ErrnoException) => {
              reject(
                error.code === 'EADDRINUSE'
                  ? new TunnelLocalPortInUseError(localPort, `127.0.0.1:${String(remotePort)}`)
                  : error,
              )
            })
            probe.listen({ host: TUNNEL_LISTEN_HOST, port: localPort }, () => {
              resolve()
            })
          })
        } finally {
          await new Promise<void>((resolve) => {
            probe.close(() => {
              resolve()
            })
          })
        }
      },
    }

    // Act
    const error = await runTunnel(
      { deps: harness.deps, json: false },
      { instanceId: INSTANCE_ID, portsSpec: `${String(occupiedPort)}:3306` },
      realDeps,
    ).catch((caught: unknown) => caught)

    // Assert：报端口占用，且停在最前一步。
    expect(error).toBeInstanceOf(TunnelLocalPortInUseError)
    // 判据证据：占用报错发生在凭据通道打开之前，一次重试都没有。
    expect(deps.calls).toEqual([])
  })

  it('试绑失败即抛错，不打开凭据通道也不开转发', async () => {
    const harness = await createTemporaryStateStore()
    const deps = createFakeDeps({ failListen: true })

    await expect(
      runTunnel(
        { deps: harness.deps, json: false },
        { instanceId: INSTANCE_ID, portsSpec: '5432:3306' },
        deps,
      ),
    ).rejects.toBeInstanceOf(TunnelLocalPortInUseError)

    expect(deps.calls).toEqual(['assertLocalPortFree:5432'])
  })
})

describe('tunnel：前台运行与清理', () => {
  it('收到 SIGINT 时关转发、关凭据通道后正常返回，只监听回环地址', async () => {
    // Arrange
    const harness = await createTemporaryStateStore()
    const deps = createFakeDeps({})

    // Act：在后台跑命令，等在转发建好后模拟 Ctrl+C。
    const tunnelPromise = runTunnel(
      { deps: harness.deps, json: true },
      { instanceId: INSTANCE_ID, portsSpec: '5432:3306' },
      deps,
    )
    await waitForCondition(() => deps.calls.includes('openForward'))
    const sigintHandler = deps.signalHandlers.get('SIGINT')
    expect(sigintHandler).toBeDefined()
    sigintHandler?.()
    await tunnelPromise

    // Assert
    expect(deps.forwarded[0]).toMatchObject({
      instanceId: INSTANCE_ID,
      localPort: 5432,
      remotePort: 3306,
      listenHost: TUNNEL_LISTEN_HOST,
      remoteHost: TUNNEL_REMOTE_HOST,
    })
    expect(deps.forwarded[0]?.logDir).toContain(TUNNEL_EVIDENCE_DIRECTORY)
    expect(deps.closed).toEqual({ forwarding: 1, credentials: 1 })
    // 信号监听在退出后解绑：进程不需要再被这个命令的回调拽住。
    expect(deps.signalHandlers.size).toBe(0)
    const payload = JSON.parse(harness.stdout.text()) as TunnelCommandResult
    expect(payload).toEqual({
      instanceId: INSTANCE_ID,
      localPort: 5432,
      remotePort: 3306,
      listenHost: TUNNEL_LISTEN_HOST,
      remoteHost: TUNNEL_REMOTE_HOST,
    })
  })

  it('重复的 SIGINT 只清理一次', async () => {
    const harness = await createTemporaryStateStore()
    const deps = createFakeDeps({})

    const tunnelPromise = runTunnel(
      { deps: harness.deps, json: false },
      { instanceId: INSTANCE_ID, portsSpec: '5432:3306' },
      deps,
    )
    await waitForCondition(() => deps.calls.includes('openForward'))
    const handler = deps.signalHandlers.get('SIGINT')
    handler?.()
    handler?.()
    await tunnelPromise

    expect(deps.closed.forwarding).toBe(1)
  })

  it('转发异常断开时报错，不当成正常退出', async () => {
    const harness = await createTemporaryStateStore()
    const deps = createFakeDeps({ waitKind: 'error' })

    await expect(
      runTunnel(
        { deps: harness.deps, json: false },
        { instanceId: INSTANCE_ID, portsSpec: '5432:3306' },
        deps,
      ),
    ).rejects.toThrow(/SSH 通道中断/)
    expect(deps.closed).toEqual({ forwarding: 1, credentials: 1 })
  })

  it('开转发失败时也关掉凭据通道，不留下打开的通道', async () => {
    const harness = await createTemporaryStateStore()
    const deps = createFakeDeps({ forwardError: new Error('指纹校验失败') })

    await expect(
      runTunnel(
        { deps: harness.deps, json: false },
        { instanceId: INSTANCE_ID, portsSpec: '5432:3306' },
        deps,
      ),
    ).rejects.toThrow(/指纹校验失败/)
    expect(deps.closed.credentials).toBe(1)
    expect(deps.signalHandlers.size).toBe(0)
  })
})

/**
 * 等一个条件成立。
 *
 * 只等内存里的标志位，不轮询网络：超时即失败，不会变成慢测试。
 * 上限 1000 毫秒，远低于快速测试的 3 秒上限。
 */
async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('等待条件超时。')
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 1)
    })
  }
}
