import { z } from 'zod'

/**
 * 计划状态。
 *
 * 判据：每个状态必须能单独回答「这台实例的钱停了没有」。
 * - `active`：授权窗口内，实例可能开着。
 * - `closed`：结算完成，钱已封口，账本已记。
 * - `expired`：展示层对「已过有效期的 active」的投影，不是落盘状态。
 * - `stopped-pending-settlement`：实例已确认停机，钱停了；账本行与关闭还没做。
 * - `escalated`：实例未确认消失，钱可能还在烧。
 *
 * `stopped-pending-settlement` 不是一个缓和版的 `escalated`。两者区别在
 * 「实例还在不在计费」：前者肯定不在，后者拿不准。混用会让运维分不清该先关机还是先结账。
 */
export const PlanStateSchema = z.enum([
  'active',
  'closed',
  'expired',
  'stopped-pending-settlement',
  'escalated',
])
export type PlanState = z.infer<typeof PlanStateSchema>

/**
 * 一次授权窗口。它事先写明能用多久、能花多少。
 *
 * 没有生效的 Plan，执行引擎不得开机或克隆实例。
 * 字段含义见 docs/specs/deploydeck-phase2.md 第 3.3 节。
 */
export const PlanSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  /** 北京时间 ISO 字符串。 */
  createdAt: z.string().min(1),
  /** 北京时间 ISO 字符串。过期后拒绝一切创建动作。 */
  expiresAt: z.string().min(1),
  budgetCapYuan: z.number().positive(),
  /**
   * 已花费。由账本金额投影而来，必填。
   *
   * 不给默认值：状态文件缺这个字段说明它被手工改坏了或写了一半。
   * 补 0 会让预算复核从 0 起算，等于把已经烧掉的钱藏起来。
   */
  spentYuan: z.number().nonnegative(),
  /**
   * 计划状态。必填。
   *
   * 不给默认值：缺状态时无法判断这份计划还能不能用，补 `active` 会凭空授权一次部署。
   */
  state: PlanStateSchema,
  /**
   * 本计划绑定的实例。没有绑定时是 `null`，必填。
   *
   * 不给默认值：缺字段时无法区分「没绑过实例」与「绑定信息丢了」，
   * 后者会让 teardown 找不到要销毁的机器。
   */
  instanceId: z.string().min(1).nullable(),
})

export type Plan = z.infer<typeof PlanSchema>
