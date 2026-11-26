import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleChannel, ConsoleRuntimeContext } from '../console/ports.js'
import { InstanceNotRunningError } from '../errors.js'
import type { Clock } from '../util/clock.js'
import type {
  InteractiveShellSession,
  OpenShellOptions,
  ShellSessionHandlers,
  ShellSessionOutcome,
  SshCredentials,
  SshShellPort,
} from './ports.js'
import {
  createShellPortWithOverrides,
  formatShellBanner,
  readTerminalSize,
  requireShellExitCode,
  type ShellChannelOptions,
} from './shell-channel.js'

/**
 * 全部用例只对假连接执行：不连真实 SSH、不连浏览器。
 * 密码用哨兵串，任何地方出现它都说明泄漏。
 */
const SENTINEL_PASSWORD = 'sentinel-password-not-real-7f3a'
const TEST_HOST = 'region-test.autodl.com'
const TEST_PORT = 2222
const TEST_INSTANCE_ID = 'af9c49bd44-8ee624d7'
const FINGERPRINT = `SHA256:${'A'.repeat(43)}`

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

async function createKnownHostsPath(): Promise<string> {
  const base = join(process.cwd(), '.tmp')
  await mkdir(base, { recursive: true })
  const parent = await mkdtemp(join(base, 'shell-channel-spec-'))
  temporaryParents.push(parent)
  return join(parent, 'ssh-known-hosts.txt')
}

const credentials: SshCredentials = {
  host: TEST_HOST,
  port: TEST_PORT,
  user: 'root',
  password: SENTINEL_PASSWORD,
}

interface FakeConnectorCalls {
  readonly requests: Array<{
    readonly instanceId: string
    readonly host: string
    readonly port: number
    readonly user: string
    readonly password: string
  }>
  readonly options: OpenShellOptions[]
}

/** 假连接：记录请求，交回一个可写的假会话。 */
function createFakeConnector(behaviour: {
  readonly onHostKey?: (fingerprint: string) => Promise<void>
  readonly session?: InteractiveShellSession
} = {}): {
  readonly connector: Parameters<typeof createShellPortWithOverrides>[1]['connector']
  readonly calls: FakeConnectorCalls
} {
  const calls: FakeConnectorCalls = { requests: [], options: [] }
  const connector: Parameters<typeof createShellPortWithOverrides>[1]['connector'] = async (
    request,
    _handlers,
    options,
  ) => {
    calls.requests.push({
      instanceId: request.instanceId,
      host: request.host,
      port: request.port,
      user: request.user,
      password: request.password,
    })
    calls.options.push(options)
    if (behaviour.onHostKey !== undefined) {
      // 真实适配层在握手阶段回调 verifyHostKey；这里直接走一遍，覆盖指纹校验路径。
      await request.verifyHostKey(FINGERPRINT)
    }
    return (
      behaviour.session ?? {
        write: () => undefined,
        resize: () => undefined,
        wait: async () => ({ exitCode: 0, transportFailure: null }),
        close: async () => undefined,
      }
    )
  }
  return { connector, calls }
}

function createOptions(
  knownHostsPath: string,
): ShellChannelOptions {
  const clock: Clock = { now: () => Date.parse('2026-01-01T00:00:00+08:00'), sleep: async () => undefined }
  const context: ConsoleRuntimeContext = {
    channel: undefined as unknown as ConsoleChannel,
    instances: { listInstances: async () => [] },
    logDir: 'run-log',
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
    clock,
  }
  return { context, knownHostsPath, connectTimeoutMs: 15_000 }
}

function createPort(options: {
  readonly status: string
  readonly statusRaw: string
  readonly connector: Parameters<typeof createShellPortWithOverrides>[1]['connector']
  readonly knownHostsPath: string
}): SshShellPort {
  return createShellPortWithOverrides(createOptions(options.knownHostsPath), {
    connector: options.connector,
    readCredentials: async () => credentials,
    readStatus: async () => ({ status: options.status, statusRaw: options.statusRaw }),
  })
}

describe('createShellPort：连接前置校验', () => {
  it('实例已关机时抛 InstanceNotRunningError，且不建立 SSH 连接', async () => {
    const knownHostsPath = await createKnownHostsPath()
    const fake = createFakeConnector()
    const port = createPort({
      status: 'stopped',
      statusRaw: '已关机',
      connector: fake.connector,
      knownHostsPath,
    })

    await expect(
      port.openShell(TEST_INSTANCE_ID, { onData: () => undefined }, { size: { columns: 80, rows: 24 }, term: 'xterm' }),
    ).rejects.toBeInstanceOf(InstanceNotRunningError)

    expect(fake.calls.requests).toEqual([])
  })

  it('状态是 unknown 时同样拒绝：unknown 不是安全状态', async () => {
    const knownHostsPath = await createKnownHostsPath()
    const fake = createFakeConnector()
    const port = createPort({
      status: 'unknown',
      statusRaw: '未知',
      connector: fake.connector,
      knownHostsPath,
    })

    await expect(
      port.openShell(TEST_INSTANCE_ID, { onData: () => undefined }, { size: { columns: 80, rows: 24 }, term: 'xterm' }),
    ).rejects.toBeInstanceOf(InstanceNotRunningError)
    expect(fake.calls.requests).toEqual([])
  })

  it('实例运行时建立连接，并用控制台凭据与首次指纹', async () => {
    const knownHostsPath = await createKnownHostsPath()
    const fake = createFakeConnector({ onHostKey: async (fingerprint) => {
      expect(fingerprint).toBe(FINGERPRINT)
    } })
    const port = createPort({
      status: 'running',
      statusRaw: '运行中',
      connector: fake.connector,
      knownHostsPath,
    })

    const session = await port.openShell(
      TEST_INSTANCE_ID,
      { onData: () => undefined },
      { size: { columns: 120, rows: 40 }, term: 'xterm-256color' },
    )

    expect(session).toBeDefined()
    expect(fake.calls.requests).toEqual([
      {
        instanceId: TEST_INSTANCE_ID,
        host: TEST_HOST,
        port: TEST_PORT,
        user: 'root',
        password: SENTINEL_PASSWORD,
      },
    ])
    expect(fake.calls.options).toEqual([
      { size: { columns: 120, rows: 40 }, term: 'xterm-256color' },
    ])
  })
})

describe('readTerminalSize', () => {
  it('有 rows 与 columns 时直接采用', () => {
    expect(readTerminalSize({ columns: 132, rows: 43 })).toEqual({ columns: 132, rows: 43 })
  })

  it('没有 tty 尺寸时回落到 80x24，而不是 0x0', () => {
    expect(readTerminalSize({})).toEqual({ columns: 80, rows: 24 })
  })

  it('非法尺寸按缺失处理', () => {
    expect(readTerminalSize({ columns: 0, rows: -1 })).toEqual({ columns: 80, rows: 24 })
  })
})

describe('requireShellExitCode', () => {
  it('拿到退出码时原样返回', () => {
    const outcome: ShellSessionOutcome = { exitCode: 3, transportFailure: null }
    expect(requireShellExitCode(outcome)).toBe(3)
  })

  it('没拿到退出码时抛错，不当成 0', () => {
    const outcome: ShellSessionOutcome = { exitCode: null, transportFailure: '连接中断' }
    expect(() => requireShellExitCode(outcome)).toThrow(/连接中断/)
  })
})

describe('formatShellBanner', () => {
  it('写出实例 ID，回答「我连到哪台机」', () => {
    const text = formatShellBanner({ instanceId: TEST_INSTANCE_ID })
    expect(text).toContain(TEST_INSTANCE_ID)
    expect(text).toContain('Ctrl-D')
  })

  it('不写 SSH 主机与用户名：欢迎行可能被截屏', () => {
    const text = formatShellBanner({ instanceId: TEST_INSTANCE_ID })
    expect(text).not.toContain(TEST_HOST)
    expect(text).not.toContain('root@')
  })
})

describe('createShellPort：数据转发', () => {
  it('把远端输出交给回调，把本地输入交给会话', async () => {
    const knownHostsPath = await createKnownHostsPath()
    const chunks: string[] = []
    const written: string[] = []
    let emitData: ((chunk: Buffer) => void) | undefined
    let resolveWait: ((outcome: ShellSessionOutcome) => void) | undefined

    const session: InteractiveShellSession = {
      write: (data) => {
        written.push(data.toString('utf8'))
      },
      resize: () => undefined,
      wait: async () =>
        await new Promise<ShellSessionOutcome>((resolve) => {
          resolveWait = resolve
        }),
      close: async () => undefined,
    }

    const connector: Parameters<typeof createShellPortWithOverrides>[1]['connector'] = async (
      _request,
      handlers: ShellSessionHandlers,
    ) => {
      emitData = handlers.onData
      return session
    }

    const port = createPort({
      status: 'running',
      statusRaw: '运行中',
      connector,
      knownHostsPath,
    })
    await port.openShell(
      TEST_INSTANCE_ID,
      { onData: (chunk) => chunks.push(chunk.toString('utf8')) },
      { size: { columns: 80, rows: 24 }, term: 'xterm' },
    )

    emitData?.(Buffer.from('root@autodl:~# ', 'utf8'))
    session.write(Buffer.from('ls\n', 'utf8'))
    resolveWait?.({ exitCode: 0, transportFailure: null })

    expect(chunks.join('')).toBe('root@autodl:~# ')
    expect(written.join('')).toBe('ls\n')
  })
})
