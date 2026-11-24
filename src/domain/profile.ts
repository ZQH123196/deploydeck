import { z } from 'zod'

/** 部署失败后容器怎么办。这个字段只管容器，不管代码。 */
export const OnDeployFailureSchema = z.enum(['keep-container', 'destroy-container'])
export type OnDeployFailure = z.infer<typeof OnDeployFailureSchema>

/**
 * 部署配置。它规定规格优先级、使用时长、预算上限与失败策略。
 * 所有行为差异都由 Profile 编排，引擎不按“开发/生产”分支判断。
 */
export const ProfileSchema = z.object({
  id: z.string().min(1),
  project: z.string().min(1),
  provider: z.string().min(1),
  /** 算力规格优先级。左端优先级最高。 */
  gpuPreference: z.array(z.string().min(1)).min(1),
  /** 地区优先级。空数组表示由 provider 自行选择。 */
  regionPreference: z.array(z.string().min(1)).default([]),
  /** 本次计划的默认可用分钟数。 */
  ttlMinutes: z.number().int().positive(),
  /** 本次计划的预算上限，单位元。 */
  budgetCapYuan: z.number().positive(),
  onDeployFailure: OnDeployFailureSchema.default('keep-container'),
  requirePinnedCommit: z.boolean().default(false),
})

export type Profile = z.infer<typeof ProfileSchema>
