import type { ConsoleInstanceSnapshot } from '../../domain/instance.js'
import type { Profile } from '../../domain/profile.js'
import { ConfigError, PowerOnFailedError } from '../../errors.js'
import type { PowerOnMode } from '../../console/ports.js'
import { writeJson, writeLine } from '../output.js'
import {
  createCommandStores,
  formatPowerOnMode,
  requireProfile,
  type CommandContext,
} from './shared.js'

/**
 * `power`：直接开关一台实例。
 *
 * 判据：
 * - 只开关机，不走销毁路径，不改计划状态。成功即实例处于期望状态（开机为运行中，
 *   关机为已关机）。
 * - 不建计划、不读单价、不设定时关机、不写账本。与 `shell` 同一判据：
 *   生命周期操作不改钱的账。账只在 `teardown` 与失败收尾时封口一行。
 * - 目标形态只有一个来源：显式 `--profile`，否则实例所属计划的部署配置。
 *   两者都拿不到即抛 `ConfigError`，不猜成有卡。
 * - `--gpu` / `--no-gpu` 覆盖目标形态；两个同时给即抛 `ConfigError`。
 * - 开机失败（无可用 GPU、超时、返回后状态不符）即抛 `PowerOnFailedError`，
 *   不静默降级到无卡模式。
 * - 写入磁盘的只有证据目录：控制台截图落 `<stateDir>/power/<instanceId>`。不写状态文件。
 *
 * 证据目录只有一段固定名、不含时间戳：`power` 不是流水线动作，不需要独立现场目录。
 * 同一实例反复开关机会覆盖同名截图，这是有意的：最关心的是最近一次发生了什么。
 */

/** 开关机证据目录名。它落在状态目录的 runs 根下。 */
export const POWER_EVIDENCE_DIRECTORY = 'power'

/** 开关机动作是否带形态。`off` 不带目标形态。 */
export type PowerAction = 'on' | 'off'

export interface PowerCommandOptions {
  /** 目标实例 ID。 */
  readonly instanceId: string
  readonly action: PowerAction
  /** 显式给出的部署配置 id。给出时目标形态取自它，不再查计划。 */
  readonly profileId: string | null
  /** 形态覆盖。`null` 表示不覆盖。 */
  readonly modeOverride: PowerOnMode | null
}

/** `power --json` 的输出形状。 */
export interface PowerCommandResult {
  readonly instanceId: string
  readonly action: PowerAction
  /** 目标形态。`off` 时也给：它是下次按配置开机的形态，输出必须能读到。 */
  readonly powerOnMode: PowerOnMode
  /** 动作结束后控制台给出的状态，归一枚举值。 */
  readonly status: ConsoleInstanceSnapshot['status']
  /** 动作结束后控制台的状态原文。解析与人工读数不一致时它是唯一线索。 */
  readonly statusRaw: string
}

/**
 * 覆盖开关解析。
 *
 * 判据：两个开关要么都不给（用部署配置），要么正好给一个。
 * 同时给是参数冲突，不是「后写的赢」。
 */
export function resolvePowerOnModeOverride(options: {
  readonly gpu?: boolean
  readonly noGpu?: boolean
}): PowerOnMode | null {
  const wantsGpu = options.gpu === true
  const wantsNoGpu = options.noGpu === true
  if (wantsGpu && wantsNoGpu) {
    throw new ConfigError('--gpu 与 --no-gpu 不能同时给：开机形态只能有一个目标。')
  }
  if (wantsGpu) {
    return 'gpu'
  }
  if (wantsNoGpu) {
    return 'no-gpu'
  }
  return null
}

/**
 * 按实测形态判定它是否与目标形态一致。
 *
 * 判据（`ConsoleInstanceSnapshot.noGpuMode`）：true 是无卡，false 是有卡。
 * null 表示页面没给出可判定的信息，同样算不一致：没有事实支撑的「大概对」不能算成功。
 */
export function matchesTargetPowerOnMode(
  targetMode: PowerOnMode,
  observedNoGpuMode: boolean | null,
): boolean {
  if (observedNoGpuMode === null) {
    return false
  }
  return observedNoGpuMode === (targetMode === 'no-gpu')
}

/**
 * `power` 命令实现。
 *
 * 依赖经 `CommandContext` 注入：单测用假 provider，不连浏览器。
 */
export async function runPowerCommand(
  context: CommandContext,
  options: PowerCommandOptions,
): Promise<void> {
  // 先校验参数再碰状态目录与浏览器：参数写错不应该在磁盘上留下任何东西。
  if (options.instanceId.trim().length === 0) {
    throw new ConfigError('instanceId 不能为空。')
  }

  const targetMode = await resolveTargetMode(context, options)
  // 证据目录口径：不带 run 的命令一律 <stateDir>/<命令名>/<instanceId>。
  // 路径解析的单一入口是 `commandEvidenceDir`，命令不自己拼。
  const logDir = await context.deps.commandEvidenceDir(
    POWER_EVIDENCE_DIRECTORY,
    options.instanceId,
  )

  // 会话生命周期交给 `withProvider`：开、调、关各一次，命令不自己管。
  // 判据：所有用到 provider 的代码都在这个回调里，不把 provider 或它的中间结果提到外面。
  const result = await context.deps.withProvider(logDir, async (provider) => {
    // 控制台列表不自动刷新，读之前先让它取一次新数据。
    const before = await readInstance(provider.listInstances.bind(provider), options.instanceId)
    if (options.action === 'off') {
      await provider.powerOff(options.instanceId)
    } else {
      const outcome = await provider.powerOn(options.instanceId, targetMode)
      if (!outcome.ok) {
        throw new PowerOnFailedError(options.instanceId, targetMode, outcome.reason, outcome.detail, before.statusRaw)
      }
    }
    const after = await readInstance(provider.listInstances.bind(provider), options.instanceId)
    return {
      instanceId: options.instanceId,
      action: options.action,
      powerOnMode: targetMode,
      status: after.status,
      statusRaw: after.statusRaw,
    } satisfies PowerCommandResult
  })

  assertFinalStatus(result)
  context.deps.logger.info('power.done', {
    instanceId: result.instanceId,
    action: result.action,
    powerOnMode: result.powerOnMode,
    status: result.status,
  })
  emitPowerResult(context, result)
}

/**
 * 算目标形态。
 *
 * 优先级：`--gpu` / `--no-gpu` 覆盖 > `--profile` 指定的配置 > 实例所属计划的配置。
 * 三处都拿不到即报错：形态决定单价与能否开机，猜错的代价是一整次部署。
 */
async function resolveTargetMode(
  context: CommandContext,
  options: PowerCommandOptions,
): Promise<PowerOnMode> {
  if (options.modeOverride !== null) {
    return options.modeOverride
  }
  const profile = await resolveProfileForInstance(context, options)
  return profile.powerOnMode
}

/** 取决定目标形态的那份部署配置。 */
async function resolveProfileForInstance(
  context: CommandContext,
  options: PowerCommandOptions,
): Promise<Profile> {
  const profiles = await context.deps.loadProfiles()
  if (options.profileId !== null) {
    return requireProfile(profiles, options.profileId)
  }
  const stores = createCommandStores(context)
  const plans = await stores.planStore.listAll()
  const plan = plans.find((candidate) => candidate.instanceId === options.instanceId)
  if (plan === undefined) {
    throw new ConfigError(
      `状态目录里没有任何计划绑定实例 ${options.instanceId}，无法确定它的开机形态。` +
        '用 --profile 指定部署配置，或用 --gpu / --no-gpu 显式指定目标形态。',
    )
  }
  return requireProfile(profiles, plan.profileId)
}

/**
 * 动作结束后的终态判据。
 *
 * 判据以列表事实为准，不以动作返回为准：`powerOff` 的契约是「等到已关机」，
 * `powerOn` 的契约是「等到运行中且形态一致」。不符即抛错，不静默当成功。
 */
function assertFinalStatus(result: PowerCommandResult): void {
  if (result.action === 'off') {
    if (result.status !== 'stopped') {
      throw new PowerOnFailedError(
        result.instanceId,
        result.powerOnMode,
        'timeout',
        `动作返回后实例状态是「${result.statusRaw}」，不是已关机。`,
        result.statusRaw,
      )
    }
    return
  }
  if (result.status !== 'running') {
    throw new PowerOnFailedError(
      result.instanceId,
      result.powerOnMode,
      'timeout',
      `动作返回后实例状态是「${result.statusRaw}」，不是运行中。`,
      result.statusRaw,
    )
  }
}

/** 读一台实例的快照。不在列表里即抛 `ConfigError`：调用方拿不到快照就不会往下动作。 */
async function readInstance(
  listInstances: (options: { readonly refresh: boolean }) => Promise<readonly ConsoleInstanceSnapshot[]>,
  instanceId: string,
): Promise<ConsoleInstanceSnapshot> {
  const snapshots = await listInstances({ refresh: true })
  const snapshot = snapshots.find((candidate) => candidate.instanceId === instanceId)
  if (snapshot === undefined) {
    throw new ConfigError(`控制台实例列表里找不到实例 ${instanceId}，无法执行开关机。`)
  }
  return snapshot
}

function emitPowerResult(context: CommandContext, result: PowerCommandResult): void {
  if (context.json) {
    writeJson(context.deps.stdout, result)
    return
  }
  const actionText = result.action === 'on' ? '开机' : '关机'
  writeLine(
    context.deps.stdout,
    `实例 ${result.instanceId} ${actionText}完成：目标形态${formatPowerOnMode(result.powerOnMode)}，` +
      `当前状态「${result.statusRaw}」。`,
  )
}
