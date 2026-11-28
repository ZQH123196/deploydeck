import { createId } from '../../util/id.js'
import { ConfigError, PlanInvalidError } from '../../errors.js'
import { createRunEngine, type RunSummary } from '../../engine/run-engine.js'
import { RUNS_DIRECTORY } from '../../engine/run-store.js'
import type { Plan } from '../../domain/plan.js'
import type { Profile } from '../../domain/profile.js'
import {
  formatYuan,
  writeJson,
  writeLine,
  writeTable,
} from '../output.js'
import {
  createCommandStores,
  emitProgress,
  formatOnDeployFailure,
  type CommandContext,
  type CommandStores,
} from './shared.js'

export interface RunCommandOptions {
  readonly plan?: string
  readonly profile?: string
  readonly runId?: string
  /** 没有生效计划时，允许 `--profile` 新建一份。 */
  readonly createPlan?: boolean
}

/**
 * `run`：装配 provider，执行引擎，输出 RunSummary。
 *
 * 计划来源有两条：`--plan` 直接用，`--profile` 先找该配置的生效计划。
 * 两条都要过 `requireActivePlan`：没有生效计划不得开机或克隆（spec 第 9.1 节）。
 * `--profile` 找不到生效计划时必须失败：新建计划要由 `--create-plan` 显式授权，
 * 不能把授权窗口变成 `run` 的副作用。
 *
 * 顺序判据：先定 run id、建 run 目录，再打开 provider。provider 的 logDir 指到本次 run 目录，
 * 控制台截图才会落进 `runs/<runId>`；反过来就分不清截图属于哪次执行。
 */
export async function runRunCommand(
  context: CommandContext,
  options: RunCommandOptions,
): Promise<void> {
  // 先校验参数再碰状态目录：参数写错不应该在磁盘上留下任何东西。
  assertPlanSource(options)
  const stores = createCommandStores(context)
  const planResolution = await resolvePlan(context, stores, options)
  // 无论计划从哪来，开机或克隆之前都要过一次生效校验。
  const plan = await stores.planService.requireActivePlan(planResolution.planId)

  const profiles = await context.deps.loadProfiles()
  const profile = requirePlanProfile(profiles, plan)
  const project = await context.deps.loadProject(profile.project)

  const runId =
    options.runId ??
    createId('run', { now: () => new Date(context.deps.clock.now()) })
  const layout = await stores.runs.createLayout(runId)
  const runsRoot = await stores.stateStore.resolve(RUNS_DIRECTORY)

  if (planResolution.createdPlanId !== undefined) {
    emitProgress(context, `已创建计划 ${planResolution.createdPlanId}（来自 --profile ${profile.id}）`)
  }
  emitProgress(context, `执行 ${runId} 开始：计划 ${plan.id}，实例日志目录 ${layout.logDirectory}`)

  const session = await context.deps.openProvider({ logDir: layout.runDirectory })
  let summary: RunSummary
  try {
    const engine = createRunEngine({
      provider: session.provider,
      plans: stores.planService,
      planStore: stores.planStore,
      runs: stores.runs,
      ledger: stores.ledger,
      clock: context.deps.clock,
      logger: context.deps.logger,
      workdirLogRoot: runsRoot,
      // 自检：证据目录必须落在本次 run 目录内。
      providerLogDir: layout.runDirectory,
    })
    summary = await engine.run({
      planId: plan.id,
      profile,
      project,
      runId,
    })
  } finally {
    await session.close()
  }

  if (context.json) {
    const payload =
      planResolution.createdPlanId === undefined
        ? summary
        : { ...summary, createdPlanId: planResolution.createdPlanId }
    writeJson(context.deps.stdout, payload)
    return
  }

  for (const line of formatRunSummary(summary, profile, planResolution.createdPlanId)) {
    writeLine(context.deps.stdout, line)
  }
  if (summary.steps.length > 0) {
    writeLine(context.deps.stdout, '')
    writeTable(
      context.deps.stdout,
      ['步骤', '类型', '退出码', '日志'],
      summary.steps.map((step) => [
        step.stepId,
        step.kind,
        step.exitCode === null ? '-' : String(step.exitCode),
        step.logPath,
      ]),
    )
  }
}

interface PlanResolution {
  readonly planId: string
  /** 走 `--profile --create-plan` 且当场新建了计划时，新计划的 id。 */
  readonly createdPlanId?: string
}

/**
 * 决定这次执行用哪份计划。
 *
 * `--plan` 直接用；`--profile` 找该配置的生效计划：恰好一份就用它，多于一份时报错列出 id
 * 让人先选。一份都没有时只有 `--create-plan` 存在才新建 —— 授权窗口必须由人显式发起，
 * `run` 不能靠一次执行顺手把计划建出来（spec 第 9.1 节）。
 * 不替人挑计划：挑错就是花错预算。
 */
async function resolvePlan(
  context: CommandContext,
  stores: CommandStores,
  options: RunCommandOptions,
): Promise<PlanResolution> {
  if (options.plan !== undefined) {
    return { planId: options.plan }
  }

  const profileId = options.profile ?? ''
  const profiles = await context.deps.loadProfiles()
  const profile = profiles.find((candidate) => candidate.id === profileId)
  if (profile === undefined) {
    const available = profiles.map((candidate) => candidate.id).join('、')
    throw new ConfigError(
      `部署配置不存在：${profileId}。` +
        (available.length > 0 ? `现有配置：${available}。` : '配置目录里没有任何部署配置。'),
    )
  }

  const activePlans = (await stores.planService.listActivePlans()).filter(
    (candidate) => candidate.profileId === profile.id,
  )
  if (activePlans.length > 1) {
    throw new PlanInvalidError(
      `部署配置 ${profile.id} 有 ${String(activePlans.length)} 份生效计划：` +
        `${activePlans.map((candidate) => candidate.id).join('、')}。` +
        '无法判定该用哪一份，请用 --plan 指定其中一份。未做任何动作。',
    )
  }
  const existing = activePlans[0]
  if (existing !== undefined) {
    return { planId: existing.id }
  }

  if (options.createPlan !== true) {
    throw new PlanInvalidError(
      `部署配置 ${profile.id} 没有生效计划，拒绝创建或开机实例（spec 第 9.1 节）。` +
        `先执行 deploydeck plan create --profile ${profile.id}，` +
        '或用 --create-plan 显式授权本次自动建计划。未做任何动作。',
    )
  }
  const created = await stores.planService.createPlan({
    profile,
    provider: context.deps.readProviderCapabilities(profile.provider),
  })
  return { planId: created.id, createdPlanId: created.id }
}

/** `--plan` 与 `--profile` 必须且只能给一个；`--create-plan` 只能配 `--profile`。 */
function assertPlanSource(options: RunCommandOptions): void {
  const hasPlan = options.plan !== undefined
  const hasProfile = options.profile !== undefined
  if (hasPlan === hasProfile) {
    throw new ConfigError('必须且只能给出 --plan <planId> 或 --profile <profileId> 其中之一。')
  }
  if (options.createPlan === true && !hasProfile) {
    throw new ConfigError(
      '--create-plan 只能与 --profile 一起用：它表示「允许为这份部署配置新建计划」。',
    )
  }
}

/** 计划引用的部署配置找不到时抛错：计划能落盘，配置却可能被改名或删除。 */
function requirePlanProfile(profiles: readonly Profile[], plan: Plan): Profile {
  const profile = profiles.find((candidate) => candidate.id === plan.profileId)
  if (profile === undefined) {
    const available = profiles.map((candidate) => candidate.id).join('、')
    throw new ConfigError(
      `计划 ${plan.id} 引用的部署配置 ${plan.profileId} 不存在。` +
        (available.length > 0 ? `现有配置：${available}。` : '配置目录里没有任何部署配置。'),
    )
  }
  return profile
}

/** 人读结果的行。表格由调用方在行之后写，保持先结论后明细。 */
function formatRunSummary(
  summary: RunSummary,
  profile: Profile,
  createdPlanId: string | undefined,
): readonly string[] {
  const lines: string[] = []
  if (createdPlanId !== undefined) {
    lines.push(`已创建计划 ${createdPlanId}（来自 --profile ${profile.id}）`)
  }
  lines.push(
    `执行 ${summary.runId} 完成：${summary.state}`,
    `  计划：${summary.planId}`,
    `  部署配置：${profile.id}`,
    `  模式：${summary.mode === 'reuse' ? '开机复用' : '克隆'}`,
    `  实例：${summary.instanceId}`,
    `  单价：${formatYuan(summary.unitPriceYuanPerHour)} 元/时`,
    `  平台定时关机：${summary.timedShutdownAt}`,
    `  失败策略：${formatOnDeployFailure(profile.onDeployFailure)}`,
    `  步骤数：${String(summary.steps.length)}`,
  )
  return lines
}
