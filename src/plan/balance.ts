/**
 * 余额熔断。纯函数，不读时钟、不发请求。
 *
 * 判据见 docs/specs/deploydeck-phase2.md 第 9.3 节与 docs/plan-and-budget.md 第 6 节：
 * 余额不足以覆盖本次预计花费时拒绝继续；低于告警线时告警。
 *
 * 它与计划预算（`decideCreate`）回答不同的问题：计划预算管「本计划还能花多少」，
 * 余额熔断管「账户里还有没有钱」。两者都必须通过才允许开机或克隆。
 */

export type BalanceDecision = 'ok' | 'warn' | 'deny'

export interface BalanceInput {
  /** 控制台显示的账户余额，元。欠费时可能为负。 */
  readonly balanceYuan: number
  /** 本次预计花费，元。口径与 `estimateRunCostYuan` 一致。 */
  readonly projectedCostYuan: number
  /** 告警线，元。余额低于该值时告警。 */
  readonly warnBelowYuan: number
}

/**
 * 判断余额是否足以支撑本次花费。
 *
 * 判据是严格比较：余额正好等于预计花费仍算够，正好等于告警线不告警。
 * 余额为负是合法观测（欠费），不是非法入参：这时任何正花费都会被拒绝。
 */
export function decideBalance(input: BalanceInput): BalanceDecision {
  const { balanceYuan, projectedCostYuan, warnBelowYuan } = input
  if (!Number.isFinite(balanceYuan)) {
    throw new RangeError(`账户余额必须是有限数字，实际 ${balanceYuan}。`)
  }
  if (!Number.isFinite(projectedCostYuan) || projectedCostYuan < 0) {
    throw new RangeError(`预计花费必须是非负有限数字，实际 ${projectedCostYuan}。`)
  }
  if (!Number.isFinite(warnBelowYuan) || warnBelowYuan < 0) {
    throw new RangeError(`告警线必须是非负有限数字，实际 ${warnBelowYuan}。`)
  }

  if (balanceYuan < projectedCostYuan) {
    return 'deny'
  }
  if (balanceYuan < warnBelowYuan) {
    return 'warn'
  }
  return 'ok'
}
