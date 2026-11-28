import { readFile } from 'node:fs/promises'
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
 *   两种形态各有一次判断：交互形态由终端通道判，非交互形态由本命令在开 exec 之前判。
 * - 不建计划、不读单价、不设定时关机。终端不改实例生命周期。
 * - 不校验计划。计划外的实例（人手工开机的）照样能连。
 * - `--json` 模式下不进入交互形态：JSON 输出与人敲键盘的终端不能同时成立。
 * - 非交互形态拿不到远端退出码即失败，不当成 0。
 * - 非交互形态的人读输出是**完整输出**，不是摘要：`shell -- cat .env` 必须能看到全文。
 *   摘要只属于 `--json` 的 tail 字段。
 */

/** 终端会话的证据目录名。它落在本次会话自己的目录下。 */
export const SHELL_EVIDENCE_DIRECTORY = 'shell'

/** 非交互形态的完整输出落盘文件名。它落在证据目录里，与 `run` 的逐字日志同样对待。 */
export const SHELL_COMMAND_OUTPUT_FILE = 'command.log'

/**
 * 非交互形态的超时，秒。
 *
 * 判据：`shell -- <command>` 是运维入口，跑的是能在人眼前完成的动作（看状态、清缓存、
 * 重启进程）。装环境、拉代码、起服务不归引擎，由使用者自己在实例上执行；
 * 耗时超过这个上限的长任务改走交互终端，不要靠调大它。
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
 * - 命令用登录 shell 执行（`bash -lc '<命令>'`）。`exec` 不分配 PTY，也不读 `~/.bashrc`；
 *   不包登录 shell 时 `shell -- 'echo $PATH'` 拿到的环境与交互终端里 `echo $PATH` 不一致。
 * - 先判实例运行中再取凭据。已关机实例即抛 `InstanceNotRunningError`（退出码 1），
 *   `exec` 通道没有这条判断，不能把「实例没开」表现成 SSH 连接失败。
 * - 输出整份落盘到 `<stateDir>/shell/<instanceId>/command.log`：`exec` 只回尾部摘要，
 *   本地不攒全量。
 * - 人读模式把**完整输出**写到终端（读回 `logPath`），不写尾部摘要。摘要只给 `--json`。
 * - 人读模式下输出不是 0 字节时，末尾补一行完整输出的位置：屏幕可能被滚掉。
 * - 退出码只取远端退出码。`null`（超时被杀或对端没发退出码）按失败处理，不当成 0。
 * - `--json` 与「非 0 即抛 `ShellFailedError`」互斥：JSON 要能读到非 0 退出码本身，
 *   抛错则 stdout 只剩一个对象、退出码仍由 `ShellFailedError` 裁决。
 */
async function runSingleCommand(
  context: CommandContext,
  options: ShellCommandOptions,
  streams: TerminalStreams,
): Promise<void> {
  const remoteCommand = requireCommandText(options.command ?? '')
  const logPath = join(
    context.deps.stateDir,
    SHELL_EVIDENCE_DIRECTORY,
    options.instanceId,
    SHELL_COMMAND_OUTPUT_FILE,
  )
  const ssh = await openCommandPort(context, options)
  try {
    requireRunningInstance(await ssh.readStatus(options.instanceId))
    const result = await ssh.exec(options.instanceId, loginShellCommand(remoteCommand), {
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
        command: remoteCommand,
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

    const completeOutput = await readCompleteOutput(logPath)
    if (completeOutput.byteLength > 0) {
      streams.stdout.write(completeOutput)
      writeLine(streams.stdout, `完整输出：${logPath}`)
    }
    if (result.exitCode !== 0) {
      throw new ShellFailedError(`远端命令退出码 ${String(result.exitCode)}。完整输出：${logPath}。`)
    }
  } finally {
    await ssh.close()
  }
}

/**
 * 远端要执行的完整命令行：命令原文包进登录 shell。
 *
 * 判据：包的是 `bash -lc '<原文>'`，原文里的单引号先按 shell 规则转义，
 * 因此 `echo 'a b'` 到远端还是 `echo 'a b'`，不会被本地解析一遍。
 * 登录 shell 读远端 `~/.bash_profile` / `~/.profile` / `~/.bashrc`，
 * 这是「与交互终端环境一致」的实现方式。
 */
export function loginShellCommand(rawCommand: string): string {
  return `bash -lc ${shellQuote(rawCommand)}`
}

/** 把一个字符串包成单引号形式，供 POSIX shell 逐字还原。 */
export function shellQuote(raw: string): string {
  return `'${raw.split("'").join(`'\\''`)}'`
}

/** 空命令是参数错误：远端会拿它开一个没有任何东西可跑的登录 shell。 */
function requireCommandText(rawCommand: string): string {
  if (rawCommand.trim().length === 0) {
    throw new ShellFailedError(
      '非交互形态需要一个非空命令：`shell <instanceId> -- <command>`。' +
        '要去交互终端，去掉 `--` 之后的命令。',
    )
  }
  return rawCommand
}

/**
 * 读回落盘的完整输出。
 *
 * 判据：写进终端的是落盘文件本身，不是 `SshExecResult` 的 tail。文件读不到即报错：
 * `exec` 已经声明「输出整份落盘」，读不到就是落盘没成立，不能静默拿摘要顶上。
 */
async function readCompleteOutput(logPath: string): Promise<Buffer> {
  try {
    return await readFile(logPath)
  } catch (error: unknown) {
    throw new ShellFailedError(
      `读取完整输出失败：${logPath}。远端输出已落盘，但本进程读不到它。`,
      { cause: error },
    )
  }
}

/**
 * 取一次数据面会话。
 *
 * 非交互形态与交互形态共用 `openShell` 这一个入口：凭据来源、主机密钥指纹校验、
 * 浏览器通道都只有一份。差别只在拿 `exec` 还是拿 PTY。
 * 实例是否运行中由命令自己判一次（`readStatus`）：`exec` 通道不带这条判断，
 * 而终端通道带了。判据仍是「只连运行中的实例」，两种形态各自守一遍。
 */
async function openCommandPort(
  context: CommandContext,
  options: ShellCommandOptions,
): Promise<{
  readonly exec: SshCommandPort['exec']
  readonly readStatus: (instanceId: string) => Promise<InstanceStatusProbe>
  readonly close: () => Promise<void>
}> {
  const session = await context.deps.openShell({
    logDir: context.deps.stateDir,
    term: options.term,
  })
  return {
    exec: async (instanceId, command, execOptions) =>
      await session.exec(instanceId, command, execOptions),
    readStatus: async (instanceId) => await session.readInstanceStatus(instanceId),
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
