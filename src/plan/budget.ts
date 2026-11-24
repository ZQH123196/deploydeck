/**
 * 预算核算。全部是纯函数，不读时钟、不发请求。
 *
 * 判据见 docs/plan-and-budget.md 第 6 节。
 */

/** 已用比例达到该值时告警。 */
export const BUDGET_WARN_RATIO = 0.8

/** 熔断线。已达到即必须关闭容器。 */
export const BUDGET_TRIP_RATIO = 1

/** 本次计划预计花费 = 单价 × 计划时长。 */
export function estimateRunCostYuan(pricePerHourYuan: number, ttlMinutes: number): number {
  if (pricePerHourYuan < 0) {
    throw new RangeError(`单价不能为负：${pricePerHourYuan}`)
  }
  if (ttlMinutes <= 0) {
    throw new RangeError(`计划时长必须为正：${ttlMinutes}`)
  }
  return (pricePerHourYuan * ttlMinutes) / 60
}

export type CreateDecision = 'allow' | 'warn' | 'deny'

/**
 * 是否允许创建容器。
 *
 * 已用达到上限即拒绝。预计花费会顶穿上限也拒绝。
 * 已用达到告警线时仍然允许，但返回 warn。
 */
export function decideCreate(input: {
  spentYuan: number
  budgetCapYuan: number
  projectedCostYuan: number
}): CreateDecision {
  const { spentYuan, budgetCapYuan, projectedCostYuan } = input
  if (budgetCapYuan <= 0) {
    throw new RangeError(`预算上限必须为正：${budgetCapYuan}`)
  }
  if (spentYuan < 0) {
    throw new RangeError(`已花费不能为负：${spentYuan}`)
  }

  const usedRatio = spentYuan / budgetCapYuan
  if (usedRatio >= BUDGET_TRIP_RATIO) {
    return 'deny'
  }
  if (spentYuan + projectedCostYuan > budgetCapYuan) {
    return 'deny'
  }
  if (usedRatio >= BUDGET_WARN_RATIO) {
    return 'warn'
  }
  return 'allow'
}

export type RuntimeDecision = 'continue' | 'trip'

/** 运行期是否必须关闭容器。已用达到熔断线即 trip。 */
export function decideRuntime(input: { spentYuan: number; budgetCapYuan: number }): RuntimeDecision {
  const { spentYuan, budgetCapYuan } = input
  if (budgetCapYuan <= 0) {
    throw new RangeError(`预算上限必须为正：${budgetCapYuan}`)
  }
  if (spentYuan < 0) {
    throw new RangeError(`已花费不能为负：${spentYuan}`)
  }
  return spentYuan / budgetCapYuan >= BUDGET_TRIP_RATIO ? 'trip' : 'continue'
}

/** 已用比例。用于进度展示与告警。 */
export function usedRatio(input: { spentYuan: number; budgetCapYuan: number }): number {
  if (input.budgetCapYuan <= 0) {
    throw new RangeError(`预算上限必须为正：${input.budgetCapYuan}`)
  }
  return input.spentYuan / input.budgetCapYuan
}
