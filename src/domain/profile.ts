import { z } from 'zod'

/** 部署失败后容器怎么办。这个字段只管容器，不管代码。 */
export const OnDeployFailureSchema = z.enum(['keep-container', 'destroy-container'])
export type OnDeployFailure = z.infer<typeof OnDeployFailureSchema>

/**
 * 部署配置。它规定实例命名、规格优先级、使用时长、预算上限与两个脚本。
 *
 * 所有行为差异都由 Profile 编排，引擎不按「开发/生产」分支判断。
 * 字段含义见 docs/specs/deploydeck-phase2.md 第 3.1 节。
 */
export const ProfileSchema = z.object({
  id: z.string().min(1),
  /** 引用 Project 的 id。 */
  project: z.string().min(1),
  /** 控制面由哪家 provider 实现。 */
  provider: z.string().min(1).default('autodl'),
  /**
   * 实例命名。控制台已有同名实例时直接复用该实例，没有时用它创建。
   * 内部一律用实例 ID 关联，不用名字关联。
   */
  instanceNamePattern: z.string().min(1),
  /** 算力规格优先级。左端优先级最高，不跳档。 */
  gpuPreference: z.array(z.string().min(1)).min(1),
  /** 地区优先级。空数组表示不限制。 */
  regionPreference: z.array(z.string().min(1)).default([]),
  /** 克隆实例时是否一起拷贝数据盘。系统盘固定拷贝，不可取消。 */
  cloneDataDisk: z.boolean().default(true),
  /**
   * 克隆源实例的名字或 ID。
   *
   * 控制台的克隆功能以「一台已关机实例」为模板，没有源实例就克隆不出东西。
   * spec 第 4 节的流程图里「没有绑定实例就走克隆」缺了这一步，这里补上：
   * 部署器按这个名字（或直接给 ID）在控制台里找源实例。
   * 找不到、或找到多台同名，一律报错让人处理，不猜。
   */
  cloneSourceInstanceName: z.string().min(1).optional(),
  /** 本次计划的默认可用分钟数。 */
  ttlMinutes: z.number().int().positive(),
  /** 本次计划的预算上限，单位元。 */
  budgetCapYuan: z.number().positive(),
  /**
   * 部署失败后容器怎么办。
   *
   * 默认 `keep-container`：失败时要能进容器查现场，生产配置显式写 `destroy-container`。
   * 判据见 docs/plan-and-budget.md 第 3.1 节。
   */
  onDeployFailure: OnDeployFailureSchema.default('keep-container'),
  /**
   * 是否强制指定 commit。它独立于 onDeployFailure。
   *
   * 必填，不给默认值：spec 第 3.1 节与 docs/plan-and-budget.md 第 3 节都把它标为必填。
   * 缺这个字段的部署配置无法判断「线上跑的是哪份代码」，不能猜成 false。
   */
  requirePinnedCommit: z.boolean(),
  /** 项目仓库内的部署脚本相对路径。开机复用路径先跑它。 */
  deployScript: z.string().min(1),
  /** 项目仓库内的启动脚本相对路径。两条路径都跑它。 */
  startScript: z.string().min(1),
})

export type Profile = z.infer<typeof ProfileSchema>
