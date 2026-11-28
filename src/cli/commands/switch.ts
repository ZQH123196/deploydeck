import type { ConsoleInstanceSnapshot } from '../../domain/instance.js'
import { ConfigError, InstanceFormMismatchError, PowerOnFailedError } from '../../errors.js'
import type { PowerOnMode, PowerPort } from '../../console/ports.js'
import type { Provider } from '../../providers/provider.js'
import { writeJson, writeLine } from '../output.js'
import { formatPowerOnMode, type CommandContext } from './shared.js'
import { matchesTargetPowerOnMode } from './power.js'

/**
 * `switch`：把一台实例在有卡与无卡之间切换。
 *
 * 内部顺序固定：关机 → 按目标形态开机 → 复验形态。顺序不可交换：
 * 运行中的实例不能直接改形态，必须先关机；关机后实例 ID 不变，这是切换能成立的前提。
 *
 * 判据：
 * 1. 切换后实例仍在，`instanceId` 不变。命令只调用 `powerOff` / `powerOn`，
 *    契约上没有任何销毁动作；关机后重新读到的实例 ID 必须与给定值相同。
 * 2. 单价变化不触发漂移判定。本命令不读单价、不读单价缓存、不写状态：
 *    形态换了单价自然不同，把这次差价判成「单价漂移」就会误删实例。
 * 3. 任一步失败时停下并保留实例，不销毁。失败后不重试、不回滚形态，
 *    实例停在那一刻的状态，由人决定下一步。
 *
 * 复验判据：`noGpuMode` 为 true 是无卡，false 是有卡。目标与复验不一致即报错，
 * 错误消息里写实测形态。null 同样算不一致。
 *
 * 已被 `teardown` 或 `guard` 销毁的实例不在列表里，切换在第一步之前就失败。
 */

/** 切换动作的证据目录名。它落在状态目录的 runs 根下。 */
export const SWITCH_EVIDENCE_DIRECTORY = 'switch'

export interface SwitchCommandOptions {
  /** 目标实例 ID。 */
  readonly instanceId: string
  /** 目标形态。`gpu` 与 `no-gpu` 必选其一。 */
  readonly targetMode: PowerOnMode
}

/** `switch --json` 的输出形状。 */
export interface SwitchCommandResult {
  readonly instanceId: string
  readonly targetMode: PowerOnMode
  /** 复验读到的实测形态。`true` 是无卡，`false` 是有卡，`null` 是页面没给出。 */
  readonly observedNoGpuMode: boolean | null
  readonly status: ConsoleInstanceSnapshot['status']
  readonly statusRaw: string
}

/** 命令装配用到的开关机端口。它不由 `CliDependencies` 注入，由 provider 会话给出。 */
export interface SwitchPowerPorts {
  readonly powerOn: PowerPort['powerOn']
  readonly powerOff: PowerPort['powerOff']
  readonly listInstances: Provider['listInstances']
}

/**
 * 切换序列本身。
 *
 * 与命令外壳分开：这一段决定动作顺序与失败裁决，端口由调用方给出。
 * 单测直接对它下断言，顺序与「失败即停」不依赖浏览器。
 */
export async function switchInstanceForm(
  ports: SwitchPowerPorts,
  options: SwitchCommandOptions,
): Promise<void> {
  const before = await requireInstance(ports, options.instanceId)
  if (before.status === 'running' && matchesTargetPowerOnMode(options.targetMode, before.noGpuMode)) {
    // 已经是目标形态：不做事，也不关机。重复关机再开机会打断正在跑的服务。
    return
  }

  // 第一步：关机。关机只改电源状态，不销毁实例。
  await ports.powerOff(options.instanceId)
  // 关机后按给定 ID 再读一次：它是「实例还在、ID 没变」的直接证据。
  // 读不到说明实例已经不在列表里，实例 ID 这个前提失效，切换必须在这里停下。
  const stopped = await requireInstance(ports, options.instanceId)
  if (stopped.status !== 'stopped') {
    throw new ConfigError(
      `实例 ${options.instanceId} 关机后状态是「${stopped.statusRaw}」，不是已关机，切换中止。`,
    )
  }

  // 第二步：按目标形态开机。
  const outcome = await ports.powerOn(options.instanceId, options.targetMode)
  if (!outcome.ok) {
    throw new PowerOnFailedError(
      options.instanceId,
      options.targetMode,
      outcome.reason,
      outcome.detail,
      stopped.statusRaw,
    )
  }

  // 第三步：复验形态。失败时实例仍是开着的，由人决定。
  const after = await requireInstance(ports, options.instanceId)
  if (!matchesTargetPowerOnMode(options.targetMode, after.noGpuMode)) {
    throw new InstanceFormMismatchError({
      instanceId: options.instanceId,
      targetMode: options.targetMode,
      observedNoGpuMode: after.noGpuMode,
      statusRaw: after.statusRaw,
    })
  }
}

/**
 * `switch` 命令实现。
 *
 * 依赖经 `CommandContext` 注入：单测用假 provider，不连浏览器。
 */
export async function runSwitchCommand(
  context: CommandContext,
  options: SwitchCommandOptions,
): Promise<void> {
  if (options.instanceId.trim().length === 0) {
    throw new ConfigError('instanceId 不能为空。')
  }

  // 证据目录口径：不带 run 的命令一律 <stateDir>/<命令名>/<instanceId>。
  // 路径解析的单一入口是 `commandEvidenceDir`，命令不自己拼。
  const logDir = await context.deps.commandEvidenceDir(
    SWITCH_EVIDENCE_DIRECTORY,
    options.instanceId,
  )

  // 会话生命周期交给 `withProvider`：开、调、关各一次，命令不自己管。
  // 判据：关机、开机、复验三次调用都在这个回调里。不把 provider 存到外部变量 ——
  // 那样回调返回后 provider 已被关掉，外层再用它就是用一个死端口。
  const result = await context.deps.withProvider(logDir, async (provider) => {
    const ports: SwitchPowerPorts = {
      powerOn: provider.powerOn.bind(provider),
      powerOff: provider.powerOff.bind(provider),
      listInstances: provider.listInstances.bind(provider),
    }
    await switchInstanceForm(ports, options)
    // 复验形态的那一次读数必须带 `refresh: true`：`noGpuMode` 从 DOM 的形态标记文字解析，
    // 不刷新读到的是上一次渲染的旧值，还可能读成 null，而复验把 null 判成不匹配。
    const after = await requireInstance(ports, options.instanceId)
    return {
      instanceId: after.instanceId,
      targetMode: options.targetMode,
      observedNoGpuMode: after.noGpuMode,
      status: after.status,
      statusRaw: after.statusRaw,
    } satisfies SwitchCommandResult
  })

  context.deps.logger.info('switch.done', {
    instanceId: result.instanceId,
    targetMode: result.targetMode,
    observedNoGpuMode: result.observedNoGpuMode,
    status: result.status,
  })
  emitSwitchResult(context, result)
}

/** 读实例快照。不在列表里即抛 `ConfigError`：没有快照就不动作。 */
async function requireInstance(
  ports: Pick<SwitchPowerPorts, 'listInstances'>,
  instanceId: string,
): Promise<ConsoleInstanceSnapshot> {
  const snapshots = await ports.listInstances({ refresh: true })
  const snapshot = snapshots.find((candidate) => candidate.instanceId === instanceId)
  if (snapshot === undefined) {
    throw new ConfigError(
      `控制台实例列表里找不到实例 ${instanceId}。实例可能已被销毁，或被另一个命令换掉了。` +
        '本命令不创建实例，请人工确认后再操作。',
    )
  }
  return snapshot
}

function emitSwitchResult(context: CommandContext, result: SwitchCommandResult): void {
  if (context.json) {
    writeJson(context.deps.stdout, result)
    return
  }
  writeLine(
    context.deps.stdout,
    `实例 ${result.instanceId} 已切换到${formatPowerOnMode(result.targetMode)}形态：` +
      `当前状态「${result.statusRaw}」。实例 ID 未变，未做任何销毁动作。`,
  )
}
