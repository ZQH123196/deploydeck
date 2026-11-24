import { z } from 'zod'

/** 计划状态。`escalated` 表示容器未确认消失，钱可能还在烧。 */
export const PlanStateSchema = z.enum(['active', 'expired', 'closed', 'escalated'])
export type PlanState = z.infer<typeof PlanStateSchema>

/**
 * 一次授权窗口。它事先写明能用多久、能花多少。
 * 没有生效的 Plan，执行引擎不得创建容器。
 */
export const PlanSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  /** 北京时间 ISO 字符串。 */
  createdAt: z.string().min(1),
  /** 北京时间 ISO 字符串。过期后拒绝一切创建容器的请求。 */
  expiresAt: z.string().min(1),
  budgetCapYuan: z.number().positive(),
  spentYuan: z.number().nonnegative().default(0),
  state: PlanStateSchema.default('active'),
  /** 当前占用的容器。可为空。 */
  resourceId: z.string().min(1).nullable().default(null),
})

export type Plan = z.infer<typeof PlanSchema>
