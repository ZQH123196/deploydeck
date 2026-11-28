import type { PowerPort, PriceQuote } from '../console/ports.js'
import type { Plan, PlanState } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import {
  BudgetExceededError,
  PlanInvalidError,
  StateFileMissingError,
} from '../errors.js'
import type { Provider } from '../providers/provider.js'
import type { Clock } from '../util/clock.js'
import { createId } from '../util/id.js'
import { addMinutesIso, beijingIso, minutesBetweenIso, parseIso } from '../util/time.js'
import { decideCreate, estimateRunCostYuan } from './budget.js'
import type { PlanStore } from './plan-store.js'

/**
 * 平台定时关机相对计划过期时刻提前的分钟数。
 *
 * 判据见 spec 第 7.4 节：关机时刻 = `expiresAt` 减 5 分钟安全余量。
 * `plan show` 与执行引擎共用这一个常量，不各自写 5。
 */
export const SHUTDOWN_SAFETY_MARGIN_MINUTES = 5

/** 创建计划时的 provider 上下文。只按能力判断，不按厂商名分支。 */
export type PlanProviderContext = Pick<Provider, 'id' | 'capabilities'>

export interface CreatePlanInput {
  /** 来源部署配置。 */
  readonly profile: Profile
  /** 目标 provider 的 id 与能力声明。 */
  readonly provider: PlanProviderContext
  /** 覆盖 Profile 的默认时长，分钟。 */
  readonly ttlMinutes?: number
  /** 覆盖 Profile 的默认预算上限，元。 */
  readonly budgetCapYuan?: number
}

/** `plan show` 的展示数据。 */
export interface PlanView {
  readonly plan: Plan
  /** 剩余分钟数。已过期或已关闭时为 0。 */
  readonly remainingMinutes: number
  /** 已花费，元。 */
  readonly spentYuan: number
  /** 预算余量 = 上限 − 已花费，元。超支时为负。 */
  readonly remainingBudgetYuan: number
  /**
   * 展示用状态。
   *
   * `active` 但已过期的计划在这里报 `expired`：守护进程每 5 分钟才巡检一次，
   * 展示侧不能把已过期的活动计划继续报成生效中。
   */
  readonly state: PlanState
  /** 平台定时关机时刻 = `expiresAt` 减安全余量，北京时间 ISO。 */
  readonly timedShutdownAt: string
}

export interface PlanServiceOptions {
  readonly plans: PlanStore
  /** 注入时钟。计划窗口与剩余时长全经它计算，测试用假时钟。 */
  readonly clock: Clock
}

export interface PlanService {
  /**
   * 由 Profile 实例化一份计划并落盘。
   *
   * 创建前校验 Profile 与 provider 能力，任一项不满足即抛 `PlanInvalidError`。
   */
  createPlan(input: CreatePlanInput): Promise<Plan>
  /** 查看计划：剩余时长、已花费、预算余量、状态、平台定时关机时刻。 */
  showPlan(planId: string): Promise<PlanView>
  /**
   * 取一份仍生效的计划。
   *
   * 不存在、状态不是 `active`、或已过期，一律抛 `PlanInvalidError`（退出码 1）。
   * 执行引擎在开机与克隆之前必须过这一关。
   */
  requireActivePlan(planId: string): Promise<Plan>
  /** 列出仍生效的计划。守护进程与 CLI 共用。 */
  listActivePlans(): Promise<readonly Plan[]>
}

export function createPlanService(options: PlanServiceOptions): PlanService {
  const { plans, clock } = options

  return {
    createPlan: async (input) => {
      assertCreatable(input)

      const ttlMinutes = resolveTtlMinutes(input)
      const budgetCapYuan = resolveBudgetCapYuan(input)
      const createdAtMillis = clock.now()
      const createdAt = beijingIso(new Date(createdAtMillis))
      const plan: Plan = {
        id: createId('plan', { now: () => new Date(createdAtMillis) }),
        profileId: input.profile.id,
        createdAt,
        expiresAt: addMinutesIso(createdAt, ttlMinutes),
        budgetCapYuan,
        spentYuan: 0,
        state: 'active',
        instanceId: null,
      }
      await plans.create(plan)
      return plan
    },

    showPlan: async (planId) => {
      const plan = await plans.read(planId)
      const nowMillis = clock.now()
      const state = effectiveState(plan, nowMillis)
      return {
        plan,
        remainingMinutes:
          state === 'active' ? minutesBetweenIso(beijingIso(new Date(nowMillis)), plan.expiresAt) : 0,
        spentYuan: plan.spentYuan,
        remainingBudgetYuan: plan.budgetCapYuan - plan.spentYuan,
        state,
        timedShutdownAt: computeTimedShutdownAt(plan),
      }
    },

    requireActivePlan: async (planId) => {
      let plan: Plan
      try {
        plan = await plans.read(planId)
      } catch (error: unknown) {
        if (error instanceof StateFileMissingError) {
          throw new PlanInvalidError(`计划不存在：${planId}。请先执行 plan create。`)
        }
        throw error
      }
      const state = effectiveState(plan, clock.now())
      if (state !== 'active') {
        throw new PlanInvalidError(describeInactivePlan(plan, state))
      }
      return plan
    },

    listActivePlans: async () => plans.listActive(new Date(clock.now())),
  }
}

/**
 * 平台定时关机时刻。纯函数：只读计划的 `expiresAt`。
 *
 * 判据见 spec 第 7.4 节。`plan show` 与执行引擎都调它，不各自算一遍。
 */
export function computeTimedShutdownAt(plan: Plan): string {
  return addMinutesIso(plan.expiresAt, -SHUTDOWN_SAFETY_MARGIN_MINUTES)
}

/** 预算复核的编排端口。执行引擎读到单价后调用一次。 */
export interface BudgetEnforcement {
  /** 读到单价后复核：超预算立即停机保留实例并抛 `BudgetExceededError`（退出码 1）。 */
  recheckAfterInstanceReady(input: {
    readonly planId: string
    readonly runId: string
    readonly instanceId: string
    readonly quote: PriceQuote
  }): Promise<void>
}

export interface BudgetEnforcementOptions {
  readonly plans: PlanStore
  /**
   * 超预算时的止损动作：停机。
   *
   * 判据（BUG 3.1）：自动判定失败不得销毁实例，销毁入口只有 `teardown` 命令。
   * 这里收停机端口而不收销毁端口，端口形状本身就挡住了误用。
   */
  readonly power: PowerPort
}

/**
 * 创建预算复核。
 *
 * 判据见 spec 第 9.2 节：开机或克隆成功后读单价，计算预计花费，超上限立即销毁。
 */
export function createBudgetEnforcement(options: BudgetEnforcementOptions): BudgetEnforcement {
  const { plans, power } = options

  return {
    recheckAfterInstanceReady: async (input) => {
      // 只读计划、不校验是否生效：这一关只回答预算。
      // 计划有效性由 run 入口的 requireActivePlan 把关，把过期误报成预算问题会误导排障。
      const plan = await plans.read(input.planId)
      const projectedCostYuan = estimateRunCostYuan(
        input.quote.unitPriceYuanPerHour,
        input.quote.ttlMinutes,
      )
      const decision = decideCreate({
        spentYuan: plan.spentYuan,
        budgetCapYuan: plan.budgetCapYuan,
        projectedCostYuan,
      })
      if (decision !== 'deny') {
        return
      }

      // 预算超限是业务失败（退出码 1），此刻实例已经就绪、钱正在烧。
      // 判据：先停机止损、确认停机完成，再抛预算错误；绝不销毁实例。
      // 停机失败不盖掉预算错误：实例仍在计费这个事实挂进错误消息，交人工处理。
      let powerOffFailure: string | null = null
      try {
        await power.powerOff(input.instanceId)
      } catch (error: unknown) {
        powerOffFailure = error instanceof Error ? error.message : String(error)
      }
      throw new BudgetExceededError(
        `计划 ${input.planId} 超预算：已花费 ${plan.spentYuan} 元，本次预计 ${projectedCostYuan} 元，` +
          `上限 ${plan.budgetCapYuan} 元（执行 ${input.runId}）。` +
          (powerOffFailure === null
            ? `已停机并保留实例 ${input.instanceId}。执行 deploydeck teardown ${input.planId} 销毁它。`
            : `停机失败：${powerOffFailure}。实例 ${input.instanceId} 仍在计费，` +
              `请立即到控制台确认并关机，或执行 deploydeck teardown ${input.planId}。`),
      )
    },
  }
}

/** 创建前的静态校验。一次只报第一个问题：修一个再看下一个，信息更明确。 */
function assertCreatable(input: CreatePlanInput): void {
  if (input.profile.gpuPreference.length === 0) {
    throw new PlanInvalidError(
      `部署配置 ${input.profile.id} 的 gpuPreference 为空，无法选择算力规格，拒绝创建计划。`,
    )
  }
  // 能力声明是强制判据（docs/provider-contract.md 第 2 节）：能力为否时必须在
  // plan create 阶段就拒绝，绝不拖到运行时。
  if (!input.provider.capabilities.create) {
    throw new PlanInvalidError(
      `provider ${input.provider.id} 不支持创建实例（create=false），` +
        '部署配置无法实例化出容器。拒绝创建计划：这个部署配置在该 provider 上没有可走的创建路径。',
    )
  }
  // 三重保障的第一层是平台定时关机。provider 不支持时不能创建计划：
  // 只剩计划层与兜底层，等于把「忘记关机」的代价押在守护进程活着上。
  if (!input.provider.capabilities.timedShutdown) {
    throw new PlanInvalidError(
      `provider ${input.provider.id} 不支持平台定时关机（timedShutdown=false），` +
        '拒绝创建计划：三重保障的第一层不能缺失。',
    )
  }
}

function resolveTtlMinutes(input: CreatePlanInput): number {
  const ttlMinutes = input.ttlMinutes ?? input.profile.ttlMinutes
  if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0) {
    throw new PlanInvalidError(`计划时长必须是正整数分钟，实际 ${ttlMinutes}。`)
  }
  return ttlMinutes
}

function resolveBudgetCapYuan(input: CreatePlanInput): number {
  const budgetCapYuan = input.budgetCapYuan ?? input.profile.budgetCapYuan
  if (!Number.isFinite(budgetCapYuan) || budgetCapYuan <= 0) {
    throw new PlanInvalidError(`计划预算上限必须是正数元，实际 ${budgetCapYuan}。`)
  }
  return budgetCapYuan
}

function isExpired(plan: Plan, nowMillis: number): boolean {
  return parseIso(plan.expiresAt).getTime() <= nowMillis
}

function effectiveState(plan: Plan, nowMillis: number): PlanState {
  return plan.state === 'active' && isExpired(plan, nowMillis) ? 'expired' : plan.state
}

function describeInactivePlan(plan: Plan, state: PlanState): string {
  if (state === 'expired') {
    return `计划 ${plan.id} 已于 ${plan.expiresAt} 过期，拒绝创建或开机实例。请重新创建计划。`
  }
  return `计划 ${plan.id} 的状态为 ${state}，不再生效，拒绝创建或开机实例。`
}
