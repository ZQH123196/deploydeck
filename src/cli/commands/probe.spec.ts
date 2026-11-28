import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { InstanceStatusProbe } from '../../console/instance-list.js'
import { PROBE_COMMAND, PROBE_TIMEOUT_SECONDS } from '../../engine/steps.js'
import { InstanceNotRunningError, ProbeFailedError } from '../../errors.js'
import type { Clock } from '../../util/clock.js'
import type { SshExecOptions, SshExecResult } from '../../ssh/ports.js'
import type { CliDependencies, ShellSession } from '../dependencies.js'
import type { OutputStream } from '../output.js'
import { PROBE_EVIDENCE_DIRECTORY, PROBE_LOG_FILE, runProbeCommand } from './probe.js'

/**
 * `probe` 命令的行为用例。
 *
 * 判据：
 * - 只连运行中的实例。已关机即 `InstanceNotRunningError`（退出码 1），不开 SSH。
 * - 执行引擎写死的一条命令，超时 30 秒，不读任何配置。
 * - 连不上、超时、退出码非 0 一律 `ProbeFailedError`（退出码 1）。
 * - 不建计划、不读单价、不设定时关机、不写账本、不改实例状态：本命令只碰证据目录。
 * - `--json` 只输出 `{ instanceId, reachable, durationMs }`。
 *
 * 隔离：不连浏览器、不连 SSH、不出网。会话入口是假对象。
 */

const INSTANCE_ID = 'af9c49bd44-8ee624d7'
const STATE_DIR = '/state'

function createOutput(): { stream: OutputStream; text: () => string } {
  const parts: string[] = []
  return {
    stream: { write: (chunk: string) => parts.push(chunk) },
    text: () => parts.join(''),
  }
}

/** 假时钟：每次 `now()` 前进固定毫秒，用来判耗时来自注入时钟。 */
function createAdvancingClock(stepMilliseconds: number): Clock {
  let currentMillis = Date.parse('2026-11-28T11:00:00+08:00')
  return {
    now: () => {
      currentMillis += stepMilliseconds
      return currentMillis
    },
    sleep: async () => undefined,
  }
}

interface FakeProbeDeps {
  readonly deps: CliDependencies
  /** 每次 `openShell` 的参数。 */
  readonly opens: Array<{ readonly logDir: string; readonly term: string }>
  /** 每次 `exec` 的参数。 */
  readonly execs: Array<{
    readonly instanceId: string
    readonly command: string
    readonly options: SshExecOptions
  }>
  /** 数据面会话被关闭的次数。 */
  readonly closes: { count: number }
  /** 打开过的其它通道。本命令不应碰它们。 */
  readonly otherChannels: string[]
  readonly stdout: ReturnType<typeof createOutput>
  readonly stderr: ReturnType<typeof createOutput>
}

function createFakeDeps(input: {
  /** 实例状态读数。默认运行中。 */
  readonly status?: InstanceStatusProbe
  /** `exec` 的返回。默认退出码 0。 */
  readonly execResult?: SshExecResult
  /** 让 `exec` 直接抛错，模拟连不上。 */
  readonly execError?: Error
  /** 数据面端口抛错时的错误构造。 */
  readonly clock?: Clock
}): FakeProbeDeps {
  const opens: FakeProbeDeps['opens'] = []
  const execs: FakeProbeDeps['execs'] = []
  const closes = { count: 0 }
  const otherChannels: string[] = []
  const stdout = createOutput()
  const stderr = createOutput()

  const session: ShellSession = {
    shell: {
      openShell: async () => {
        otherChannels.push('pty')
        throw new Error('probe 不应开 PTY')
      },
    },
    readInstanceStatus: async (instanceId: string): Promise<InstanceStatusProbe> =>
      input.status ?? { instanceId, status: 'running', statusRaw: '运行中' },
    exec: async (
      instanceId: string,
      command: string,
      options: SshExecOptions,
    ): Promise<SshExecResult> => {
      execs.push({ instanceId, command, options })
      if (input.execError !== undefined) {
        throw input.execError
      }
      return (
        input.execResult ?? {
          exitCode: 0,
          stdoutTail: '',
          stderrTail: '',
          stdoutBytes: 0,
          stderrBytes: 0,
          durationMs: 1,
          timedOut: false,
        }
      )
    },
    close: async () => {
      closes.count += 1
    },
  }

  const deps = {
    stateDir: STATE_DIR,
    clock: input.clock ?? createAdvancingClock(5),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    stdout: stdout.stream,
    stderr: stderr.stream,
    openShell: async (options: { readonly logDir: string; readonly term: string }) => {
      opens.push(options)
      return session
    },
    // 与真实装配同形：命令不自己拼路径，一律经 `commandEvidenceDir`。
    commandEvidenceDir: async (command: string, instanceId: string) =>
      join(STATE_DIR, command, instanceId),
    withProvider: async () => {
      otherChannels.push('provider')
      throw new Error('probe 不应打开 provider')
    },
    createStateStore: () => {
      otherChannels.push('state-store')
      throw new Error('probe 不应打开状态存储')
    },
    loadProfiles: async () => {
      otherChannels.push('profiles')
      return []
    },
  } as unknown as CliDependencies

  return { deps, opens, execs, closes, otherChannels, stdout, stderr }
}

describe('probe：可达', () => {
  it('执行固定探测命令，超时 30 秒，关闭会话一次', async () => {
    // Arrange
    const fake = createFakeDeps({})

    // Act
    await runProbeCommand({ deps: fake.deps, json: true }, { instanceId: INSTANCE_ID })

    // Assert：命令来自引擎常量，不是配置文本；会话用完即关。
    expect(fake.execs).toHaveLength(1)
    expect(fake.execs[0]?.instanceId).toBe(INSTANCE_ID)
    expect(fake.execs[0]?.command).toBe(PROBE_COMMAND)
    expect(fake.execs[0]?.options.timeoutSeconds).toBe(PROBE_TIMEOUT_SECONDS)
    expect(fake.closes.count).toBe(1)
  })

  it('--json 只输出 instanceId、reachable 与 durationMs，耗时取注入时钟', async () => {
    // Arrange：假时钟每次调用前进 5 ms，耗时应当由两次读数之差得出。
    const fake = createFakeDeps({ clock: createAdvancingClock(5) })

    // Act
    await runProbeCommand({ deps: fake.deps, json: true }, { instanceId: INSTANCE_ID })

    // Assert
    const lines = fake.stdout.text().split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    const payload = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(Object.keys(payload).sort()).toEqual(['durationMs', 'instanceId', 'reachable'])
    expect(payload['instanceId']).toBe(INSTANCE_ID)
    expect(payload['reachable']).toBe(true)
    expect(payload['durationMs']).toBe(5)
  })

  it('证据目录是 <stateDir>/probe/<instanceId>，不碰 provider 与状态存储', async () => {
    // Arrange
    const fake = createFakeDeps({})

    // Act
    await runProbeCommand({ deps: fake.deps, json: true }, { instanceId: INSTANCE_ID })

    // Assert：判据是「不建计划、不读单价、不设定时关机、不写账本、不改实例状态」。
    expect(fake.opens).toEqual([
      { logDir: join(STATE_DIR, PROBE_EVIDENCE_DIRECTORY, INSTANCE_ID), term: 'xterm-256color' },
    ])
    expect(fake.execs[0]?.options.logPath).toBe(
      join(STATE_DIR, PROBE_EVIDENCE_DIRECTORY, INSTANCE_ID, PROBE_LOG_FILE),
    )
    expect(fake.otherChannels).toEqual([])
  })

  it('人读模式写一行结论，不写 JSON', async () => {
    // Arrange
    const fake = createFakeDeps({})

    // Act
    await runProbeCommand({ deps: fake.deps, json: false }, { instanceId: INSTANCE_ID })

    // Assert
    expect(fake.stdout.text()).toContain('可达')
    expect(fake.stdout.text()).not.toContain('{')
  })
})

describe('probe：不可达', () => {
  it('实例已关机即抛 InstanceNotRunningError（退出码 1），不开 SSH', async () => {
    // Arrange
    const fake = createFakeDeps({
      status: { instanceId: INSTANCE_ID, status: 'stopped', statusRaw: '已关机' },
    })

    // Act
    const error = await runProbeCommand({ deps: fake.deps, json: false }, {
      instanceId: INSTANCE_ID,
    }).catch((caught: unknown) => caught)

    // Assert：判据是「已关机不表现成 SSH 连接失败」。
    expect(error).toBeInstanceOf(InstanceNotRunningError)
    expect((error as InstanceNotRunningError).code).toBe('INSTANCE_NOT_RUNNING')
    expect((error as InstanceNotRunningError).exitCode).toBe(1)
    expect(fake.execs).toEqual([])
    expect(fake.closes.count).toBe(1)
  })

  it('连接失败抛 ProbeFailedError（退出码 1），原始错误进 cause', async () => {
    // Arrange
    const fake = createFakeDeps({ execError: new Error('connect ECONNREFUSED') })

    // Act
    const error = await runProbeCommand({ deps: fake.deps, json: false }, {
      instanceId: INSTANCE_ID,
    }).catch((caught: unknown) => caught)

    // Assert
    expect(error).toBeInstanceOf(ProbeFailedError)
    expect((error as ProbeFailedError).code).toBe('PROBE_FAILED')
    expect((error as ProbeFailedError).exitCode).toBe(1)
    expect(((error as Error).cause as Error).message).toContain('ECONNREFUSED')
    expect(fake.closes.count).toBe(1)
  })

  it('命令超时抛 ProbeFailedError，不当成可达', async () => {
    // Arrange
    const fake = createFakeDeps({
      execResult: {
        exitCode: null,
        stdoutTail: '',
        stderrTail: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        durationMs: PROBE_TIMEOUT_SECONDS * 1000,
        timedOut: true,
      },
    })

    // Act
    const error = await runProbeCommand({ deps: fake.deps, json: false }, {
      instanceId: INSTANCE_ID,
    }).catch((caught: unknown) => caught)

    // Assert
    expect(error).toBeInstanceOf(ProbeFailedError)
    expect((error as Error).message).toContain('超时')
    expect(fake.stdout.text()).toBe('')
  })

  it('命令退出码非 0 抛 ProbeFailedError：`true` 恒真，非 0 说明 shell 坏了', async () => {
    // Arrange
    const fake = createFakeDeps({
      execResult: {
        exitCode: 127,
        stdoutTail: '',
        stderrTail: 'sh: 1: true: not found\n',
        stdoutBytes: 0,
        stderrBytes: 25,
        durationMs: 1,
        timedOut: false,
      },
    })

    // Act
    const error = await runProbeCommand({ deps: fake.deps, json: false }, {
      instanceId: INSTANCE_ID,
    }).catch((caught: unknown) => caught)

    // Assert
    expect(error).toBeInstanceOf(ProbeFailedError)
    expect((error as Error).message).toContain('127')
    expect(fake.stdout.text()).toBe('')
  })

  it('会话没拿到退出码抛 ProbeFailedError，不当成 0', async () => {
    // Arrange
    const fake = createFakeDeps({
      execResult: {
        exitCode: null,
        stdoutTail: '',
        stderrTail: '',
        stdoutBytes: 0,
        stderrBytes: 0,
        durationMs: 1,
        timedOut: false,
      },
    })

    // Act
    const error = await runProbeCommand({ deps: fake.deps, json: false }, {
      instanceId: INSTANCE_ID,
    }).catch((caught: unknown) => caught)

    // Assert
    expect(error).toBeInstanceOf(ProbeFailedError)
    expect((error as Error).message).toContain('没有拿到退出码')
  })

  it('空 instanceId 抛 ProbeFailedError，且不打开任何通道', async () => {
    // Arrange
    const fake = createFakeDeps({})

    // Act
    const error = await runProbeCommand({ deps: fake.deps, json: false }, {
      instanceId: '   ',
    }).catch((caught: unknown) => caught)

    // Assert：参数写错不应该在磁盘上留下任何东西。
    expect(error).toBeInstanceOf(ProbeFailedError)
    expect(fake.opens).toEqual([])
  })
})
