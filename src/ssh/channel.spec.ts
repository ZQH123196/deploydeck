import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleChannel, ConsoleRuntimeContext } from '../console/ports.js'
import { ConfigError, HostKeyChangedError, SshError } from '../errors.js'
import type { Clock } from '../util/clock.js'
import {
  createSshPortWithOverrides,
  type SshChannelOptions,
  type SshConnectRequest,
  type SshSession,
  type SshSessionConnector,
  type SshSessionExecHandlers,
  type SshSessionExecOutcome,
} from './channel.js'
import { createKnownHosts } from './known-hosts.js'
import type { SshCredentials, SshPort } from './ports.js'

/**
 * 全部用例只对假连接执行：不连真实 SSH、不连浏览器。
 * 密码用哨兵串，任何地方出现它都说明泄漏。
 */
const SENTINEL_PASSWORD = 'sentinel-password-not-real-7f3a'
const TEST_HOST = 'region-test.autodl.com'
const TEST_PORT = 2222
const TEST_INSTANCE_ID = 'af9c49bd44-8ee624d7'
/** 合法形状的指纹：SHA256: 加 43 位 base64。 */
const FINGERPRINT_FIRST = `SHA256:${'A'.repeat(43)}`
const FINGERPRINT_SECOND = `SHA256:${'B'.repeat(43)}`

const credentials: SshCredentials = {
  host: TEST_HOST,
  port: TEST_PORT,
  user: 'root',
  password: SENTINEL_PASSWORD,
}

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

async function createTemporaryParent(): Promise<string> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'ssh-channel-spec-'))
  temporaryParents.push(parent)
  return parent
}

interface FakeSessionBehavior {
  readonly stdout?: readonly string[]
  readonly stderr?: readonly string[]
  readonly exitCode?: number | null
  /** 命令永不结束，直到连接被关闭。 */
  readonly hang?: boolean
  /** 输出之后连接中断。 */
  readonly failWith?: Error
}

class FakeSession implements SshSession {
  closed = false
  private rejectHanging: ((error: Error) => void) | undefined

  constructor(private readonly behavior: FakeSessionBehavior) {}

  async exec(_command: string, handlers: SshSessionExecHandlers): Promise<SshSessionExecOutcome> {
    for (const chunk of this.behavior.stdout ?? []) {
      handlers.onStdout(Buffer.from(chunk, 'utf8'))
    }
    for (const chunk of this.behavior.stderr ?? []) {
      handlers.onStderr(Buffer.from(chunk, 'utf8'))
    }
    if (this.behavior.failWith !== undefined) {
      throw this.behavior.failWith
    }
    if (this.behavior.hang === true) {
      return await new Promise<SshSessionExecOutcome>((_resolve, reject) => {
        this.rejectHanging = reject
      })
    }
    return { exitCode: this.behavior.exitCode ?? 0 }
  }

  async close(): Promise<void> {
    this.closed = true
    this.rejectHanging?.(new SshError('SSH_CONNECT_FAILED', '连接已被测试关闭。'))
    this.rejectHanging = undefined
  }
}

type ConnectorStep = (request: SshConnectRequest) => Promise<SshSession>

class FakeConnector implements SshSessionConnector {
  readonly requests: SshConnectRequest[] = []
  readonly sessions: FakeSession[] = []
  private stepIndex = 0

  constructor(private readonly steps: readonly ConnectorStep[]) {}

  async connect(request: SshConnectRequest): Promise<SshSession> {
    // 计划用完后重复最后一步：超时用例要连接很多次。
    const step = this.steps[this.stepIndex] ?? this.steps[this.steps.length - 1]
    this.stepIndex += 1
    if (step === undefined) {
      throw new Error('测试计划里没有连接步骤。')
    }
    this.requests.push(request)
    const session = await step(request)
    if (session instanceof FakeSession) {
      this.sessions.push(session)
    }
    return session
  }
}

function sessionStep(behavior: FakeSessionBehavior): ConnectorStep {
  return async () => new FakeSession(behavior)
}

function failureStep(error: Error): ConnectorStep {
  return async () => {
    throw error
  }
}

function verifyThenSessionStep(fingerprint: string, behavior: FakeSessionBehavior = {}): ConnectorStep {
  return async (request) => {
    await request.verifyHostKey(fingerprint)
    return new FakeSession(behavior)
  }
}

function createContext(clock?: Clock): ConsoleRuntimeContext {
  const channel: ConsoleChannel = {
    goto: async () => {},
    currentUrl: async () => '',
    // 本 spec 不读页面：凭据读取被替换成假实现。
    evaluate: async <Result>(): Promise<Result> => {
      throw new Error('本用例不读页面。')
    },
    click: async () => {},
    type: async () => {},
    waitFor: async () => {},
    waitForGone: async () => {},
    screenshot: async () => {},
    close: async () => {},
  }
  return {
    channel,
    logDir: join(process.cwd(), '.tmp', 'ssh-channel-spec-logdir'),
    timeoutMs: 1000,
    pollIntervalMs: 10,
    instances: { listInstances: async () => [] },
    ...(clock === undefined ? {} : { clock }),
  }
}

interface Fixture {
  readonly parent: string
  readonly knownHostsPath: string
  readonly connector: FakeConnector
  readonly port: SshPort
}

interface FixtureOptions {
  readonly steps: readonly ConnectorStep[]
  readonly reconnectAttempts?: number
  readonly knownHostsPath?: string
  readonly clock?: Clock
}

async function createFixture(options: FixtureOptions): Promise<Fixture> {
  const parent = await createTemporaryParent()
  const knownHostsPath = options.knownHostsPath ?? join(parent, 'ssh-known-hosts.txt')
  const connector = new FakeConnector(options.steps)
  const portOptions: SshChannelOptions = {
    context: createContext(options.clock),
    knownHostsPath,
    connectTimeoutMs: 500,
    reconnectAttempts: options.reconnectAttempts ?? 1,
  }
  const port = createSshPortWithOverrides(portOptions, {
    connector,
    readCredentials: async () => credentials,
  })
  return { parent, knownHostsPath, connector, port }
}

function logPath(parent: string, name = 'step-1.log'): string {
  return join(parent, 'logs', name)
}

function connectFailure(): SshError {
  return new SshError('SSH_CONNECT_FAILED', 'SSH 连接失败：连接被拒绝。')
}

/** 推进虚拟时间并立即完成等待。轮询类测试用它，不做真实等待。 */
function createFakeClock(): Clock & { elapsed(): number } {
  let current = 0
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds
    },
    elapsed: () => current,
  }
}

describe('命令执行', () => {
  it('成功执行：退出码、尾部与字节数正确，完整输出落盘', async () => {
    const fixture = await createFixture({
      steps: [sessionStep({ stdout: ['ok\n'], stderr: ['warning\n'], exitCode: 0 })],
    })
    const outputPath = logPath(fixture.parent)

    const result = await fixture.port.exec(TEST_INSTANCE_ID, 'echo ok', {
      timeoutSeconds: 5,
      logPath: outputPath,
    })

    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdoutTail).toBe('ok')
    expect(result.stderrTail).toBe('warning')
    expect(result.stdoutBytes).toBe(3)
    expect(result.stderrBytes).toBe(8)
    expect(await readFile(outputPath, 'utf8')).toBe('ok\nwarning\n')
    expect(fixture.connector.sessions[0]?.closed).toBe(true)
  })

  it('超时：返回 timedOut 与空退出码，并关闭连接', async () => {
    const fixture = await createFixture({
      steps: [sessionStep({ stdout: ['partial line\n'], hang: true })],
    })

    const result = await fixture.port.exec(TEST_INSTANCE_ID, 'sleep 999', {
      timeoutSeconds: 0.02,
      logPath: logPath(fixture.parent),
    })

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    expect(result.stdoutTail).toBe('partial line')
    expect(fixture.connector.sessions[0]?.closed).toBe(true)
  })

  it('输出超过尾部上限：尾部只留最后 200 行，字节数是全量', async () => {
    const lines = Array.from({ length: 250 }, (_value, index) => `line-${String(index).padStart(3, '0')}\n`)
    const fixture = await createFixture({ steps: [sessionStep({ stdout: lines, exitCode: 0 })] })
    const outputPath = logPath(fixture.parent)

    const result = await fixture.port.exec(TEST_INSTANCE_ID, 'print 250 lines', {
      timeoutSeconds: 5,
      logPath: outputPath,
    })

    const tailLines = result.stdoutTail.split('\n')
    expect(tailLines).toHaveLength(200)
    expect(tailLines[0]).toBe('line-050')
    expect(tailLines[199]).toBe('line-249')
    expect(result.stdoutBytes).toBe(250 * 9)
    const fullLog = await readFile(outputPath, 'utf8')
    expect(fullLog.split('\n').filter((line) => line.length > 0)).toHaveLength(250)
    expect(fullLog).toContain('line-000')
  })
})

describe('失败分类', () => {
  it('认证失败：抛 SshError，错误消息与日志都不含密码', async () => {
    const fixture = await createFixture({
      steps: [
        failureStep(
          new SshError('SSH_AUTH_FAILED', 'SSH 认证失败：root@region-test.autodl.com:2222。'),
        ),
      ],
    })
    const outputPath = logPath(fixture.parent)

    let caught: unknown
    try {
      await fixture.port.exec(TEST_INSTANCE_ID, 'echo ok', { timeoutSeconds: 5, logPath: outputPath })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SshError)
    expect(caught).toMatchObject({ code: 'SSH_AUTH_FAILED', exitCode: 1 })
    const message = caught instanceof Error ? caught.message : ''
    const stack = caught instanceof Error ? (caught.stack ?? '') : ''
    expect(message).not.toContain(SENTINEL_PASSWORD)
    expect(stack).not.toContain(SENTINEL_PASSWORD)
    // 认证失败发生在打开日志之前：既没有日志文件，也不该重试。
    expect(existsSync(outputPath)).toBe(false)
    expect(fixture.connector.requests).toHaveLength(1)
  })

  it('指纹变化：抛 HostKeyChangedError，且不自动更新记录', async () => {
    const parent = await createTemporaryParent()
    const knownHostsPath = join(parent, 'ssh-known-hosts.txt')
    await createKnownHosts({ filePath: knownHostsPath }).verify({
      instanceId: TEST_INSTANCE_ID,
      host: TEST_HOST,
      port: TEST_PORT,
      fingerprint: FINGERPRINT_FIRST,
    })
    const fixture = await createFixture({
      knownHostsPath,
      steps: [verifyThenSessionStep(FINGERPRINT_SECOND)],
    })

    let caught: unknown
    try {
      await fixture.port.exec(TEST_INSTANCE_ID, 'echo ok', {
        timeoutSeconds: 5,
        logPath: logPath(fixture.parent),
      })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HostKeyChangedError)
    expect(caught).toMatchObject({ code: 'HOST_KEY_CHANGED', exitCode: 2 })
    const content = await readFile(knownHostsPath, 'utf8')
    expect(content).toContain(FINGERPRINT_FIRST)
    expect(content).not.toContain(FINGERPRINT_SECOND)
    // 指纹变化不重试：再撞一次没有任何意义。
    expect(fixture.connector.requests).toHaveLength(1)
  })

  it('首次连接：记录指纹后放行', async () => {
    const fixture = await createFixture({
      steps: [verifyThenSessionStep(FINGERPRINT_FIRST, { stdout: ['ok\n'] })],
    })

    const result = await fixture.port.exec(TEST_INSTANCE_ID, 'echo ok', {
      timeoutSeconds: 5,
      logPath: logPath(fixture.parent),
    })

    expect(result.exitCode).toBe(0)
    expect(await readFile(fixture.knownHostsPath, 'utf8')).toContain(FINGERPRINT_FIRST)
  })
})

describe('重连策略', () => {
  it('连接建立失败后重连一次成功', async () => {
    const fixture = await createFixture({
      steps: [failureStep(connectFailure()), sessionStep({ stdout: ['ok\n'] })],
    })

    const result = await fixture.port.exec(TEST_INSTANCE_ID, 'echo ok', {
      timeoutSeconds: 5,
      logPath: logPath(fixture.parent),
    })

    expect(result.exitCode).toBe(0)
    expect(fixture.connector.requests).toHaveLength(2)
  })

  it('重连一次仍失败则停止，不无限重试', async () => {
    const fixture = await createFixture({
      steps: [failureStep(connectFailure()), failureStep(connectFailure())],
    })

    await expect(
      fixture.port.exec(TEST_INSTANCE_ID, 'echo ok', {
        timeoutSeconds: 5,
        logPath: logPath(fixture.parent),
      }),
    ).rejects.toMatchObject({ code: 'SSH_CONNECT_FAILED' })
    expect(fixture.connector.requests).toHaveLength(2)
  })

  it('命令执行中连接中断：不重连、不重放，报错并保留已输出内容', async () => {
    const fixture = await createFixture({
      steps: [
        sessionStep({
          stdout: ['started\n'],
          failWith: new SshError('SSH_CONNECT_FAILED', 'SSH 连接在命令执行期间中断。'),
        }),
      ],
    })
    const outputPath = logPath(fixture.parent)

    await expect(
      fixture.port.exec(TEST_INSTANCE_ID, 'deploy.sh', { timeoutSeconds: 5, logPath: outputPath }),
    ).rejects.toMatchObject({ code: 'SSH_CONNECT_FAILED' })

    expect(fixture.connector.requests).toHaveLength(1)
    expect(await readFile(outputPath, 'utf8')).toContain('started')
  })
})

describe('等待 SSH 就绪', () => {
  it('超时抛错，而且反复尝试连接', async () => {
    const clock = createFakeClock()
    const fixture = await createFixture({ steps: [failureStep(connectFailure())], clock })

    let caught: unknown
    try {
      await fixture.port.waitUntilReady(TEST_INSTANCE_ID, 100)
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SshError)
    expect(caught).toMatchObject({ code: 'SSH_CONNECT_FAILED', exitCode: 1 })
    expect(caught instanceof Error ? caught.message : '').toContain('未就绪')
    expect(fixture.connector.requests.length).toBeGreaterThan(1)
    expect(clock.elapsed()).toBeGreaterThanOrEqual(100)
  })

  it('指纹变化立即报错，不进入轮询', async () => {
    const parent = await createTemporaryParent()
    const knownHostsPath = join(parent, 'ssh-known-hosts.txt')
    await createKnownHosts({ filePath: knownHostsPath }).verify({
      instanceId: TEST_INSTANCE_ID,
      host: TEST_HOST,
      port: TEST_PORT,
      fingerprint: FINGERPRINT_FIRST,
    })
    const fixture = await createFixture({
      knownHostsPath,
      steps: [verifyThenSessionStep(FINGERPRINT_SECOND)],
      clock: createFakeClock(),
    })

    await expect(fixture.port.waitUntilReady(TEST_INSTANCE_ID, 100)).rejects.toBeInstanceOf(
      HostKeyChangedError,
    )
    expect(fixture.connector.requests).toHaveLength(1)
  })
})

describe('装配期校验', () => {
  it('known-hosts 路径必须是绝对路径', () => {
    expect(() =>
      createSshPortWithOverrides(
        {
          context: createContext(),
          knownHostsPath: join('relative-dir', 'ssh-known-hosts.txt'),
          connectTimeoutMs: 500,
          reconnectAttempts: 1,
        },
        { connector: new FakeConnector([]), readCredentials: async () => credentials },
      ),
    ).toThrow(ConfigError)
  })
})
