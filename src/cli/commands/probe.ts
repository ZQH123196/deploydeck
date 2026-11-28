import { join } from 'node:path'
import type { InstanceStatusProbe } from '../../console/instance-list.js'
import { PROBE_COMMAND, PROBE_TIMEOUT_SECONDS } from '../../engine/steps.js'
import { InstanceNotRunningError, ProbeFailedError } from '../../errors.js'
import type { SshExecOptions, SshExecResult } from '../../ssh/ports.js'
import type { Clock } from '../../util/clock.js'
import type { ShellSession } from '../dependencies.js'
import { emitResult, type CommandContext } from './shared.js'

/**
 * `probe`：确认一台实例能不能连上并执行一条命令。
 *
 * 判据：
 * - 只回答「SSH 能不能连上并执行一条命令」，不回答「业务服务起来没有」。
 *   执行的是引擎写死的一条命令（`PROBE_COMMAND`），不读任何配置。
 * - 只连运行中的实例。已关机即抛 `InstanceNotRunningError`（退出码 1），
 *   不把「实例没开」表现成 SSH 连接失败。与 `shell` 同一条判据。
 * - 不建计划、不读单价、不设定时关机、不写账本、不改实例状态。与 `shell` / `power` 同一条判据。
 * - 不校验计划。计划外手工开机的实例照样能 probe。
 * - 连不上、命令超时、退出码非 0 一律抛 `ProbeFailedError`（退出码 1）。
 * - 证据目录是 `<stateDir>/probe/<instanceId>/`，与 `power` / `switch` 一致。
 *   `true` 没有输出，所以不落盘输出：空文件会被读成「探测没跑」。
 */

/** 探测的证据目录名。不带 run 的命令一律 `<stateDir>/<命令名>/<instanceId>`。 */
export const PROBE_EVIDENCE_DIRECTORY = 'probe'

/**
 * 数据面通道的终端类型。
 *
 * 判据：`exec` 不分配 PTY，`$TERM` 不参与探测判断。固定值只为满足会话入口的入参。
 */
const PROBE_TERM = 'xterm-256color'

export interface ProbeCommandOptions {
  /** 目标实例 ID。 */
  readonly instanceId: string
}

/** `probe --json` 的输出形状。 */
export interface ProbeCommandResult {
  readonly instanceId: string
  /** 能连上并执行一条命令即 `true`。失败时本命令抛错，不输出 `false`。 */
  readonly reachable: true
  /** 从命令发出到拿到退出码的耗时，毫秒，取注入时钟。 */
  readonly durationMs: number
}

/** `probe` 用到的数据面出口。从 `ShellSession` 里取这一小片，命令不依赖整条终端通道。 */
export interface ProbeSession {
  readonly exec: ShellSession['exec']
  readonly readInstanceStatus: ShellSession['readInstanceStatus']
  readonly close: ShellSession['close']
}

/**
 * `probe` 命令实现。
 *
 * 会话入口复用 `deps.openShell`：它与 `shell -- <命令>` 是同一条控制台会话、
 * 同一套凭据与主机密钥校验，不另开一套浏览器会话。
 */
export async function runProbeCommand(
  context: CommandContext,
  options: ProbeCommandOptions,
): Promise<void> {
  // 先校验参数再碰状态目录与浏览器：参数写错不应该在磁盘上留下任何东西。
  if (options.instanceId.trim().length === 0) {
    throw new ProbeFailedError('instanceId 不能为空。')
  }

  const logDir = await context.deps.commandEvidenceDir(
    PROBE_EVIDENCE_DIRECTORY,
    options.instanceId,
  )
  const session = await context.deps.openShell({ logDir, term: PROBE_TERM })
  let durationMs: number
  try {
    // 与 `shell` 同一条判据：先判实例运行中，再开 SSH。
    const status = await session.readInstanceStatus(options.instanceId)
    requireRunningInstance(status)
    durationMs = await probeWithSession({
      session,
      instanceId: options.instanceId,
      logDir,
      clock: context.deps.clock,
    })
  } finally {
    await session.close()
  }

  const payload: ProbeCommandResult = {
    instanceId: options.instanceId,
    reachable: true,
    durationMs,
  }
  context.deps.logger.info('probe.done', {
    instanceId: options.instanceId,
    command: PROBE_COMMAND,
    timeoutSeconds: PROBE_TIMEOUT_SECONDS,
    durationMs,
    logDir,
  })
  emitResult(context, payload, [
    `实例 ${options.instanceId} 可达：${PROBE_COMMAND} 退出码 0，耗时 ${String(durationMs)} ms。`,
  ])
}

/**
 * 在一条数据面会话上执行固定探测命令，返回耗时，毫秒。取注入时钟。
 *
 * 判据：
 * - 退出码 0 才算可达。超时、没有退出码、非 0 一律 `ProbeFailedError`。
 *   `true` 恒真，所以这三类都说明链路或 shell 有问题，不是业务问题。
 * - 建连与传输异常也归 `ProbeFailedError`，原始错误经 `cause` 保留。
 *   SSH 类错误的退出码同样是 1，码名统一成 `PROBE_FAILED` 只为了让机器读者按一个码分叉。
 * - `exec` 要一个日志落点，完整输出写在那里。`true` 没有输出，文件到场时是空的。
 */
async function probeWithSession(input: {
  readonly session: ProbeSession
  readonly instanceId: string
  readonly logDir: string
  readonly clock: Clock
}): Promise<number> {
  const startedAtMillis = input.clock.now()
  let result: SshExecResult
  try {
    result = await input.session.exec(input.instanceId, PROBE_COMMAND, {
      timeoutSeconds: PROBE_TIMEOUT_SECONDS,
      logPath: probeLogPath(input.logDir),
    })
  } catch (error: unknown) {
    throw new ProbeFailedError(
      `探测失败：连不上实例 ${input.instanceId}，或 SSH 会话没有建立。` +
        `证据目录：${input.logDir}。`,
      { cause: error },
    )
  }
  const durationMs = Math.max(0, input.clock.now() - startedAtMillis)

  if (result.timedOut) {
    throw new ProbeFailedError(
      `探测超时：${PROBE_COMMAND} 在 ${String(PROBE_TIMEOUT_SECONDS)} 秒内没有返回，判定实例不可达。` +
        `实例 ${input.instanceId} 的 SSH 可能不通，也可能 shell 不能执行命令。` +
        `证据目录：${input.logDir}。`,
    )
  }
  if (result.exitCode === null) {
    throw new ProbeFailedError(
      `探测没有拿到退出码：会话在 ${PROBE_COMMAND} 返回前断开。` +
        `实例 ${input.instanceId} 是否可达未知。证据目录：${input.logDir}。`,
    )
  }
  if (result.exitCode !== 0) {
    throw new ProbeFailedError(
      `探测命令 ${PROBE_COMMAND} 退出码 ${String(result.exitCode)}，期望 0。` +
        `实例 ${input.instanceId} 的 shell 不能正常执行命令。证据目录：${input.logDir}。`,
    )
  }
  return durationMs
}

/**
 * 实例状态判据：只连运行中的实例。
 *
 * 判据与 `shell` 相同：已关机即抛 `InstanceNotRunningError`（退出码 1），
 * 不表现成 SSH 连接失败。
 */
function requireRunningInstance(status: InstanceStatusProbe): void {
  if (status.status !== 'running') {
    throw new InstanceNotRunningError(status.instanceId, status.statusRaw)
  }
}

/** 证据目录下只有一个固定文件名，重复探测覆盖它。 */
function probeLogPath(logDir: string): string {
  return join(logDir, PROBE_LOG_FILE)
}

/** 探测日志文件名。 */
export const PROBE_LOG_FILE = 'probe.log'
