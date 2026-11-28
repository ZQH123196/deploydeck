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
  SshShellPort,
} from '../../ssh/ports.js'
import type { CliDependencies, ShellSession } from '../dependencies.js'
import { runShellCommand, type TerminalStreams } from './shell.js'
import type { OutputStream } from '../output.js'

/**
 * `shell` 命令的行为用例。
 *
 * 判据（docs/specs/deploydeck-phase3-shell.md 第 4 节）：
 * - 交互形态与 `--json` 互斥。
 * - 交互形态要求本地有 tty，没有即报错，不静默退化。
 * - 非交互形态在 PTY 里跑一条命令，拿退出码。
 * - 实例不在运行中由通道层拒绝，命令不吞错。
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
  readonly writtenToShell: string[]
} {
  const writtenToShell: string[] = []
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
    writtenToShell,
  }
}

interface FakeShellSetup {
  readonly outcome: ShellSessionOutcome
  readonly onWrite?: (data: Buffer) => void
}

function createFakeDeps(setup: FakeShellSetup): {
  readonly deps: CliDependencies
  readonly opens: Array<{ logDir: string; term: string }>
  readonly openShellArgs: Array<{ instanceId: string; options: OpenShellOptions }>
  readonly closed: { count: number }
} {
  const opens: Array<{ logDir: string; term: string }> = []
  const openShellArgs: Array<{ instanceId: string; options: OpenShellOptions }> = []
  const closed = { count: 0 }

  const shellPort: SshShellPort = {
    async openShell(
      instanceId: string,
      handlers: ShellSessionHandlers,
      options: OpenShellOptions,
    ): Promise<InteractiveShellSession> {
      openShellArgs.push({ instanceId, options })
      const session: InteractiveShellSession = {
        write: (data: Buffer) => setup.onWrite?.(data),
        resize: () => undefined,
        wait: async () => setup.outcome,
        close: async () => undefined,
      }
      void handlers
      return session
    },
  }

  const shellSession: ShellSession = {
    shell: shellPort,
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

  return { deps, opens, openShellArgs, closed }
}

function createDepsReturningNullExit(): {
  readonly deps: CliDependencies
  readonly closed: { count: number }
} {
  const closed = { count: 0 }
  const deps = {
    stateDir: '/tmp/deploydeck-state',
    openShell: async () => ({
      shell: {
        openShell: async (): Promise<InteractiveShellSession> => ({
          write: () => undefined,
          resize: () => undefined,
          wait: async () => ({ exitCode: null, transportFailure: '连接中断' }),
          close: async () => undefined,
        }),
      },
      close: async () => {
        closed.count += 1
      },
    }),
    stdout: createOutput().stream,
    stderr: createOutput().stream,
  } as unknown as CliDependencies
  return { deps, closed }
}

describe('shell：交互形态的前置校验', () => {
  it('没有本地 tty 时抛 InteractiveTerminalRequiredError，不建立连接', async () => {
    const fake = createFakeDeps({ outcome: { exitCode: 0, transportFailure: null } })
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
    const fake = createFakeDeps({ outcome: { exitCode: 0, transportFailure: null } })
    const { streams } = createStreams({ stdinIsTty: true, columns: 100, rows: 30 })

    await expect(
      runShellCommand({ deps: fake.deps, json: true }, { instanceId: INSTANCE_ID, command: null, term: 'xterm' }, streams),
    ).rejects.toBeInstanceOf(ShellFailedError)

    expect(fake.opens).toEqual([])
  })
})

describe('shell：非交互形态', () => {
  it('在 PTY 里写入命令并返回远端退出码，关闭通道', async () => {
    const written: string[] = []
    const fake = createFakeDeps({
      outcome: { exitCode: 0, transportFailure: null },
      onWrite: (data) => written.push(data.toString('utf8')),
    })
    const { streams } = createStreams({ stdinIsTty: false })
    const stdout = createOutput()

    await runShellCommand(
      { deps: { ...fake.deps, stdout: stdout.stream } as unknown as CliDependencies, json: true },
      { instanceId: INSTANCE_ID, command: 'uname -a', term: 'xterm-256color' },
      streams,
    )

    // 命令写进远端 shell 时带换行：没有换行远端不会执行。
    expect(written.join('')).toBe('uname -a\n')
    expect(fake.openShellArgs).toHaveLength(1)
    expect(fake.openShellArgs[0]?.instanceId).toBe(INSTANCE_ID)
    expect(fake.closed.count).toBe(1)

    const payload = JSON.parse(stdout.text()) as Record<string, unknown>
    expect(payload['exitCode']).toBe(0)
    expect(payload['command']).toBe('uname -a')
  })

  it('远端命令退出码非 0 时抛 ShellFailedError，并带上退出码', async () => {
    const fake = createFakeDeps({ outcome: { exitCode: 127, transportFailure: null } })
    const { streams } = createStreams({ stdinIsTty: false })

    await expect(
      runShellCommand(
        { deps: fake.deps, json: false },
        { instanceId: INSTANCE_ID, command: 'nope', term: 'xterm' },
        streams,
      ),
    ).rejects.toThrow(/127/)
  })

  it('会话没给退出码时抛错，不当成成功', async () => {
    const fake = createDepsReturningNullExit()
    const { streams } = createStreams({ stdinIsTty: false })

    await expect(
      runShellCommand(
        { deps: fake.deps, json: false },
        { instanceId: INSTANCE_ID, command: 'sleep 100', term: 'xterm' },
        streams,
      ),
    ).rejects.toThrow(/连接中断/)

    expect(fake.closed.count).toBe(1)
  })
})

describe('shell：终端尺寸', () => {
  it('把本地终端的行列数交给通道，不是写死的 80x24', async () => {
    const fake = createFakeDeps({ outcome: { exitCode: 0, transportFailure: null } })
    const { streams } = createStreams({ stdinIsTty: false, columns: 132, rows: 43 })

    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'true', term: 'xterm' },
      streams,
    )

    expect(fake.openShellArgs[0]?.options.size).toEqual({ columns: 132, rows: 43 })
  })

  it('没有 tty 尺寸时回落到 80x24', async () => {
    const fake = createFakeDeps({ outcome: { exitCode: 0, transportFailure: null } })
    const { streams } = createStreams({ stdinIsTty: false })

    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'true', term: 'xterm' },
      streams,
    )

    expect(fake.openShellArgs[0]?.options.size).toEqual({ columns: 80, rows: 24 })
  })
})

describe('shell：输出边界', () => {
  it('--json 模式下 stdout 只有一个 JSON 对象', async () => {
    const fake = createFakeDeps({ outcome: { exitCode: 0, transportFailure: null } })
    const { streams } = createStreams({ stdinIsTty: false })
    const stdout = createOutput()

    await runShellCommand(
      { deps: { ...fake.deps, stdout: stdout.stream } as unknown as CliDependencies, json: true },
      { instanceId: INSTANCE_ID, command: 'true', term: 'xterm' },
      streams,
    )

    const lines = stdout.text().split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow()
  })

  it('人读模式下远端字节写进真实终端，不写进 stdout 抽象', async () => {
    const written: string[] = []
    const fake = createFakeDeps({
      outcome: { exitCode: 0, transportFailure: null },
      onWrite: (data) => written.push(data.toString('utf8')),
    })
    const { streams } = createStreams({ stdinIsTty: false })
    const stdout = createOutput()

    await runShellCommand(
      { deps: { ...fake.deps, stdout: stdout.stream } as unknown as CliDependencies, json: false },
      { instanceId: INSTANCE_ID, command: 'echo hi', term: 'xterm' },
      streams,
    )

    // 命令是写给远端的；stdout 抽象里不该出现它。
    expect(written.join('')).toBe('echo hi\n')
    expect(stdout.text()).toBe('')
  })
})
