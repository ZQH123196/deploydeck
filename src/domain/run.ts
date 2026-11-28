import { z } from 'zod'

/**
 * 一次执行的状态。
 *
 * `stray` 表示部署失败且容器被保留，需要人处理。它不是 `failed`：
 * `failed` 的容器已经消失，`stray` 的容器仍然存在并计费。
 */
export const RunStateSchema = z.enum(['created', 'running', 'succeeded', 'failed', 'stray'])
export type RunState = z.infer<typeof RunStateSchema>

/** 取实例的方式。 */
export const RunModeSchema = z.enum(['reuse', 'clone'])
export type RunMode = z.infer<typeof RunModeSchema>

/**
 * 步骤类型。
 *
 * `console` 是控制台动作（开机、克隆、设定时关机、销毁），记的是动作描述；
 * `ssh` 是在实例里执行的命令，记的是完整命令；
 * `builtin` 是引擎内部判定（计划校验、预算复核），记的是判据名。
 * 三者都要留痕：容器消失后，人只能靠 Run 记录还原发生了什么。
 */
export const StepKindSchema = z.enum(['console', 'ssh', 'builtin'])
export type StepKind = z.infer<typeof StepKindSchema>

/** 单步执行结果。命令在执行前就记录，成功失败都记。 */
export const StepResultSchema = z.object({
  stepId: z.string().min(1),
  kind: StepKindSchema,
  command: z.string().min(1),
  /**
   * 命令未执行完（例如超时被杀）时为 null。
   *
   * `console` 与 `builtin` 没有问题进程的退出码，约定 0 表示动作达成目标、
   * 1 表示未达成但流程继续（例如开机失败转克隆）。
   */
  exitCode: z.number().int().nullable(),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  /** 完整输出落盘，这里只留便于阅读的尾部。 */
  stdoutTail: z.string(),
  stderrTail: z.string(),
  /**
   * 完整输出的字节数。
   *
   * 尾部只留摘要，所以「到底输出多少」只能靠它。它也是判断日志是否被截断的依据。
   * 控制台动作与内置判定没有 stdout，记 0。
   */
  stdoutBytes: z.number().int().nonnegative().default(0),
  stderrBytes: z.number().int().nonnegative().default(0),
  /** 完整日志路径。容器消失后，这里是人唯一的现场。 */
  logPath: z.string().min(1),
  /** 动作前后截图。没有截图的步骤为空数组。 */
  screenshotPaths: z.array(z.string().min(1)).default([]),
  /**
   * 这一步没执行，因为它要达成的目标此前已经达成过。
   *
   * 判据只有一条用途：引导脚本。引导是「实例首次就绪时跑一次」的动作，
   * 已跑过时执行层要留一条跳过记录 —— 步骤列表里少了这一步，运维会以为配置写错了。
   *
   * 不要给它找第二个用途。「计划窗口不足没跑这一步」那类不是跳过：它要么是失败，
   * 要么根本没进计划。把那种情况记成跳过，等于把失败伪装成正常。
   *
   * 跳过时 `exitCode` 记 0：这一步的目标达成了，只是达成在更早的一次执行里。
   * 不要记 `null` —— `null` 的含义是「没拿到退出码」，执行层会把它当失败收尾，
   * 一次正常跳过会变成一次失败。
   */
  skipped: z.boolean().default(false),
})

export type StepResult = z.infer<typeof StepResultSchema>

/**
 * 计划下的一次执行。
 *
 * 字段含义见 docs/specs/deploydeck-phase2.md 第 3.4 节。
 */
export const RunSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  mode: RunModeSchema,
  /** 目标实例。克隆尚未完成时为空。 */
  instanceId: z.string().min(1).nullable().default(null),
  /** 部署的代码版本。配置文件不强制时可以为空。 */
  commitSha: z.string().min(1).nullable().default(null),
  state: RunStateSchema.default('created'),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1).nullable().default(null),
  /** 日志目录。容器消失后，这里是人唯一的现场。 */
  logDir: z.string().min(1),
  /**
   * 实例到手时刻。`teardown` 封口账本时用它当 `startedAt`。
   *
   * 与 `startedAt` 不同：`startedAt` 是执行记录创建的时刻，实例要到开机或克隆完成后才开始计费。
   * 没有取得实例就失败时为空。
   */
  instanceAcquiredAt: z.string().min(1).nullable().default(null),
  /** 实例规格。账本结算用。没有取得实例时为空。 */
  gpuSpec: z.string().min(1).nullable().default(null),
  /** 观测到的单价，元/小时。账本结算用。没读到单价时为空。 */
  unitPriceYuanPerHour: z.number().nonnegative().nullable().default(null),
  steps: z.array(StepResultSchema).default([]),
})

export type Run = z.infer<typeof RunSchema>
