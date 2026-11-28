import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CloneOutcome,
  CloneRequest,
  ListInstancesOptions,
  PowerOnOutcome,
  PriceQuote,
  TeardownOutcome,
  TimedShutdownReceipt,
} from '../console/ports.js'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import type { Plan } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import type { Project } from '../domain/project.js'
import type { Run } from '../domain/run.js'
import {
  AmbiguousInstanceNameError,
  BalanceInsufficientError,
  BudgetExceededError,
  CloneQuotaExhaustedError,
  CloneSourceMissingError,
  CloneTimeoutError,
  ConfigError,
  ConsoleParseError,
  HealthCheckFailedError,
  HumanRequiredError,
  InstanceNotGoneError,
  PlanInvalidError,
  StateFileMissingError,
  StrayInstanceError,
} from '../errors.js'
import type { Logger, LogLevel } from '../logging/logger.js'
import { createPlanService, computeTimedShutdownAt, type PlanService } from '../plan/plan-service.js'
import { createPlanStore, type PlanStore } from '../plan/plan-store.js'
import {
  readObservedPrice,
  recordObservedPrice,
  type PriceSlot,
} from '../plan/price-cache.js'
import type { Provider, ProviderCapabilities } from '../providers/provider.js'
import type { SshExecOptions, SshExecResult } from '../ssh/ports.js'
import { createLedgerStore, type LedgerStore } from '../state/ledger-store.js'
import type { LedgerEntry } from '../state/ledger.js'
import { createStateStore } from '../state/store.js'
import type { StateStore } from '../state/ports.js'
import type { Clock } from '../util/clock.js'
import { beijingIso, formatBeijingMinute, parseBeijingDateTimeText } from '../util/time.js'
import { createRunEngine, PRICE_DRIFT_THRESHOLD_RATIO, SSH_READY_TIMEOUT_MS, type RunEngine, type RunSummary } from './run-engine.js'
import { createRunStore, RUNS_DIRECTORY, type RunStore } from './run-store.js'
import { STEP_ID } from './steps.js'

/**
 * 工单 10 执行引擎的验收用例。
 *
 * 全部外部行为用手写假对象：五组控制台端口 + SSH 端口都是假的，不连浏览器、不连真实 SSH。
 * 状态目录用 `.tmp/` 下的真实临时目录，时钟用假时钟，日志用只收集事件的假 logger。
 */

const START_ISO = '2026-01-01T00:00:00+08:00'
const INSTANCE_ID = 'af9c49bd44-8ee624d7'
const CLONE_SOURCE_ID = 'b1c2d3e4f5-00112233'
const CLONED_INSTANCE_ID = 'c9d8e7f600-44556677'

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

interface FakeClock extends Clock {
  advanceMinutes(minutes: number): void
}

function createFakeClock(startIso: string): FakeClock {
  let currentMillis = Date.parse(startIso)
  return {
    now: () => currentMillis,
    sleep: async (milliseconds) => {
      currentMillis += milliseconds
    },
    advanceMinutes: (minutes) => {
      currentMillis += minutes * 60_000
    },
  }
}

interface LoggerRecord {
  readonly level: LogLevel
  readonly event: string
  readonly fields: Record<string, unknown> | undefined
}

function createFakeLogger(): { logger: Logger; events: LoggerRecord[] } {
  const events: LoggerRecord[] = []
  const record =
    (level: LogLevel) =>
    (event: string, fields?: Record<string, unknown>): void => {
      events.push({ level, event, fields })
    }
  return {
    events,
    logger: { info: record('info'), warn: record('warn'), error: record('error') },
  }
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'trans-dev',
    project: 'trans-app',
    provider: 'autodl',
    instanceNamePattern: 'trans-dev',
    gpuPreference: ['v-48g'],
    regionPreference: [],
    powerOnMode: 'gpu',
    cloneDataDisk: true,
    ttlMinutes: 60,
    budgetCapYuan: 6,
    onDeployFailure: 'keep-container',
    ...overrides,
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'trans-app',
    workdir: '/root/trans_app',
    healthCheck: 'curl -fsS http://127.0.0.1:6006/health',
    ...overrides,
  }
}

function makeInstance(overrides: Partial<ConsoleInstanceSnapshot> = {}): ConsoleInstanceSnapshot {
  return {
    instanceId: INSTANCE_ID,
    name: 'trans-dev',
    status: 'stopped',
    statusRaw: '已关机',
    gpuSpec: 'RTX 5090(32GB)',
    systemDiskUsed: '10 GB',
    dataDiskUsed: '0 GB',
    health: '正常',
    billingMode: '按量计费',
    autoReleaseAt: null,
    balanceWarning: null,
    timedShutdownAt: null,
    sshCommand: null,
    noGpuMode: null,
    ...overrides,
  }
}

type ProviderAction =
  | 'listInstances'
  | 'powerOn'
  | 'powerOff'
  | 'readCloneQuota'
  | 'clone'
  | 'readPriceQuote'
  | 'setTimedShutdown'
  | 'clearTimedShutdown'
  | 'readBalance'
  | 'destroy'
  | 'waitUntilReady'
  | 'exec'

interface ProviderCall {
  readonly action: ProviderAction
  readonly detail: Record<string, unknown>
}

interface FakeProviderBehavior {
  readonly capabilities?: Partial<ProviderCapabilities>
  /** 列表内容。测试可以直接改它模拟控制台状态变化。 */
  readonly instances?: readonly ConsoleInstanceSnapshot[]
  readonly powerOn?: (instanceId: string) => Promise<PowerOnOutcome>
  readonly powerOff?: (instanceId: string) => Promise<void>
  readonly readCloneQuota?: (sourceInstanceId: string) => Promise<number>
  readonly clone?: (request: CloneRequest) => Promise<CloneOutcome>
  readonly readPriceQuote?: (instanceId: string, ttlMinutes: number) => Promise<PriceQuote>
  readonly setTimedShutdown?: (instanceId: string, shutdownAt: string) => Promise<TimedShutdownReceipt>
  readonly readBalance?: () => Promise<number>
  readonly destroy?: (instanceId: string) => Promise<TeardownOutcome>
  readonly waitUntilReady?: (instanceId: string, timeoutMs: number) => Promise<void>
  /** 某条命令的 stdout。默认空串。 */
  readonly stdoutFor?: (command: string) => string
  /** 某条命令的退出码。默认 0。 */
  readonly exitCodeFor?: (command: string) => number
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  create: true,
  powerCycle: true,
  noGpuMode: false,
  timedShutdown: true,
  accessInfo: true,
  imageSnapshot: false,
  clone: true,
}

/**
 * 假 provider。默认行为模仿控制台：
 * 开机把状态改成 running，克隆产出一台新实例（名字继承源实例），销毁把它从列表移除。
 * 用例只在需要反例时覆盖单项行为。
 */
class FakeProvider implements Provider {
  readonly id = 'fake-autodl'
  readonly capabilities: ProviderCapabilities
  readonly calls: ProviderCall[] = []
  snapshots: ConsoleInstanceSnapshot[]
  private clonedCount = 0

  constructor(
    private readonly behavior: FakeProviderBehavior,
    private readonly clock: FakeClock,
  ) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...behavior.capabilities }
    this.snapshots = [...(behavior.instances ?? [])]
  }

  actions(): ProviderAction[] {
    return this.calls.map((call) => call.action)
  }

  private record(action: ProviderAction, detail: Record<string, unknown> = {}): void {
    this.calls.push({ action, detail })
  }

  private serverNow(): string {
    return beijingIso(new Date(this.clock.now()))
  }

  async listInstances(options?: ListInstancesOptions): Promise<readonly ConsoleInstanceSnapshot[]> {
    this.record('listInstances', options === undefined ? {} : { refresh: options.refresh })
    return [...this.snapshots]
  }

  async powerOn(instanceId: string): Promise<PowerOnOutcome> {
    this.record('powerOn', { instanceId })
    if (this.behavior.powerOn !== undefined) {
      return await this.behavior.powerOn(instanceId)
    }
    this.setStatus(instanceId, 'running', '运行中')
    return { ok: true, instanceId }
  }

  async powerOff(instanceId: string): Promise<void> {
    this.record('powerOff', { instanceId })
    if (this.behavior.powerOff !== undefined) {
      await this.behavior.powerOff(instanceId)
      return
    }
    this.setStatus(instanceId, 'stopped', '已关机')
  }

  async readCloneQuota(sourceInstanceId: string): Promise<number> {
    this.record('readCloneQuota', { sourceInstanceId })
    if (this.behavior.readCloneQuota !== undefined) {
      return await this.behavior.readCloneQuota(sourceInstanceId)
    }
    return 10
  }

  async clone(request: CloneRequest): Promise<CloneOutcome> {
    this.record('clone', { request })
    if (this.behavior.clone !== undefined) {
      return await this.behavior.clone(request)
    }
    const source = this.snapshots.find((snapshot) => snapshot.instanceId === request.sourceInstanceId)
    this.clonedCount += 1
    const instanceId = `${CLONED_INSTANCE_ID}-${String(this.clonedCount)}`
    // 实测事实：克隆出来的实例名继承源实例名，不是 instanceNamePattern。
    this.snapshots = [
      ...this.snapshots,
      makeInstance({
        instanceId,
        name: source?.name ?? '',
        status: 'stopped',
        statusRaw: '已关机',
        gpuSpec: source?.gpuSpec ?? 'RTX 5090(32GB)',
      }),
    ]
    return { instanceId, sourceInstanceId: request.sourceInstanceId }
  }

  async readPriceQuote(instanceId: string, ttlMinutes: number): Promise<PriceQuote> {
    this.record('readPriceQuote', { instanceId, ttlMinutes })
    if (this.behavior.readPriceQuote !== undefined) {
      return await this.behavior.readPriceQuote(instanceId, ttlMinutes)
    }
    return {
      serverTime: this.serverNow(),
      unitPriceYuanPerHour: 1,
      estimatedCostYuan: ttlMinutes / 60,
      ttlMinutes,
      balanceYuan: 100,
    }
  }

  async clearTimedShutdown(instanceId: string): Promise<void> {
    this.record('clearTimedShutdown', { instanceId })
  }

  async setTimedShutdown(instanceId: string, shutdownAt: string): Promise<TimedShutdownReceipt> {
    this.record('setTimedShutdown', { instanceId, shutdownAt })
    if (this.behavior.setTimedShutdown !== undefined) {
      return await this.behavior.setTimedShutdown(instanceId, shutdownAt)
    }
    // 控制台只到分钟精度，回执是归一后的时刻。
    return {
      serverTime: this.serverNow(),
      shutdownAt: parseBeijingDateTimeText(formatBeijingMinute(shutdownAt)),
    }
  }

  async readBalance(): Promise<number> {
    this.record('readBalance')
    if (this.behavior.readBalance !== undefined) {
      return await this.behavior.readBalance()
    }
    return 100
  }

  async destroy(instanceId: string): Promise<TeardownOutcome> {
    this.record('destroy', { instanceId })
    if (this.behavior.destroy !== undefined) {
      return await this.behavior.destroy(instanceId)
    }
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.instanceId !== instanceId)
    return { state: 'gone' }
  }

  async waitUntilReady(instanceId: string, timeoutMs: number): Promise<void> {
    this.record('waitUntilReady', { instanceId, timeoutMs })
    if (this.behavior.waitUntilReady !== undefined) {
      await this.behavior.waitUntilReady(instanceId, timeoutMs)
    }
  }

  async exec(
    instanceId: string,
    command: string,
    options: SshExecOptions,
  ): Promise<SshExecResult> {
    this.record('exec', { instanceId, command, logPath: options.logPath })
    const stdout = this.behavior.stdoutFor?.(command) ?? ''
    const exitCode = this.behavior.exitCodeFor?.(command) ?? 0
    // 模拟真实 SSH 端口的行为：完整输出落盘，返回值只带尾部与字节数。
    await writeFile(options.logPath, stdout, 'utf8')
    return {
      exitCode,
      stdoutTail: stdout,
      stderrTail: '',
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      stderrBytes: 0,
      durationMs: 1,
      timedOut: false,
    }
  }

  private setStatus(instanceId: string, status: ConsoleInstanceSnapshot['status'], statusRaw: string): void {
    this.snapshots = this.snapshots.map((snapshot) =>
      snapshot.instanceId === instanceId ? { ...snapshot, status, statusRaw } : snapshot,
    )
  }
}

interface FixtureOptions {
  readonly profile?: Partial<Profile>
  readonly project?: Partial<Project>
  readonly planTtlMinutes?: number
  readonly planBudgetCapYuan?: number
  readonly behavior?: FakeProviderBehavior
  readonly seedUnitPriceYuanPerHour?: number
  /** 种子单价写进哪个形态槽。缺省 `gpu`。 */
  readonly seedPriceSlot?: PriceSlot
  readonly workdirLogRoot?: string
}

interface Fixture {
  readonly stateDir: string
  readonly store: StateStore
  readonly runs: RunStore
  readonly planStore: PlanStore
  readonly planService: PlanService
  readonly ledger: LedgerStore
  readonly clock: FakeClock
  readonly provider: FakeProvider
  readonly engine: RunEngine
  readonly profile: Profile
  readonly project: Project
  readonly plan: Plan
  readonly logs: LoggerRecord[]
  readRun(runId: string): Promise<Run>
  readPlan(): Promise<Plan>
  run(): Promise<RunSummary>
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'run-engine-spec-'))
  temporaryParents.push(parent)
  const stateDir = join(parent, 'state')
  const store = createStateStore({
    stateDir,
    configDir: join(parent, 'config'),
    lockTimeoutMs: 5_000,
    lockRetryIntervalMs: 5,
  })
  const runs = createRunStore(store)
  const planStore = createPlanStore(store)
  const ledger = createLedgerStore(store)
  const clock = createFakeClock(START_ISO)
  const profile = makeProfile(options.profile)
  const project = makeProject(options.project)
  const provider = new FakeProvider(options.behavior ?? {}, clock)
  const planService = createPlanService({ plans: planStore, clock })
  const plan = await planService.createPlan({
    profile,
    provider: { id: provider.id, capabilities: provider.capabilities },
    ...(options.planTtlMinutes === undefined ? {} : { ttlMinutes: options.planTtlMinutes }),
    ...(options.planBudgetCapYuan === undefined ? {} : { budgetCapYuan: options.planBudgetCapYuan }),
  })
  if (options.seedUnitPriceYuanPerHour !== undefined) {
    await recordObservedPrice(store, profile.id, options.seedPriceSlot ?? 'gpu', {
      unitPriceYuanPerHour: options.seedUnitPriceYuanPerHour,
      observedAt: START_ISO,
      gpuSpec: 'RTX 5090(32GB)',
    })
  }
  const fakeLogger = createFakeLogger()
  const engine = createRunEngine({
    provider,
    plans: planService,
    planStore,
    runs,
    ledger,
    clock,
    logger: fakeLogger.logger,
    workdirLogRoot: options.workdirLogRoot ?? join(stateDir, RUNS_DIRECTORY),
    providerLogDir: null,
  })
  return {
    stateDir,
    store,
    runs,
    planStore,
    planService,
    ledger,
    clock,
    provider,
    engine,
    profile,
    project,
    plan,
    logs: fakeLogger.events,
    readRun: async (runId) => await runs.read(runId),
    readPlan: async () => await planStore.read(plan.id),
    run: async () =>
      await engine.run({
        planId: plan.id,
        profile,
        project,
      }),
  }
}

/** 子串在文本里出现的次数。 */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/** Run 记录里 SSH 步骤的顺序。控制台动作与内置判定不参与这个断言。 */
function sshStepIds(run: Run): string[] {
  return run.steps.filter((step) => step.kind === 'ssh').map((step) => step.stepId)
}

describe('run：开机复用路径', () => {
  it('实例已关机时开机，步骤顺序为部署脚本 → 启动脚本 → 健康检查', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    const summary = await fixture.run()

    expect(fixture.provider.actions()).toContain('powerOn')
    expect(summary.mode).toBe('reuse')
    expect(summary.instanceId).toBe(INSTANCE_ID)
    expect(summary.state).toBe('succeeded')
    const run = await fixture.readRun(summary.runId)
    expect(sshStepIds(run)).toEqual([STEP_ID.healthCheck])
  })

  it('实例已运行时不开机，直接跑部署脚本 → 启动脚本 → 健康检查', async () => {
    const fixture = await createFixture({
      behavior: { instances: [makeInstance({ status: 'running', statusRaw: '运行中' })] },
    })

    const summary = await fixture.run()

    expect(fixture.provider.actions()).not.toContain('powerOn')
    expect(summary.mode).toBe('reuse')
    const run = await fixture.readRun(summary.runId)
    expect(sshStepIds(run)).toEqual([STEP_ID.healthCheck])
  })

  it('开机失败（无可用 GPU）时自动走克隆，只跑启动脚本与健康检查', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        powerOn: async () => ({ ok: false, reason: 'no-gpu', detail: '主机无可用 GPU' }),
      },
    })

    const summary = await fixture.run()

    expect(fixture.provider.actions()).toContain('powerOn')
    expect(fixture.provider.actions()).toContain('clone')
    expect(summary.mode).toBe('clone')
    const cloneCall = fixture.provider.calls.find((call) => call.action === 'clone')
    expect((cloneCall?.detail['request'] as CloneRequest).sourceInstanceId).toBe(INSTANCE_ID)
    const run = await fixture.readRun(summary.runId)
    expect(sshStepIds(run)).toEqual([STEP_ID.healthCheck])
  })
})

describe('run：克隆路径', () => {
  it('没有同名实例时按部署配置的克隆源克隆，只跑启动脚本与健康检查', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
      },
    })

    const summary = await fixture.run()

    expect(summary.mode).toBe('clone')
    expect(fixture.provider.actions()).not.toContain('powerOn')
    expect(fixture.provider.actions()).toContain('readCloneQuota')
    const cloneCall = fixture.provider.calls.find((call) => call.action === 'clone')
    expect((cloneCall?.detail['request'] as CloneRequest).sourceInstanceId).toBe(CLONE_SOURCE_ID)
    const run = await fixture.readRun(summary.runId)
    expect(sshStepIds(run)).toEqual([STEP_ID.healthCheck])
    // 克隆产物要绑定到计划上：下一次执行靠 plan.instanceId 命中「已绑定实例」那条。
    expect((await fixture.readPlan()).instanceId).toBe(summary.instanceId)
  })

  it('cloneDataDisk 只决定克隆参数，不改变步骤序列：克隆路径都只跑启动脚本与健康检查', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template', cloneDataDisk: false },
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
      },
    })

    const summary = await fixture.run()

    expect(summary.mode).toBe('clone')
    const cloneCall = fixture.provider.calls.find((call) => call.action === 'clone')
    expect((cloneCall?.detail['request'] as CloneRequest).cloneDataDisk).toBe(false)
    const run = await fixture.readRun(summary.runId)
    expect(sshStepIds(run)).toEqual([STEP_ID.healthCheck])
  })

  it('克隆源未关机时先关机再克隆', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [
          makeInstance({
            instanceId: CLONE_SOURCE_ID,
            name: 'trans-template',
            status: 'running',
            statusRaw: '运行中',
          }),
        ],
      },
    })

    await fixture.run()

    const actions = fixture.provider.actions()
    expect(actions.indexOf('powerOff')).toBeGreaterThanOrEqual(0)
    expect(actions.indexOf('powerOff')).toBeLessThan(actions.indexOf('clone'))
  })

  it('克隆配额为 0 时抛 CloneQuotaExhaustedError，不尝试克隆', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
        readCloneQuota: async () => 0,
      },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(CloneQuotaExhaustedError)
    expect(fixture.provider.actions()).not.toContain('clone')
    // 配额判据先于任何实例状态改动（spec 第 7.3 节）：源实例不关机。
    expect(fixture.provider.actions()).not.toContain('powerOff')
  })

  it('源实例未关机且配额为 0：先失败，不关源实例', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [
          makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template', status: 'running', statusRaw: '运行中' }),
        ],
        readCloneQuota: async () => 0,
      },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(CloneQuotaExhaustedError)
    expect(fixture.provider.actions()).not.toContain('powerOff')
    expect(fixture.provider.actions()).not.toContain('clone')
  })

  it('克隆超时时 Run 记 stray、计划记 escalated：钱可能还在烧', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
        clone: async () => {
          throw new CloneTimeoutError('克隆 30 分钟未完成')
        },
      },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(CloneTimeoutError)
    const plan = await fixture.readPlan()
    expect(plan.state).toBe('escalated')
    const runsDirectory = await fixture.store.resolve(RUNS_DIRECTORY)
    const runFiles = await readRunRecords(runsDirectory)
    expect(runFiles).toHaveLength(1)
    expect(runFiles[0]?.state).toBe('stray')
  })

  it('克隆已受理但报错时接管实例：绑定到计划、落 stray，不丢实例 ID', async () => {
    // Arrange：平台已创建实例并把它放进列表，随后抛 StrayInstanceError（缺口 8.1）。
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
        clone: async (request) => {
          fixture.provider.snapshots = [
            ...fixture.provider.snapshots,
            // 被接管的实例带真实快照：规格要能进账本。
            { ...makeInstance({ instanceId: 'stray-0001', name: '' }), gpuSpec: 'RTX 5090(32GB)' },
          ]
          throw new StrayInstanceError(new ConsoleParseError('新实例行读数解析失败'), {
            instanceId: 'stray-0001',
            snapshot: { ...makeInstance({ instanceId: 'stray-0001', name: '' }) },
          })
        },
      },
    })

    // Act
    const error = (await fixture.run().catch((caught: unknown) => caught)) as Error

    // Assert：实例 ID 不丢，计划绑上它，Run 记 stray，账本记这一笔。
    expect(error).toBeInstanceOf(StrayInstanceError)
    expect(error.message).toContain('stray-0001')
    expect(error.message).toContain('已接管实例 stray-0001')
    const plan = await fixture.readPlan()
    expect(plan.instanceId).toBe('stray-0001')
    expect(plan.state).toBe('escalated')
    expect((await onlyRunRecord(fixture)).state).toBe('stray')
    // 单价还没读到，账本不写：金额编不出来，交 teardown 封口。
    await expect(fixture.ledger.readAll()).rejects.toBeInstanceOf(StateFileMissingError)
    expect(fixture.provider.actions()).not.toContain('destroy')
  })

  it('没接管到实例但克隆已受理：Run 记 stray、计划 escalated，报错写明钱可能还在烧', async () => {
    // 判据：`CLONE_RESULT_UNKNOWN` 但拿不到实例 ID（例如回读也读不到）时，
    // 仍是「平台已扣配额、实例可能已建出来」，必须按 stray 收尾而不是 failed。
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
        clone: async () => {
          throw new StrayInstanceError(new ConsoleParseError('读数解析失败且回读也没找到新实例'), {
            instanceId: '',
            snapshot: null,
          })
        },
      },
    })

    const error = (await fixture.run().catch((caught: unknown) => caught)) as Error

    expect(error).toBeInstanceOf(StrayInstanceError)
    const run = await onlyRunRecord(fixture)
    expect(run.state).toBe('stray')
    expect((await fixture.readPlan()).state).toBe('escalated')
    expect(error.message).toContain('钱可能还在烧')
    expect(fixture.provider.actions()).not.toContain('destroy')
  })

  it('克隆返回的实例在列表里读不到时记 stray 与 escalated：实例状态未知', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
        // 克隆回执给了 ID，但列表里没有这条记录：既不能当失败（容器可能真存在），也不能继续。
        clone: async (request) => ({ instanceId: 'ghost-instance', sourceInstanceId: request.sourceInstanceId }),
      },
    })

    await expect(fixture.run()).rejects.toThrow(/ghost-instance/)
    const run = await onlyRunRecord(fixture)
    expect(run.state).toBe('stray')
    expect((await fixture.readPlan()).state).toBe('escalated')
  })
})

describe('run：取实例判定表的失败', () => {
  it('同名实例处于 cloning 时抛错，且不点任何东西', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance({ status: 'cloning', statusRaw: '克隆锁定中' })],
      },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(HumanRequiredError)
    expect(fixture.provider.actions()).toEqual(['listInstances'])
  })

  it('同名实例多于一台时抛错并列出实例 ID，不猜哪一台', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [
          makeInstance(),
          makeInstance({ instanceId: 'second-000000', name: 'trans-dev' }),
        ],
      },
    })

    const error = await fixture.run().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AmbiguousInstanceNameError)
    expect((error as Error).message).toContain('second-000000')
    expect(fixture.provider.actions()).toEqual(['listInstances'])
  })

  it('没有同名实例且配置没写克隆源时抛错，并列出已关机的实例供人挑', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'other-machine' })],
      },
    })

    const error = await fixture.run().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CloneSourceMissingError)
    expect((error as Error).message).toContain('cloneSourceInstanceName')
    expect((error as Error).message).toContain(CLONE_SOURCE_ID)
    expect(fixture.provider.actions()).toEqual(['listInstances'])
  })

  it('克隆源在列表里命中不到时抛 CloneSourceMissingError', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'ghost-template' },
      behavior: { instances: [] },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(CloneSourceMissingError)
    expect(fixture.provider.actions()).toEqual(['listInstances'])
  })
})

describe('run：前置校验零动作', () => {
  it('计划不存在时抛 PlanInvalidError，零控制台动作', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    await expect(
      fixture.engine.run({
        planId: 'plan-missing',
        profile: fixture.profile,
        project: fixture.project,
      }),
    ).rejects.toBeInstanceOf(PlanInvalidError)
    expect(fixture.provider.actions()).toEqual([])
  })

  it('计划剩余时长不足 5 分钟时抛错，零动作且不设定时关机', async () => {
    const fixture = await createFixture({
      planTtlMinutes: 5,
      behavior: { instances: [makeInstance()] },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(PlanInvalidError)
    expect(fixture.provider.actions()).toEqual([])
    expect((await fixture.readPlan()).instanceId).toBeNull()
  })
})

describe('run：失败分叉', () => {
  it('健康检查失败时 Run 为 stray、计划转待结算，实例停机保留且不销毁', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })

    const error = await fixture.run().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HealthCheckFailedError)
    // 判据：自动判定失败只停机，不销毁。销毁入口只剩 teardown。
    expect(fixture.provider.actions()).not.toContain('destroy')
    expect(fixture.provider.actions()).toContain('powerOff')
    expect(instanceStatusIn(fixture)).toBe('stopped')
    const run = await onlyRunRecord(fixture)
    expect(run.state).toBe('stray')
    expect(sshStepIds(run)).toEqual([STEP_ID.healthCheck])
    // 判据（M2）：停机成功 = 钱停了。计划状态必须说「已停机、待结算」，
    // 不能说 escalated —— 那个状态的含义是「实例未确认消失，钱可能还在烧」。
    expect((await fixture.readPlan()).state).toBe('stopped-pending-settlement')
    expect((await fixture.readPlan()).instanceId).toBe(INSTANCE_ID)
    // 账本封口判据 = 实例不再运行，与「停机是否成功」无关：这里停机成功了，应当封口。
    expect(await fixture.ledger.readAll()).toHaveLength(1)
  })

  it('停机失败时不封口账本：实例可能还在跑，等 teardown 按实际停机时刻封口', async () => {
    // 判据：实例仍在运行时写账，后续继续烧的钱就进不了这一行。
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
        powerOff: async () => {
          throw new Error('控制台关机按钮没响应')
        },
      },
    })

    await fixture.run().catch(() => undefined)

    await expect(fixture.ledger.readAll()).rejects.toBeInstanceOf(StateFileMissingError)
    const run = await onlyRunRecord(fixture)
    expect(run.state).toBe('stray')
    expect((await fixture.readPlan()).state).toBe('escalated')
  })

  it('同样的失败，停机成功与停机失败落到两个不同的计划状态', async () => {
    // 判据（M2）：两个状态必须能被人一眼分开 ——
    // 一个说「钱停了、只差结账」，一个说「钱可能还在烧」。
    const stopped = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })
    const powerOffFailed = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
        powerOff: async () => {
          throw new Error('控制台关机按钮没响应')
        },
      },
    })

    await stopped.run().catch(() => undefined)
    await powerOffFailed.run().catch(() => undefined)

    expect((await stopped.readPlan()).state).toBe('stopped-pending-settlement')
    expect((await powerOffFailed.readPlan()).state).toBe('escalated')
    // 报错文案也要跟着分叉：读到 escalated 的人会想到「先关机」，读到待结算的人只想到「去结账」。
    const stoppedPlanText = stopped.logs.find((event) => event.event === 'run.stray')
    expect(stoppedPlanText?.fields?.['instanceStopped']).toBe(true)
  })

  it('停机成功的报错写明计划转待结算，且只出现一次现场指引', async () => {
    // 判据（S2）：现场指引只能出现一次。两处都拼会让人以为有两台机器要看。
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })

    const error = (await fixture.run().catch((caught: unknown) => caught)) as Error

    expect(error.message).toContain('转 stopped-pending-settlement')
    expect(error.message).not.toContain('转 escalated')
    expect(countOccurrences(error.message, '进容器查现场')).toBe(1)
  })

  it('停机失败会经 abortForMoneySafety 时，报错里的现场指引也只出现一次', async () => {
    // 判据（S2）：`abortForMoneySafety` 停机失败分支抛 HumanRequiredError，
    // 外层 finishWithFailure 还会追加一次 hint。两处都拼就重复了。
    const fixture = await createFixture({
      seedUnitPriceYuanPerHour: 1,
      behavior: {
        instances: [makeInstance()],
        readPriceQuote: async (_instanceId, ttlMinutes) => ({
          serverTime: START_ISO,
          unitPriceYuanPerHour: 1 + PRICE_DRIFT_THRESHOLD_RATIO * 2,
          estimatedCostYuan: 1,
          ttlMinutes,
          balanceYuan: 100,
        }),
        powerOff: async () => {
          throw new Error('控制台关机按钮没响应')
        },
      },
    })

    const error = (await fixture.run().catch((caught: unknown) => caught)) as Error

    expect(error).toBeInstanceOf(HumanRequiredError)
    expect(countOccurrences(error.message, '进容器查现场')).toBe(1)
    expect((await fixture.readPlan()).state).toBe('escalated')
  })

  it('健康检查失败且 destroy-container：仍不销毁，只停机保留', async () => {
    const fixture = await createFixture({
      profile: { onDeployFailure: 'destroy-container' },
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })

    const error = await fixture.run().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HealthCheckFailedError)
    // 判据：onDeployFailure 不再引起自动销毁，实例留在列表里。
    expect(fixture.provider.actions()).not.toContain('destroy')
    expect(instanceStatusIn(fixture)).toBe('stopped')
    const run = await onlyRunRecord(fixture)
    expect(run.state).toBe('stray')
    expect(sshStepIds(run)).toEqual([STEP_ID.healthCheck])
    expect((error as Error).message).toContain('teardown')
  })

  it('停机失败也保留实例：原错误照旧抛，报错写明实例可能仍在运行与处置办法', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
        powerOff: async () => {
          throw new Error('控制台关机按钮没响应')
        },
      },
    })

    const error = (await fixture.run().catch((caught: unknown) => caught)) as Error

    // 判据：停机失败不改变分类，原错误照旧抛；处置办法与「实例仍在」写进同一条消息。
    expect(error).toBeInstanceOf(HealthCheckFailedError)
    expect(fixture.provider.actions()).not.toContain('destroy')
    expect(instanceStatusIn(fixture)).not.toBe('stopped')
    expect(error.message).toContain('停机失败（Error：控制台关机按钮没响应）')
    expect(error.message).toContain('已保留且可能仍在运行计费')
    // 文案不能说「已停机」：实例可能还在跑，这句会把人送错方向。
    expect(error.message).not.toContain('已停机并保留')
    expect(error.message).toContain('本次未写账本行')
    expect(error.message).toContain('teardown')
    const run = await onlyRunRecord(fixture)
    expect(run.state).toBe('stray')
    expect((await fixture.readPlan()).state).toBe('escalated')
  })
})

describe('run：金钱止损', () => {
  it('预算超限时停机保留并抛 BudgetExceededError，实例仍在列表里', async () => {
    const fixture = await createFixture({
      planBudgetCapYuan: 0.5,
      behavior: { instances: [makeInstance()] },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(BudgetExceededError)
    // 判据：预算超限只停机，不销毁。
    expect(fixture.provider.actions()).not.toContain('destroy')
    expect(fixture.provider.actions()).toContain('powerOff')
    expect(instanceStatusIn(fixture)).toBe('stopped')
    expect((await onlyRunRecord(fixture)).state).toBe('stray')
    expect((await fixture.readPlan()).state).toBe('stopped-pending-settlement')
  })

  it('预算超限只停机一次：预算复核自己不停机，停机只发生在失败收尾', async () => {
    // 判据（S1）：停机若有两处，账本封口判据就得同时看两处。这里锁死只有一处。
    const fixture = await createFixture({
      planBudgetCapYuan: 0.5,
      behavior: { instances: [makeInstance()] },
    })

    await fixture.run().catch(() => undefined)

    const powerOffCalls = fixture.provider.calls.filter((call) => call.action === 'powerOff')
    expect(powerOffCalls).toHaveLength(1)
    // 停机成功就该封口，且只封一行。
    expect(await fixture.ledger.readAll()).toHaveLength(1)
  })

  it('预算超限停机失败时计划转 escalated，不写账本', async () => {
    // 判据（M2 的另一半）：停机失败 = 钱可能还在烧，与停机成功必须落到不同状态。
    const fixture = await createFixture({
      planBudgetCapYuan: 0.5,
      behavior: {
        instances: [makeInstance()],
        powerOff: async () => {
          throw new Error('控制台关机按钮没响应')
        },
      },
    })

    await fixture.run().catch(() => undefined)

    expect((await onlyRunRecord(fixture)).state).toBe('stray')
    expect((await fixture.readPlan()).state).toBe('escalated')
    await expect(fixture.ledger.readAll()).rejects.toBeInstanceOf(StateFileMissingError)
  })

  it('单价漂移超过阈值时停机保留并抛 HumanRequiredError，缓存不被新价覆盖', async () => {
    const fixture = await createFixture({
      seedUnitPriceYuanPerHour: 1,
      behavior: {
        instances: [makeInstance()],
        // 假时钟没有前进，服务器时间就是执行开始时刻。
        readPriceQuote: async (_instanceId, ttlMinutes) => ({
          serverTime: START_ISO,
          unitPriceYuanPerHour: 1 + PRICE_DRIFT_THRESHOLD_RATIO * 2,
          estimatedCostYuan: 1,
          ttlMinutes,
          balanceYuan: 100,
        }),
      },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(HumanRequiredError)
    expect(fixture.provider.actions()).not.toContain('destroy')
    expect(instanceStatusIn(fixture)).toBe('stopped')
    expect((await onlyRunRecord(fixture)).state).toBe('stray')
    const cached = await readObservedPrice(fixture.store, fixture.profile.id, 'gpu')
    expect(cached?.unitPriceYuanPerHour).toBe(1)
  })

  it('余额不足以支撑预计花费时停机保留并抛 BalanceInsufficientError', async () => {
    const fixture = await createFixture({
      planBudgetCapYuan: 100,
      behavior: {
        instances: [makeInstance()],
        readPriceQuote: async (_instanceId, ttlMinutes) => ({
          serverTime: START_ISO,
          unitPriceYuanPerHour: 1,
          estimatedCostYuan: 1,
          ttlMinutes,
          balanceYuan: 0.1,
        }),
      },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(BalanceInsufficientError)
    expect(fixture.provider.actions()).not.toContain('destroy')
    expect(fixture.provider.actions()).toContain('powerOff')
    expect(instanceStatusIn(fixture)).toBe('stopped')
  })
})

describe('run：单价缓存按开机形态分槽', () => {
  it('无卡形态开机时读到有卡单价也不算漂移：两种形态各比各的槽', async () => {
    // Arrange：上次有卡开机观测到 2.87 元/时，本次无卡开机报价 0.0973 元/时。
    const fixture = await createFixture({
      profile: { powerOnMode: 'no-gpu' },
      seedUnitPriceYuanPerHour: 2.87,
      seedPriceSlot: 'gpu',
      behavior: {
        instances: [makeInstance()],
        readPriceQuote: async (_instanceId, ttlMinutes) => ({
          serverTime: START_ISO,
          unitPriceYuanPerHour: 0.0973,
          estimatedCostYuan: 0.1,
          ttlMinutes,
          balanceYuan: 100,
        }),
      },
    })

    // Act
    const summary = await fixture.run()

    // Assert：无卡槽里还没有观测，不构成漂移；本次观测写进无卡槽，不动有卡槽。
    expect(summary.state).toBe('succeeded')
    const noGpuCached = await readObservedPrice(fixture.store, fixture.profile.id, 'no-gpu')
    expect(noGpuCached?.unitPriceYuanPerHour).toBe(0.0973)
    const gpuCached = await readObservedPrice(fixture.store, fixture.profile.id, 'gpu')
    expect(gpuCached?.unitPriceYuanPerHour).toBe(2.87)
  })

  it('实例列表的实测形态优先：配置写 gpu 但实例标着无卡时按无卡槽比较', async () => {
    // Arrange：有卡槽里是 2.87，无卡槽里是 0.0973；实例列表给出实测无卡形态。
    const fixture = await createFixture({
      seedUnitPriceYuanPerHour: 0.0973,
      seedPriceSlot: 'no-gpu',
      behavior: {
        instances: [makeInstance({ noGpuMode: true })],
        readPriceQuote: async (_instanceId, ttlMinutes) => ({
          serverTime: START_ISO,
          unitPriceYuanPerHour: 0.0973,
          estimatedCostYuan: 0.1,
          ttlMinutes,
          balanceYuan: 100,
        }),
      },
    })
    await recordObservedPrice(fixture.store, fixture.profile.id, 'gpu', {
      unitPriceYuanPerHour: 2.87,
      observedAt: START_ISO,
      gpuSpec: 'RTX 5090(32GB)',
    })

    // Act
    const summary = await fixture.run()

    // Assert
    expect(summary.state).toBe('succeeded')
  })

  it('旧版缓存 prices/<profileId>.jsonc 按缺省形态迁移，不被当成无卡形态的对照', async () => {
    // Arrange：旧文件里是有卡价 2.87。
    const fixture = await createFixture({
      profile: { powerOnMode: 'no-gpu' },
      behavior: {
        instances: [makeInstance()],
        readPriceQuote: async (_instanceId, ttlMinutes) => ({
          serverTime: START_ISO,
          unitPriceYuanPerHour: 0.0973,
          estimatedCostYuan: 0.1,
          ttlMinutes,
          balanceYuan: 100,
        }),
      },
    })
    await fixture.store.writeJson('prices/trans-dev.jsonc', {
      unitPriceYuanPerHour: 2.87,
      observedAt: START_ISO,
      gpuSpec: 'RTX 5090(32GB)',
    })

    // Act
    const summary = await fixture.run()

    // Assert：旧文件只进有卡槽，无卡开机不拿有卡价做对照。
    expect(summary.state).toBe('succeeded')
    const gpuCached = await readObservedPrice(fixture.store, fixture.profile.id, 'gpu')
    expect(gpuCached?.unitPriceYuanPerHour).toBe(2.87)
    const noGpuCached = await readObservedPrice(fixture.store, fixture.profile.id, 'no-gpu')
    expect(noGpuCached?.unitPriceYuanPerHour).toBe(0.0973)
  })
})

describe('run：定时关机与日志', () => {
  it('读完单价才发现计划窗口不足时停机保留，Run 记 stray、计划转待结算并记账', async () => {
    // 本机时钟与控制台服务器时间不一致：本机以为还剩 60 分钟，控制台已经只剩 4 分钟。
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        readPriceQuote: async (_instanceId, ttlMinutes) => ({
          serverTime: '2026-01-01T00:56:00+08:00',
          unitPriceYuanPerHour: 1,
          estimatedCostYuan: 1,
          ttlMinutes,
          balanceYuan: 100,
        }),
      },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(PlanInvalidError)
    // 判据：只停机，不销毁。
    expect(fixture.provider.actions()).not.toContain('destroy')
    expect(fixture.provider.actions()).toContain('powerOff')
    expect(instanceStatusIn(fixture)).toBe('stopped')
    expect(fixture.provider.actions()).not.toContain('setTimedShutdown')
    expect((await onlyRunRecord(fixture)).state).toBe('stray')
    expect((await fixture.readPlan()).state).toBe('stopped-pending-settlement')
    expect(await fixture.ledger.readAll()).toHaveLength(1)
  })

  it('设置的定时关机时刻等于 computeTimedShutdownAt(plan)', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    const summary = await fixture.run()

    const expected = computeTimedShutdownAt(fixture.plan)
    const call = fixture.provider.calls.find((candidate) => candidate.action === 'setTimedShutdown')
    expect(call?.detail['shutdownAt']).toBe(expected)
    expect(summary.timedShutdownAt).toBe(expected)
  })

  it('每步日志文件真的落盘，路径与 StepResult.logPath 一致，stdoutBytes 与写入字节一致', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        stdoutFor: (command) => `output of ${command}\n第二行\n`,
      },
    })

    const summary = await fixture.run()

    const run = await fixture.readRun(summary.runId)
    const expectedLogDirectory = join(fixture.stateDir, RUNS_DIRECTORY, summary.runId, 'logs')
    const sshSteps = run.steps.filter((step) => step.kind === 'ssh')
    expect(sshSteps).toHaveLength(1)
    for (const step of sshSteps) {
      expect(step.logPath).toBe(join(expectedLogDirectory, `${step.stepId}.log`))
      const written = await readFile(step.logPath, 'utf8')
      expect(written).toBe(`output of ${step.command}\n第二行\n`)
      expect(step.stdoutBytes).toBe(Buffer.byteLength(written, 'utf8'))
    }
  })

  it('控制台动作与内置判定也各有一份日志文件，Run 记录里能读到每步命令与退出码', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    const summary = await fixture.run()

    const run = await fixture.readRun(summary.runId)
    expect(run.steps.length).toBeGreaterThan(3)
    const expectedLogDirectory = join(fixture.stateDir, RUNS_DIRECTORY, summary.runId, 'logs')
    for (const step of run.steps) {
      expect(step.command.length).toBeGreaterThan(0)
      expect(step.exitCode).toBe(0)
      expect(step.logPath).toBe(join(expectedLogDirectory, `${step.stepId}.log`))
    }
    // SSH 步骤的日志是命令完整输出（由 SSH 通道写）。控制台动作与内置判定没有 stdout，
    // 日志由引擎写：开始与结束各一行，进程中途被杀也能读到「这一步本来要做什么」。
    const engineSteps = run.steps.filter((step) => step.kind !== 'ssh')
    expect(engineSteps.length).toBeGreaterThan(0)
    for (const step of engineSteps) {
      const written = await readFile(step.logPath, 'utf8')
      expect(written).toContain('step.start')
      expect(written).toContain(step.command)
    }
  })

  it('成功路径不写账本：实例仍在运行，账要等后续 teardown 或计划过期', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    await fixture.run()

    await expect(fixture.ledger.readAll()).rejects.toBeInstanceOf(StateFileMissingError)
  })

  it('失败停机保留时写一行账本，金额按单价与停机时刻算', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })

    await fixture.run().catch(() => undefined)

    const entries: readonly LedgerEntry[] = await fixture.ledger.readAll()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.instanceId).toBe(INSTANCE_ID)
    expect(entries[0]?.planId).toBe(fixture.plan.id)
    expect(entries[0]?.gpuSpec).toBe('RTX 5090(32GB)')
  })

  it('失败停机保留后把金额记回计划 spentYuan，下一次预算复核能看到这笔钱', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })
    // 让停机时刻比取得实例晚 30 分钟：假时钟不前进时金额恒为 0，看不出投影有没有发生。
    // 生产语义上重复关一台已关机的实例是幂等操作，这里照同一语义覆盖停机行为。
    fixture.provider.powerOff = async (instanceId) => {
      fixture.clock.advanceMinutes(30)
      fixture.provider.snapshots = fixture.provider.snapshots.map((snapshot) =>
        snapshot.instanceId === instanceId ? { ...snapshot, status: 'stopped' } : snapshot,
      )
    }

    await fixture.run().catch(() => undefined)

    const plan = await fixture.readPlan()
    // 单价 1 元/时 × 30 分钟 = 0.5 元。
    expect(plan.spentYuan).toBeCloseTo(0.5, 10)
  })
})

describe('run：provider 能力判据', () => {
  it('clone=false 时拒绝克隆路径，零动作', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        capabilities: { clone: false },
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
      },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(ConfigError)
    expect(fixture.provider.actions()).toEqual(['listInstances'])
  })

  it('powerCycle=false 时拒绝开机路径，零动作', async () => {
    const fixture = await createFixture({
      behavior: { capabilities: { powerCycle: false }, instances: [makeInstance()] },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(ConfigError)
    expect(fixture.provider.actions()).toEqual(['listInstances'])
  })

  it('accessInfo=false 时拒绝继续：SSH 是唯一数据面', async () => {
    const fixture = await createFixture({
      behavior: { capabilities: { accessInfo: false }, instances: [makeInstance()] },
    })

    await expect(fixture.run()).rejects.toBeInstanceOf(ConfigError)
    expect(fixture.provider.actions()).toEqual(['listInstances'])
  })
})

describe('run：失败报错的现场信息', () => {
  it('keep-container 的 stray 报错给出 workdir、SSH 登录方式与本机 run 目录', async () => {
    const fixture = await createFixture({
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })

    const error = (await fixture.run().catch((caught: unknown) => caught)) as Error
    const run = await onlyRunRecord(fixture)

    expect(error.message).toContain('/root/trans_app')
    expect(error.message).toContain('SSH 登录列')
    expect(error.message).toContain(run.logDir)
    expect(error.message).toContain('deploydeck guard')
    expect(error.message).toContain('deploydeck teardown')
  })

  it('destroy-container 也不再销毁：stray 报错给出本机 run 目录', async () => {
    const fixture = await createFixture({
      profile: { onDeployFailure: 'destroy-container' },
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })

    const error = (await fixture.run().catch((caught: unknown) => caught)) as Error
    const run = await onlyRunRecord(fixture)

    expect(error.message).toContain(run.logDir)
    expect(run.state).toBe('stray')
    expect(fixture.provider.actions()).not.toContain('destroy')
  })

  it('取实例失败（克隆超时）的 stray 报错给出现场信息', async () => {
    const fixture = await createFixture({
      profile: { cloneSourceInstanceName: 'trans-template' },
      behavior: {
        instances: [makeInstance({ instanceId: CLONE_SOURCE_ID, name: 'trans-template' })],
        clone: async () => {
          throw new CloneTimeoutError('克隆 30 分钟未完成')
        },
      },
    })

    const error = (await fixture.run().catch((caught: unknown) => caught)) as Error
    const run = await onlyRunRecord(fixture)

    expect(error.message).toContain(run.logDir)
    expect(error.message).toContain('控制台实例列表')
  })
})

describe('run：账本投影失败', () => {
  it('账本已写但计划金额回写失败时抛 HumanRequiredError，并保留原始错误链', async () => {
    // Arrange：计划存储的 recordSpent 失败，模拟投影写不进去。
    const fixture = await createFixture({
      profile: { onDeployFailure: 'destroy-container' },
      behavior: {
        instances: [makeInstance()],
        exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
      },
    })
    const brokenPlanStore: PlanStore = {
      ...fixture.planStore,
      recordSpent: async () => {
        throw new Error('写计划文件失败')
      },
    }
    const brokenEngine = createRunEngine({
      provider: fixture.provider,
      plans: fixture.planService,
      planStore: brokenPlanStore,
      runs: fixture.runs,
      ledger: fixture.ledger,
      clock: fixture.clock,
      logger: createFakeLogger().logger,
      workdirLogRoot: join(fixture.stateDir, RUNS_DIRECTORY),
      providerLogDir: null,
    })

    // Act
    const error = (await brokenEngine
      .run({
        planId: fixture.plan.id,
        profile: fixture.profile,
        project: fixture.project,
      })
      .catch((caught: unknown) => caught)) as HumanRequiredError

    // Assert：账本行仍在（事实），计划金额没回写，错误链保留原始原因。
    expect(error).toBeInstanceOf(HumanRequiredError)
    expect(error.message).toContain('账已记上但计划金额没回写')
    expect((error.cause as Error).message).toContain('写计划文件失败')
    expect(await fixture.ledger.readAll()).toHaveLength(1)
  })
})

describe('run：装配自检', () => {
  it('workdirLogRoot 与状态存储的 runs 根不一致时抛 ConfigError', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })
    const brokenEngine = createRunEngine({
      provider: fixture.provider,
      plans: fixture.planService,
      planStore: fixture.planStore,
      runs: fixture.runs,
      ledger: fixture.ledger,
      clock: fixture.clock,
      logger: createFakeLogger().logger,
      workdirLogRoot: join(fixture.stateDir, 'another-runs-root'),
      providerLogDir: null,
    })

    await expect(
      brokenEngine.run({
        planId: fixture.plan.id,
        profile: fixture.profile,
        project: fixture.project,
      }),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  it('workdirLogRoot 是相对路径时构造即抛 ConfigError', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    expect(() =>
      createRunEngine({
        provider: fixture.provider,
        plans: fixture.planService,
        planStore: fixture.planStore,
        runs: fixture.runs,
        ledger: fixture.ledger,
        clock: fixture.clock,
        logger: createFakeLogger().logger,
        workdirLogRoot: 'relative/runs',
        providerLogDir: null,
      }),
    ).toThrow(ConfigError)
  })

  it('SSH 就绪等待使用明确的超时常量', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    await fixture.run()

    const call = fixture.provider.calls.find((candidate) => candidate.action === 'waitUntilReady')
    expect(call?.detail['timeoutMs']).toBe(SSH_READY_TIMEOUT_MS)
  })

  it('请求给出 runId 时用它，执行记录落在这份 id 下', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    const summary = await fixture.engine.run({
      planId: fixture.plan.id,
      profile: fixture.profile,
      project: fixture.project,
      runId: 'run-fixed-001',
    })

    expect(summary.runId).toBe('run-fixed-001')
    expect((await fixture.readRun('run-fixed-001')).id).toBe('run-fixed-001')
  })

  it('providerLogDir 不在 runs 根内时构造即抛 ConfigError', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })

    expect(() =>
      createRunEngine({
        provider: fixture.provider,
        plans: fixture.planService,
        planStore: fixture.planStore,
        runs: fixture.runs,
        ledger: fixture.ledger,
        clock: fixture.clock,
        logger: createFakeLogger().logger,
        workdirLogRoot: join(fixture.stateDir, RUNS_DIRECTORY),
        providerLogDir: join(fixture.stateDir, 'elsewhere'),
      }),
    ).toThrow(ConfigError)
  })

  it('providerLogDir 不在本次执行目录内时抛 ConfigError，且零控制台动作', async () => {
    const fixture = await createFixture({ behavior: { instances: [makeInstance()] } })
    const brokenEngine = createRunEngine({
      provider: fixture.provider,
      plans: fixture.planService,
      planStore: fixture.planStore,
      runs: fixture.runs,
      ledger: fixture.ledger,
      clock: fixture.clock,
      logger: createFakeLogger().logger,
      workdirLogRoot: join(fixture.stateDir, RUNS_DIRECTORY),
      providerLogDir: join(fixture.stateDir, RUNS_DIRECTORY, 'another-run'),
    })

    await expect(
      brokenEngine.run({
        planId: fixture.plan.id,
        profile: fixture.profile,
        project: fixture.project,
        runId: 'run-fixed-002',
      }),
    ).rejects.toBeInstanceOf(ConfigError)
    expect(fixture.provider.actions()).toEqual([])
  })
})

/** 读 runs 目录下的全部 Run 记录。用例要断言「写了哪些记录」，不依赖具体的 runId。 */
async function readRunRecords(runsDirectory: string): Promise<Run[]> {
  const fileNames = (await readdir(runsDirectory)).filter((name) => name.endsWith('.jsonc'))
  const records: Run[] = []
  for (const fileName of fileNames) {
    const text = await readFile(join(runsDirectory, fileName), 'utf8')
    records.push(JSON.parse(text) as Run)
  }
  return records
}

/** 列表里该实例的当前状态。用例用它断言「实例仍在」。 */
function instanceStatusIn(fixture: Fixture): string | undefined {
  return fixture.provider.snapshots.find((snapshot) => snapshot.instanceId === INSTANCE_ID)?.status
}

async function onlyRunRecord(fixture: Fixture): Promise<Run> {
  const runsDirectory = await fixture.store.resolve(RUNS_DIRECTORY)
  const records = await readRunRecords(runsDirectory)
  expect(records).toHaveLength(1)
  const record = records[0]
  if (record === undefined) {
    throw new Error('没有找到 Run 记录。')
  }
  return record
}
