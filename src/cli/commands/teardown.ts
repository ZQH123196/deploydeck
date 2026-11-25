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
  /** 本次新写入的账本行。已经结算过时为 null（不重复记账）。 */
  readonly ledgerEntry: LedgerEntry | null
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
  const alreadyAccounted =
    ledgerSnapshot.status === 'present' &&
    ledgerSnapshot.entries.some(
      (entry) => entry.planId === planId && entry.instanceId === instanceId,
    )

  const logDir = await stores.stateStore.resolve(`${RUNS_DIRECTORY}/${run.id}`)
  const session = await context.deps.openProvider({ logDir })
  let snapshot: ConsoleInstanceSnapshot | undefined
  try {
    // 先读一次列表：实例可能已经被销毁（重复执行 teardown、失败收尾已销毁等情况）。
    const snapshots = await session.provider.listInstances({ refresh: true })
    snapshot = snapshots.find((candidate) => candidate.instanceId === instanceId)

    if (snapshot === undefined) {
      if (!alreadyAccounted) {
        throw new HumanRequiredError(
          `实例 ${instanceId} 已不在控制台实例列表里，但账本没有它的记录，无法确定停止时刻与金额。` +
            `计划 ${planId} 保持原状态，未做任何改动。请人工核对账本与状态目录。`,
        )
      }
      const closed = await closePlanWithLedger(stores, planId, instanceId, null)
      emitTeardownResult(context, {
        planId,
        instanceId,
        state: closed.plan.state,
        ledgerEntry: null,
        spentYuan: closed.plan.spentYuan,
        budgetCapYuan: closed.plan.budgetCapYuan,
        budgetExhausted: closed.plan.spentYuan >= closed.plan.budgetCapYuan,
      })
      return
    }

    // 账本需要的事实全部来自执行记录。缺一个就抛人工错误，不从旁路兜底。
    const accounting = requireRunAccounting(run)
    const outcome = await session.provider.destroy(instanceId)
    if (outcome.state === 'escalated') {
      await markPlanEscalated(stores, planId)
      throw new InstanceNotGoneError(
        `销毁实例 ${instanceId} 未确认消失：${outcome.reason}。` +
          `计划 ${planId} 已标记为 ESCALATED，钱可能还在烧，请立即在控制台确认。`,
      )
    }

    const entry = buildLedgerEntry({
      planId,
      runId: run.id,
      instanceId,
      gpuSpec: accounting.gpuSpec,
      startedAt: accounting.startedAt,
      stoppedAt: beijingIso(new Date(context.deps.clock.now())),
      unitPriceYuanPerHour: accounting.unitPriceYuanPerHour,
    })

    const closed = await closePlanWithLedger(stores, planId, instanceId, entry)
    const ledgerEntry = closed.writtenEntry
    context.deps.logger.info('teardown.closed', {
      planId,
      instanceId,
      runId: run.id,
      amountYuan: ledgerEntry === null ? 0 : ledgerEntry.amountYuan,
      spentYuan: closed.plan.spentYuan,
      budgetExhausted: closed.plan.spentYuan >= closed.plan.budgetCapYuan,
      alreadyAccounted,
    })
    emitTeardownResult(context, {
      planId,
      instanceId,
      state: closed.plan.state,
      ledgerEntry,
      spentYuan: closed.plan.spentYuan,
      budgetCapYuan: closed.plan.budgetCapYuan,
      budgetExhausted: closed.plan.spentYuan >= closed.plan.budgetCapYuan,
    })
  } finally {
    await session.close()
  }
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
  if (result.ledgerEntry === null) {
    writeLine(context.deps.stdout, '  账本：该实例生命周期已有记录，本次未重复记账。')
  } else {
    writeLine(
      context.deps.stdout,
      `  账本：新增一行，金额 ${formatYuan(result.ledgerEntry.amountYuan)} 元` +
        `（单价 ${formatYuan(result.ledgerEntry.unitPriceYuanPerHour)} 元/时）`,
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
