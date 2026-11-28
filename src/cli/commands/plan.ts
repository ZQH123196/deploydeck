import type { PlanState } from '../../domain/plan.js'
import { RUNS_DIRECTORY } from '../../engine/run-store.js'
import { PlanInvalidError, StateFileMissingError } from '../../errors.js'
import { computeTimedShutdownAt, type PlanService, type PlanView } from '../../plan/plan-service.js'
import { minutesBetweenIso } from '../../util/time.js'
import {
  formatNumber,
  formatYuan,
  writeJson,
  writeLine,
  writeTable,
} from '../output.js'
import {
  createCommandStores,
  emitResult,
  formatOnDeployFailure,
  readPositiveIntegerOption,
  readPositiveNumberOption,
  requireProfile,
  type CommandContext,
} from './shared.js'

export interface PlanShowCommandOptions {
  /** `--balance`：打开控制面读账户余额。不带时输出里明确写「余额未读取」。 */
  readonly balance: boolean
}

export interface PlanCreateCommandOptions {
  readonly profile: string
  readonly ttl?: string
  readonly budget?: string
}

/** `plan create`：读部署配置，用 provider 能力校验，落盘一份计划。 */
export async function runPlanCreateCommand(
  context: CommandContext,
  options: PlanCreateCommandOptions,
): Promise<void> {
  const { planService } = createCommandStores(context)
  const profiles = await context.deps.loadProfiles()
  const profile = requireProfile(profiles, options.profile)
  // 能力校验用静态声明，不打开浏览器：plan create 是纯本地动作。
  const provider = context.deps.readProviderCapabilities(profile.provider)

  const plan = await planService.createPlan({
    profile,
    provider,
    ...(options.ttl === undefined
      ? {}
      : { ttlMinutes: readPositiveIntegerOption(options.ttl, '--ttl') }),
    ...(options.budget === undefined
      ? {}
      : { budgetCapYuan: readPositiveNumberOption(options.budget, '--budget') }),
  })
  const timedShutdownAt = computeTimedShutdownAt(plan)

  emitResult(
    context,
    { plan, timedShutdownAt, onDeployFailure: profile.onDeployFailure },
    [
      `已创建计划 ${plan.id}`,
      `  部署配置：${profile.id}`,
      `  过期时刻：${plan.expiresAt}`,
      `  平台定时关机：${timedShutdownAt}`,
      `  失败策略：${formatOnDeployFailure(profile.onDeployFailure)}`,
      `  时长：${formatNumber(minutesBetweenIso(plan.createdAt, plan.expiresAt))} 分钟`,
      `  预算上限：${formatYuan(plan.budgetCapYuan)} 元`,
    ],
  )
}

/**
 * `plan show [planId]`：不带参数列出全部生效计划；带参数显示单份。
 *
 * 余额按需读取：控制台是唯一来源，读它要打开浏览器并检查登录态。
 * 不带 `--balance` 时输出里明确写「余额未读取」，不拿计划预算冒充账户余额。
 */
export async function runPlanShowCommand(
  context: CommandContext,
  planId: string | undefined,
  options: PlanShowCommandOptions,
): Promise<void> {
  const stores = createCommandStores(context)
  const { planService } = stores
  const balanceYuan = options.balance ? await readAccountBalance(context, stores) : null

  if (planId === undefined) {
    const plans = await planService.listActivePlans()
    const views: PlanView[] = []
    for (const plan of plans) {
      views.push(await planService.showPlan(plan.id))
    }
    if (context.json) {
      writeJson(context.deps.stdout, { plans: views, balanceYuan })
      return
    }
    if (views.length === 0) {
      writeLine(context.deps.stdout, '没有生效中的计划。用 plan create 创建一份。')
      writeLine(context.deps.stdout, formatBalanceLine(balanceYuan))
      return
    }
    writeTable(
      context.deps.stdout,
      ['计划ID', '部署配置', '剩余(分)', '过期时刻', '定时关机', '已花费(元)', '预算余量(元)'],
      views.map((view) => [
        view.plan.id,
        view.plan.profileId,
        String(Math.floor(view.remainingMinutes)),
        view.plan.expiresAt,
        view.timedShutdownAt,
        formatYuan(view.spentYuan),
        formatYuan(view.remainingBudgetYuan),
      ]),
    )
    writeLine(context.deps.stdout, formatBalanceLine(balanceYuan))
    return
  }

  const view = await showPlanOrThrow(planService, planId)
  emitResult(
    context,
    { ...view, balanceYuan },
    [
      `计划：${view.plan.id}`,
      `  状态：${formatPlanState(view.state)}`,
      `  部署配置：${view.plan.profileId}`,
      `  创建时刻：${view.plan.createdAt}`,
      `  过期时刻：${view.plan.expiresAt}`,
      `  剩余：${String(Math.floor(view.remainingMinutes))} 分钟`,
      `  平台定时关机：${view.timedShutdownAt}`,
      `  已花费：${formatYuan(view.spentYuan)} 元`,
      `  预算余量：${formatYuan(view.remainingBudgetYuan)} 元`,
      `  绑定实例：${view.plan.instanceId ?? '-'}`,
      `  ${formatBalanceLine(balanceYuan)}`,
    ],
  )
}

/**
 * 读账户余额。只用只读动作，不改变任何实例状态。
 *
 * 证据目录指到 runs 根：余额读取不产生截图，正常不会有文件落进去。
 */
async function readAccountBalance(
  context: CommandContext,
  stores: ReturnType<typeof createCommandStores>,
): Promise<number> {
  const logDir = await stores.stateStore.resolve(RUNS_DIRECTORY)
  const session = await context.deps.openProvider({ logDir })
  try {
    return await session.provider.readBalance()
  } finally {
    await session.close()
  }
}

/** 余额展示。未读取时明说，不显示 0 也不显示预算余量。 */
function formatBalanceLine(balanceYuan: number | null): string {
  return balanceYuan === null
    ? '账户余额：未读取（加 --balance 读取）'
    : `账户余额：${formatYuan(balanceYuan)} 元`
}

/** 单份计划。文件不存在时换成「计划不存在」的业务失败，不暴露状态文件名。 */
async function showPlanOrThrow(
  planService: PlanService,
  planId: string,
): Promise<PlanView> {
  try {
    return await planService.showPlan(planId)
  } catch (error: unknown) {
    if (error instanceof StateFileMissingError) {
      throw new PlanInvalidError(`计划不存在：${planId}。请先执行 plan create。`)
    }
    throw error
  }
}

/**
 * 计划状态的展示词。
 *
 * 判据：每个展示词都必须回答「钱停了没有」。ESCALATED 保留英文：
 * 它表示钱可能还在烧，不适合用温和的译名。
 */
export function formatPlanState(state: PlanState): string {
  if (state === 'active') {
    return '生效中'
  }
  if (state === 'closed') {
    return '已关闭'
  }
  if (state === 'expired') {
    return '已过期'
  }
  if (state === 'stopped-pending-settlement') {
    return '已停机·待结算（钱已停，账未结）'
  }
  return 'ESCALATED（需人工确认，钱可能还在烧）'
}
