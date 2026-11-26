import type { InstanceStatusProbe } from '../../console/instance-list.js'
import { InstanceNotRunningError, InteractiveTerminalRequiredError, ShellFailedError } from '../../errors.js'
import type { SshShellPort, TerminalSize } from '../../ssh/ports.js'
import { formatShellBanner, readTerminalSize, requireShellExitCode } from '../../ssh/shell-channel.js'
import { writeJson, writeLine } from '../output.js'
import type { CommandContext } from './shared.js'

/**
 * `shell`：连到运行中实例的交互式终端。
 *
 * 两种形态（spec 第 4 节）：
 *
 * 1. `shell <instanceId>`：开一条 PTY shell，把本地键盘与窗口尺寸转发过去。
 *    需要本地有 tty。没有 tty 即抛 `InteractiveTerminalRequiredError`（退出码 2），
 *    不静默退化成非交互。
 * 2. `shell -- <command>`：在 PTY 里跑一条命令。本地没有 tty 也能跑，输出照常落盘。
 *
 * 判据：
 * - 只连运行中的实例。已关机或创建中即抛 `InstanceNotRunningError`（退出码 1）。
 * - 不建计划、不读单价、不设定时关机。终端不改实例生命周期。
 * - 不校验计划。计划外的实例（人手工开机的）照样能连。
 * - `--json` 模式下不进入交互形态：JSON 输出与人敲键盘的终端不能同时成立。
 */

/** 终端会话的证据目录名。它落在本次会话自己的目录下。 */
export const SHELL_EVIDENCE_DIRECTORY = 'shell'

/** 本地输入与输出流。生产用 `process.stdin` / `process.stdout`。 */
export interface TerminalStreams {
  /** 本地输入。交互形态从它读按键。 */
  readonly stdin: NodeJS.ReadStream
  /** 本地输出。交互形态把远端字节写给它，不走 CLI 的 stdout 抽象。 */
  readonly stdout: NodeJS.WriteStream
}

export interface ShellCommandOptions {
  /** 目标实例 ID。由 `--instance` 或位置参数给出。 */
  readonly instanceId: string
  /** 要执行的命令。给出即非交互形态，一条命令跑完即退出。 */
  readonly command: string | null
  /** 终端类型，写进远端 `$TERM`。 */
  readonly term: string
}

/**
 * `shell` 命令实现。
 *
 * 依赖经 `CommandContext` 与 `TerminalStreams` 注入：单测用内存流与假通道，
 * 不碰真实网络、不读真实键盘。
 */
export async function runShellCommand(
  context: CommandContext,
  options: ShellCommandOptions,
  streams: TerminalStreams,
): Promise<void> {
  const isInteractive = options.command === null
  if (isInteractive && context.json) {
    throw new ShellFailedError(
      '交互式终端不能与 --json 同时使用：JSON 必须只输出一个对象，而交互形态会把远端字节直接写进终端。' +
        '要交互就去掉 --json；要机器可读就改用 `shell -- <command>`。',
    )
  }
  if (isInteractive && !isTty(streams.stdin)) {
    throw new InteractiveTerminalRequiredError()
  }

  const size = readTerminalSize(streams.stdin)
  const session = await context.deps.openShell({
    logDir: context.deps.stateDir,
    term: options.term,
  })

  let resizeListener: (() => void) | undefined
  try {
    const shell = session.shell
    const shellSession = await shell.openShell(
      options.instanceId,
      {
        onData: (chunk: Buffer) => {
          streams.stdout.write(chunk)
        },
        onResize: () => undefined,
      },
      { size, term: options.term },
    )

    if (!isInteractive) {
      // 非交互形态：命令由远端登录 shell 执行，与交互形态走同一条 PTY 通道，
      // 所以 `apt install` 这类需要确认的步骤能看到提示、能拿到输入流。
      shellSession.write(Buffer.from(`${options.command}\n`, 'utf8'))
    } else {
      writeLine(context.deps.stderr, formatShellBanner({ instanceId: options.instanceId }))
      streams.stdin.on('data', (chunk: Buffer) => {
        shellSession.write(chunk)
      })
      streams.stdin.resume()
      resizeListener = () => {
        shellSession.resize(readTerminalSize(streams.stdin))
      }
      streams.stdout.on('resize', resizeListener)
    }

    const outcome = await shellSession.wait()
    const exitCode = requireShellExitCode(outcome)

    if (context.json) {
      writeJson(context.deps.stdout, {
        instanceId: options.instanceId,
        command: options.command,
        exitCode,
        transportFailure: outcome.transportFailure,
      })
      return
    }
    if (!isInteractive && exitCode !== 0) {
      throw new ShellFailedError(`远端命令退出码 ${String(exitCode)}。`)
    }
  } finally {
    if (resizeListener !== undefined) {
      streams.stdout.off('resize', resizeListener)
    }
    streams.stdin.pause()
    streams.stdin.off('data', handleNoop)
    await session.close()
  }
}

/** `stdin.off('data', ...)` 需要同一个函数引用；交互分支用的是匿名函数，这里只兜住没有监听的情况。 */
function handleNoop(): void {
  return undefined
}

/** 判断一个流是不是真实终端。拿不到 `isTTY` 时按「不是」处理。 */
export function isTty(stream: { readonly isTTY?: boolean }): boolean {
  return stream.isTTY === true
}

/** 供 `shell` 命令判断实例状态时复用的形状。 */
export type ShellInstanceStatus = InstanceStatusProbe

/** 实例状态不是运行中时的错误构造。放在这里，命令与测试共用同一个错误。 */
export function requireRunningInstance(probe: InstanceStatusProbe): InstanceStatusProbe {
  if (probe.status !== 'running') {
    throw new InstanceNotRunningError(probe.instanceId, probe.statusRaw)
  }
  return probe
}

/** 终端尺寸的默认展示。人读模式下打出来便于排查排版问题。 */
export function formatTerminalSize(size: TerminalSize): string {
  return `${String(size.columns)}x${String(size.rows)}`
}

/** 供依赖装配的端口类型别名，避免命令文件依赖 ssh 模块的具体实现。 */
export type { SshShellPort }
