import { z } from 'zod'

/** 部署失败后容器怎么办。这个字段只管容器，不管代码。 */
export const OnDeployFailureSchema = z.enum(['keep-container', 'destroy-container'])
export type OnDeployFailure = z.infer<typeof OnDeployFailureSchema>

/**
 * 环境变量名。
 *
 * 判据：它会被当作变量名解析与下发，不是任意文本。POSIX 环境变量名只允许
 * 字母、数字与下划线，且不能以数字开头。名字里出现 `=` 会让下发的一整个键值对改写语义，
 * 出现空白或 `$` 说明写的是 shell 表达式而非变量名，一律拒绝。
 */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 本机环境变量名到用途的映射。
 *
 * 判据：`Profile` 里只写**本机变量名**，不写值。值在运行时从本机环境读出，
 * 只注入远端脚本进程的环境。这样配置文件可以进仓库，密钥不必落盘。
 * 值一旦写进 `Profile`、执行记录或日志，就再也收不回来。
 */
export const EnvNamesSchema = z
  .record(z.string().regex(ENV_VAR_NAME_PATTERN, '环境变量名只允许字母、数字与下划线，且不能以数字开头'), z.string())
  .default({})

export type EnvNames = z.infer<typeof EnvNamesSchema>

/** 判断取值是不是合法的环境变量名。端口装配与 schema 共用这一份判据。 */
export function isEnvVarName(value: string): boolean {
  return ENV_VAR_NAME_PATTERN.test(value)
}

/**
 * 开机形态。
 *
 * `gpu`：租用算力开机，主机没有空闲 GPU 时开不了机。
 * `no-gpu`：无卡模式开机，不占 GPU，一定能开机，单价低。
 */
export const PowerOnModeSchema = z.enum(['gpu', 'no-gpu'])
export type PowerOnMode = z.infer<typeof PowerOnModeSchema>

/**
 * 部署配置。它规定实例命名、规格优先级、使用时长、预算上限、脚本与环境。
 *
 * 所有行为差异都由 Profile 编排，引擎不按「开发/生产」分支判断。
 * 字段含义见 docs/specs/deploydeck-phase2.md 第 3.1 节。
 *
 * 判据：`bootstrapScript` 与 `bootstrapEnv` 必须同时给或同时不给。只给一半说明配置写错：
 * 有脚本没环境会让引导读到空串，有环境没脚本等于声明了一份没人用的凭据。
 */
export const ProfileSchema = z
  .object({
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
  /**
   * 开机形态。缺省 `gpu`。
   *
   * `no-gpu` 表示走控制台的「无卡模式开机」：不占 GPU，单价低，主机没有空闲 GPU 也能开机。
   * 判据：开发与测试环境应显式写 `no-gpu`；真正需要算力时才用 `gpu`。
   * 引擎不会自行降级到无卡模式，也不会从无卡模式自动升到有卡模式。
   */
  powerOnMode: PowerOnModeSchema.default('gpu'),
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
  /**
   * 部署脚本与启动脚本进程的环境变量。键是本机变量名，值在运行时从本机读出。
   *
   * 判据：声明的变量在本机不存在即启动失败，不静默落空。落空会让脚本读到空串，
   * 表现为远端认证失败这类与配置无关的报错，人查不到根因。
   * 它不作用于引导脚本：引导脚本有独立的 `bootstrapEnv`。
   */
  env: EnvNamesSchema,
  /**
   * 一次性引导脚本，项目仓库内的相对路径。
   *
   * 判据：装环境、下载模型这类动作一次性且耗时远超启动脚本上限，不能塞进 `startScript`
   * （600 秒上限会把它们截断）。引导只在实例第一次就绪时跑，重启不重跑。
   */
  bootstrapScript: z.string().min(1).optional(),
  /**
   * 只给引导脚本进程的环境变量。键是本机变量名。
   *
   * 判据：装环境与下载模型要用的凭据（镜像站 token、模型站 token）不该同时出现在
   * 每次启动的脚本进程里。两个进程的环境分开声明，不共用一份。
   */
  bootstrapEnv: EnvNamesSchema,
})
  .superRefine((profile, context) => {
    if (profile.bootstrapScript !== undefined) {
      return
    }
    if (Object.keys(profile.bootstrapEnv).length === 0) {
      return
    }
    context.addIssue({
      code: 'custom',
      path: ['bootstrapEnv'],
      message:
        'bootstrapEnv 只能与 bootstrapScript 一起给：没有引导脚本时它没有任何作用。' +
        '要么补上 bootstrapScript，要么删掉 bootstrapEnv。',
    })
  })

export type Profile = z.infer<typeof ProfileSchema>
