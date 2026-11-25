import { ConfigError } from '../../errors.js'
import { runGuardLoop, type GuardDependencies, type GuardRoundReport } from '../../guard/guard.js'
import { formatYuan, writeJson, writeLine } from '../output.js'
import { createCommandStores, emitProgress, type CommandContext } from './shared.js'

/** 默认巡检间隔，分钟。spec 第 9.3 节要求「每 5 分钟检查过期计划」。 */
export const DEFAULT_GUARD_INTERVAL_MINUTES = 5

export interface GuardCommandOptions {
  /** 巡检间隔，分钟。来自 `--interval-minutes`，默认 5。 */
  readonly intervalMinutes: number
  /** 只巡一轮就退出。 */
  readonly once: boolean
}

/**
 * `guard`：计划层守护。
 *
 * 判据（spec 第 9.3 节）：平台定时关机是主要保障，守护层是第二层；
 * 浏览器不可用时守护层降级为告警，不静默。
 *
 * 常驻模式没有「命令结果」：进度与告警全走 stderr，stdout 不写任何东西。
 * `--json` 只与 `--once` 一起用，输出一轮巡检的 JSON 报告。
 *
 * 系统级自启动（pm2 / systemd）属 Phase 3：本期由人把 `guard` 挂在终端或自管进程里。
 */
export async function runGuardCommand(
  context: CommandContext,
  options: GuardCommandOptions,
): Promise<void> {
  if (context.json && !options.once) {
    throw new ConfigError(
      'guard --json 只能与 --once 一起用：常驻守护没有最终结果，stdout 不能输出 JSON。' +
        '需要机器可读报告时用 deploydeck guard --once --json。',
    )
  }
  // 余额告警阈值必须显式配置。没配时在启动期就报错，猜一个数会让告警线失去意义。
  const balanceWarnBelowYuan = context.deps.readBalanceWarnBelowYuan()

  const stores = createCommandStores(context)
  const deps: GuardDependencies = {
    planStore: stores.planStore,
    runs: stores.runs,
    ledger: stores.ledger,
    stateStore: stores.stateStore,
    clock: context.deps.clock,
    logger: context.deps.logger,
    openProvider: async (providerOptions) => await context.deps.openProvider(providerOptions),
  }

  let round = 0
  const report = await runGuardLoop(deps, {
    balanceWarnBelowYuan,
    intervalMs: options.intervalMinutes * 60_000,
    once: options.once,
    onRound: (roundReport) => {
      round += 1
      if (!options.once) {
        emitProgress(context, formatRoundProgress(round, roundReport))
      }
    },
  })
  if (report === null) {
    // 常驻模式不会返回。保留分支让类型完整，也防止将来改动静默丢结果。
    throw new ConfigError('guard 常驻模式意外返回，未输出任何结果。')
  }

  if (context.json) {
    writeJson(context.deps.stdout, report)
    return
  }
  for (const line of formatRoundResult(report, balanceWarnBelowYuan)) {
    writeLine(context.deps.stdout, line)
  }
}

/** 常驻模式每轮的进度行。stderr 走 emitProgress。 */
function formatRoundProgress(round: number, report: GuardRoundReport): string {
  const parts = [
    `守护第 ${String(round)} 轮：生效计划 ${String(report.activePlanCount)} 份`,
    `过期 ${String(report.expiredPlanIds.length)} 份`,
    `关闭 ${String(report.closedPlanIds.length)} 份`,
    `ESCALATED ${String(report.escalatedPlanIds.length)} 份`,
  ]
  if (report.balanceYuan === null) {
    parts.push('余额未读取')
  } else {
    parts.push(`余额 ${formatYuan(report.balanceYuan)} 元`)
  }
  if (report.degraded) {
    parts.push('控制面不可用，已降级为告警')
  }
  return parts.join('，')
}

/** `--once` 的人读结果。 */
function formatRoundResult(
  report: GuardRoundReport,
  balanceWarnBelowYuan: number,
): readonly string[] {
  const lines = [
    `守护巡检完成：${report.startedAt}`,
    `  生效计划：${String(report.activePlanCount)} 份（过期 ${String(report.expiredPlanIds.length)} 份）`,
    `  已关闭：${report.closedPlanIds.length === 0 ? '无' : report.closedPlanIds.join('、')}`,
    `  ESCALATED：${report.escalatedPlanIds.length === 0 ? '无' : report.escalatedPlanIds.join('、')}`,
  ]
  if (report.balanceYuan === null) {
    lines.push('  账户余额：未读取（控制面不可用）')
  } else {
    lines.push(
      `  账户余额：${formatYuan(report.balanceYuan)} 元（告警阈值 ${formatYuan(balanceWarnBelowYuan)} 元）`,
    )
  }
  if (report.balanceWarning) {
    lines.push('  余额低于告警阈值：请及时充值。')
  }
  if (report.degraded) {
    lines.push('  控制面不可用：本轮已降级为告警，已有实例不受影响。')
  }
  return lines
}
