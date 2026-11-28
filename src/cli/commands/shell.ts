import { join } from 'node:path'
import type { InstanceStatusProbe } from '../../console/instance-list.js'
import {
  InstanceNotRunningError,
  InteractiveTerminalRequiredError,
  ShellFailedError,
} from '../../errors.js'
import type { SshCommandPort, SshShellPort, TerminalSize } from '../../ssh/ports.js'
import { formatShellBanner, readTerminalSize } from '../../ssh/shell-channel.js'
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
 * 2. `shell -- <command>`：走 `SshPort.exec` 跑一条命令，拿远端退出码。
 *    不开 PTY：PTY 会话的结束事件依赖远端 shell 主动退出，远端退出后本地可能收不到，
 *    命令跑得再对也会卡到超时。`exec` 的语义就是「跑完一条命令拿退出码」，跑完即断开。
 *
 * 判据：
 * - 只连运行中的实例。已关机或创建中即抛 `InstanceNotRunningError`（退出码 1）。
 * - 不建计划、不读单价、不设定时关机。终端不改实例生命周期。
 * - 不校验计划。计划外的实例（人手工开机的）照样能连。
 * - `--json` 模式下不进入交互形态：JSON 输出与人敲键盘的终端不能同时成立。
 * - 非交互形态拿不到远端退出码即失败，不当成 0。
 */

/** 终端会话的证据目录名。它落在本次会话自己的目录下。 */
export const SHELL_EVIDENCE_DIRECTORY = 'shell'

/** 非交互形态的完整输出落盘文件名。它落在证据目录里，与 `run` 的逐字日志同样对待。 */
export const SHELL_COMMAND_OUTPUT_FILE = 'command.log'

/**
 * 非交互形态的超时，秒。
 *
 * 判据：`shell -- <command>` 是运维入口，跑的是能在人眼前完成的动作（看状态、清缓存、
 * 重启进程）。它不承担安装与构建，那两类有独立的引导脚本与 7200 秒上限。
 * 超过这个上限的命令应当改写成脚本并走引导脚本，不要靠调大它。
 */
export const SHELL_COMMAND_TIMEOUT_SECONDS = 600

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
 * 依赖经 `CommandContext` 与 `TerminalStreams` 注入：单测用内存流与假端口，
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
  if (isInteractive) {
    await runInteractiveShell(context, options, streams)
    return
  }
  await runSingleCommand(context, options, streams)
}

/**
 * 交互形态：开 PTY，转发键盘与窗口尺寸。
 *
 * 终态唯一来源是会话的 `exitCode`。拿不到就意味着远端状态未知，交给人核对。
 */
async function runInteractiveShell(
  context: CommandContext,
  options: ShellCommandOptions,
  streams: TerminalStreams,
): Promise<void> {
  const size = readTerminalSize(streams.stdin)
  const session = await context.deps.openShell({
    logDir: context.deps.stateDir,
    term: options.term,
  })

  let dataListener: ((chunk: Buffer) => void) | undefined
  let resizeListener: (() => void) | undefined
  try {
    const shellSession = await session.shell.openShell(
      options.instanceId,
      {
        onData: (chunk: Buffer) => {
          streams.stdout.write(chunk)
        },
        onResize: () => undefined,
      },
      { size, term: options.term },
    )

    writeLine(context.deps.stderr, formatShellBanner({ instanceId: options.instanceId }))
    dataListener = (chunk: Buffer) => {
      shellSession.write(chunk)
    }
    streams.stdin.on('data', dataListener)
    streams.stdin.resume()
    resizeListener = () => {
      shellSession.resize(readTerminalSize(streams.stdin))
    }
    streams.stdout.on('resize', resizeListener)

    const outcome = await shellSession.wait()
    if (outcome.exitCode === null) {
      throw new ShellFailedError(
        '终端会话没有拿到远端退出码' +
          (outcome.transportFailure === null ? '：连接在你离开前断开。' : `：${outcome.transportFailure}。`) +
          '远端命令是否执行完成未知，请人工核对实例状态。',
      )
    }
    writeLine(
      context.deps.stderr,
      `会话已结束，远端 shell 退出码 ${String(outcome.exitCode)}。`,
    )
  } finally {
    if (resizeListener !== undefined) {
      streams.stdout.off('resize', resizeListener)
    }
    if (dataListener !== undefined) {
      streams.stdin.off('data', dataListener)
    }
    await session.close()
  }
}

/**
 * 非交互形态：走数据面 `exec` 跑一条命令。
 *
 * 判据：
 * - 输出整份落盘到 `<stateDir>/shell/<instanceId>/.log`，本地不攒全量。
 * - 退出码只取远端退出码。`null`（超时被杀或对端没发退出码）按失败处理，不当成 0。
 * - `--json` 与「非 0 即抛 `ShellFailedError`」互斥：JSON 要能读到非 0 退出码本身，
 *   抛错则 stdout 只剩一个对象、退出码仍由 `ShellFailedError` 裁决。
 */
async function runSingleCommand(
  context: CommandContext,
  options: ShellCommandOptions,
  streams: TerminalStreams,
): Promise<void> {
  const command = options.command ?? ''
  const logPath = join(
    context.deps.stateDir,
    SHELL_EVIDENCE_DIRECTORY,
    options.instanceId,
    SHELL_COMMAND_OUTPUT_FILE,
  )
  const ssh = await openCommandPort(context, options)
  try {
    const result = await ssh.exec(options.instanceId, command, {
      timeoutSeconds: SHELL_COMMAND_TIMEOUT_SECONDS,
      logPath,
    })

    if (result.exitCode === null) {
      throw new ShellFailedError(
        result.timedOut
          ? `远端命令执行超过 ${String(SHELL_COMMAND_TIMEOUT_SECONDS)} 秒被终止，没有拿到退出码。` +
              `完整输出：${logPath}。远端命令是否已生效未知，请人工核对实例状态。`
          : `远端命令没有给出退出码，会话已断开。完整输出：${logPath}。` +
              '远端命令是否执行完成未知，请人工核对实例状态。',
      )
    }

    if (context.json) {
      writeJson(context.deps.stdout, {
        instanceId: options.instanceId,
        command,
        exitCode: result.exitCode,
        transportFailure: null,
      })
      if (result.stderrTail.trim().length > 0) {
        writeLine(context.deps.stderr, result.stderrTail)
      }
      if (result.exitCode !== 0) {
        throw new ShellFailedError(`远端命令退出码 ${String(result.exitCode)}。完整输出：${logPath}。`)
      }
      return
    }

    if (result.stdoutTail.length > 0) {
      streams.stdout.write(result.stdoutTail)
    }
    if (result.stderrTail.length > 0) {
      streams.stdout.write(result.stderrTail)
    }
    if (result.exitCode !== 0) {
      throw new ShellFailedError(`远端命令退出码 ${String(result.exitCode)}。完整输出：${logPath}。`)
    }
  } finally {
    await ssh.close()
  }
}

/**
 * 取一次数据面会话。
 *
 * 非交互形态与交互形态共用 `openShell` 这一个入口：凭据来源、主机密钥指纹校验、
 * 实例状态前置判断都只有一份。差别只在拿 `exec` 还是拿 PTY。
 * 实例是否运行中的判断由通道层做，命令不重复判一次：判两次等于两个事实来源。
 */
async function openCommandPort(
  context: CommandContext,
  options: ShellCommandOptions,
): Promise<{ readonly exec: SshCommandPort['exec']; readonly close: () => Promise<void> }> {
  const session = await context.deps.openShell({
    logDir: context.deps.stateDir,
    term: options.term,
  })
  return {
    exec: async (instanceId, command, execOptions) =>
      await session.exec(instanceId, command, execOptions),
    close: async () => {
      await session.close()
    },
  }
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
