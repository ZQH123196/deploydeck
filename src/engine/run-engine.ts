import { appendFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve as resolveAbsolutePath } from 'node:path'
import type { PowerOnMode, PriceQuote } from '../console/ports.js'
import { computeLedgerAmount } from '../console/release.js'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import type { Plan, PlanState } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import type { Project } from '../domain/project.js'
import type { Run, RunMode, RunState, StepResult } from '../domain/run.js'
import {
  BalanceInsufficientError,
  CloneQuotaExhaustedError,
  ConfigError,
  DeploydeckError,
  HumanRequiredError,
  InstanceNotFoundError,
  isDeploydeckErrorWithCode,
  PlanInvalidError,
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
import {
  detectPriceDrift,
  readObservedPrice,
  recordObservedPrice,
  resolvePriceSlot,
} from '../plan/price-cache.js'
import type { Provider } from '../providers/provider.js'
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

/**
 * 执行引擎。
 *
 * 顺序判据：计划校验 → 取实例（开机复用或克隆）→ 等 SSH 就绪 → 读单价复核预算
 * → 设定时关机 → 收尾。任一步失败即停，后续步骤不执行。
 *
 * `run` 的产出只有一件事：一台能 SSH 的实例。它不判断业务服务是否可用，
 * 也不执行任何远端命令。连通性探测归 `probe` 命令，见 `PROBE_COMMAND`。
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
 * 判据：`run` 不产生 `ssh` 类型步骤，所以这里没有远端命令的 id。
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
  /** 失败路径的停机保留。销毁不在这里：销毁入口只有 `teardown` 命令。 */
  powerOffOnFailure: 'power-off-on-failure',
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
  // 预算复核是执行引擎的一步，不走 Profile 分支：超预算就报失败，与失败策略无关。
  // 它只读计划、不停机：停机与状态分叉只在失败收尾一处做（BUG 3.1）。
  const budget = createBudgetEnforcement({ plans: options.planStore })

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

  // ── 1. 计划校验 ──
  // 没有生效计划时不得开机或克隆实例（spec 第 9.1 节）。
  let currentPlan: Plan = await plans.requireActivePlan(request.planId)

  // ── 2. 计划剩余时长必须覆盖安全余量 ──
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

  // ── 3. 建执行目录 ──
  // 先定 run id，再建目录：装配方按 run 目录设置 provider 的 logDir，顺序倒了证据就会落错地方。
  // 自检放在取实例之前：装配错误必须在碰任何控制台动作之前暴露。
  const runId = request.runId ?? createId('run', { now: () => new Date(clock.now()) })
  const layout = await runs.createLayout(runId)
  assertLogDirectoryInsideRunsRoot(options.workdirLogRoot, layout)
  assertProviderLogDirInsideRunDirectory(options.providerLogDir, layout)

  // ── 4. 取实例的判定 ──
  // 只读列表。名不唯一、克隆源缺失这类问题在这里就失败，不动资源。
  const decision = await decideAcquisition({ provider, profile, plan: currentPlan })
  // 能力声明是硬判据（docs/provider-contract.md 第 2 节）：能力为否时必须显式拒绝，
  // 不得静默降级成「少做一步」。全部检查都在第一个控制台动作之前。
  assertCapabilitiesForDecision(provider, decision)

  // ── 5. 建执行记录 ──
  const startedAt = beijingIso(new Date(startedAtMillis))
  const tracker: { record: Run } = {
    record: {
      id: runId,
      planId: currentPlan.id,
      mode: decision.kind === 'clone' ? 'clone' : 'reuse',
      instanceId: null,
      commitSha: null,
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
    logDir: layout.logDirectory,
  })

  // 取得实例之后才有值的字段。失败分叉与账本都读它们。
  let instanceId = ''
  let gpuSpec = ''
  let acquiredAt = ''
  let unitPriceYuanPerHour: number | null = null

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
      '进容器查现场：控制台实例列表的 SSH 登录列给出主机与端口，用 root 加密码登录。' +
      `本机现场：${layout.logDirectory}。`
    )
  }

  /** 实例已消失时的现场指引：只剩本机 run 目录。 */
  function localForensicsHint(): string {
    return `本机现场：${layout.logDirectory}。`
  }

  /**
   * 停机动作结果对应的计划状态。
   *
   * 判据：停机成功 → `stopped-pending-settlement`（钱停了，只差结账）；
   * 停机失败 → `escalated`（实例可能仍在计费）。
   * 这是「停机结果 → 计划状态」的唯一映射，报错文案与落盘状态都调它，不各写一份。
   */
  function planStateOfPowerOff(powerOffFailure: string | null): PlanState {
    return powerOffFailure === null ? 'stopped-pending-settlement' : 'escalated'
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

  /**
   * 停机保留：把钱停住，不动实例本身。返回停机失败的原因，成功时返回 `null`。
   *
   * 判据：自动判定失败时不得销毁实例。销毁是破坏性且不可撤回的动作，
   * 只允许由人显式执行 `teardown`。停机失败同样不销毁：实例留在列表里，交人工处理。
   */
  async function tryPowerOffForMoneySafety(context: string): Promise<string | null> {
    try {
      await runEngineStep({
        stepId: ENGINE_STEP_ID.powerOffOnFailure,
        kind: 'console',
        command: `powerOff(${instanceId})`,
        action: () => provider.powerOff(instanceId),
        exitCodeOf: () => 0,
        summaryOf: () => ({ instanceId }),
      })
    } catch (error: unknown) {
      logger.error('run.money-safety.power-off-failed', {
        runId,
        planId: currentPlan.id,
        instanceId,
        context,
        error: describeError(error),
      })
      return describeError(error)
    }
    logger.info('run.money-safety.power-off', { runId, planId: currentPlan.id, instanceId })
    return null
  }

  /**
   * 失败收尾的最后一段文字：实例被怎么处置了、钱停了没有、人下一步做什么。
   *
   * 判据：这段文字必须让人直接读到「钱停了没有」的答案，不能只给状态名。
   * 停机成功时计划状态是 `stopped-pending-settlement`，停机失败时是 `escalated`，
   * 两种结局的动作也不同：前者只需结账，后者必须先关机。
   */
  function describePowerOffOutcome(powerOffFailure: string | null): string {
    // 两个分支各说各话：停机成功才敢说「已停机」，停机失败必须说「可能还在跑」。
    const verdict =
      powerOffFailure === null
        ? `实例 ${instanceId} 已停机并保留`
        : `实例 ${instanceId} 停机失败（${powerOffFailure}），已保留且可能仍在运行计费`
    return (
      `${verdict}，Run 状态为 stray，计划 ${currentPlan.id} 转 ${planStateOfPowerOff(powerOffFailure)}。` +
      `停机不等于结算：执行 deploydeck teardown ${currentPlan.id} 销毁它并封口这笔账，` +
      '或到控制台确认；实例留着时按计划过期时刻由 deploydeck guard 处理。' +
      (powerOffFailure === null
        ? ''
        : '本次未写账本行：账要等 teardown 按实际停机时刻封口，现在封口会把之后烧的钱漏掉。')
    )
  }

  /**
   * 实例已到手但不能再继续（余额、单价漂移、计划窗口不足、预算超限）：先停机，再抛原错误。
   *
   * 这与 `onDeployFailure` 无关。那条策略回答「部署失败后容器怎么办」，
   * 而这些情况是「没有合法窗口继续跑」：继续运行就是无授权计费，但不销毁实例。
   * 停机失败时改为抛 `HumanRequiredError`：实例状态未知，原错误不再是主要问题。
   *
   * 判据：本函数只负责停机与抛错，不落 Run 状态、不转计划状态、不写账本。
   * 这三件事全归 `finishWithFailure` 一处，否则「停机成功」这个事实会有两个判断点。
   */
  async function abortForMoneySafety(error: DeploydeckError): Promise<never> {
    const powerOffFailure = await tryPowerOffForMoneySafety(error.message)
    if (powerOffFailure !== null) {
      // 现场指引不在这里拼：外层 `finishWithFailure` 会在本消息后统一追加一次。
      // 两处都拼会让人在同一条报错里读到两遍「进容器查现场」，反而怀疑是不是两台机器。
      throw new HumanRequiredError(
        `${error.message}\n停机失败：${powerOffFailure}。` +
          `实例 ${instanceId} 已保留且可能仍在计费。` +
          `立即到控制台确认并关机，或执行 deploydeck teardown ${currentPlan.id} 销毁它。`,
      )
    }
    throw withFailureOutcome(
      error,
      `实例 ${instanceId} 已停机并保留。执行 deploydeck teardown ${currentPlan.id} 销毁它并封口这笔账。`,
    )
  }

  /**
   * 失败收尾：先停机再落 Run 状态。停机是唯一的止损出口。
   *
   * 判据（BUG 3.1）：销毁实例的入口只有 `teardown` 命令一条。本函数在失败路径上
   * 只停机、不销毁。Run 一律记 `stray`：容器还在，需要人处理。
   *
   * 计划状态按「钱停了没有」分叉，两件事不能共用一个状态：
   * 1. 停机成功 → `stopped-pending-settlement`。实例已关机，从停机那一刻起不再计费。
   * 2. 停机失败 → `escalated`。实例可能仍在运行，钱可能还在烧。
   *
   * 账本封口判据 = 实例不再运行：
   * 1. 本函数停机成功：这一笔到此为止，写账本，金额按停机时刻封口。
   * 2. 停机失败：实例可能还在跑，不写账本；等 `teardown` 停机成功后按实际停机时刻封口。
   *
   * 预算超限不再例外：`recheckAfterInstanceReady` 已不再自己停机（S1），
   * 停机只有本函数一处，所以本函数停机成功时一律封口，不存在「同一笔记两行」。
   */
  async function finishWithFailure(error: unknown): Promise<never> {
    // 停机是止损动作，不是收尾的前置条件：它失败时记下原因继续落状态。
    const powerOffFailure = await tryPowerOffForMoneySafety(describeError(error))
    await markStray(powerOffFailure)
    if (powerOffFailure === null) {
      await appendLedgerIfPossible()
    }
    if (profile.onDeployFailure === 'destroy-container') {
      logger.warn('run.failure.destroy-container-skipped', {
        runId,
        planId: currentPlan.id,
        instanceId,
        strategy: profile.onDeployFailure,
      })
    }
    throw withFailureOutcome(
      error,
      describePowerOffOutcome(powerOffFailure) + instanceForensicsHint(),
    )
  }

  /**
   * 落失败状态：Run 转 stray，计划按「停机动作有没有成功」分叉。
   *
   * 判据：`powerOffFailure === null` 是「实例已停机」的唯一定义。只有它成立时，
   * 计划才允许写 `stopped-pending-settlement`；停机失败或没做停机动作一律写 `escalated`。
   * 不能两边都写 `escalated` —— 那会把「钱已停、等结账」与「钱可能还在烧」混成同一个状态，
   * 守护进程与人都无法据此决定下一步该关机还是该结账。
   */
  async function markStray(powerOffFailure: string | null): Promise<void> {
    await updateRecord({ state: 'stray', finishedAt: clockIso() })
    const nextState = planStateOfPowerOff(powerOffFailure)
    if (currentPlan.state !== nextState) {
      currentPlan = { ...currentPlan, state: nextState }
      await planStore.save(currentPlan)
    }
    logger.error('run.stray', {
      runId,
      planId: currentPlan.id,
      instanceId,
      planState: currentPlan.state,
      instanceStopped: powerOffFailure === null,
    })
  }

  /**
   * 失败收尾时写一行账本，并把该行金额记回计划。
   *
   * 成功路径不写：实例仍在运行，账要等后续 teardown 或计划过期时才封口。
   * 失败且已停机时写：这一笔的钱到这里就封口了，再留着实例也不该继续按运行时长记。
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
        command: `powerOn(${instanceSnapshot.instanceId}, ${profile.powerOnMode})`,
        action: () => provider.powerOn(instanceSnapshot.instanceId, profile.powerOnMode),
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
    // 分类只读 code 字段。判据（缺口 8.1）：克隆已受理却没走到确认，实例 ID 已知时
    // 必须接管——绑定到计划、落 stray。账要等 teardown 才能封口：此刻还没读到单价，
    // 写账本行就等于编一个金额。接管不了（ID 未知或读不到列表）才交人工核对。
    const strayReason = strayInstanceReason(error)
    if (strayReason !== null) {
      instanceId = strayReason.instanceId
      acquiredAt = clockIso()
      await updateRecord({ instanceId, mode: 'clone', instanceAcquiredAt: acquiredAt })
      await bindPlanInstance(instanceId)
      // 取实例阶段从未做过停机动作，实例状态未知：按「钱可能还在烧」落 escalated。
      await markStray('未做停机动作：取实例阶段尚未取得可停机的实例状态')
      logger.error('run.instance.taken-over', {
        runId,
        planId: currentPlan.id,
        instanceId,
        statusKnown: strayReason.snapshot !== null,
        gpuSpec: strayReason.snapshot?.gpuSpec ?? null,
      })
      throw withFailureOutcome(
        error,
        `已接管实例 ${instanceId}：已绑定到计划 ${currentPlan.id}，Run 状态为 stray，计划转 escalated。` +
          `实例状态未知且仍在计费：到控制台核对它，确认后执行 deploydeck teardown ${currentPlan.id} ` +
          '停机并封口这一笔账。' +
          instanceForensicsHint(),
      )
    }
    // 钱可能还在烧的判据（按码逐条）：
    // - `CLONE_RESULT_UNKNOWN`：克隆已受理但没能确认，无论有没有接管到实例 ID。没接管到 ID
    //   恰恰是最需要人核对的情况：平台已扣配额，实例可能已经建出来了。
    // - `CLONE_TIMEOUT`：等克隆完成超时，实例可能已经建出来。
    // - `INSTANCE_NOT_FOUND`：克隆回执给了 ID 但列表读不到，实例可能存在但我们读不到。
    const mayStillBeBilling = isDeploydeckErrorWithCode(
      error,
      'CLONE_RESULT_UNKNOWN',
      'CLONE_TIMEOUT',
      'INSTANCE_NOT_FOUND',
    )
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
    // 缓存按开机形态分槽：有无卡单价不同源，同一个槽比较必然被判成漂移。
    const priceSlot = resolvePriceSlot({
      powerOnMode: profile.powerOnMode,
      instanceNoGpuMode: acquired.snapshot.noGpuMode,
    })
    const drift = await runEngineStep({
      stepId: ENGINE_STEP_ID.priceDrift,
      kind: 'builtin',
      command:
        `detectPriceDrift(prices/${profile.id}-${priceSlot}.jsonc, ` +
        `阈值 ${String(PRICE_DRIFT_THRESHOLD_RATIO)})`,
      action: async () => {
        const cached = await readObservedPrice(runs.stateStore, profile.id, priceSlot)
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
      command: `recordObservedPrice(prices/${profile.id}-${priceSlot}.jsonc)`,
      action: async () =>
        await recordObservedPrice(runs.stateStore, profile.id, priceSlot, {
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
    // 超预算时它只抛 BudgetExceededError，不销毁实例（spec 第 9.2 节）；
    // 停机保留由本函数的外层 catch 统一做。
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

    // ── 13. 收尾 ──
    // 到这里实例已到手、SSH 已就绪、单价与预算已复核、定时关机已设上。
    // 不在这里跑任何远端命令：服务是否可用由使用者自己判断。
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
      commitSha: null,
      state: 'succeeded',
      unitPriceYuanPerHour: quote.unitPriceYuanPerHour,
      timedShutdownAt,
      steps: tracker.record.steps,
    }
  } catch (error: unknown) {
    // 走到这里时实例已经到手（取实例阶段的失败在上面单独处理过）。
    // 判据：失败一律停机保留、不销毁，销毁只由 teardown 执行。
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

/**
 * 从错误里取出「克隆已创建但状态未知」的实例。
 *
 * 判据：只认显式 `instanceId` 字段（错误分类走字段、不走类继承层级）。
 * 没有该字段时返回 `null`，由调用方按原分类收尾。
 */
function strayInstanceReason(
  error: unknown,
): { readonly instanceId: string; readonly snapshot: ConsoleInstanceSnapshot | null } | null {
  if (!isDeploydeckErrorWithCode(error, 'CLONE_RESULT_UNKNOWN')) {
    return null
  }
  const stray = error as { readonly instanceId?: unknown; readonly snapshot?: unknown }
  if (typeof stray.instanceId !== 'string' || stray.instanceId.length === 0) {
    return null
  }
  const snapshot = stray.snapshot ?? null
  return {
    instanceId: stray.instanceId,
    snapshot: isConsoleInstanceSnapshot(snapshot) ? snapshot : null,
  }
}

/** 读回来的实例快照是否带得出规格。规格是账本字段，拿不到就按「未知」记。 */
function isConsoleInstanceSnapshot(value: unknown): value is ConsoleInstanceSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly gpuSpec?: unknown }).gpuSpec === 'string' &&
    (value as { readonly gpuSpec: string }).gpuSpec.length > 0
  )
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
