import { z } from 'zod'

/**
 * 控制台实例状态。控制台给出中文原文，解析后归一成这个闭合枚举。
 * `unknown` 不是安全状态：不得当作已关机，也不得当作已消失。
 */
export const InstanceStatusSchema = z.enum([
  'stopped',
  'starting',
  'running',
  'cloning',
  'resetting',
  'unknown',
])
export type InstanceStatus = z.infer<typeof InstanceStatusSchema>

/**
 * 控制台实例列表的一行。
 *
 * 字段含义见 docs/specs/deploydeck-phase2.md 第 7.1 节。
 * 这里只收控制台直接显示的内容。需要推断的量（单价、是否绑定计划）不进来。
 */
export const ConsoleInstanceSnapshotSchema = z.object({
  /** 实例 ID。内部一律用它关联，不用名字。 */
  instanceId: z.string().min(1),
  /**
   * 实例名。克隆中的实例还没有名字，控制台此时显示「设置名称」按钮。
   * 无名实例取空字符串。
   */
  name: z.string(),
  status: InstanceStatusSchema,
  /** 控制台原文状态。解析与人工读数不一致时，它是唯一线索。 */
  statusRaw: z.string().min(1),
  /** 规格展示字段，例如 RTX 5090(32GB)。 */
  gpuSpec: z.string().min(1),
  /** 系统盘占用，按控制台原文保留。 */
  systemDiskUsed: z.string(),
  /** 数据盘占用，按控制台原文保留。 */
  dataDiskUsed: z.string(),
  /** 健康状态，按控制台原文保留。 */
  health: z.string(),
  /** 付费方式，按控制台原文保留。 */
  billingMode: z.string(),
  /** 释放倒计时解析成的时刻。没有倒计时为空。 */
  autoReleaseAt: z.string().min(1).nullable(),
  /** 余额告警原文，例如「余额不足24小时」。没有告警为空。 */
  balanceWarning: z.string().min(1).nullable(),
  /**
   * 平台定时关机时刻。未设置为空。
   *
   * 实测（2026-11-25 真机）：设置过定时关机后，列表第 6 列直接显示该时刻，
   * 不必重开对话框回读。
   */
  timedShutdownAt: z.string().min(1).nullable(),
  /** SSH 登录列给出的登录指令。密码要展开才可见，由 SSH 通道负责。 */
  sshCommand: z.string().min(1).nullable(),
})

export type ConsoleInstanceSnapshot = z.infer<typeof ConsoleInstanceSnapshotSchema>
