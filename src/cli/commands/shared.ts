import type { Profile } from '../../domain/profile.js'
import { ConfigError } from '../../errors.js'
import { createLedgerStore, type LedgerStore } from '../../state/ledger-store.js'
import type { StateStore } from '../../state/ports.js'
import { createPlanService, type PlanService } from '../../plan/plan-service.js'
import { createPlanStore, type PlanStore } from '../../plan/plan-store.js'
import type { RunStore } from '../../engine/run-store.js'
import { createRunStore } from '../../engine/run-store.js'
import type { CliDependencies } from '../dependencies.js'
import { writeJson, writeLine } from '../output.js'

/** 每条命令共享的上下文：依赖与输出模式。 */
export interface CommandContext {
  readonly deps: CliDependencies
  /** 是否 `--json` 模式。true 时 stdout 只允许一个 JSON 对象。 */
  readonly json: boolean
}

/** 命令用到的存储与服务。全部由状态存储装配，不从命令里各自 new。 */
export interface CommandStores {
  readonly stateStore: StateStore
  readonly planStore: PlanStore
  readonly planService: PlanService
  readonly runs: RunStore
  readonly ledger: LedgerStore
}

export function createCommandStores(context: CommandContext): CommandStores {
  const stateStore = context.deps.createStateStore()
  const planStore = createPlanStore(stateStore)
  return {
    stateStore,
    planStore,
    planService: createPlanService({ plans: planStore, clock: context.deps.clock }),
    runs: createRunStore(stateStore),
    ledger: createLedgerStore(stateStore),
  }
}

/** 按 id 取部署配置。找不到即抛错并列出可用 id，不猜。 */
export function requireProfile(profiles: readonly Profile[], profileId: string): Profile {
  const profile = profiles.find((candidate) => candidate.id === profileId)
  if (profile !== undefined) {
    return profile
  }
  const available = profiles.map((candidate) => candidate.id).join('、')
  throw new ConfigError(
    `部署配置不存在：${profileId}。` +
      (available.length > 0 ? `现有配置：${available}。` : '配置目录里没有任何部署配置。'),
  )
}

/** 正整数选项。非法即抛错，不猜默认值。 */
export function readPositiveIntegerOption(raw: string, optionName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${optionName} 必须是正整数，当前值：${raw}`)
  }
  const value = Number(raw)
  if (value <= 0) {
    throw new ConfigError(`${optionName} 必须是正整数，当前值：${raw}`)
  }
  return value
}

/** 正数选项（金额可以是小数）。非法即抛错，不猜默认值。 */
export function readPositiveNumberOption(raw: string, optionName: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${optionName} 必须是正数，当前值：${raw}`)
  }
  return value
}

/** JSON 模式写一个对象；人读模式写给定的文本行。两条路互斥。 */
export function emitResult(
  context: CommandContext,
  value: unknown,
  humanLines: readonly string[],
): void {
  if (context.json) {
    writeJson(context.deps.stdout, value)
    return
  }
  for (const line of humanLines) {
    writeLine(context.deps.stdout, line)
  }
}

/** 人读模式下写一行进度。JSON 模式下必须闭嘴：stdout 只能有那个 JSON 对象。 */
export function emitProgress(context: CommandContext, line: string): void {
  if (context.json) {
    return
  }
  writeLine(context.deps.stderr, line)
}

export function formatOnDeployFailure(onDeployFailure: Profile['onDeployFailure']): string {
  return onDeployFailure === 'keep-container' ? '保留容器' : '销毁容器'
}
