import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  InstanceNotRunningError,
  InteractiveTerminalRequiredError,
  ShellFailedError,
} from '../../errors.js'
import type { InstanceStatusProbe } from '../../console/instance-list.js'
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
import {
  loginShellCommand,
  runShellCommand,
  shellQuote,
  SHELL_COMMAND_OUTPUT_FILE,
  SHELL_COMMAND_TIMEOUT_SECONDS,
  SHELL_EVIDENCE_DIRECTORY,
  type TerminalStreams,
} from './shell.js'
import type { OutputStream } from '../output.js'

/**
 * `shell` 命令的行为用例。
 *
 * 判据（docs/specs/deploydeck-phase3-shell.md 第 3.2 节与第 3.5 节）：
 * - 交互形态与 `--json` 互斥。
 * - 交互形态要求本地有 tty，没有即报错，不静默退化。
 * - 非交互形态走数据面 `exec`：不开 PTY，按远端退出码返回，跑完即断开。
 * - 非交互形态的命令包进登录 shell 执行，拿到的环境与交互终端一致。
 * - 非交互形态先判实例运行中；已关机即 `InstanceNotRunningError`（退出码 1），不开 SSH。
 * - 非交互形态的人读输出是落盘的完整输出，不是 200 行尾部摘要。
 * - 拿不到远端退出码即失败，不当成成功。
 *
 * 全部 IO 是假的：不连浏览器、不连 SSH、不读真实键盘。没有真实网络与真实 Chrome。
 * 「落盘」是真的：临时目录里写 `command.log`，用来判「终端上看到的是不是全文」。
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
  /**
   * 落盘的完整输出。不给时用 `stdoutTail + stderrTail`：多数用例只关心尾部，
   * 「全文」用例显式给一份比 tail 长的内容。
   */
  readonly logContent?: string
}

interface FakeDeps {
  readonly deps: CliDependencies
  /** 每次 `openShell` 收到的参数。非交互形态不该出现新的 openShell 之外的通道。 */
  readonly opens: Array<{ logDir: string; term: string }>
  /** 每次 `shell.openShell` 的参数。非交互形态必须一次都不出现。 */
  readonly ptyOpens: Array<{ instanceId: string; options: OpenShellOptions }>
  /** 每次 `exec` 的参数。非交互形态必须恰好一次。 */
  readonly execs: Array<{ instanceId: string; command: string; options: SshExecOptions }>
  /** 每次状态读数。非交互形态必须在 `exec` 之前恰好一次。 */
  readonly statusReads: string[]
  /** 调用顺序，用来判「先判状态、再跑命令」。 */
  readonly calls: string[]
  readonly closed: { count: number }
  readonly ptyWrites: string[]
  readonly stateDir: string
  readonly stdoutText: () => string
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

/** 每台实例一个临时状态目录：`command.log` 的落点是 `deps.stateDir` 拼出来的。 */
async function createTemporaryStateDir(): Promise<string> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'shell-spec-'))
  temporaryParents.push(parent)
  return join(parent, 'state')
}

function createFakeDeps(input: {
  readonly outcome?: ShellSessionOutcome
  readonly exec?: FakeExecSetup
  /** 状态读数返回的快照。不给时是运行中。 */
  readonly status?: InstanceStatusProbe
  readonly stateDir: string
}): FakeDeps {
  const opens: Array<{ logDir: string; term: string }> = []
  const ptyOpens: Array<{ instanceId: string; options: OpenShellOptions }> = []
  const execs: Array<{ instanceId: string; command: string; options: SshExecOptions }> = []
  const statusReads: string[] = []
  const calls: string[] = []
  const ptyWrites: string[] = []
  const closed = { count: 0 }
  const stdout = createOutput()

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
    readInstanceStatus: async (instanceId: string): Promise<InstanceStatusProbe> => {
      statusReads.push(instanceId)
      calls.push('readInstanceStatus')
      return input.status ?? { instanceId, status: 'running', statusRaw: '运行中' }
    },
    exec: async (
      instanceId: string,
      command: string,
      options: SshExecOptions,
    ): Promise<SshExecResult> => {
      calls.push('exec')
      execs.push({ instanceId, command, options })
      const stdoutTail = input.exec?.stdoutTail ?? ''
      const stderrTail = input.exec?.stderrTail ?? ''
      // 真实实现边跑边写盘。这里在返回前补上，判据是「终端上看到的是文件内容」。
      await mkdir(dirname(options.logPath), { recursive: true })
      await writeFile(
        options.logPath,
        input.exec?.logContent ?? stdoutTail + stderrTail,
        'utf8',
      )
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
    stateDir: input.stateDir,
    openShell: async (options: { logDir: string; term: string }) => {
      opens.push(options)
      return shellSession
    },
    stdout: stdout.stream,
    stderr: createOutput().stream,
  } as unknown as CliDependencies

  return {
    deps,
    opens,
    ptyOpens,
    execs,
    statusReads,
    calls,
    closed,
    ptyWrites,
    stateDir: input.stateDir,
    stdoutText: stdout.text,
  }
}

describe('shell：交互形态的前置校验', () => {
  it('没有本地 tty 时抛 InteractiveTerminalRequiredError，不建立连接', async () => {
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
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
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
    const { streams } = createStreams({ stdinIsTty: true, columns: 100, rows: 30 })

    await expect(
      runShellCommand({ deps: fake.deps, json: true }, { instanceId: INSTANCE_ID, command: null, term: 'xterm' }, streams),
    ).rejects.toBeInstanceOf(ShellFailedError)

    expect(fake.opens).toEqual([])
  })
})

describe('shell：交互形态', () => {
  it('把本地终端的行列数交给 PTY 通道，不是写死的 80x24', async () => {
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
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
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
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
      stateDir: await createTemporaryStateDir(),
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
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: { exitCode: 0, stdoutTail: 'Linux host 6.8\n' },
    })
    const { streams } = createStreams({ stdinIsTty: false })

    // Act
    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'uname -a', term: 'xterm-256color' },
      streams,
    )

    // Assert：只有一次 exec，PTY 一次都没开。
    expect(fake.ptyOpens).toEqual([])
    expect(fake.execs).toHaveLength(1)
    expect(fake.execs[0]?.instanceId).toBe(INSTANCE_ID)
    expect(fake.execs[0]?.options.timeoutSeconds).toBe(SHELL_COMMAND_TIMEOUT_SECONDS)
    expect(fake.execs[0]?.options.logPath).toBe(
      join(fake.stateDir, 'shell', INSTANCE_ID, 'command.log'),
    )
    // 跑完即断开：通道被关，且只关一次。
    expect(fake.closed.count).toBe(1)
  })

  it('命令包进登录 shell 执行，不是裸交给 exec', async () => {
    // Arrange
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
    const { streams } = createStreams({ stdinIsTty: false })

    // Act
    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'echo $PATH', term: 'xterm' },
      streams,
    )

    // Assert：exec 不分配 PTY、不读 ~/.bashrc；不包登录 shell 就拿不到交互终端的环境。
    expect(fake.execs[0]?.command).toBe(`bash -lc 'echo $PATH'`)
  })

  it('纯函数：命令原文包成登录 shell，单引号按 shell 规则转义', () => {
    // 判据：转义后远端重新解析出来的仍是原文，不丢字符、不多解析一层。
    expect(loginShellCommand('echo $NVM_DIR')).toBe(`bash -lc 'echo $NVM_DIR'`)
    // 内层单引号先切开再按 `'\''` 拼接，远端重新解析得到的仍是 `echo 'a b'`。
    expect(loginShellCommand(`echo 'a b'`)).toBe("bash -lc 'echo '\\''a b'\\'''")
    expect(shellQuote('a b')).toBe(`'a b'`)
  })

  it('先判实例运行中，再跑命令', async () => {
    // Arrange
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
    const { streams } = createStreams({ stdinIsTty: false })

    // Act
    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'uname -a', term: 'xterm' },
      streams,
    )

    // Assert
    expect(fake.statusReads).toEqual([INSTANCE_ID])
    expect(fake.calls).toEqual(['readInstanceStatus', 'exec'])
  })

  it('实例已关机即抛 InstanceNotRunningError（退出码 1），不开 SSH 会话', async () => {
    // Arrange
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      status: { instanceId: INSTANCE_ID, status: 'stopped', statusRaw: '已关机' },
    })
    const { streams } = createStreams({ stdinIsTty: false })

    // Act
    const error = await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'uname -a', term: 'xterm' },
      streams,
    ).catch((caught: unknown) => caught)

    // Assert：判据是「已关机不表现成 SSH 连接失败」。
    expect(error).toBeInstanceOf(InstanceNotRunningError)
    expect((error as InstanceNotRunningError).exitCode).toBe(1)
    expect((error as InstanceNotRunningError).code).toBe('INSTANCE_NOT_RUNNING')
    expect(fake.execs).toEqual([])
    expect(fake.closed.count).toBe(1)
  })

  it('人读模式下把完整输出写进本地终端，不是 200 行尾部摘要', async () => {
    // Arrange：500 行输出，尾部摘要只留最后 200 行。
    const allLines = Array.from({ length: 500 }, (_value, index) => `line-${String(index + 1)}`)
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: {
        exitCode: 0,
        stdoutTail: `${allLines.slice(-200).join('\n')}\n`,
        logContent: `${allLines.join('\n')}\n`,
      },
    })
    const { streams, stdoutText } = createStreams({ stdinIsTty: false })

    // Act
    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'cat big.log', term: 'xterm' },
      streams,
    )

    // Assert：第 1 行也得在终端上。tail 只含 line-301 之后。
    const text = stdoutText()
    expect(text).toContain('line-1\n')
    expect(text).toContain('line-500')
    expect(fake.ptyWrites).toEqual([])
  })

  it('人读模式在结尾补一行完整输出的位置', async () => {
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: { exitCode: 0, stdoutTail: 'total 12\n' },
    })
    const { streams, stdoutText } = createStreams({ stdinIsTty: false })

    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'ls -l', term: 'xterm' },
      streams,
    )

    const logPath = join(fake.stateDir, 'shell', INSTANCE_ID, 'command.log')
    expect(stdoutText().split('\n').filter((line) => line.length > 0)).toEqual([
      'total 12',
      `完整输出：${logPath}`,
    ])
  })

  it('没有任何输出时不补完整输出的那行', async () => {
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
    const { streams, stdoutText } = createStreams({ stdinIsTty: false })

    await runShellCommand(
      { deps: fake.deps, json: false },
      { instanceId: INSTANCE_ID, command: 'true', term: 'xterm' },
      streams,
    )

    expect(stdoutText()).toBe('')
  })

  it('落盘文件读不到时报错，不静默拿尾部摘要顶上', async () => {
    // Arrange：exec 回来但没写盘文件。完整输出是命令的结论，读不到就不能假装有。
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
    const recorded = fake.deps.openShell.bind(fake.deps)
    const brokenDeps = {
      ...fake.deps,
      openShell: async (options: { logDir: string; term: string }) => {
        const session = await recorded(options)
        return {
          ...session,
          exec: async (): Promise<SshExecResult> => ({
            exitCode: 0,
            stdoutTail: 'tail-only\n',
            stderrTail: '',
            stdoutBytes: 10,
            stderrBytes: 0,
            durationMs: 1,
            timedOut: false,
          }),
        }
      },
    } as unknown as CliDependencies
    const { streams } = createStreams({ stdinIsTty: false })

    // Act
    const error = await runShellCommand(
      { deps: brokenDeps, json: false },
      { instanceId: INSTANCE_ID, command: 'ls', term: 'xterm' },
      streams,
    ).catch((caught: unknown) => caught)

    // Assert
    expect(error).toBeInstanceOf(ShellFailedError)
    expect((error as Error).message).toContain('读取完整输出失败')
  })

  it('远端退出码非 0 时抛 ShellFailedError，并带上退出码', async () => {
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: { exitCode: 127, stderrTail: 'nope: command not found' },
    })
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
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: { exitCode: null, timedOut: true },
    })
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

  it('空命令即报错，不开会话也不开 SSH', async () => {
    // 判据：`shell <id> --` 后面什么都没给，远端会拿它开一个什么都不跑的登录 shell，
    // 看起来退出码 0、实际什么都没做。这必须是参数错误。
    const fake = createFakeDeps({ stateDir: await createTemporaryStateDir() })
    const { streams } = createStreams({ stdinIsTty: false })

    await expect(
      runShellCommand(
        { deps: fake.deps, json: false },
        { instanceId: INSTANCE_ID, command: '   ', term: 'xterm' },
        streams,
      ),
    ).rejects.toBeInstanceOf(ShellFailedError)

    expect(fake.opens).toEqual([])
    expect(fake.execs).toEqual([])
  })

  it('会话断开没给退出码时抛错，不当成 0', async () => {
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: { exitCode: null, timedOut: false },
    })
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

describe('shell：落盘文件名', () => {
  it('完整输出落在 shell/<instanceId>/command.log', () => {
    // 判据：证据目录按 <命令名>/<instanceId>/ 建，落盘文件名是 command.log。
    // 改文件名而不改注释，就是「说的和做的不一致」，这条用例把它钉死。
    expect(SHELL_COMMAND_OUTPUT_FILE).toBe('command.log')
    expect(SHELL_EVIDENCE_DIRECTORY).toBe('shell')
  })
})

describe('shell：--json 输出', () => {
  it('--json 的 stdout 只有一个 JSON 对象，字段形状不变', async () => {
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: { exitCode: 0, stdoutTail: 'ignored\n' },
    })
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
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: { exitCode: 3 },
    })
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

  it('--json 下不往 stdout 写完整输出与落盘位置行', async () => {
    // 判据：JSON 模式下 stdout 只有那一个对象；人读模式的「完整输出」行只属于人读模式。
    const fake = createFakeDeps({
      stateDir: await createTemporaryStateDir(),
      exec: { exitCode: 0, stdoutTail: 'x\n', logContent: 'x\n' },
    })
    const { streams } = createStreams({ stdinIsTty: false })
    const stdout = createOutput()

    await runShellCommand(
      { deps: { ...fake.deps, stdout: stdout.stream } as unknown as CliDependencies, json: true },
      { instanceId: INSTANCE_ID, command: 'uname -a', term: 'xterm' },
      streams,
    )

    expect(stdout.text().split('\n').filter((line) => line.length > 0)).toHaveLength(1)
  })
})
