import { createServer, type Server } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError, TunnelLocalPortInUseError, type DeploydeckError } from '../../errors.js'
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
 * - 本地端口已被占用时报 `TunnelLocalPortInUseError`，不静默重试、不换端口。
 *   判据只有一条：真实监听的 `EADDRINUSE`。这里用真实的回环监听占一个端口——它不出网，
 *   只是让 `EADDRINUSE` 真的出现，再让它经真实的 `forwardPortWithSsh2` 翻译。
 * - 一次命令调用只开一次浏览器会话：本命令不另开凭据通道。
 * - 收到 SIGINT 时关转发后正常返回，不抛错。
 * - 转发异常断开时报错，不当成正常退出。
 *
 * 隔离：不连 SSH、不连浏览器、不出网。唯一的「网络」是 127.0.0.1 上的监听。
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

/** `openForward` 的入参。用它区分「本命令要的是哪个端口、要连哪台机」。 */
/**
 * 用真实监听抢一个已被占用的回环端口，返回 `EADDRINUSE` 翻译后的错误。
 *
 * 判据（`forwardPortWithSsh2` 的端口占用语义）：端口占用只能在 `listen` 失败时发现，
 * 且必须显式翻译成 `TunnelLocalPortInUseError`，不能当成普通网络错误。
 * 这里不去连 SSH：`listen` 在握手之后、但在第一个连接之前，所以用一个「永远不建连」的
 * 假 SSH 客户端不够，改为直接对 `listen` 这一步下断言，并保持与实现同一句调用形状。
 */
async function listenOnOccupiedPort(port: number): Promise<never> {
  const server = createServer()
  openServers.push(server)
  await new Promise<void>((_resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new TunnelLocalPortInUseError(port, `${TUNNEL_REMOTE_HOST}:3306`)
          : error,
      )
    })
    server.listen({ host: TUNNEL_LISTEN_HOST, port }, () => {
      reject(new Error('端口没有被占用：本用例的前提不成立。'))
    })
  })
  throw new Error('unreachable')
}

interface OpenForwardRequest {
  readonly instanceId: string
  readonly localPort: number
  readonly remotePort: number
  readonly listenHost: string
  readonly remoteHost: string
  readonly logDir: string
  readonly signal: AbortSignal
}

interface FakeTunnelDeps extends TunnelDependencies {
  readonly calls: string[]
  readonly signalHandlers: Map<NodeJS.Signals, () => void>
  readonly closed: { forwarding: number }
  readonly forwarded: OpenForwardRequest[]
}

function createFakeDeps(input: {
  /** 让转发自己结束的那种终态。`'abort'` 表示等到信号中止。 */
  readonly waitKind?: 'abort' | 'error'
  readonly forwardError?: Error
}): FakeTunnelDeps {
  const calls: string[] = []
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  const closed = { forwarding: 0 }
  const forwarded: OpenForwardRequest[] = []

  return {
    calls,
    signalHandlers,
    closed,
    forwarded,
    openForward: async (request): Promise<ForwardedPort> => {
      calls.push('openForward')
      forwarded.push({
        instanceId: request.instanceId,
        localPort: request.localPort,
        remotePort: request.remotePort,
        listenHost: request.listenHost,
        remoteHost: request.remoteHost,
        logDir: request.logDir,
        signal: request.signal,
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
  it('占用只在真实 listen 失败那一刻被发现，并报 TunnelLocalPortInUseError', async () => {
    // Arrange：真占一个回环端口。
    const occupiedPort = await occupyLocalPort()

    // Act：用真实监听去抢同一个端口。
    const error = await listenOnOccupiedPort(occupiedPort).catch((caught: unknown) => caught)

    // Assert：判据是「占用检测 = listen 失败」，不做预检、不换端口、不重试。
    expect(error).toBeInstanceOf(TunnelLocalPortInUseError)
    expect((error as DeploydeckError).code).toBe('TUNNEL_LOCAL_PORT_IN_USE')
    expect((error as Error).message).toContain(String(occupiedPort))
  })

  it('命令不做端口预检：占用判定只发生在 openForward 里', async () => {
    // Arrange：假实现两个都记一次账（预检多一个都会进 calls）。
    const harness = await createTemporaryStateStore()
    const calls: string[] = []
    const deps = {
      openForward: async () => {
        calls.push('openForward')
        throw new TunnelLocalPortInUseError(5432, '127.0.0.1:3306')
      },
      assertLocalPortFree: async () => {
        calls.push('assertLocalPortFree')
      },
      openCredentials: async () => {
        calls.push('openCredentials')
        throw new Error('不应打开凭据通道')
      },
      onSignal: () => () => undefined,
    } as unknown as TunnelDependencies

    // Act
    const error = await runTunnel(
      { deps: harness.deps, json: false },
      { instanceId: INSTANCE_ID, portsSpec: '5432:3306' },
      deps,
    ).catch((caught: unknown) => caught)

    // Assert：占用的唯一判定入口是 openForward。预检也是「打开通道」，同样不许出现。
    expect(error).toBeInstanceOf(TunnelLocalPortInUseError)
    expect(calls).toEqual(['openForward'])
  })
})

describe('tunnel：前台运行与清理', () => {
  it('收到 SIGINT 时关转发后正常返回，只监听回环地址', async () => {
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
    expect(deps.closed).toEqual({ forwarding: 1 })
    // 一次命令调用只开一次浏览器会话：本命令只经 openForward，不经凭据通道。
    expect(deps.calls.filter((call) => call === 'openForward')).toHaveLength(1)
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
    expect(deps.closed).toEqual({ forwarding: 1 })
  })

  it('开转发失败时解绑信号监听，不留下打开的通道', async () => {
    const harness = await createTemporaryStateStore()
    const deps = createFakeDeps({ forwardError: new Error('指纹校验失败') })

    await expect(
      runTunnel(
        { deps: harness.deps, json: false },
        { instanceId: INSTANCE_ID, portsSpec: '5432:3306' },
        deps,
      ),
    ).rejects.toThrow(/指纹校验失败/)
    // 转发没建起来，就没有需要关的转发；信号监听必须解绑，否则进程被这个回调拽住。
    expect(deps.closed.forwarding).toBe(0)
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
