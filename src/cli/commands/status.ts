import type { Plan, PlanState } from '../../domain/plan.js'
import type { ConsoleInstanceSnapshot } from '../../domain/instance.js'
import { RUNS_DIRECTORY } from '../../engine/run-store.js'
import { readObservedPrice } from '../../plan/price-cache.js'
import type { LedgerEntry } from '../../state/ledger.js'
import type { LedgerSnapshot } from '../../state/ledger-store.js'
import { beijingIso, minutesBetweenIso } from '../../util/time.js'
import { formatNullable, formatYuan, writeJson, writeLine, writeTable } from '../output.js'
import { createCommandStores, type CommandContext, type CommandStores } from './shared.js'

/** `status` 一份计划的展示值。字段名直接进 `--json` 输出。 */
export interface StatusPlanView {
  readonly planId: string
  readonly profileId: string
  /** 计划状态枚举，机器可读。人读模式的展示词只在终端输出里出现。 */
  readonly state: PlanState
  readonly expiresAt: string
  readonly remainingMinutes: number
  readonly instanceId: string | null
  readonly instanceStatus: string | null
  readonly instanceStatusRaw: string | null
  readonly gpuSpec: string | null
  readonly unitPriceYuanPerHour: number | null
  readonly spentYuan: number
  readonly budgetCapYuan: number
}

/** `status --json` 的输出形状。 */
export interface StatusCommandResult {
  readonly plans: readonly StatusPlanView[]
  readonly ledger: {
    /**
     * 账本文件是否存在。
     *
     * 判据（docs/state-layout.md 第 7 节）：空账本与账本文件丢失必须能区分。
     * `missing` 表示状态目录里没有 ledger.jsonl：可能从没结算过，也可能文件被删了。
     */
    readonly status: 'missing' | 'present'
    readonly entryCount: number
    readonly recentEntries: readonly LedgerEntry[]
  }
}

/** 最近展示几行账本。 */
const LEDGER_RECENT_LIMIT = 5

/**
 * `status`：列出全部生效计划、它们绑定的实例、实例当前状态、单价、累计花费与账本摘要。
 *
 * 只读命令：不写状态目录，只在需要读实例状态时打开控制台。没有生效计划时不打开控制台，
 * 省掉一次登录态检查。
 */
export async function runStatusCommand(context: CommandContext): Promise<void> {
  const stores = createCommandStores(context)
  const plans = await stores.planService.listActivePlans()
  const ledgerSnapshot = await stores.ledger.readSnapshot()
  const ledgerEntries = ledgerEntriesOf(ledgerSnapshot)
  const snapshots = plans.length === 0 ? [] : await readInstanceSnapshots(context, stores)

  const views: StatusPlanView[] = []
  for (const plan of plans) {
    views.push(await buildPlanView(context, stores, plan, snapshots))
  }
  const result: StatusCommandResult = {
    plans: views,
    ledger: {
      status: ledgerSnapshot.status,
      entryCount: ledgerEntries.length,
      recentEntries: ledgerEntries.slice(-LEDGER_RECENT_LIMIT),
    },
  }

  if (context.json) {
    writeJson(context.deps.stdout, result)
    return
  }

  if (result.plans.length === 0) {
    writeLine(context.deps.stdout, '没有生效中的计划。用 plan create 创建一份。')
  } else {
    writeTable(
      context.deps.stdout,
      ['计划ID', '部署配置', '实例', '实例状态', '单价(元/时)', '已花费(元)', '预算(元)', '剩余(分)'],
      result.plans.map((view) => [
        view.planId,
        view.profileId,
        formatNullable(view.instanceId),
        formatNullable(view.instanceStatusRaw),
        view.unitPriceYuanPerHour === null ? '-' : formatYuan(view.unitPriceYuanPerHour),
        formatYuan(view.spentYuan),
        formatYuan(view.budgetCapYuan),
        String(view.remainingMinutes),
      ]),
    )
  }

  writeLine(context.deps.stdout, formatLedgerSummary(result.ledger))
  if (result.ledger.recentEntries.length > 0) {
    writeTable(
      context.deps.stdout,
      ['计划', '执行', '实例', '规格', '金额(元)'],
      result.ledger.recentEntries.map((entry) => [
        entry.planId,
        entry.runId,
        entry.instanceId,
        entry.gpuSpec,
        formatYuan(entry.amountYuan),
      ]),
    )
  }
}

/** 读一次实例列表。控制台列表不自动刷新，必须要求刷新后再读。 */
async function readInstanceSnapshots(
  context: CommandContext,
  stores: CommandStores,
): Promise<readonly ConsoleInstanceSnapshot[]> {
  // 只读命令没有自己的 run 目录：证据目录指到 runs 根，正常不会有截图落进去。
  const logDir = await stores.stateStore.resolve(RUNS_DIRECTORY)
  const session = await context.deps.openProvider({ logDir })
  try {
    return await session.provider.listInstances({ refresh: true })
  } finally {
    await session.close()
  }
}

async function buildPlanView(
  context: CommandContext,
  stores: CommandStores,
  plan: Plan,
  snapshots: readonly ConsoleInstanceSnapshot[],
): Promise<StatusPlanView> {
  const snapshot =
    plan.instanceId === null
      ? undefined
      : snapshots.find((candidate) => candidate.instanceId === plan.instanceId)
  // 单价取该配置最近一次观测：控制台是唯一来源，没观测过就是未知。
  const observation = await readObservedPrice(stores.stateStore, plan.profileId)
  const remainingMinutes = Math.max(
    0,
    Math.floor(minutesBetweenIso(beijingIso(new Date(context.deps.clock.now())), plan.expiresAt)),
  )
  return {
    planId: plan.id,
    profileId: plan.profileId,
    state: plan.state,
    expiresAt: plan.expiresAt,
    remainingMinutes,
    instanceId: plan.instanceId,
    instanceStatus: snapshot?.status ?? null,
    instanceStatusRaw: snapshot?.statusRaw ?? null,
    gpuSpec: snapshot?.gpuSpec ?? null,
    unitPriceYuanPerHour: observation?.unitPriceYuanPerHour ?? null,
    spentYuan: plan.spentYuan,
    budgetCapYuan: plan.budgetCapYuan,
  }
}

/** 账本快照的行。文件不存在时是空集，但调用方已经能从 `status` 字段看出区别。 */
function ledgerEntriesOf(snapshot: LedgerSnapshot): readonly LedgerEntry[] {
  return snapshot.status === 'present' ? snapshot.entries : []
}

/** 账本摘要。文件不存在时明确写出来，不冒充「0 行」。 */
function formatLedgerSummary(ledger: StatusCommandResult['ledger']): string {
  if (ledger.status === 'missing') {
    return '账本：文件不存在（状态目录里没有 ledger.jsonl；可能尚未结算过，也可能文件被删除）'
  }
  return `账本：${String(ledger.entryCount)} 行（最近 ${String(ledger.recentEntries.length)} 行见下）`
}
