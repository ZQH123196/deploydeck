import { computeLedgerAmount } from '../console/release.js'
import { PlanSchema, type Plan } from '../domain/plan.js'
import type { Run } from '../domain/run.js'
import { HumanRequiredError } from '../errors.js'
import type { LedgerStore } from '../state/ledger-store.js'
import type { LedgerEntry } from '../state/ledger.js'
import type { StateStore } from '../state/ports.js'
import { planSettlementLockName, type PlanStore } from './plan-store.js'

/**
 * 计划结算：账本行生成、计划关闭、计划转 ESCALATED / STOPPED-PENDING-SETTLEMENT。
 *
 * 三条路径共用这一份实现：`teardown`、`guard` 的过期/超预算销毁、以及后续
 * 任何「实例已确认消失」的收尾。判据见 docs/plan-and-budget.md 第 7.1 节：
 * 账本是事实，`plan.spentYuan` 是它的投影；封口一行就把金额记回计划。
 *
 * 计费终点判据：一个实例生命周期只记一行账，那一行的 `stoppedAt` 就是计费终点。
 * 停机成功那一刻已经写下的行，后续任何结算动作都必须承认它，不能再用更晚的钟点造第二行。
 */

/** 结算需要的存储。三件都指向同一个状态目录。 */
export interface PlanSettlementStores {
  readonly stateStore: StateStore
  readonly planStore: PlanStore
  readonly ledger: LedgerStore
}

/** 账本一行需要的、只能来自执行记录的事实。 */
export interface RunAccounting {
  /** 实例到手时刻。账本的 `startedAt`。 */
  readonly startedAt: string
  readonly gpuSpec: string
  readonly unitPriceYuanPerHour: number
}

/**
 * 从执行记录取账本字段。
 *
 * 三个值缺一个就抛 `HumanRequiredError`，不编数字、不从旁路兜底：
 * 账本金额是事后对账的唯一依据。缺失时错误信息必须说清缺哪个、去哪个文件核对。
 */
export function requireRunAccounting(run: Run): RunAccounting {
  if (run.instanceAcquiredAt === null) {
    throw new HumanRequiredError(
      `执行记录 runs/${run.id}.jsonc 缺少 instanceAcquiredAt（实例到手时刻），无法计算账本金额。` +
        '该字段由执行引擎在取得实例后写入。未做任何销毁动作。' +
        `请人工核对控制台与状态目录的 runs/${run.id}.jsonc 后处理。`,
    )
  }
  if (run.gpuSpec === null) {
    throw new HumanRequiredError(
      `执行记录 runs/${run.id}.jsonc 缺少 gpuSpec（实例规格），无法写账本。` +
        '该字段由执行引擎在取得实例后写入。未做任何销毁动作。' +
        `请人工核对控制台与状态目录的 runs/${run.id}.jsonc 后处理。`,
    )
  }
  if (run.unitPriceYuanPerHour === null) {
    throw new HumanRequiredError(
      `执行记录 runs/${run.id}.jsonc 缺少 unitPriceYuanPerHour（观测到的单价），无法计算账本金额。` +
        '单价只能从控制台取得，观测记录在 prices/<profileId>.jsonc。未做任何销毁动作。' +
        '请先确认控制台单价，再核对状态目录的这两份文件后处理。',
    )
  }
  return {
    startedAt: run.instanceAcquiredAt,
    gpuSpec: run.gpuSpec,
    unitPriceYuanPerHour: run.unitPriceYuanPerHour,
  }
}

/** 生成账本行。金额 = 单价 × 时长，时长由起止时刻换算。 */
export function buildLedgerEntry(input: {
  readonly planId: string
  readonly runId: string
  readonly instanceId: string
  readonly gpuSpec: string
  readonly startedAt: string
  readonly stoppedAt: string
  readonly unitPriceYuanPerHour: number
}): LedgerEntry {
  return {
    planId: input.planId,
    runId: input.runId,
    instanceId: input.instanceId,
    gpuSpec: input.gpuSpec,
    startedAt: input.startedAt,
    stoppedAt: input.stoppedAt,
    unitPriceYuanPerHour: input.unitPriceYuanPerHour,
    amountYuan: computeLedgerAmount({
      unitPriceYuanPerHour: input.unitPriceYuanPerHour,
      startedAt: input.startedAt,
      stoppedAt: input.stoppedAt,
    }),
  }
}

/** 关闭计划的返回值。`writtenEntry` 为 `null` 表示该实例生命周期已有账本行。 */
export interface ClosePlanResult {
  readonly plan: Plan
  readonly writtenEntry: LedgerEntry | null
  /**
   * 账本里已有的那一行，仅当本次没有新增行时给出。
   *
   * 用途：让调用方能打印「费用已在 <时刻> 封口」这句话。没有它，调用方只能再说一遍
   * 「未重复记账」，运维无法确认那笔账到底记在哪个时刻。
   */
  readonly existingEntry: LedgerEntry | null
}

/**
 * 写账本并把计划转 `closed`。
 *
 * 整段在一把锁内：
 * 1. 再次读计划：锁外读到的状态可能已被别的进程改掉。
 * 2. 再次查账本：同一实例生命周期只允许一行账，重复结算不重复记账、不重复累加。
 * 3. 先写账本再更新计划：账本是事实，计划是它的投影。
 *
 * 判据（M1）：`entry` 只在「该实例尚无账本行」时才允许非空。已有账本行时调用方必须传
 * `null` —— 此时实例的计费终点早已被那一行封住，再用当前钟点造一行只会被本函数丢弃，
 * 而丢弃本身不可见，账本会永久少记「停机到 teardown 之间」那段时长。
 */
export async function closePlanWithLedger(
  stores: PlanSettlementStores,
  planId: string,
  instanceId: string,
  entry: LedgerEntry | null,
): Promise<ClosePlanResult> {
  return stores.stateStore.withLock(planSettlementLockName(planId), async () => {
    const current = await stores.planStore.read(planId)
    const existingEntry = await findInstanceEntry(stores.ledger, planId, instanceId)
    const writtenEntry = entry !== null && existingEntry === null ? entry : null
    if (writtenEntry !== null) {
      await stores.ledger.append(writtenEntry)
    }
    const spentYuan = current.spentYuan + (writtenEntry === null ? 0 : writtenEntry.amountYuan)
    const closed = PlanSchema.parse({ ...current, spentYuan, state: 'closed' })
    await stores.planStore.save(closed)
    return { plan: closed, writtenEntry, existingEntry }
  })
}

/**
 * 关闭一份没有绑定实例的计划（例如已过期但从未执行过 run）。
 *
 * 过期计划留着会让守护进程每一轮都扫到它；没有实例可销毁时，直接转 `closed`。
 */
export async function closePlanWithoutLedger(
  stores: PlanSettlementStores,
  planId: string,
): Promise<Plan> {
  return stores.stateStore.withLock(planSettlementLockName(planId), async () => {
    const current = await stores.planStore.read(planId)
    const closed = PlanSchema.parse({ ...current, state: 'closed' })
    await stores.planStore.save(closed)
    return closed
  })
}

/**
 * 计划转 `escalated`：实例未确认消失，钱可能还在烧。
 *
 * 判据：只有「实例可能仍在运行」才允许写这个状态。停机成功的计划写
 * `stopped-pending-settlement`，不用这个状态，否则运维分不清该先关机还是先结账。
 */
export async function markPlanEscalated(
  stores: Pick<PlanSettlementStores, 'planStore'>,
  planId: string,
): Promise<Plan> {
  const current = await stores.planStore.read(planId)
  if (current.state === 'escalated') {
    return current
  }
  const escalated = PlanSchema.parse({ ...current, state: 'escalated' })
  await stores.planStore.save(escalated)
  return escalated
}

/**
 * 计划转 `stopped-pending-settlement`：实例已确认停机，钱停了；账还没结。
 *
 * 判据：本状态只由「实例已确认不再运行」的路径写入。写它之后 `guard` 会补做结算。
 */
export async function markPlanStoppedPendingSettlement(
  stores: Pick<PlanSettlementStores, 'planStore'>,
  planId: string,
): Promise<Plan> {
  const current = await stores.planStore.read(planId)
  if (current.state === 'stopped-pending-settlement') {
    return current
  }
  const stopped = PlanSchema.parse({ ...current, state: 'stopped-pending-settlement' })
  await stores.planStore.save(stopped)
  return stopped
}

/** 该实例在该计划下的账本行。没有则返回 `null`，不编造金额。 */
export async function findInstanceEntry(
  ledger: LedgerStore,
  planId: string,
  instanceId: string,
): Promise<LedgerEntry | null> {
  const snapshot = await ledger.readSnapshot()
  if (snapshot.status === 'missing') {
    return null
  }
  return (
    snapshot.entries.find(
      (candidate) => candidate.planId === planId && candidate.instanceId === instanceId,
    ) ?? null
  )
}
