import { describe, expect, it } from 'vitest'
import {
  InteractiveTerminalRequiredError,
  ShellFailedError,
} from '../../errors.js'
import type {
  InteractiveShellSession,
  OpenShellOptions,
  ShellSessionHandlers,
  ShellSessionOutcome,
  SshExecOptions,
  SshExecResult,
  SshShellPort,
} from '../../ssh/ports.js'
import type { CliDependencies, ShellSession } from '../dependencies.js'
import { runShellCommand, SHELL_COMMAND_TIMEOUT_SECONDS, type TerminalStreams } from './shell.js'
import type { OutputStream } from '../output.js'

/**
 * `shell` 命令的行为用例。
 *
 * 判据（docs/specs/deploydeck-phase3-shell.md 第 3.2 节与第 3.5 节）：
 * - 交互形态与 `--json` 互斥。
 * - 交互形态要求本地有 tty，没有即报错，不静默退化。
 * - 非交互形态走数据面 `exec`：不开 PTY，按远端退出码返回，跑完即断开。
 * - 拿不到远端退出码即失败，不当成成功。
 *
 * 全部 IO 是假的：不连浏览器、不连 SSH、不读真实键盘。
 */

const INSTANCE_ID = 'af9c49bd44-8ee624d7'

function createOutput(): { stream: OutputStream; text: () => string } {
  const parts: string[] = []
  return {
    stream: { write: (chunk: string) => parts.push(chunk) },
    text: () => parts.join(''),
  }
}

/** 假 stdin / stdout。`isTTY` 与尺寸由用例给定。 */
function createStreams(options: {
  readonly stdinIsTty: boolean
  readonly columns?: number
  readonly rows?: number
}): {
  readonly streams: TerminalStreams
  readonly stdoutText: () => string
} {
  const stdoutParts: string[] = []

  const stdin = {
    isTTY: options.stdinIsTty,
    ...(options.columns === undefined ? {} : { columns: options.columns }),
    ...(options.rows === undefined ? {} : { rows: options.rows }),
    on: () => undefined,
    off: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
  }
  const stdout = {
    isTTY: true,
    on: () => undefined,
    off: () => undefined,
    write: (chunk: Buffer | string) => {
      stdoutParts.push(chunk.toString())
      return true
    },
  }

  return {
    streams: { stdin, stdout } as unknown as TerminalStreams,
    stdoutText: () => stdoutParts.join(''),
  }
}

interface FakeExecSetup {
  readonly exitCode: number | null
  readonly stdoutTail?: string
  readonly stderrTail?: string
  readonly timedOut?: boolean
}

interface FakeDeps {
  readonly deps: CliDependencies
  /** 每次 `openShell` 收到的参数。非交互形态不该出现新的 openShell 之外的通道。 */
  readonly opens: Array<{ logDir: string; term: string }>
  /** 每次 `shell.openShell` 的参数。非交互形态必须一次都不出现。 */
  readonly ptyOpens: Array<{ instanceId: string; options: OpenShellOptions }>
  /** 每次 `exec` 的参数。非交互形态必须恰好一次。 */
  readonly execs: Array<{ instanceId: string; command: string; options: SshExecOptions }>
  readonly closed: { count: number }
  readonly ptyWrites: string[]
}

function createFakeDeps(input: {
  readonly outcome?: ShellSessionOutcome
  readonly exec?: FakeExecSetup
}): FakeDeps {
  const opens: Array<{ logDir: string; term: string }> = []
  const ptyOpens: Array<{ instanceId: string; options: OpenShellOptions }> = []
  const execs: Array<{ instanceId: string; command: string; options: SshExecOptions }> = []
  const ptyWrites: string[] = []
  const closed = { count: 0 }

  const shellPort: SshShellPort = {
    async openShell(
      instanceId: string,
      handlers: ShellSessionHandlers,
      options: OpenShellOptions,
    ): Promise<InteractiveShellSession> {
      ptyOpens.push({ instanceId, options })
      void handlers
      return {
        write: (data: Buffer) => ptyWrites.push(data.toString('utf8')),
        resize: () => undefined,
        wait: async () => input.outcome ?? { exitCode: 0, transportFailure: null },
        close: async () => undefined,
      }
    },
  }

  const shellSession: ShellSession = {
    shell: shellPort,
    exec: async (
      instanceId: string,
      command: string,
      options: SshExecOptions,
    ): Promise<SshExecResult> => {
      execs.push({ instanceId, command, options })
      const stdoutTail = input.exec?.stdoutTail ?? ''
      const stderrTail = input.exec?.stderrTail ?? ''
      return {
        // 用属性存在性判断：`exitCode: null` 是「没拿到退出码」，不能被 `??` 换成 0。
        exitCode: input.exec === undefined ? 0 : input.exec.exitCode,
        stdoutTail,
        stderrTail,
        stdoutBytes: Buffer.byteLength(stdoutTail, 'utf8'),
        stderrBytes: Buffer.byteLength(stderrTail, 'utf8'),
        durationMs: 5,
        timedOut: input.exec?.timedOut ?? false,
      }
    },
    close: async () => {
      closed.count += 1
    },
  }

  const deps = {
    stateDir: '/tmp/deploydeck-state',
    openShell: async (options: { logDir: string; term: string }) => {
      opens.push(options)
      return shellSession
    },
    stdout: createOutput().stream,
    stderr: createOutput().stream,
  } as unknown as CliDependencies

  return { deps, opens, ptyOpens, execs, closed, ptyWrites }
}

describe('shell：交互形态的前置校验', () => {
  it('没有本地 tty 时抛 InteractiveTerminalRequiredError，不建立连接', async () => {
    const fake = createFakeDeps({})
    const { streams } = createStreams({ stdinIsTty: false })
    let opened = false
    const deps = {
      ...fake.deps,
      openShell: async () => {
        opened = true
        throw new Error('不应打开通道')
      },
    } as unknown as CliDependencies

    await expect(
      runShellCommand({ deps, json: false }, { instanceId: INSTANCE_ID, command: null, term: 'xterm' }, streams),
    ).rejects.toBeInstanceOf(InteractiveTerminalRequiredError)

    expect(opened).toBe(false)
  })

  it('交互形态与 --json 互斥，抛 ShellFailedError', async () => {
    const fake = createFakeDeps({})
    const { streams } = createStreams({ stdinIsTty: true, columns: 100, rows: 30 })

    await expect(
      runShellCommand({ deps: fake.deps, json: true }, { instanceId: INSTANCE_ID, command: null, term: 'xterm' }, streams),
    ).rejects.toBeInstanceOf(ShellFailedError)

    expect(fake.opens).toEqual([])
  })
})

describe('shell：交互形态', () => {
  it('把本地终端的行列数交给 PTY 通道，不是写死的 80x24', async () => {
    const fake = createFakeDeps({})
    const { streams } = createStreams({ stdinIsTty: true, columns: 132, rows: 43 })

    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: null, term: 'xterm' },
      streams,
    )

    expect(fake.ptyOpens[0]?.options.size).toEqual({ columns: 132, rows: 43 })
    expect(fake.execs).toEqual([])
  })

  it('没有 tty 尺寸时回落到 80x24', async () => {
    const fake = createFakeDeps({})
    const { streams } = createStreams({ stdinIsTty: true })

    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: null, term: 'xterm' },
      streams,
    )

    expect(fake.ptyOpens[0]?.options.size).toEqual({ columns: 80, rows: 24 })
  })

  it('会话没给退出码时抛错，不当成成功，并关闭通道', async () => {
    const fake = createFakeDeps({
      outcome: { exitCode: null, transportFailure: '连接中断' },
    })
    const { streams } = createStreams({ stdinIsTty: true })

    await expect(
      runShellCommand(
        { deps: fake.deps, json: false },
        { instanceId: INSTANCE_ID, command: null, term: 'xterm' },
        streams,
      ),
    ).rejects.toThrow(/连接中断/)

    expect(fake.closed.count).toBe(1)
  })
})

describe('shell：非交互形态走 exec', () => {
  it('命令交给 SshPort.exec，不开 PTY，带独立超时与落盘路径', async () => {
    // Arrange
    const fake = createFakeDeps({ exec: { exitCode: 0, stdoutTail: 'Linux host 6.8\n' } })
    const { streams } = createStreams({ stdinIsTty: false })

    // Act
    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'uname -a', term: 'xterm-256color' },
      streams,
    )

    // Assert：只有一次 exec，命令原样交给数据面；PTY 一次都没开。
    expect(fake.ptyOpens).toEqual([])
    expect(fake.execs).toHaveLength(1)
    expect(fake.execs[0]?.instanceId).toBe(INSTANCE_ID)
    expect(fake.execs[0]?.command).toBe('uname -a')
    expect(fake.execs[0]?.options.timeoutSeconds).toBe(SHELL_COMMAND_TIMEOUT_SECONDS)
    expect(fake.execs[0]?.options.logPath).toContain('shell')
    expect(fake.execs[0]?.options.logPath).toContain(INSTANCE_ID)
    // 跑完即断开：通道被关，且只关一次。
    expect(fake.closed.count).toBe(1)
  })

  it('人读模式下把远端输出尾部写进本地终端', async () => {
    const fake = createFakeDeps({ exec: { exitCode: 0, stdoutTail: 'total 12\n' } })
    const { streams, stdoutText } = createStreams({ stdinIsTty: false })

    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'ls -l', term: 'xterm' },
      streams,
    )

    expect(stdoutText()).toContain('total 12')
    expect(fake.ptyWrites).toEqual([])
  })

  it('远端退出码非 0 时抛 ShellFailedError，并带上退出码', async () => {
    const fake = createFakeDeps({ exec: { exitCode: 127, stderrTail: 'nope: command not found' } })
    const { streams } = createStreams({ stdinIsTty: false })

    await expect(
      runShellCommand(
        { deps: fake.deps, json: false },
        { instanceId: INSTANCE_ID, command: 'nope', term: 'xterm' },
        streams,
      ),
    ).rejects.toThrow(/127/)

    expect(fake.closed.count).toBe(1)
  })

  it('超时被杀（退出码 null）时抛 ShellFailedError，不当成成功', async () => {
    const fake = createFakeDeps({ exec: { exitCode: null, timedOut: true } })
    const { streams } = createStreams({ stdinIsTty: false })

    const error = await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'sleep 10000', term: 'xterm' },
      streams,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ShellFailedError)
    expect((error as Error).message).toContain(String(SHELL_COMMAND_TIMEOUT_SECONDS))
    expect(fake.closed.count).toBe(1)
  })

  it('会话断开没给退出码时抛错，不当成 0', async () => {
    const fake = createFakeDeps({ exec: { exitCode: null, timedOut: false } })
    const { streams } = createStreams({ stdinIsTty: false })

    await expect(
      runShellCommand(
        { deps: fake.deps, json: false },
        { instanceId: INSTANCE_ID, command: 'true', term: 'xterm' },
        streams,
      ),
    ).rejects.toBeInstanceOf(ShellFailedError)
  })
})

describe('shell：--json 输出', () => {
  it('--json 的 stdout 只有一个 JSON 对象，字段形状不变', async () => {
    const fake = createFakeDeps({ exec: { exitCode: 0, stdoutTail: 'ignored\n' } })
    const { streams } = createStreams({ stdinIsTty: false })
    const stdout = createOutput()

    await runShellCommand(
      { deps: { ...fake.deps, stdout: stdout.stream } as unknown as CliDependencies, json: true },
      { instanceId: INSTANCE_ID, command: 'uname -a', term: 'xterm' },
      streams,
    )

    const lines = stdout.text().split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    const payload = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(payload).toEqual({
      instanceId: INSTANCE_ID,
      command: 'uname -a',
      exitCode: 0,
      transportFailure: null,
    })
  })

  it('--json 下远端非 0 退出码照常打出对象，退出码由 ShellFailedError 裁决', async () => {
    const fake = createFakeDeps({ exec: { exitCode: 3 } })
    const { streams } = createStreams({ stdinIsTty: false })
    const stdout = createOutput()

    const error = await runShellCommand(
      { deps: { ...fake.deps, stdout: stdout.stream } as unknown as CliDependencies, json: true },
      { instanceId: INSTANCE_ID, command: 'false', term: 'xterm' },
      streams,
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ShellFailedError)
    const payload = JSON.parse(stdout.text()) as Record<string, unknown>
    expect(payload['exitCode']).toBe(3)
  })
})
