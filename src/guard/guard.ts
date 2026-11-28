import type { Plan } from '../domain/plan.js'
import type { Run } from '../domain/run.js'
import { RUNS_DIRECTORY, type RunStore } from '../engine/run-store.js'
import { isDeploydeckErrorWithCode } from '../errors.js'
import type { Logger } from '../logging/logger.js'
import { decideRuntime } from '../plan/budget.js'
import type { PlanStore } from '../plan/plan-store.js'
import {
  buildLedgerEntry,
  closePlanWithLedger,
  closePlanWithoutLedger,
  findInstanceEntry,
  markPlanEscalated,
  markPlanStoppedPendingSettlement,
  requireRunAccounting,
} from '../plan/settlement.js'
import type { Provider } from '../providers/provider.js'
import type { TeardownOutcome } from '../console/ports.js'
import type { LedgerStore } from '../state/ledger-store.js'
import type { StateStore } from '../state/ports.js'
import type { Clock } from '../util/clock.js'
import { beijingIso, parseIso } from '../util/time.js'

/**
 * 计划层守护。
 *
 * 判据（docs/specs/deploydeck-phase2.md 第 9.3 节）：三重保障的第二层是「守护进程
 * 每 5 分钟检查过期计划」，第三层是余额告警。本文件是这两层的实现。
 *
 * 每轮做三件事：
 * 1. 过期的生效计划：绑定了实例就执行销毁链，确认消失后写账本、把金额记回
 *    `plan.spentYuan`、计划转 `closed`；未确认消失则计划转 `escalated`。
 * 2. 仍生效但 `spentYuan >= budgetCapYuan` 的计划：销毁并记 `closed`。
 * 3. 读账户余额；低于显式配置的阈值时打 warn。
 *
 * 降级判据：浏览器不可用时**降级为告警，不静默**。记 error 日志、下一轮继续，
 * 不退出进程，也不改动任何实例状态。系统级自启动（pm2 / systemd）属 Phase 3。
 *
 * ## 实测状态：只在假通道上验证过
 *
 * 2026-11-25 的真机验证覆盖了开关机、定时关机、克隆、`run` 与 `teardown`，
 * **没有覆盖 `guard`**。本文件的「过期计划自动销毁」「预算熔断销毁」「余额告警」
 * 三条路径全部只有 `src/guard/guard.spec.ts` 的假通道覆盖，没在真控制台上跑过。
 *
 * 未做真机验证的原因不是遗漏，是成本：`guard` 的核心动作是**销毁别人的实例**，
 * 要验它就得准备一台可丢弃的实例并让它过期，属于必须专门排期的动作。
 *
 * 因此首次真机启用 `guard` 时按「未验证」对待，至少做到：
 * 1. 先用 `--once` 跑一轮，确认它读到的计划、实例与余额与你人工看到的一致，
 *    且这一轮**没有**触发任何销毁。
 * 2. 再放到后台常驻。第一次真正触发销毁时，人要在场。
 * 3. 退出码 0 只代表「这一轮跑完了」，不代表「没有需要人管的事」：
 *    告警与降级都只落日志，要看 `--once` 输出的 JSON。
 */

/** 一轮守护读到的全部事实与动作结果。`--once` 直接输出它。 */
export interface GuardRoundReport {
  /** 本轮开始时刻，北京时间 ISO 串。 */
  readonly startedAt: string
  /** 状态仍为 `active` 的计划数（含已过期）。 */
  readonly activePlanCount: number
  /** 已过期的生效计划。 */
  readonly expiredPlanIds: readonly string[]
  /** 已花到预算上限的生效计划。 */
  readonly overBudgetPlanIds: readonly string[]
  /** 本轮销毁并关闭的计划。 */
  readonly closedPlanIds: readonly string[]
  /**
   * 本轮转 `stopped-pending-settlement` 的计划：实例已停机，钱停了，等下一轮结算。
   *
   * 与 `escalatedPlanIds` 分开列：这一类不需要人立即去控制台关机。
   */
  readonly stoppedPendingSettlementPlanIds: readonly string[]
  /**
   * 本轮转 `escalated` 的计划：实例未确认消失或结算失败，钱可能还在烧。
   *
   * 判据：只有「实例可能仍在运行」才进这一列。停机成功的计划不进这里。
   */
  readonly escalatedPlanIds: readonly string[]
  /** 本轮读到的账户余额。没读到时为 null。 */
  readonly balanceYuan: number | null
  /** 余额低于阈值。 */
  readonly balanceWarning: boolean
  /** 本轮因浏览器不可用而降级。降级时剩余计划动作留给下一轮。 */
  readonly degraded: boolean
}

/** 一次 provider 会话。`close` 只关通道，不关浏览器。 */
export interface GuardProviderSession {
  readonly provider: Provider
  close(): Promise<void>
}

/** 守护进程的依赖。全部可替换：测试用假 provider 与假时钟，不连浏览器。 */
export interface GuardDependencies {
  readonly planStore: PlanStore
  readonly runs: RunStore
  readonly ledger: LedgerStore
  readonly stateStore: StateStore
  readonly clock: Clock
  readonly logger: Logger
  /** 打开控制面。浏览器不可用时抛错，由本轮捕获并降级。 */
  openProvider(options: { readonly logDir: string }): Promise<GuardProviderSession>
}

/** 一轮守护的参数。 */
export interface GuardRoundSettings {
  /** 余额告警阈值，元。必须显式配置，见 `src/config/paths.ts`。 */
  readonly balanceWarnBelowYuan: number
}

export interface GuardLoopOptions extends GuardRoundSettings {
  /** 两轮之间的间隔，毫秒。默认值由 CLI 给出（5 分钟）。 */
  readonly intervalMs: number
  /** 只巡一轮就返回。测试与人工排查用。 */
  readonly once: boolean
  /** 每轮结束后的回调。常驻模式用它打进度。 */
  readonly onRound?: (report: GuardRoundReport) => void
}

/**
 * 需要销毁的计划及原因。原因只进日志与报告，不改变动作。
 *
 * `pending-settlement` 不是「到期」也不是「超预算」：实例已经停机，钱停了，
 * 本轮只需要把账结掉。它和另两个原因的动作相同（销毁链 + 结算），差别只在于
 * 前者通常秒回「已消失」，因为实例本来就停着。
 */
interface PendingPlan {
  readonly plan: Plan
  readonly reason: 'expired' | 'budget-trip' | 'pending-settlement'
}

/**
 * 跑一轮守护。计划内的失败不向上抛：本轮的职责是「发现并处理」，
 * 单份计划的状态文件或控制台动作失败不应该让整轮停摆。
 */
export async function runGuardRound(
  deps: GuardDependencies,
  settings: GuardRoundSettings,
): Promise<GuardRoundReport> {
  const nowMillis = deps.clock.now()
  const startedAt = beijingIso(new Date(nowMillis))
  const allPlans = await deps.planStore.listAll()
  const activePlans = allPlans.filter((plan) => plan.state === 'active')
  const expiredPlans = activePlans.filter(
    (plan) => parseIso(plan.expiresAt).getTime() <= nowMillis,
  )
  const expiredIds: ReadonlySet<string> = new Set(expiredPlans.map((plan) => plan.id))
  const overBudgetPlans = activePlans.filter(
    (plan) => !expiredIds.has(plan.id) && decideRuntime(plan) === 'trip',
  )
  // 停机成功、等结算的计划。它们的钱已经停了，不按「过期」或「超预算」再算一遍：
  // 判据只看状态，不再看时钟 —— 这类计划可能还没到期，也可能到期了。
  const pendingSettlementPlans = allPlans.filter(
    (plan) => plan.state === 'stopped-pending-settlement',
  )

  const closedPlanIds: string[] = []
  const stoppedPendingSettlementPlanIds: string[] = []
  const escalatedPlanIds: string[] = []

  // 过期但没有绑定实例：没有可销毁的对象，直接关闭，避免每轮重复扫描。
  for (const plan of expiredPlans) {
    if (plan.instanceId !== null) {
      continue
    }
    try {
      await closePlanWithoutLedger(deps, plan.id)
      closedPlanIds.push(plan.id)
      deps.logger.info('guard.plan.closed', {
        planId: plan.id,
        reason: 'expired-without-instance',
      })
    } catch (error: unknown) {
      deps.logger.error('guard.plan.close-failed', {
        planId: plan.id,
        reason: 'expired-without-instance',
        error: describeError(error),
      })
    }
  }

  // 停机成功但没绑定实例：没有可销毁的对象，也就没有可结算的账，直接关闭。
  for (const plan of pendingSettlementPlans) {
    if (plan.instanceId !== null) {
      continue
    }
    try {
      await closePlanWithoutLedger(deps, plan.id)
      closedPlanIds.push(plan.id)
      deps.logger.info('guard.plan.closed', {
        planId: plan.id,
        reason: 'pending-settlement-without-instance',
      })
    } catch (error: unknown) {
      deps.logger.error('guard.plan.close-failed', {
        planId: plan.id,
        reason: 'pending-settlement-without-instance',
        error: describeError(error),
      })
    }
  }

  let degraded = false
  const pending: PendingPlan[] = [
    ...expiredPlans
      .filter((plan) => plan.instanceId !== null)
      .map((plan): PendingPlan => ({ plan, reason: 'expired' })),
    ...overBudgetPlans.map((plan): PendingPlan => ({ plan, reason: 'budget-trip' })),
    ...pendingSettlementPlans
      .filter((plan) => plan.instanceId !== null)
      .map((plan): PendingPlan => ({ plan, reason: 'pending-settlement' })),
  ]
  for (const pendingPlan of pending) {
    let logDir: string
    try {
      logDir = await guardLogDir(deps, pendingPlan.plan)
    } catch (error: unknown) {
      deps.logger.error('guard.plan.failed', {
        planId: pendingPlan.plan.id,
        phase: 'resolve-log-dir',
        error: describeError(error),
      })
      continue
    }

    let session: GuardProviderSession
    try {
      session = await deps.openProvider({ logDir })
    } catch (error: unknown) {
      // 控制面不可用：本轮剩余销毁全部降级，下一轮重试。已有实例不受影响。
      degraded = true
      deps.logger.error('guard.degraded', {
        phase: 'open-provider',
        planId: pendingPlan.plan.id,
        message: '控制面不可用，本轮计划层销毁降级为告警；已有实例不受影响，下一轮继续。',
        error: describeError(error),
      })
      break
    }
    try {
      await handlePlan(
        deps,
        pendingPlan,
        session.provider,
        closedPlanIds,
        stoppedPendingSettlementPlanIds,
        escalatedPlanIds,
      )
    } catch (error: unknown) {
      // 单份计划的结算失败不能中断其余计划：钱要尽早止损。
      deps.logger.error('guard.plan.failed', {
        planId: pendingPlan.plan.id,
        error: describeError(error),
      })
    } finally {
      await session.close()
    }
  }

  // 余额层。浏览器不可用时同样降级为告警，不静默。
  let balanceYuan: number | null = null
  let balanceWarning = false
  if (degraded) {
    deps.logger.warn('guard.balance.skipped', {
      message: '本轮控制面不可用，跳过余额读取；下一轮继续。',
    })
  } else {
    try {
      balanceYuan = await readBalance(deps)
      if (balanceYuan < settings.balanceWarnBelowYuan) {
        balanceWarning = true
        deps.logger.warn('guard.balance.low', {
          balanceYuan,
          warnBelowYuan: settings.balanceWarnBelowYuan,
          message: '账户余额低于告警阈值，请及时充值，避免下一个计划无法执行。',
        })
      }
    } catch (error: unknown) {
      degraded = true
      deps.logger.error('guard.degraded', {
        phase: 'read-balance',
        message: '读账户余额失败，本轮余额告警降级为日志；下一轮继续。',
        error: describeError(error),
      })
    }
  }

  return {
    startedAt,
    activePlanCount: activePlans.length,
    expiredPlanIds: expiredPlans.map((plan) => plan.id),
    overBudgetPlanIds: overBudgetPlans.map((plan) => plan.id),
    closedPlanIds,
    stoppedPendingSettlementPlanIds,
    escalatedPlanIds,
    balanceYuan,
    balanceWarning,
    degraded,
  }
}

/**
 * 常驻循环。
 *
 * `once` 为真时只跑一轮并返回结果；否则永不返回（进程被杀才停）。
 * 浏览器不可用不会让循环退出：下一轮会重试，这是降级判据的一部分。
 */
export async function runGuardLoop(
  deps: GuardDependencies,
  options: GuardLoopOptions,
): Promise<GuardRoundReport | null> {
  for (;;) {
    const report = await runGuardRound(deps, {
      balanceWarnBelowYuan: options.balanceWarnBelowYuan,
    })
    deps.logger.info('guard.round', { ...report })
    options.onRound?.(report)
    if (options.once) {
      return report
    }
    await deps.clock.sleep(options.intervalMs)
  }
}

/**
 * 处理一份需要销毁的计划：销毁 → 记账 → 关闭。
 *
 * 判据（M1/M2）：两种结局的状态必须分开写。
 * 1. 实例确认消失（销毁链成功，或实例本来就不在列表里）：钱停了。
 *    - 该实例已有账本行 → 那一行就是计费终点，本次不写账，直接关闭。
 *    - 没有账本行 → 按当前钟点写一行再关闭（此时当前钟点就是停机时刻）。
 *    结算环节失败（缺字段、锁冲突等）时，实例毕竟已经不在，计划写
 *    `stopped-pending-settlement` 而不是 `escalated`：钱停了，只是账还差一步。
 * 2. 实例未确认消失（销毁链失败或超时）：计划转 `escalated`，钱可能还在烧。
 */
async function handlePlan(
  deps: GuardDependencies,
  pendingPlan: PendingPlan,
  provider: Provider,
  closedPlanIds: string[],
  stoppedPendingSettlementPlanIds: string[],
  escalatedPlanIds: string[],
): Promise<void> {
  const { plan } = pendingPlan
  const instanceId = plan.instanceId
  if (instanceId === null) {
    // 调用方已过滤；这里保留判据，防止将来改动漏过滤。
    throw new Error(`计划 ${plan.id} 没有绑定实例，不应进入销毁流程。`)
  }

  const existingEntry = await findInstanceEntry(deps.ledger, plan.id, instanceId)
  // 已有账本行时实例的计费终点已封口：连销毁链都不必走（实例可能早已不在列表里）。
  if (existingEntry !== null) {
    await closeAlreadyAccountedPlan(deps, plan, instanceId, closedPlanIds, stoppedPendingSettlementPlanIds)
    return
  }

  let outcome: TeardownOutcome
  try {
    outcome = await provider.destroy(instanceId)
  } catch (error: unknown) {
    await escalate(deps, plan, escalatedPlanIds, 'destroy-chain-failed', error)
    return
  }
  if (outcome.state === 'escalated') {
    await escalate(deps, plan, escalatedPlanIds, 'instance-not-gone', outcome.reason)
    return
  }

  const run = await latestRunForInstance(deps, plan.id, instanceId)
  if (run === undefined) {
    // 实例已确认消失：钱停了。缺执行记录只是账还差一步，不能报成「钱可能还在烧」。
    await settleFailureAfterInstanceGone(
      deps,
      plan,
      stoppedPendingSettlementPlanIds,
      'run-record-missing',
      `实例 ${instanceId} 已确认消失，但找不到绑定它的执行记录，无法结算账本。`,
    )
    return
  }

  let accounting: ReturnType<typeof requireRunAccounting>
  try {
    accounting = requireRunAccounting(run)
  } catch (error: unknown) {
    // 实例已经消失，钱停止计费；但账本缺字段，不能编金额，交人工。
    await settleFailureAfterInstanceGone(
      deps,
      plan,
      stoppedPendingSettlementPlanIds,
      'run-accounting-incomplete',
      error,
    )
    return
  }

  const entry = buildLedgerEntry({
    planId: plan.id,
    runId: run.id,
    instanceId,
    gpuSpec: accounting.gpuSpec,
    startedAt: accounting.startedAt,
    stoppedAt: beijingIso(new Date(deps.clock.now())),
    unitPriceYuanPerHour: accounting.unitPriceYuanPerHour,
  })
  try {
    const closed = await closePlanWithLedger(deps, plan.id, instanceId, entry)
    closedPlanIds.push(plan.id)
    deps.logger.info('guard.plan.closed', {
      planId: plan.id,
      instanceId,
      runId: run.id,
      amountYuan: closed.writtenEntry === null ? 0 : closed.writtenEntry.amountYuan,
      spentYuan: closed.plan.spentYuan,
      reason: pendingPlan.reason,
    })
  } catch (error: unknown) {
    await settleFailureAfterInstanceGone(
      deps,
      plan,
      stoppedPendingSettlementPlanIds,
      'settlement-failed',
      error,
    )
  }
}

/**
 * 该实例已经在账本里：实例的计费终点是那一行的 `stoppedAt`，直接关闭计划。
 *
 * 判据（M1）：已有账本行时不构造 entry、不调销毁链。账本已封口，
 * 再用当前钟点造一行只会被结算层丢弃，账本因此永久少记时间。
 * 关闭失败时计划写 `stopped-pending-settlement`：钱停了，下一轮再关。
 */
async function closeAlreadyAccountedPlan(
  deps: GuardDependencies,
  plan: Plan,
  instanceId: string,
  closedPlanIds: string[],
  stoppedPendingSettlementPlanIds: string[],
): Promise<void> {
  try {
    const closed = await closePlanWithLedger(deps, plan.id, instanceId, null)
    closedPlanIds.push(plan.id)
    deps.logger.info('guard.plan.closed', {
      planId: plan.id,
      instanceId,
      wroteLedgerEntry: false,
      accountedStoppedAt: closed.existingEntry?.stoppedAt ?? null,
      spentYuan: closed.plan.spentYuan,
      reason: 'already-accounted',
    })
  } catch (error: unknown) {
    await settleFailureAfterInstanceGone(
      deps,
      plan,
      stoppedPendingSettlementPlanIds,
      'already-accounted-close-failed',
      error,
    )
  }
}

/**
 * 实例已确认消失，但结算没做完：计划转 `stopped-pending-settlement`。
 *
 * 判据：这一分支绝不写 `escalated`。`escalated` 的含义是「实例未确认消失，钱可能还在烧」，
 * 而这里刚好相反：实例不在了，钱停了，只是账还差一步。写错状态会让运维去找一台不存在的机器。
 */
async function settleFailureAfterInstanceGone(
  deps: GuardDependencies,
  plan: Plan,
  stoppedPendingSettlementPlanIds: string[],
  reason: string,
  cause: unknown,
): Promise<void> {
  stoppedPendingSettlementPlanIds.push(plan.id)
  deps.logger.error('guard.plan.stopped-pending-settlement', {
    planId: plan.id,
    instanceId: plan.instanceId,
    reason,
    error: describeError(cause),
    message: '实例已确认停机，钱停了；账还没结算完，下一轮继续。',
  })
  try {
    await markPlanStoppedPendingSettlement(deps, plan.id)
  } catch (error: unknown) {
    deps.logger.error('guard.plan.mark-stopped-failed', {
      planId: plan.id,
      error: describeError(error),
    })
  }
}

/**
 * 计划转 escalated 并记 error 日志。守护进程不因它改退出码。
 *
 * 判据：只有「实例未确认消失」才允许走到这里。
 */
async function escalate(
  deps: GuardDependencies,
  plan: Plan,
  escalatedPlanIds: string[],
  reason: string,
  cause: unknown,
): Promise<void> {
  escalatedPlanIds.push(plan.id)
  deps.logger.error('guard.plan.escalated', {
    planId: plan.id,
    instanceId: plan.instanceId,
    reason,
    error: describeError(cause),
    message: '实例未确认消失，钱可能还在烧。请立即在控制台确认。',
  })
  try {
    await markPlanEscalated(deps, plan.id)
  } catch (error: unknown) {
    deps.logger.error('guard.plan.escalate-failed', {
      planId: plan.id,
      error: describeError(error),
    })
  }
}

/** 绑定该实例的最近一次执行记录。执行记录按 startedAt 升序，取最后一个匹配项。 */
async function latestRunForInstance(
  deps: GuardDependencies,
  planId: string,
  instanceId: string,
): Promise<Run | undefined> {
  const runs = await deps.runs.listForPlan(planId)
  return [...runs].reverse().find((candidate) => candidate.instanceId === instanceId)
}

/** 销毁动作的现场落点：绑定该实例那次 run 的目录。找不到时用 runs 根。 */
async function guardLogDir(deps: GuardDependencies, plan: Plan): Promise<string> {
  if (plan.instanceId !== null) {
    const run = await latestRunForInstance(deps, plan.id, plan.instanceId)
    if (run !== undefined) {
      return await deps.stateStore.resolve(`${RUNS_DIRECTORY}/${run.id}`)
    }
  }
  return await deps.stateStore.resolve(RUNS_DIRECTORY)
}

/** 读一次账户余额。单独开会话：余额读取不需要某份计划的证据目录。 */
async function readBalance(deps: GuardDependencies): Promise<number> {
  const logDir = await deps.stateStore.resolve(RUNS_DIRECTORY)
  const session = await deps.openProvider({ logDir })
  try {
    return await session.provider.readBalance()
  } finally {
    await session.close()
  }
}

function describeError(error: unknown): string {
  if (isDeploydeckErrorWithCode(error)) {
    return `${error.code}：${error.message}`
  }
  if (error instanceof Error) {
    return `${error.name}：${error.message}`
  }
  return String(error)
}
