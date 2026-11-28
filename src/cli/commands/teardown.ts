import type { ConsoleInstanceSnapshot } from '../../domain/instance.js'
import { type Plan, type PlanState } from '../../domain/plan.js'
import { RUNS_DIRECTORY } from '../../engine/run-store.js'
import {
  HumanRequiredError,
  InstanceNotGoneError,
  PlanInvalidError,
  StateFileMissingError,
} from '../../errors.js'
import {
  buildLedgerEntry,
  closePlanWithLedger,
  findInstanceEntry,
  markPlanEscalated,
  requireRunAccounting,
} from '../../plan/settlement.js'
import type { LedgerSnapshot } from '../../state/ledger-store.js'
import type { LedgerEntry } from '../../state/ledger.js'
import { beijingIso } from '../../util/time.js'
import { formatYuan, writeJson, writeLine } from '../output.js'
import {
  createCommandStores,
  type CommandContext,
  type CommandStores,
} from './shared.js'

/** `teardown --json` 的输出形状。 */
export interface TeardownCommandResult {
  readonly planId: string
  readonly instanceId: string
  readonly state: PlanState
  /**
   * 本次新写入的账本行。该实例生命周期已有账本行时为 null。
   *
   * 为 null 时看 `accountedStoppedAt`：那一行的 `stoppedAt` 就是计费终点。
   */
  readonly ledgerEntry: LedgerEntry | null
  /**
   * 该实例在账本里已封口的计费终点。`ledgerEntry` 为 null 时给出这一行的值。
   *
   * 判据：运维要能只读这一份输出就回答「钱停在几点」。只写「未重复记账」回答不了。
   */
  readonly accountedStoppedAt: string | null
  /**
   * 该实例的计费终点是否已封口。
   *
   * `true` 表示账本里这一笔已经记全，本次没有新增行；
   * `false` 表示本次新增了行（`ledgerEntry` 非空）。
   * 两者互斥，读者不必自己从 `ledgerEntry` 反推。
   */
  readonly settledBeforeThisRun: boolean
  readonly spentYuan: number
  readonly budgetCapYuan: number
  /** 已花费达到或超过预算上限。 */
  readonly budgetExhausted: boolean
}

/**
 * `teardown <planId>`：销毁计划绑定的实例，确认消失后写账本，计划转 `closed`。
 *
 * 判据（spec 第 7.6 节）：终态是「实例从列表消失」，不是「释放请求返回成功」。
 * 未确认消失时计划转 `escalated`，退出码 2，不自动重试。
 *
 * 记账口径：账本是事实，`plan.spentYuan` 是账本的投影。账本每封口一行，就把金额记回计划，
 * 同一份计划的下一次执行才能看见已经烧掉的钱。
 *
 * 计费终点判据（M1）：该实例已有账本行时，那一行的 `stoppedAt` 就是计费终点。
 * 此时本次不得再造 entry —— 停机成功那一刻账已经封了，用当前钟点造的量会被结算层丢弃，
 * 而丢弃不可见，账本会永久低估。这种情形本次只做「关闭计划」，不写账。
 */
export async function runTeardownCommand(
  context: CommandContext,
  planId: string,
): Promise<void> {
  const stores = createCommandStores(context)
  const plan = await readPlanForTeardown(stores, planId)
  const instanceId = plan.instanceId
  if (instanceId === null) {
    throw new PlanInvalidError(
      `计划 ${planId} 没有绑定实例，没有可销毁的对象。` +
        '只有执行过 run 的计划才会绑定实例。',
    )
  }

  const runs = await stores.runs.listForPlan(planId)
  const run = [...runs].reverse().find((candidate) => candidate.instanceId === instanceId)
  if (run === undefined) {
    throw new HumanRequiredError(
      `计划 ${planId} 绑定了实例 ${instanceId}，但状态目录里找不到绑定该实例的执行记录，` +
        '无法取到账本需要的实例到手时刻、规格与单价。未做任何销毁动作。' +
        '请人工核对状态目录的 runs/ 后重试。',
    )
  }

  // 账本快照显式区分「文件不存在」与「空账本」：文件丢失时继续结算会重复记账。
  const ledgerSnapshot = await stores.ledger.readSnapshot()
  assertLedgerNotLost(plan, ledgerSnapshot)
  const existingEntry = await findInstanceEntry(stores.ledger, planId, instanceId)

  // 判据：本次将写账时，账本需要的事实必须在销毁之前就取齐。
  // 销毁是不可撤回的动作；先销毁再发现缺字段，实例已经没了而账还没记，等于把计费终点弄丢。
  // 已有账本行时不必取这些字段：那一行已经把计费终点封住。
  const accounting = existingEntry === null ? requireRunAccounting(run) : null

  const logDir = await stores.stateStore.resolve(`${RUNS_DIRECTORY}/${run.id}`)
  const session = await context.deps.openProvider({ logDir })
  let snapshot: ConsoleInstanceSnapshot | undefined
  try {
    // 先读一次列表：实例可能已经被销毁（重复执行 teardown、失败收尾已销毁等情况）。
    const snapshots = await session.provider.listInstances({ refresh: true })
    snapshot = snapshots.find((candidate) => candidate.instanceId === instanceId)

    if (snapshot === undefined) {
      if (existingEntry === null) {
        throw new HumanRequiredError(
          `实例 ${instanceId} 已不在控制台实例列表里，但账本没有它的记录，无法确定停止时刻与金额。` +
            `计划 ${planId} 保持原状态，未做任何改动。请人工核对账本与状态目录。`,
        )
      }
      const closed = await closePlanWithLedger(stores, planId, instanceId, null)
      recordTeardownClosed(context, planId, instanceId, run.id, closed)
      emitTeardownResult(context, teardownResult(planId, instanceId, closed))
      return
    }

    const outcome = await session.provider.destroy(instanceId)
    if (outcome.state === 'escalated') {
      await markPlanEscalated(stores, planId)
      throw new InstanceNotGoneError(
        `销毁实例 ${instanceId} 未确认消失：${outcome.reason}。` +
          `计划 ${planId} 已标记为 ESCALATED，钱可能还在烧，请立即在控制台确认。`,
      )
    }

    // 已有账本行时不构造 entry：计费终点已封口，不拿当前钟点造第二个终点。
    const entry =
      accounting === null
        ? null
        : buildLedgerEntry({
            planId,
            runId: run.id,
            instanceId,
            ...accounting,
            stoppedAt: beijingIso(new Date(context.deps.clock.now())),
          })
    const closed = await closePlanWithLedger(stores, planId, instanceId, entry)
    recordTeardownClosed(context, planId, instanceId, run.id, closed)
    emitTeardownResult(context, teardownResult(planId, instanceId, closed))
  } finally {
    await session.close()
  }
}

/**
 * `teardown` 的最终结果形状。
 *
 * 判据：`ledgerEntry` 与 `accountedStoppedAt` 必须恰好给出一个「计费终点」来源：
 * 本次新增行时前者有值，之前已封口时后者有值。
 */
function teardownResult(
  planId: string,
  instanceId: string,
  closed: Awaited<ReturnType<typeof closePlanWithLedger>>,
): TeardownCommandResult {
  const settledBeforeThisRun = closed.writtenEntry === null
  return {
    planId,
    instanceId,
    state: closed.plan.state,
    ledgerEntry: closed.writtenEntry,
    // 本次没写行时，计费终点就是账本里那一行的 `stoppedAt`。
    accountedStoppedAt: settledBeforeThisRun ? (closed.existingEntry?.stoppedAt ?? null) : null,
    settledBeforeThisRun,
    spentYuan: closed.plan.spentYuan,
    budgetCapYuan: closed.plan.budgetCapYuan,
    budgetExhausted: closed.plan.spentYuan >= closed.plan.budgetCapYuan,
  }
}

function recordTeardownClosed(
  context: CommandContext,
  planId: string,
  instanceId: string,
  runId: string,
  closed: Awaited<ReturnType<typeof closePlanWithLedger>>,
): void {
  context.deps.logger.info('teardown.closed', {
    planId,
    instanceId,
    runId,
    wroteLedgerEntry: closed.writtenEntry !== null,
    amountYuan: closed.writtenEntry === null ? 0 : closed.writtenEntry.amountYuan,
    accountedStoppedAt: closed.writtenEntry?.stoppedAt ?? closed.existingEntry?.stoppedAt ?? null,
    spentYuan: closed.plan.spentYuan,
    budgetExhausted: closed.plan.spentYuan >= closed.plan.budgetCapYuan,
  })
}

/**
 * 账本文件丢失时的自检。
 *
 * 状态目录里没有 `ledger.jsonl`，但计划上已经有 `spentYuan`：说明至少发生过一次结算，
 * 账本行却没了。此时继续结算会重复记账，账对不上，必须交人工。
 * 反之 `spentYuan` 为 0 时，文件不存在就是「从没结算过」，允许继续。
 */
export function assertLedgerNotLost(plan: Plan, snapshot: LedgerSnapshot): void {
  if (snapshot.status !== 'missing' || plan.spentYuan === 0) {
    return
  }
  throw new HumanRequiredError(
    `计划 ${plan.id} 的 spentYuan 已是 ${String(plan.spentYuan)} 元，说明至少发生过一次账本结算，` +
      '但状态目录里没有账本文件 ledger.jsonl。账本丢失时无法判断这台实例是否已经记账，' +
      '继续结算会重复记账。未做任何销毁动作。请人工恢复账本或核对实例的生命周期后处理。',
  )
}

async function readPlanForTeardown(
  stores: CommandStores,
  planId: string,
): Promise<Plan> {
  let plan: Plan
  try {
    plan = await stores.planStore.read(planId)
  } catch (error: unknown) {
    if (error instanceof StateFileMissingError) {
      throw new PlanInvalidError(`计划不存在：${planId}。请先执行 plan create。`)
    }
    throw error
  }
  if (plan.state === 'closed') {
    throw new PlanInvalidError(`计划 ${planId} 已关闭，没有可销毁的实例。`)
  }
  return plan
}

function emitTeardownResult(context: CommandContext, result: TeardownCommandResult): void {
  if (context.json) {
    writeJson(context.deps.stdout, result)
    return
  }
  writeLine(context.deps.stdout, `已销毁实例 ${result.instanceId}（计划 ${result.planId} 已关闭）`)
  if (result.ledgerEntry !== null) {
    writeLine(
      context.deps.stdout,
      `  账本：新增一行，金额 ${formatYuan(result.ledgerEntry.amountYuan)} 元` +
        `（单价 ${formatYuan(result.ledgerEntry.unitPriceYuanPerHour)} 元/时）`,
    )
  } else {
    // 判据：文案必须让人读出「本次没记新账」与「那笔账记到哪一刻」，不能只说「未重复记账」。
    writeLine(
      context.deps.stdout,
      `  账本：本次没有新增账本行。该实例的费用已在停机时刻 ${String(result.accountedStoppedAt)} 封口，` +
        '金额已记在计划已花费里。',
    )
  }
  writeLine(
    context.deps.stdout,
    `  计划已花费：${formatYuan(result.spentYuan)} / 上限 ${formatYuan(result.budgetCapYuan)} 元`,
  )
  if (result.budgetExhausted) {
    writeLine(context.deps.stdout, '  预算已用尽：本计划不能再发起 run。')
  }
}
