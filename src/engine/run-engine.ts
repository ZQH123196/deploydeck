import { appendFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolveAbsolutePath } from 'node:path'
import type { PriceQuote, TeardownOutcome } from '../console/ports.js'
import { computeLedgerAmount } from '../console/release.js'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import type { Plan } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import type { Project } from '../domain/project.js'
import type { Run, RunMode, RunState, StepResult } from '../domain/run.js'
import {
  BalanceInsufficientError,
  CloneQuotaExhaustedError,
  ConfigError,
  DeploydeckError,
  HealthCheckFailedError,
  HumanRequiredError,
  InstanceNotGoneError,
  InstanceNotFoundError,
  isDeploydeckErrorWithCode,
  PlanInvalidError,
  PinnedCommitRequiredError,
  ScriptFailedError,
} from '../errors.js'
import type { Logger } from '../logging/logger.js'
import { decideBalance } from '../plan/balance.js'
import { estimateRunCostYuan } from '../plan/budget.js'
import {
  computeTimedShutdownAt,
  createBudgetEnforcement,
  SHUTDOWN_SAFETY_MARGIN_MINUTES,
  type BudgetEnforcement,
  type PlanService,
} from '../plan/plan-service.js'
import type { PlanStore } from '../plan/plan-store.js'
import { detectPriceDrift, readObservedPrice, recordObservedPrice } from '../plan/price-cache.js'
import type { Provider } from '../providers/provider.js'
import type { SshExecResult } from '../ssh/ports.js'
import type { LedgerEntry } from '../state/ledger.js'
import type { LedgerStore } from '../state/ledger-store.js'
import type { Clock } from '../util/clock.js'
import { createId } from '../util/id.js'
import {
  beijingIso,
  formatBeijingMinute,
  minutesBetweenIso,
  parseBeijingDateTimeText,
  parseIso,
} from '../util/time.js'
import { decideAcquisition } from './acquisition.js'
import type { RunLayout, RunStore } from './run-store.js'
import { stepLogFilePath } from './run-store.js'
import { normalizeCommitSha, planDeploySteps, STEP_ID, type PlannedStep } from './steps.js'

/**
 * 执行引擎。
 *
 * 顺序判据见 docs/specs/deploydeck-phase2.md 第 4 节与第 10 节：
 * 计划校验 → 取实例（开机复用或克隆）→ 等 SSH 就绪 → 读单价复核预算 → 设定时关机
 * → 执行脚本 → 健康检查 → 收尾。任一步失败即停，后续步骤不执行。
 *
 * 全部外部行为都经端口注入：控制台动作、SSH、状态存储、时钟、日志。
 * 本文件不出现浏览器、CDP、ssh2 的具体实现。
 *
 * 控制面证据（截图与动作日志）的落点由 `RunEngineOptions.providerLogDir` 给出。
 * 它必须在本次执行目录内：装配方在打开 provider 之前就得定下 run id，否则证据会落进
 * 一个事后无人认领的目录。`StepResult.screenshotPaths` 目前恒为空数组：
 * `Provider` 端口没有把截图路径回传的位置。
 */

/** 等 SSH 就绪的上限，毫秒。经验值：克隆出的实例还要走一遍系统启动。 */
export const SSH_READY_TIMEOUT_MS = 5 * 60 * 1000

/**
 * 单价偏差阈值（20%）。
 *
 * 判据与工单 06 共用一份实现（`detectPriceDrift`），这里只给阈值。
 * 超过它说明定价或计价口径变了，继续跑就是按未知价格烧钱。
 */
export const PRICE_DRIFT_THRESHOLD_RATIO = 0.2

/**
 * 余额告警线，元。
 *
 * 工程里没有任何来源规定这个数，所以这里不编一个「看起来合理」的值：
 * 传 0 表示只在欠费（余额为负）时告警。真正的告警阈值属于守护进程的配置面，
 * 本工单只消费 `deny`（余额撑不住本次预计花费）。
 */
export const BALANCE_WARN_BELOW_YUAN = 0

/**
 * 引擎自己的步骤 id（控制台动作与内置判定）。
 *
 * 部署脚本步骤的 id 定义在 `steps.ts`。两组 id 不重叠：一组是引擎做的动作，
 * 一组是实例里跑的脚本。
 */
const ENGINE_STEP_ID = {
  instanceSelect: 'instance-select',
  powerOn: 'power-on',
  clonePowerOff: 'clone-power-off',
  cloneQuota: 'clone-quota',
  clone: 'clone',
  sshReady: 'ssh-ready',
  priceQuote: 'price-quote',
  priceDrift: 'price-drift',
  priceCache: 'price-cache',
  budgetRecheck: 'budget-recheck',
  balanceRecheck: 'balance-recheck',
  timedShutdown: 'timed-shutdown',
  destroy: 'destroy',
} as const

export interface RunEngineOptions {
  readonly provider: Provider
  readonly plans: PlanService
  readonly planStore: PlanStore
  readonly runs: RunStore
  readonly ledger: LedgerStore
  readonly clock: Clock
  readonly logger: Logger
  /** 状态目录下的 runs 根。用来校验执行记录与步骤日志落在同一个根上。 */
  readonly workdirLogRoot: string
  /**
   * provider 的控制面证据落点（即 `AutodlProviderOptions.logDir`）。
   *
   * 自检：给值时它必须落在本次执行目录（`runs/<runId>`）内，否则构造出的执行记录
   * 说日志在这里、实际截图在那里，事后按 run 目录找不到全部现场。
   * `null` 只允许假 provider 使用：它不写截图与动作日志。
   */
  readonly providerLogDir: string | null
}

export interface RunRequest {
  readonly planId: string
  readonly profile: Profile
  readonly project: Project
  readonly commitSha: string | null
  /**
   * 执行 id。提供时用它，不提供时自己生成。
   *
   * 装配方需要按 run 目录设置 provider 的 logDir，所以必须在打开 provider 之前定下 id：
   * 这样截图会落进 `runs/<runId>`，而不是一个事后不知道属于哪次执行的目录。
   */
  readonly runId?: string
}

/** 一次执行的结论。它是 CLI 唯一需要读的东西，不含内部中间状态。 */
export interface RunSummary {
  readonly runId: string
  readonly planId: string
  readonly mode: RunMode
  readonly instanceId: string
  readonly commitSha: string | null
  readonly state: RunState
  readonly unitPriceYuanPerHour: number
  readonly timedShutdownAt: string
  /** 只含已执行的步骤。任一步失败后，后续步骤不出现在这里。 */
  readonly steps: readonly StepResult[]
}

export interface RunEngine {
  run(request: RunRequest): Promise<RunSummary>
}

interface AcquiredInstance {
  readonly mode: RunMode
  readonly instanceId: string
  readonly snapshot: ConsoleInstanceSnapshot
  /** 实例开始计费的时刻。账本用它当 `startedAt`。 */
  readonly acquiredAt: string
}

export function createRunEngine(options: RunEngineOptions): RunEngine {
  assertWorkdirLogRoot(options.workdirLogRoot)
  assertProviderLogDirConfig(options.workdirLogRoot, options.providerLogDir)
  // 预算复核是执行引擎的一步，不走 Profile 分支：超预算就销毁，与失败策略无关。
  const budget = createBudgetEnforcement({ plans: options.planStore, teardown: options.provider })

  return {
    run: async (request) => await runOnce(options, budget, request),
  }
}

async function runOnce(
  options: RunEngineOptions,
  budget: BudgetEnforcement,
  request: RunRequest,
): Promise<RunSummary> {
  const { provider, plans, planStore, runs, ledger, clock, logger } = options
  const { profile, project } = request
  const clockIso = (): string => beijingIso(new Date(clock.now()))

  // ── 1. 锁定 commit 的校验先于一切 ──
  // 它不需要计划，也不需要碰任何资源；不满足时一个动作都不做。
  // sha 同时在这里做启动期校验：它会被拼进 SSH 命令，非法值必须在碰云端之前崩。
  const commitSha = normalizeCommitSha(request.commitSha)
  if (profile.requirePinnedCommit && commitSha === null) {
    throw new PinnedCommitRequiredError(profile.id)
  }

  // ── 2. 计划校验 ──
  // 没有生效计划时不得开机或克隆实例（spec 第 9.1 节）。
  let currentPlan: Plan = await plans.requireActivePlan(request.planId)

  // ── 3. 计划剩余时长必须覆盖安全余量 ──
  // 剩余不足安全余量时定时关机时刻落在过去，控制台设不上，等于买一台关不掉的机器。
  // 这里在取得任何实例之前拒绝，零动作。
  const startedAtMillis = clock.now()
  const timedShutdownAt = computeTimedShutdownAt(currentPlan)
  if (parseIso(timedShutdownAt).getTime() <= startedAtMillis) {
    throw new PlanInvalidError(
      `计划 ${currentPlan.id} 剩余时长不足：过期时刻 ${currentPlan.expiresAt}，` +
        `平台定时关机时刻 ${timedShutdownAt} 已不在将来（安全余量 ${String(SHUTDOWN_SAFETY_MARGIN_MINUTES)} 分钟）。` +
        '未做任何动作。请重新创建计划后再执行。',
    )
  }

  // ── 4. 建执行目录 ──
  // 先定 run id，再建目录：装配方按 run 目录设置 provider 的 logDir，顺序倒了证据就会落错地方。
  // 自检放在取实例之前：装配错误必须在碰任何控制台动作之前暴露。
  const runId = request.runId ?? createId('run', { now: () => new Date(clock.now()) })
  const layout = await runs.createLayout(runId)
  assertLogDirectoryInsideRunsRoot(options.workdirLogRoot, layout)
  assertProviderLogDirInsideRunDirectory(options.providerLogDir, layout)

  // ── 5. 取实例的判定 ──
  // 只读列表。名不唯一、克隆源缺失这类问题在这里就失败，不动资源。
  const decision = await decideAcquisition({ provider, profile, plan: currentPlan })
  // 能力声明是硬判据（docs/provider-contract.md 第 2 节）：能力为否时必须显式拒绝，
  // 不得静默降级成「少做一步」。全部检查都在第一个控制台动作之前。
  assertCapabilitiesForDecision(provider, decision)

  // ── 6. 建执行记录 ──
  const startedAt = beijingIso(new Date(startedAtMillis))
  const tracker: { record: Run } = {
    record: {
      id: runId,
      planId: currentPlan.id,
      mode: decision.kind === 'clone' ? 'clone' : 'reuse',
      instanceId: null,
      commitSha,
      state: 'created',
      startedAt,
      finishedAt: null,
      logDir: layout.logDirectory,
      instanceAcquiredAt: null,
      gpuSpec: null,
      unitPriceYuanPerHour: null,
      steps: [],
    },
  }
  await runs.save(tracker.record)
  await updateRecord({ state: 'running' })
  logger.info('run.start', {
    runId,
    planId: currentPlan.id,
    profileId: profile.id,
    projectId: project.id,
    mode: tracker.record.mode,
    commitSha,
    logDir: layout.logDirectory,
  })

  // 取得实例之后才有值的字段。失败分叉与账本都读它们。
  let instanceId = ''
  let gpuSpec = ''
  let acquiredAt = ''
  let unitPriceYuanPerHour: number | null = null
  /** 实例已被销毁或已确认消失。此后不再对实例做任何动作。 */
  let instanceDisposed = false

  async function updateRecord(patch: Partial<Run>): Promise<void> {
    tracker.record = { ...tracker.record, ...patch }
    await runs.save(tracker.record)
  }

  async function appendStep(step: StepResult): Promise<void> {
    tracker.record = { ...tracker.record, steps: [...tracker.record.steps, step] }
    await runs.save(tracker.record)
  }

  /** 控制台动作与内置判定的日志文件绝对路径。每步一份，容器消失后仍可读。 */
  function engineStepLogPath(stepId: string): string {
    return stepLogFilePath(layout, stepId)
  }

  /**
   * 实例仍在时的现场指引。
   *
   * 判据（docs/architecture.md 第 4.6 节）：`stray` 的报错必须给出进容器查现场的方法。
   * 容器消失之后只剩本机日志，所以本机 run 目录也要给出绝对路径。
   */
  function instanceForensicsHint(): string {
    return (
      `进容器查现场：项目目录 ${project.workdir}；` +
      'SSH 登录方式：控制台实例列表的 SSH 登录列给出主机与端口，用 root 加密码登录。' +
      `本机现场：${layout.logDirectory}。`
    )
  }

  /** 实例已消失时的现场指引：只剩本机 run 目录。 */
  function localForensicsHint(): string {
    return `本机现场：${layout.logDirectory}。`
  }

  /**
   * 跑一步控制台动作或内置判定。
   *
   * 执行前先写一条 `step.start` 到本步日志文件，并记日志；执行后追加 `step.finish`。
   * 进程在执行中被杀时，磁盘上仍能读到「这一步开始时打算做什么」。
   */
  async function runEngineStep<Result>(input: {
    readonly stepId: string
    readonly kind: 'console' | 'builtin'
    readonly command: string
    readonly action: () => Promise<Result>
    /** 动作达成目标返回 0。返回非 0 表示没达成但流程还要继续（例如开机失败转克隆）。 */
    readonly exitCodeOf: (result: Result) => number
    readonly summaryOf: (result: Result) => Record<string, unknown>
  }): Promise<Result> {
    logger.info('run.step.start', {
      runId,
      planId: currentPlan.id,
      stepId: input.stepId,
      kind: input.kind,
      command: input.command,
    })
    const startedStepAt = clockIso()
    const logPath = engineStepLogPath(input.stepId)
    await writeFile(
      logPath,
      `${jsonLine({ event: 'step.start', time: startedStepAt, stepId: input.stepId, kind: input.kind, command: input.command })}\n`,
      'utf8',
    )

    let result: Result
    try {
      result = await input.action()
    } catch (error: unknown) {
      const finishedStepAt = clockIso()
      await appendFile(
        logPath,
        `${jsonLine({ event: 'step.error', time: finishedStepAt, stepId: input.stepId, error: describeError(error) })}\n`,
        'utf8',
      )
      await appendStep({
        stepId: input.stepId,
        kind: input.kind,
        command: input.command,
        exitCode: null,
        startedAt: startedStepAt,
        finishedAt: finishedStepAt,
        stdoutTail: '',
        stderrTail: describeError(error),
        stdoutBytes: 0,
        stderrBytes: 0,
        logPath,
        screenshotPaths: [],
      })
      logger.error('run.step.failed', {
        runId,
        planId: currentPlan.id,
        stepId: input.stepId,
        error: describeError(error),
      })
      throw error
    }

    const finishedStepAt = clockIso()
    const exitCode = input.exitCodeOf(result)
    await appendFile(
      logPath,
      `${jsonLine({
        event: 'step.finish',
        time: finishedStepAt,
        stepId: input.stepId,
        exitCode,
        result: input.summaryOf(result),
      })}\n`,
      'utf8',
    )
    await appendStep({
      stepId: input.stepId,
      kind: input.kind,
      command: input.command,
      exitCode,
      startedAt: startedStepAt,
      finishedAt: finishedStepAt,
      stdoutTail: '',
      stderrTail: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      logPath,
      screenshotPaths: [],
    })
    logger.info('run.step.finish', {
      runId,
      planId: currentPlan.id,
      stepId: input.stepId,
      exitCode,
      logPath,
    })
    return result
  }

  /** 在实例里跑一条命令。日志文件由 SSH 通道写：完整输出落盘，Run 记录只留尾部与字节数。 */
  async function runSshStep(step: PlannedStep): Promise<SshExecResult> {
    const logPath = stepLogFilePath(layout, step.stepId)
    logger.info('run.step.start', {
      runId,
      planId: currentPlan.id,
      stepId: step.stepId,
      kind: step.kind,
      command: step.command,
      timeoutSeconds: step.timeoutSeconds,
      logPath,
    })
    const startedStepAt = clockIso()

    let result: SshExecResult
    try {
      result = await provider.exec(instanceId, step.command, {
        timeoutSeconds: step.timeoutSeconds,
        logPath,
      })
    } catch (error: unknown) {
      const finishedStepAt = clockIso()
      // SSH 通道连上之后才创建日志文件。连接失败时文件不存在，这里补一行错误，
      // 保证 Run 记录里的 logPath 一定读得到东西。命令中途断线时文件已存在，
      // 追加而不是覆盖：已经产生的输出不能被抹掉。
      try {
        await appendFile(
          logPath,
          `${jsonLine({ event: 'step.error', time: finishedStepAt, stepId: step.stepId, error: describeError(error) })}\n`,
          'utf8',
        )
      } catch (logError: unknown) {
        logger.warn('run.step.log-write-failed', {
          runId,
          planId: currentPlan.id,
          stepId: step.stepId,
          logPath,
          error: describeError(logError),
        })
      }
      await appendStep({
        stepId: step.stepId,
        kind: step.kind,
        command: step.command,
        exitCode: null,
        startedAt: startedStepAt,
        finishedAt: finishedStepAt,
        stdoutTail: '',
        stderrTail: describeError(error),
        stdoutBytes: 0,
        stderrBytes: 0,
        logPath,
        screenshotPaths: [],
      })
      throw error
    }

    const finishedStepAt = clockIso()
    await appendStep({
      stepId: step.stepId,
      kind: step.kind,
      command: step.command,
      exitCode: result.exitCode,
      startedAt: startedStepAt,
      finishedAt: finishedStepAt,
      stdoutTail: result.stdoutTail,
      stderrTail: result.stderrTail,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      logPath,
      screenshotPaths: [],
    })
    logger.info('run.step.finish', {
      runId,
      planId: currentPlan.id,
      stepId: step.stepId,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      durationMs: result.durationMs,
      logPath,
    })
    return result
  }

  /**
   * 销毁实例并记录这一步。
   *
   * 销毁链自己失败时实例状态未知，按 ESCALATED 处理：不能假设它已经消失。
   */
  async function destroyInstance(): Promise<TeardownOutcome> {
    try {
      return await runEngineStep<TeardownOutcome>({
        stepId: ENGINE_STEP_ID.destroy,
        kind: 'console',
        command: `destroy(${instanceId})`,
        action: () => provider.destroy(instanceId),
        exitCodeOf: (outcome) => (outcome.state === 'gone' ? 0 : 1),
        summaryOf: (outcome) =>
          outcome.state === 'gone' ? { state: 'gone' } : { state: 'escalated', reason: outcome.reason },
      })
    } catch (error: unknown) {
      throw new InstanceNotGoneError(
        `销毁实例 ${instanceId} 的链路失败：${describeError(error)}。` +
          '实例状态未知，钱可能还在烧，请立即在控制台确认。',
      )
    }
  }

  /**
   * 止损销毁：确认消失即把实例标记为已销毁。
   *
   * 未确认消失（含销毁链自己失败）抛 `InstanceNotGoneError`：钱可能还在烧，
   * 由失败收尾记 stray 并把计划转 escalated。
   */
  async function disposeForMoneySafety(context: string): Promise<void> {
    const outcome = await destroyInstance()
    if (outcome.state === 'escalated') {
      throw new InstanceNotGoneError(
        `${context} 销毁实例 ${instanceId} 未确认消失：${outcome.reason}。` +
          '钱可能还在烧，请立即人工确认。',
      )
    }
    instanceDisposed = true
  }

  /**
   * 实例已到手但不能再继续（预算、余额、单价漂移、计划窗口不足）：先销毁止损，再抛原错误。
   *
   * 这与 `onDeployFailure` 无关。那条策略回答「部署失败后容器怎么办」，
   * 而这些情况是「根本没有合法窗口继续跑」：留着容器就是无授权计费。
   */
  async function abortForMoneySafety(error: DeploydeckError): Promise<never> {
    await disposeForMoneySafety(error.message)
    // 现场信息由失败收尾统一追加一次，这里只补「已销毁」这个事实，避免重复。
    throw withFailureOutcome(
      error,
      `已销毁实例 ${instanceId}（控制台中已不存在）。`,
    )
  }

  /**
   * 失败收尾：决定容器留不留，落 Run 状态，必要时记账，然后把原错误抛出去。
   *
   * 分类判据（spec 第 10.5 节）：
   * `stray` 是失败但容器仍在，需要人处理；`failed` 是容器已消失。
   */
  async function finishWithFailure(error: unknown): Promise<never> {
    // 分类只读显式 code 字段（AGENTS.md 代码规范 · 错误分类），不按类继承层级分叉。
    // 已经确认消失的路径：预算复核自己会先销毁再抛错，金额止损也走这里。
    if (instanceDisposed || isDeploydeckErrorWithCode(error, 'BUDGET_EXCEEDED')) {
      await updateRecord({ state: 'failed', finishedAt: clockIso() })
      await appendLedgerIfPossible()
      logger.error('run.failed', {
        runId,
        planId: currentPlan.id,
        instanceId,
        state: 'failed',
        error: describeError(error),
      })
      throw withFailureOutcome(error, localForensicsHint())
    }

    // 实例可能仍在列表里：钱可能还在烧，计划转 escalated。
    if (isDeploydeckErrorWithCode(error, 'INSTANCE_NOT_GONE')) {
      await markStray(error.message)
      throw withFailureOutcome(error, instanceForensicsHint())
    }

    if (profile.onDeployFailure === 'keep-container') {
      await updateRecord({ state: 'stray', finishedAt: clockIso() })
      logger.error('run.stray', {
        runId,
        planId: currentPlan.id,
        instanceId,
        strategy: profile.onDeployFailure,
        error: describeError(error),
      })
      throw withFailureOutcome(
        error,
        `按部署配置 ${profile.id} 的 onDeployFailure=keep-container 保留了实例 ${instanceId}，` +
          `Run 状态为 stray。容器仍在计费：到计划过期时刻由 deploydeck guard 销毁` +
          `（guard 需有人保持运行；Phase 3 才做系统级自启动），` +
          `也可立即执行 deploydeck teardown ${currentPlan.id} 销毁它。` +
          instanceForensicsHint(),
      )
    }

    // destroy-container：实例必须立刻消失。
    const outcome = await destroyInstance()
    if (outcome.state === 'escalated') {
      await markStray(outcome.reason)
      throw new InstanceNotGoneError(
        `实例 ${instanceId} 在 ${describeError(error)} 之后销毁未确认消失：${outcome.reason}。` +
          '钱可能还在烧，请立即人工确认。' + instanceForensicsHint(),
      )
    }
    instanceDisposed = true
    await updateRecord({ state: 'failed', finishedAt: clockIso() })
    await appendLedgerIfPossible()
    logger.error('run.failed', {
      runId,
      planId: currentPlan.id,
      instanceId,
      state: 'failed',
      strategy: profile.onDeployFailure,
      error: describeError(error),
    })
    throw withFailureOutcome(
      error,
      `按部署配置 ${profile.id} 的 onDeployFailure=destroy-container 已销毁实例 ${instanceId}` +
        `（控制台中已不存在），Run 状态为 failed。${localForensicsHint()}`,
    )
  }

  /** 标记实例仍在的状态：Run 转 stray，计划转 escalated。 */
  async function markStray(reason: string): Promise<void> {
    await updateRecord({ state: 'stray', finishedAt: clockIso() })
    if (currentPlan.state !== 'escalated') {
      currentPlan = { ...currentPlan, state: 'escalated' }
      await planStore.save(currentPlan)
    }
    logger.error('run.stray', {
      runId,
      planId: currentPlan.id,
      instanceId,
      planState: currentPlan.state,
      reason,
    })
  }

  /**
   * 实例消失时写一行账本，并把该行金额记回计划。
   *
   * 成功路径不写：实例仍在运行，账要等后续 teardown 或计划过期时才封口。
   * 单价未知时不写：账本只记已封口的金额，编一个数会让事后对账更乱。
   *
   * 记账后必须投影到 `plan.spentYuan`：同一份计划的下一次执行要能看到这次已经烧掉的钱，
   * 否则预算复核永远从 0 起算，预算上限只是摆设。
   */
  async function appendLedgerIfPossible(): Promise<void> {
    if (unitPriceYuanPerHour === null) {
      logger.warn('run.ledger.skipped', {
        runId,
        planId: currentPlan.id,
        instanceId,
        reason: '未读到单价，无法计算金额',
      })
      return
    }
    const stoppedAt = clockIso()
    const entry: LedgerEntry = {
      planId: currentPlan.id,
      runId,
      instanceId,
      gpuSpec,
      startedAt: acquiredAt,
      stoppedAt,
      unitPriceYuanPerHour: unitPriceYuanPerHour,
      amountYuan: computeLedgerAmount({
        unitPriceYuanPerHour,
        startedAt: acquiredAt,
        stoppedAt,
      }),
    }
    await ledger.append(entry)
    logger.info('run.ledger.appended', { ...entry })
    try {
      currentPlan = await planStore.recordSpent(currentPlan.id, entry.amountYuan)
      logger.info('run.ledger.projected', {
        planId: currentPlan.id,
        amountYuan: entry.amountYuan,
        spentYuan: currentPlan.spentYuan,
        budgetCapYuan: currentPlan.budgetCapYuan,
      })
    } catch (error: unknown) {
      // 账本行已经落盘，这一行是事实；投影失败只影响预算复核的起点。
      // Let it crash（AGENTS.md 代码规范）：不吞成一行日志，交给人核对并手工处理。
      // 原始错误经 `cause` 保留，`status` 会同时看到账本行与没回写的计划金额。
      logger.error('run.ledger.projection-failed', {
        runId,
        planId: currentPlan.id,
        amountYuan: entry.amountYuan,
        error: describeError(error),
      })
      throw new HumanRequiredError(
        `账已记上但计划金额没回写：账本已新增一行（金额 ${String(entry.amountYuan)} 元，实例 ${instanceId}），` +
          `但计划 ${currentPlan.id} 的 spentYuan 更新失败（${describeError(error)}）。` +
          '去执行 deploydeck status 核对计划与账本，再手工处理。' +
          `本机现场：${layout.logDirectory}。`,
        { cause: error },
      )
    }
  }

  async function acquireInstance(): Promise<AcquiredInstance> {
    if (decision.kind === 'reuse-running') {
      return await reuseRunningInstance(decision.snapshot)
    }
    if (decision.kind === 'power-on') {
      const instanceSnapshot = decision.snapshot
      const outcome = await runEngineStep({
        stepId: ENGINE_STEP_ID.powerOn,
        kind: 'console',
        command: `powerOn(${instanceSnapshot.instanceId})`,
        action: () => provider.powerOn(instanceSnapshot.instanceId),
        exitCodeOf: (powerOnOutcome) => (powerOnOutcome.ok ? 0 : 1),
        summaryOf: (powerOnOutcome) =>
          powerOnOutcome.ok
            ? { ok: true, instanceId: powerOnOutcome.instanceId }
            : { ok: false, reason: powerOnOutcome.reason, detail: powerOnOutcome.detail },
      })
      if (outcome.ok) {
        return {
          mode: 'reuse',
          instanceId: instanceSnapshot.instanceId,
          snapshot: instanceSnapshot,
          acquiredAt: clockIso(),
        }
      }
      // 开机失败才克隆（spec 第 4.1 节）。源实例就是这台已经关机的实例。
      logger.warn('run.instance.power-on-failed', {
        runId,
        planId: currentPlan.id,
        instanceId: instanceSnapshot.instanceId,
        reason: outcome.reason,
        detail: outcome.detail,
      })
      await updateRecord({ mode: 'clone' })
      return await cloneFromSource(instanceSnapshot)
    }
    return await cloneFromSource(decision.source)
  }

  async function reuseRunningInstance(
    snapshot: ConsoleInstanceSnapshot,
  ): Promise<AcquiredInstance> {
    await runEngineStep({
      stepId: ENGINE_STEP_ID.instanceSelect,
      kind: 'builtin',
      command: `reuse(running:${snapshot.instanceId})`,
      action: async () => snapshot,
      exitCodeOf: () => 0,
      summaryOf: (value) => ({ status: value.status, gpuSpec: value.gpuSpec }),
    })
    return {
      mode: 'reuse',
      instanceId: snapshot.instanceId,
      snapshot,
      acquiredAt: clockIso(),
    }
  }

  async function cloneFromSource(source: ConsoleInstanceSnapshot): Promise<AcquiredInstance> {
    // 配额判据必须早于任何实例状态改动（spec 第 7.3 节与第 9.4 节）：
    // 为 0 时直接失败，源实例保持原状态，不做「先关机再发现没配额」这种不可逆动作。
    const remaining = await runEngineStep({
      stepId: ENGINE_STEP_ID.cloneQuota,
      kind: 'console',
      command: `readCloneQuota(${source.instanceId})`,
      action: () => provider.readCloneQuota(source.instanceId),
      exitCodeOf: () => 0,
      summaryOf: (value) => ({ remaining: value }),
    })
    if (remaining <= 0) {
      throw new CloneQuotaExhaustedError(remaining)
    }

    if (source.status !== 'stopped') {
      // spec 第 7.3 节：源实例必须已关机，未关机先关机。
      await runEngineStep({
        stepId: ENGINE_STEP_ID.clonePowerOff,
        kind: 'console',
        command: `powerOff(${source.instanceId})`,
        action: () => provider.powerOff(source.instanceId),
        exitCodeOf: () => 0,
        summaryOf: () => ({ instanceId: source.instanceId }),
      })
    }

    const cloneOutcome = await runEngineStep({
      stepId: ENGINE_STEP_ID.clone,
      kind: 'console',
      command: `clone(source=${source.instanceId}, name=${profile.instanceNamePattern})`,
      action: () =>
        provider.clone({
          sourceInstanceId: source.instanceId,
          gpuPreference: profile.gpuPreference,
          regionPreference: profile.regionPreference,
          cloneDataDisk: profile.cloneDataDisk,
          instanceName: profile.instanceNamePattern,
        }),
      exitCodeOf: () => 0,
      summaryOf: (value) => ({
        instanceId: value.instanceId,
        sourceInstanceId: value.sourceInstanceId,
      }),
    })

    // 回列表读一次规格：账本与单价缓存都要 gpuSpec，克隆回执里没有。
    const snapshot = await requireInstanceSnapshot(cloneOutcome.instanceId)
    return {
      mode: 'clone',
      instanceId: cloneOutcome.instanceId,
      snapshot,
      acquiredAt: clockIso(),
    }
  }

  async function requireInstanceSnapshot(targetId: string): Promise<ConsoleInstanceSnapshot> {
    const snapshots = await provider.listInstances({ refresh: true })
    const snapshot = snapshots.find((candidate) => candidate.instanceId === targetId)
    if (snapshot === undefined) {
      throw new InstanceNotFoundError(targetId)
    }
    return snapshot
  }

  /** 把实例 ID 绑到计划上。进程中途崩溃时，teardown 仍能靠它找到这台实例。 */
  async function bindPlanInstance(targetInstanceId: string): Promise<void> {
    if (currentPlan.instanceId === targetInstanceId) {
      return
    }
    currentPlan = { ...currentPlan, instanceId: targetInstanceId }
    await planStore.save(currentPlan)
  }

  // ── 6. 取实例 ──
  let acquired: AcquiredInstance
  try {
    acquired = await acquireInstance()
  } catch (error: unknown) {
    // 还没拿到实例就失败：可能没有容器，也可能容器已经存在。
    // 克隆超时：新实例可能已创建但未确认。
    // 克隆成功后回列表读不到：实例存在但我们读不到它的规格，状态未知。
    // 这两种都按「钱可能还在烧」处理，交人工。分类只读 code 字段。
    const mayStillBeBilling = isDeploydeckErrorWithCode(error, 'CLONE_TIMEOUT', 'INSTANCE_NOT_FOUND')
    if (mayStillBeBilling) {
      await updateRecord({ state: 'stray', finishedAt: clockIso() })
      if (currentPlan.state !== 'escalated') {
        currentPlan = { ...currentPlan, state: 'escalated' }
        await planStore.save(currentPlan)
      }
    } else {
      await updateRecord({ state: 'failed', finishedAt: clockIso() })
    }
    logger.error('run.failed', {
      runId,
      planId: currentPlan.id,
      state: tracker.record.state,
      phase: 'acquire',
      error: describeError(error),
    })
    // 取实例失败必须带现场信息：stray 给「怎么进容器查」，failed 给本机 run 目录绝对路径。
    throw withFailureOutcome(
      error,
      mayStillBeBilling
        ? `克隆出的实例可能已创建但未确认，钱可能还在烧。请到控制台实例列表核对本次克隆出的新实例。` +
            instanceForensicsHint()
        : localForensicsHint(),
    )
  }

  instanceId = acquired.instanceId
  gpuSpec = acquired.snapshot.gpuSpec
  acquiredAt = acquired.acquiredAt
  // 账本结算要用的三件事一到手就落进执行记录：容器消失后只剩本机记录可查。
  await updateRecord({
    instanceId,
    mode: acquired.mode,
    instanceAcquiredAt: acquired.acquiredAt,
    gpuSpec,
  })
  await bindPlanInstance(instanceId)

  try {
    // ── 7. 等 SSH 就绪 ──
    await runEngineStep({
      stepId: ENGINE_STEP_ID.sshReady,
      kind: 'builtin',
      command: `waitUntilReady(${instanceId}, ${String(SSH_READY_TIMEOUT_MS)}ms)`,
      action: async () => await provider.waitUntilReady(instanceId, SSH_READY_TIMEOUT_MS),
      exitCodeOf: () => 0,
      summaryOf: () => ({ instanceId, timeoutMs: SSH_READY_TIMEOUT_MS }),
    })

    // ── 8. 读单价 ──
    const remainingMinutes = Math.max(
      1,
      Math.floor(minutesBetweenIso(clockIso(), currentPlan.expiresAt)),
    )
    const quote = await runEngineStep<PriceQuote>({
      stepId: ENGINE_STEP_ID.priceQuote,
      kind: 'console',
      command: `readPriceQuote(${instanceId}, ${String(remainingMinutes)} 分钟)`,
      action: () => provider.readPriceQuote(instanceId, remainingMinutes),
      exitCodeOf: () => 0,
      summaryOf: (value) => ({
        serverTime: value.serverTime,
        unitPriceYuanPerHour: value.unitPriceYuanPerHour,
        ttlMinutes: value.ttlMinutes,
        balanceYuan: value.balanceYuan,
      }),
    })
    unitPriceYuanPerHour = quote.unitPriceYuanPerHour
    await updateRecord({ unitPriceYuanPerHour })

    // ── 9. 单价漂移 ──
    // 先比较再写缓存：漂移时不能把新价写进缓存，否则「清掉缓存再重试」这个方法就失效了。
    const drift = await runEngineStep({
      stepId: ENGINE_STEP_ID.priceDrift,
      kind: 'builtin',
      command: `detectPriceDrift(prices/${profile.id}.jsonc, 阈值 ${String(PRICE_DRIFT_THRESHOLD_RATIO)})`,
      action: async () => {
        const cached = await readObservedPrice(runs.stateStore, profile.id)
        if (cached === null) {
          return null
        }
        return {
          cachedYuanPerHour: cached.unitPriceYuanPerHour,
          result: detectPriceDrift({
            cachedYuanPerHour: cached.unitPriceYuanPerHour,
            observedYuanPerHour: quote.unitPriceYuanPerHour,
            thresholdRatio: PRICE_DRIFT_THRESHOLD_RATIO,
          }),
        }
      },
      exitCodeOf: (value) => (value !== null && value.result.drifted ? 1 : 0),
      summaryOf: (value) =>
        value === null
          ? { cached: false }
          : { cached: true, cachedYuanPerHour: value.cachedYuanPerHour, drifted: value.result.drifted },
    })
    if (drift !== null && drift.result.drifted) {
      await abortForMoneySafety(new HumanRequiredError(`单价漂移：${drift.result.message}`))
    }

    await runEngineStep({
      stepId: ENGINE_STEP_ID.priceCache,
      kind: 'builtin',
      command: `recordObservedPrice(prices/${profile.id}.jsonc)`,
      action: async () =>
        await recordObservedPrice(runs.stateStore, profile.id, {
          unitPriceYuanPerHour: quote.unitPriceYuanPerHour,
          observedAt: quote.serverTime,
          gpuSpec,
        }),
      exitCodeOf: () => 0,
      summaryOf: () => ({
        unitPriceYuanPerHour: quote.unitPriceYuanPerHour,
        observedAt: quote.serverTime,
        gpuSpec,
      }),
    })

    // ── 10. 预算复核 ──
    // 超预算时它自己先销毁实例再抛 BudgetExceededError（spec 第 9.2 节）。
    await runEngineStep({
      stepId: ENGINE_STEP_ID.budgetRecheck,
      kind: 'builtin',
      command:
        `recheckAfterInstanceReady(plan=${currentPlan.id}, run=${runId}, ` +
        `单价 ${String(quote.unitPriceYuanPerHour)} 元/时 × ${String(quote.ttlMinutes)} 分钟)`,
      action: async () =>
        await budget.recheckAfterInstanceReady({
          planId: currentPlan.id,
          runId,
          instanceId,
          quote,
        }),
      exitCodeOf: () => 0,
      summaryOf: () => ({
        projectedCostYuan: estimateRunCostYuan(quote.unitPriceYuanPerHour, quote.ttlMinutes),
      }),
    })

    // ── 11. 余额熔断 ──
    const projectedCostYuan = estimateRunCostYuan(quote.unitPriceYuanPerHour, quote.ttlMinutes)
    const balanceDecision = await runEngineStep({
      stepId: ENGINE_STEP_ID.balanceRecheck,
      kind: 'builtin',
      command: `decideBalance(余额 ${String(quote.balanceYuan)} 元，预计 ${String(projectedCostYuan)} 元)`,
      action: async () =>
        decideBalance({
          balanceYuan: quote.balanceYuan,
          projectedCostYuan,
          warnBelowYuan: BALANCE_WARN_BELOW_YUAN,
        }),
      exitCodeOf: (decision) => (decision === 'deny' ? 1 : 0),
      summaryOf: (decision) => ({ decision, balanceYuan: quote.balanceYuan, projectedCostYuan }),
    })
    if (balanceDecision === 'warn') {
      logger.warn('run.balance.warn', {
        runId,
        planId: currentPlan.id,
        instanceId,
        balanceYuan: quote.balanceYuan,
        projectedCostYuan,
      })
    }
    if (balanceDecision === 'deny') {
      await abortForMoneySafety(
        new BalanceInsufficientError(
          `账户余额 ${String(quote.balanceYuan)} 元不足以支撑本次预计花费 ${String(projectedCostYuan)} 元` +
            `（单价 ${String(quote.unitPriceYuanPerHour)} 元/时 × ${String(quote.ttlMinutes)} 分钟）。` +
            '请充值后重新创建计划。',
        ),
      )
    }

    // ── 12. 设置平台定时关机 ──
    // 时间基准以控制台服务器时间为准（spec 第 7.4 节）：本机时钟可能偏。
    const receipt = await runEngineStep({
      stepId: ENGINE_STEP_ID.timedShutdown,
      kind: 'console',
      command: `setTimedShutdown(${instanceId}, ${timedShutdownAt})`,
      action: async () => {
        if (parseIso(timedShutdownAt).getTime() <= parseIso(quote.serverTime).getTime()) {
          throw new PlanInvalidError(
            `计划 ${currentPlan.id} 剩余时长不足 ${String(SHUTDOWN_SAFETY_MARGIN_MINUTES)} 分钟：` +
              `控制台服务器时间 ${quote.serverTime}，` +
              `平台定时关机时刻 ${timedShutdownAt} 已不在将来。未设置定时关机，也不执行任何步骤。`,
          )
        }
        const timedShutdownReceipt = await provider.setTimedShutdown(instanceId, timedShutdownAt)
        const expected = parseBeijingDateTimeText(formatBeijingMinute(timedShutdownAt))
        if (timedShutdownReceipt.shutdownAt !== expected) {
          throw new HumanRequiredError(
            `设置定时关机后回读不一致：期望 ${expected}，控制台显示 ${timedShutdownReceipt.shutdownAt}。` +
              '平台可能没有接受该时刻，请在控制台确认。',
          )
        }
        return timedShutdownReceipt
      },
      exitCodeOf: () => 0,
      summaryOf: (value) => ({ serverTime: value.serverTime, shutdownAt: value.shutdownAt }),
    })
    logger.info('run.timed-shutdown', {
      runId,
      planId: currentPlan.id,
      instanceId,
      timedShutdownAt,
      serverTime: receipt.serverTime,
    })

    // ── 13. 脚本与健康检查 ──
    for (const step of planDeploySteps({ mode: acquired.mode, profile, project, commitSha })) {
      const result = await runSshStep(step)
      if (result.timedOut || result.exitCode !== 0) {
        throw stepFailure(step, result)
      }
    }

    // ── 14. 收尾 ──
    await updateRecord({ state: 'succeeded', finishedAt: clockIso() })
    logger.info('run.succeeded', {
      runId,
      planId: currentPlan.id,
      instanceId,
      mode: acquired.mode,
      unitPriceYuanPerHour: quote.unitPriceYuanPerHour,
      timedShutdownAt,
      stepCount: tracker.record.steps.length,
    })
    return {
      runId,
      planId: currentPlan.id,
      mode: acquired.mode,
      instanceId,
      commitSha,
      state: 'succeeded',
      unitPriceYuanPerHour: quote.unitPriceYuanPerHour,
      timedShutdownAt,
      steps: tracker.record.steps,
    }
  } catch (error: unknown) {
    // 计划窗口不足是在读完单价后才发现（本机时钟与控制台服务器时间不一致时才会走到）：
    // 先销毁止损，再按「实例已消失」收尾，否则会留下一台无授权计费的实例。
    // 分类读 code 字段，不按类继承层级。
    if (isDeploydeckErrorWithCode(error, 'PLAN_INVALID')) {
      try {
        await disposeForMoneySafety(error.message)
      } catch (destroyError: unknown) {
        return await finishWithFailure(destroyError)
      }
    }
    return await finishWithFailure(error)
  }
}

/**
 * provider 能力判据。
 *
 * 判据（docs/provider-contract.md 第 2 节）：能力为否时上层必须显式拒绝该路径。
 * `create` 管「能不能创建全新实例」，`clone` 管克隆这条具体路径；克隆同时需要两者。
 * `accessInfo` 管 SSH 登录信息：所有部署步骤都走 SSH，没有它整条链没意义。
 */
function assertCapabilitiesForDecision(
  provider: Provider,
  decision: { readonly kind: 'reuse-running' | 'power-on' | 'clone' },
): void {
  const capabilities = provider.capabilities
  if (decision.kind === 'power-on' && !capabilities.powerCycle) {
    throw new ConfigError(
      `provider ${provider.id} 声明不支持开机复用（powerCycle=false），拒绝走「先开机、失败再克隆」路径。` +
        '请改用声明了该能力的 provider，或人工处理这台实例。未做任何动作。',
    )
  }
  if (decision.kind === 'clone') {
    if (!capabilities.create) {
      throw new ConfigError(
        `provider ${provider.id} 声明不支持创建实例（create=false），拒绝走克隆路径。未做任何动作。`,
      )
    }
    if (!capabilities.clone) {
      throw new ConfigError(
        `provider ${provider.id} 声明不支持克隆（clone=false），拒绝走克隆路径。` +
          '请改用开机复用路径，或换一个声明了 clone 的 provider。未做任何动作。',
      )
    }
  }
  if (!capabilities.accessInfo) {
    throw new ConfigError(
      `provider ${provider.id} 声明不支持查询 SSH 登录信息（accessInfo=false），` +
        '部署步骤无法执行。拒绝继续。未做任何动作。',
    )
  }
}

/** 把步骤失败转成业务错误。健康检查失败与脚本失败分开，排障时一眼能看出卡在哪。 */
function stepFailure(step: PlannedStep, result: SshExecResult): DeploydeckError {
  const outcome = result.timedOut
    ? `超时（${String(step.timeoutSeconds)} 秒）被终止`
    : `退出码 ${String(result.exitCode)}`
  const detail = tailOf(result.stderrTail.trim().length > 0 ? result.stderrTail : result.stdoutTail)
  const message =
    `步骤 ${step.stepId} 失败：${outcome}。命令：${step.command}。` +
    (detail.length > 0 ? `输出尾部：${detail}` : '没有输出。')
  return step.stepId === STEP_ID.healthCheck
    ? new HealthCheckFailedError(message)
    : new ScriptFailedError(message)
}

/** 错误消息里的输出尾部。完整输出在日志文件里，这里只留够定位的几行。 */
function tailOf(text: string): string {
  const lines = text.split('\n')
  const tail = lines.slice(-8).join('\n')
  return tail.length > 1200 ? tail.slice(-1200) : tail
}

/**
 * 往原错误上追加收尾说明。
 *
 * 只改 `message`，不重建错误对象：`code` 与 `exitCode` 是给上层分叉用的，
 * 重建会丢掉分类信息。
 */
function withFailureOutcome(error: unknown, suffix: string): Error {
  if (error instanceof Error) {
    error.message = `${error.message}\n${suffix}`
    return error
  }
  return new Error(`${String(error)}\n${suffix}`)
}

function describeError(error: unknown): string {
  if (error instanceof DeploydeckError) {
    return `${error.code}：${error.message}`
  }
  if (error instanceof Error) {
    return `${error.name}：${error.message}`
  }
  return String(error)
}

function jsonLine(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function assertWorkdirLogRoot(workdirLogRoot: string): void {
  if (workdirLogRoot.trim().length === 0) {
    throw new ConfigError('执行引擎的 workdirLogRoot 不能为空：它必须是状态目录下的 runs 根。')
  }
  if (!isAbsolute(workdirLogRoot)) {
    throw new ConfigError(
      `执行引擎的 workdirLogRoot 必须是绝对路径，当前值：${workdirLogRoot}。` +
        '相对路径会随进程工作目录漂移，日志可能落到别处。',
    )
  }
}

/**
 * 装配自检：执行记录的日志目录必须就是 `workdirLogRoot` 下的运行目录。
 *
 * 两处都能算出日志目录（状态存储、装配方传入的 runs 根）。不一致时日志会分叉到两个根，
 * 事后按 run 目录找不到全部现场，所以构造时就把装配错误暴露出来。
 */
function assertLogDirectoryInsideRunsRoot(workdirLogRoot: string, layout: RunLayout): void {
  const expected = resolveAbsolutePath(join(workdirLogRoot, layout.runId, 'logs'))
  const actual = resolveAbsolutePath(layout.logDirectory)
  if (expected !== actual) {
    throw new ConfigError(
      `装配错误：workdirLogRoot（${workdirLogRoot}）推出的日志目录 ${expected} ` +
        `与状态存储给出的 ${actual} 不一致。两者必须指向同一个 runs 根。`,
    )
  }
}

/**
 * 装配自检：provider 的控制面证据必须落进 runs 根。
 *
 * 构造期先做能做的检查（绝对路径、在 runs 根内），精确到本次 run 的那一条在取得 run id 后做。
 * `null` 只允许假 provider 使用：它不写截图与动作日志。
 */
function assertProviderLogDirConfig(workdirLogRoot: string, providerLogDir: string | null): void {
  if (providerLogDir === null) {
    return
  }
  if (providerLogDir.trim().length === 0) {
    throw new ConfigError('providerLogDir 不能为空字符串：不给证据目录时传 null。')
  }
  if (!isAbsolute(providerLogDir)) {
    throw new ConfigError(
      `providerLogDir 必须是绝对路径，当前值：${providerLogDir}。` +
        '相对路径会随进程工作目录漂移，截图可能落到别处。',
    )
  }
  if (!isInsideOrEqual(workdirLogRoot, providerLogDir)) {
    throw new ConfigError(
      `装配错误：provider 的 logDir（${resolveAbsolutePath(providerLogDir)}）不在 runs 根` +
        `（${resolveAbsolutePath(workdirLogRoot)}）内。控制台证据必须按 run 归档。`,
    )
  }
}

/**
 * 装配自检：provider 的控制面证据必须落进本次执行目录。
 *
 * 判据是证据能按 run 归档。装配方若在打开 provider 之前没定下 run id，截图会落进
 * 别的目录，事后按 `runs/<runId>` 找不到全部现场。
 */
function assertProviderLogDirInsideRunDirectory(
  providerLogDir: string | null,
  layout: RunLayout,
): void {
  if (providerLogDir === null) {
    return
  }
  if (!isInsideOrEqual(layout.runDirectory, providerLogDir)) {
    throw new ConfigError(
      `装配错误：provider 的 logDir（${resolveAbsolutePath(providerLogDir)}）不在本次执行目录` +
        `（${resolveAbsolutePath(layout.runDirectory)}）内。` +
        '控制台截图与动作日志必须落进本次 run 目录，否则事后按 run 目录找不到现场。',
    )
  }
}

/** 路径落在目录内或等于该目录。比较前先归一，避免 `a/../b` 这类写法绕过。 */
function isInsideOrEqual(directory: string, candidate: string): boolean {
  const relativePath = relative(resolveAbsolutePath(directory), resolveAbsolutePath(candidate))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}
