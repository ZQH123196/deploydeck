import { z } from 'zod'

/** 一次执行的状态。`escalated` 表示容器未确认消失，需要人工。 */
export const RunStateSchema = z.enum([
  'created',
  'deploying',
  'succeeded',
  'failed',
  'tearing-down',
  'torn-down',
  'escalated',
])
export type RunState = z.infer<typeof RunStateSchema>

/** 单步执行结果。命令在执行前就记录，成功失败都记。 */
export const StepResultSchema = z.object({
  stepId: z.string().min(1),
  command: z.string().min(1),
  exitCode: z.number().int(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  /** 输出尾部。完整输出落盘，这里只留便于阅读的片段。 */
  stdoutTail: z.string(),
  stderrTail: z.string(),
  /** 原始字节数。输出被截断时，这是唯一的完整性依据。 */
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
})

export type StepResult = z.infer<typeof StepResultSchema>

export const RunSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  /** 本次部署使用的 commit。空值表示使用工作区。 */
  commitSha: z.string().min(1).nullable().default(null),
  resourceId: z.string().min(1).nullable().default(null),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1).nullable().default(null),
  state: RunStateSchema.default('created'),
  steps: z.array(StepResultSchema).default([]),
  /** 日志目录。容器消失后，这里是人唯一的现场。 */
  logDir: z.string().min(1),
})

export type Run = z.infer<typeof RunSchema>
