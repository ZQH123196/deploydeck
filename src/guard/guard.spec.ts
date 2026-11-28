import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloneOutcome, CloneRequest, PriceQuote, TeardownOutcome, TimedShutdownReceipt } from '../console/ports.js'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import type { Plan } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import { ConfigError, HumanRequiredError } from '../errors.js'
import { RUNS_DIRECTORY, createRunStore, type RunStore } from '../engine/run-store.js'
import { runGuardLoop, runGuardRound, type GuardDependencies } from './guard.js'
import type { Logger, LogLevel } from '../logging/logger.js'
import { createPlanStore, type PlanStore } from '../plan/plan-store.js'
import type { Provider } from '../providers/provider.js'
import type { SshExecOptions, SshExecResult } from '../ssh/ports.js'
import { createLedgerStore, type LedgerStore } from '../state/ledger-store.js'
import type { LedgerEntry } from '../state/ledger.js'
import { createStateStore } from '../state/store.js'
import type { StateStore } from '../state/ports.js'
import type { Clock } from '../util/clock.js'
import { beijingIso } from '../util/time.js'

/**
 * 计划层守护的验收用例。
 *
 * 外部行为全部用手写假 provider：不连浏览器、不连 SSH、不连真实控制台。
 * 状态目录用 `.tmp/` 下的真实临时目录，时钟用假时钟。
 */

const START_ISO = '2026-01-01T00:00:00+08:00'
const INSTANCE_ID = 'af9c49bd44-8ee624d7'
const BALANCE_WARN_BELOW_YUAN = 20

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
  return { events, logger: { info: record('info'), warn: record('warn'), error: record('error') } }
}

function makeProfile(): Profile {
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
  }
}

function makeInstance(): ConsoleInstanceSnapshot {
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
  }
}

/** 假 provider。守护只用到 destroy 与 readBalance，其余方法一律报错以免误用。 */
class FakeGuardProvider implements Provider {
  readonly id = 'fake-autodl'
  readonly capabilities = {
    create: true,
    powerCycle: true,
    noGpuMode: false,
    timedShutdown: true,
    accessInfo: true,
    imageSnapshot: false,
    clone: true,
  }
  readonly calls: string[] = []
  destroyResult: TeardownOutcome = { state: 'gone' }
  balanceYuan = 100
  destroyError: Error | null = null

  async destroy(instanceId: string): Promise<TeardownOutcome> {
    this.calls.push(`destroy(${instanceId})`)
    if (this.destroyError !== null) {
      throw this.destroyError
    }
    return this.destroyResult
  }

  async readBalance(): Promise<number> {
    this.calls.push('readBalance')
    return this.balanceYuan
  }

  async listInstances(): Promise<readonly ConsoleInstanceSnapshot[]> {
    throw new Error('守护的 fake provider 不使用 listInstances')
  }
  async powerOn(): Promise<never> {
    throw new Error('守护的 fake provider 不使用 powerOn')
  }
  async powerOff(): Promise<never> {
    throw new Error('守护的 fake provider 不使用 powerOff')
  }
  async readCloneQuota(): Promise<never> {
    throw new Error('守护的 fake provider 不使用 readCloneQuota')
  }
  async clone(_request: CloneRequest): Promise<CloneOutcome> {
    void _request
    throw new Error('守护的 fake provider 不使用 clone')
  }
  async readPriceQuote(): Promise<PriceQuote> {
    throw new Error('守护的 fake provider 不使用 readPriceQuote')
  }
  async clearTimedShutdown(): Promise<void> {}

  async setTimedShutdown(): Promise<TimedShutdownReceipt> {
    throw new Error('守护的 fake provider 不使用 setTimedShutdown')
  }
  async waitUntilReady(): Promise<never> {
    throw new Error('守护的 fake provider 不使用 waitUntilReady')
  }
  async exec(_instanceId: string, _command: string, _options: SshExecOptions): Promise<SshExecResult> {
    void _instanceId
    void _command
    void _options
    throw new Error('守护的 fake provider 不使用 exec')
  }
}

interface Fixture {
  readonly stateDir: string
  readonly store: StateStore
  readonly runs: RunStore
  readonly planStore: PlanStore
  readonly ledger: LedgerStore
  readonly clock: FakeClock
  readonly logger: Logger
  readonly events: LoggerRecord[]
  readonly provider: FakeGuardProvider
  readonly openedLogDirs: string[]
  /** 设置后 openProvider 抛该错误，模拟浏览器不可用。 */
  openProviderError: Error | null
  deps(): GuardDependencies
  createPlan(overrides: Partial<Plan>): Promise<Plan>
  seedRun(input: { runId: string; planId: string; instanceId: string; accounting?: boolean }): Promise<void>
  readPlan(planId: string): Promise<Plan>
  readLedger(): Promise<readonly LedgerEntry[]>
  runRound(): ReturnType<typeof runGuardRound>
}

async function createFixture(): Promise<Fixture> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'guard-spec-'))
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
  const fakeLogger = createFakeLogger()
  const provider = new FakeGuardProvider()
  const openedLogDirs: string[] = []
  const fixture: Fixture = {
    stateDir,
    store,
    runs,
    planStore,
    ledger,
    clock,
    logger: fakeLogger.logger,
    events: fakeLogger.events,
    provider,
    openedLogDirs,
    openProviderError: null,
    deps: () => ({
      planStore,
      runs,
      ledger,
      stateStore: store,
      clock,
      logger: fakeLogger.logger,
      openProvider: async ({ logDir }) => {
        openedLogDirs.push(logDir)
        if (fixture.openProviderError !== null) {
          throw fixture.openProviderError
        }
        return { provider, close: async () => undefined }
      },
    }),
    createPlan: async (overrides) => {
      const plan: Plan = {
        id: overrides.id ?? 'plan-default',
        profileId: 'trans-dev',
        createdAt: START_ISO,
        expiresAt: beijingIso(new Date(Date.parse(START_ISO) + 60 * 60_000)),
        budgetCapYuan: 6,
        spentYuan: 0,
        state: 'active',
        instanceId: null,
        ...overrides,
      }
      await planStore.create(plan)
      return plan
    },
    seedRun: async (input) => {
      const layout = await runs.createLayout(input.runId)
      const profile = makeProfile()
      void profile
      await runs.save({
        id: input.runId,
        planId: input.planId,
        mode: 'reuse',
        instanceId: input.instanceId,
        commitSha: null,
        state: 'running',
        startedAt: START_ISO,
        finishedAt: null,
        logDir: layout.runDirectory,
        instanceAcquiredAt: input.accounting === false ? null : START_ISO,
        gpuSpec: input.accounting === false ? null : 'RTX 5090(32GB)',
        unitPriceYuanPerHour: input.accounting === false ? null : 2,
        steps: [],
      })
    },
    readPlan: async (planId) => await planStore.read(planId),
    readLedger: async () => {
      const snapshot = await ledger.readSnapshot()
      return snapshot.status === 'present' ? snapshot.entries : []
    },
    runRound: async () => await runGuardRound(fixture.deps(), { balanceWarnBelowYuan: BALANCE_WARN_BELOW_YUAN }),
  }
  return fixture
}

function eventsNamed(events: readonly LoggerRecord[], event: string): readonly LoggerRecord[] {
  return events.filter((record) => record.event === event)
}

describe('guard：过期计划', () => {
  it('过期且绑定实例：销毁、写账本、金额记回计划、计划转 closed', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-expired',
      expiresAt: beijingIso(new Date(Date.parse(START_ISO) - 1)),
      instanceId: INSTANCE_ID,
      spentYuan: 1,
    })
    await fixture.seedRun({ runId: 'run-1', planId: plan.id, instanceId: INSTANCE_ID })
    fixture.clock.advanceMinutes(10)

    // Act
    const report = await fixture.runRound()

    // Assert：实例被销毁，账本一行金额 = 2 元/时 × 10 分钟 ≈ 0.333 元。
    expect(fixture.provider.calls).toContain(`destroy(${INSTANCE_ID})`)
    expect(report.closedPlanIds).toEqual([plan.id])
    expect(report.escalatedPlanIds).toEqual([])
    const closed = await fixture.readPlan(plan.id)
    expect(closed.state).toBe('closed')
    expect(closed.spentYuan).toBeCloseTo(1 + (2 * 10) / 60, 10)
    const ledger = await fixture.readLedger()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.instanceId).toBe(INSTANCE_ID)
    expect(ledger[0]?.amountYuan).toBeCloseTo((2 * 10) / 60, 10)
  })

  it('销毁未确认消失：计划转 escalated，不写账本，error 日志带原因', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-escalate',
      expiresAt: beijingIso(new Date(Date.parse(START_ISO) - 1)),
      instanceId: INSTANCE_ID,
    })
    await fixture.seedRun({ runId: 'run-2', planId: plan.id, instanceId: INSTANCE_ID })
    fixture.provider.destroyResult = { state: 'escalated', reason: '释放后实例仍在列表里' }

    // Act
    const report = await fixture.runRound()

    // Assert
    expect(report.escalatedPlanIds).toEqual([plan.id])
    expect(report.closedPlanIds).toEqual([])
    expect((await fixture.readPlan(plan.id)).state).toBe('escalated')
    expect(await fixture.readLedger()).toEqual([])
    const escalated = eventsNamed(fixture.events, 'guard.plan.escalated')
    expect(escalated).toHaveLength(1)
    expect(escalated[0]?.level).toBe('error')
    expect(String(escalated[0]?.fields?.['reason'])).toContain('instance-not-gone')
  })

  it('过期但没有绑定实例：直接关闭，不销毁任何东西', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-expired-no-instance',
      expiresAt: beijingIso(new Date(Date.parse(START_ISO) - 1)),
      instanceId: null,
    })

    // Act
    const report = await fixture.runRound()

    // Assert
    expect(report.closedPlanIds).toEqual([plan.id])
    expect((await fixture.readPlan(plan.id)).state).toBe('closed')
    expect(fixture.provider.calls).toEqual(['readBalance'])
  })
})

describe('guard：预算熔断', () => {
  it('生效中但已花到上限：销毁并关闭', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-over-budget',
      instanceId: INSTANCE_ID,
      spentYuan: 6,
      budgetCapYuan: 6,
    })
    await fixture.seedRun({ runId: 'run-3', planId: plan.id, instanceId: INSTANCE_ID })
    fixture.clock.advanceMinutes(5)

    // Act
    const report = await fixture.runRound()

    // Assert
    expect(report.overBudgetPlanIds).toEqual([plan.id])
    expect(report.closedPlanIds).toEqual([plan.id])
    expect((await fixture.readPlan(plan.id)).state).toBe('closed')
  })

  it('未到上限的生效计划不动', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-normal',
      instanceId: INSTANCE_ID,
      spentYuan: 0.5,
      budgetCapYuan: 6,
    })
    await fixture.seedRun({ runId: 'run-4', planId: plan.id, instanceId: INSTANCE_ID })

    // Act
    const report = await fixture.runRound()

    // Assert
    expect(report.closedPlanIds).toEqual([])
    expect(report.overBudgetPlanIds).toEqual([])
    expect(fixture.provider.calls).not.toContain(`destroy(${INSTANCE_ID})`)
    expect((await fixture.readPlan(plan.id)).state).toBe('active')
  })

  it('实例已消失但执行记录缺结算字段：转待结算，不转 escalated', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-missing-accounting',
      instanceId: INSTANCE_ID,
      spentYuan: 6,
      budgetCapYuan: 6,
    })
    await fixture.seedRun({
      runId: 'run-5',
      planId: plan.id,
      instanceId: INSTANCE_ID,
      accounting: false,
    })

    // Act
    const report = await fixture.runRound()

    // Assert：钱先止损，账本因缺字段不写。
    // 判据（M2）：实例已确认消失，钱停了。这类计划不能报 escalated ——
    // escalated 的含义是「钱可能还在烧」，写错状态会让人去找一台不存在的机器。
    expect(fixture.provider.calls).toContain(`destroy(${INSTANCE_ID})`)
    expect(report.escalatedPlanIds).toEqual([])
    expect(report.stoppedPendingSettlementPlanIds).toEqual([plan.id])
    expect((await fixture.readPlan(plan.id)).state).toBe('stopped-pending-settlement')
    expect(await fixture.readLedger()).toEqual([])
    const pending = eventsNamed(fixture.events, 'guard.plan.stopped-pending-settlement')
    expect(String(pending[0]?.fields?.['reason'])).toContain('run-accounting-incomplete')
  })
})

describe('guard：余额层', () => {
  it('余额低于阈值时打 warn', async () => {
    // Arrange
    const fixture = await createFixture()
    fixture.provider.balanceYuan = 5

    // Act
    const report = await fixture.runRound()

    // Assert
    expect(report.balanceYuan).toBe(5)
    expect(report.balanceWarning).toBe(true)
    const warn = eventsNamed(fixture.events, 'guard.balance.low')
    expect(warn).toHaveLength(1)
    expect(warn[0]?.level).toBe('warn')
    expect(warn[0]?.fields?.['warnBelowYuan']).toBe(BALANCE_WARN_BELOW_YUAN)
  })

  it('余额正常时不告警', async () => {
    // Arrange
    const fixture = await createFixture()

    // Act
    const report = await fixture.runRound()

    // Assert
    expect(report.balanceWarning).toBe(false)
    expect(eventsNamed(fixture.events, 'guard.balance.low')).toEqual([])
  })
})

describe('guard：控制面不可用时降级为告警', () => {
  it('浏览器连不上：记 error、返回 degraded、计划保持原状、不抛错', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-degraded',
      instanceId: INSTANCE_ID,
      spentYuan: 6,
      budgetCapYuan: 6,
    })
    await fixture.seedRun({ runId: 'run-6', planId: plan.id, instanceId: INSTANCE_ID })
    fixture.openProviderError = new ConfigError('CDP 端口不可达')

    // Act
    const report = await fixture.runRound()

    // Assert
    expect(report.degraded).toBe(true)
    expect(report.closedPlanIds).toEqual([])
    expect((await fixture.readPlan(plan.id)).state).toBe('active')
    const degraded = eventsNamed(fixture.events, 'guard.degraded')
    expect(degraded.length).toBeGreaterThan(0)
    expect(degraded[0]?.level).toBe('error')
    expect(String(degraded[0]?.fields?.['message'])).toContain('降级为告警')
  })

  it('读余额失败：记 error 并返回 degraded，不影响计划动作', async () => {
    // Arrange
    const fixture = await createFixture()
    let call = 0
    const deps: GuardDependencies = {
      ...fixture.deps(),
      openProvider: async ({ logDir }) => {
        fixture.openedLogDirs.push(logDir)
        call += 1
        // 第一次用于余额读取；这里让余额读取失败。
        throw new ConfigError('读余额时控制台断开')
      },
    }

    // Act
    const report = await runGuardRound(deps, { balanceWarnBelowYuan: BALANCE_WARN_BELOW_YUAN })

    // Assert
    expect(call).toBe(1)
    expect(report.degraded).toBe(true)
    expect(report.balanceYuan).toBeNull()
    expect(eventsNamed(fixture.events, 'guard.degraded')[0]?.fields?.['phase']).toBe('read-balance')
  })
})

describe('guard：常驻循环', () => {
  it('--once 只跑一轮就返回', async () => {
    // Arrange
    const fixture = await createFixture()
    const rounds: string[] = []

    // Act
    const report = await runGuardLoop(fixture.deps(), {
      balanceWarnBelowYuan: BALANCE_WARN_BELOW_YUAN,
      intervalMs: 5 * 60_000,
      once: true,
      onRound: (round) => {
        rounds.push(round.startedAt)
      },
    })

    // Assert
    expect(report).not.toBeNull()
    expect(rounds).toHaveLength(1)
  })
})

describe('guard：结算锁', () => {
  it('同一实例生命周期已有账本行时不重复记账', async () => {
    // Arrange：先手动写一行账，再让守护销毁关闭。
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-already-accounted',
      instanceId: INSTANCE_ID,
      spentYuan: 6,
      budgetCapYuan: 6,
    })
    await fixture.seedRun({ runId: 'run-7', planId: plan.id, instanceId: INSTANCE_ID })
    fixture.clock.advanceMinutes(5)
    await fixture.ledger.append({
      planId: plan.id,
      runId: 'run-7',
      instanceId: INSTANCE_ID,
      gpuSpec: 'RTX 5090(32GB)',
      startedAt: START_ISO,
      stoppedAt: beijingIso(new Date(Date.parse(START_ISO) + 5 * 60_000)),
      unitPriceYuanPerHour: 2,
      amountYuan: (2 * 5) / 60,
    })

    // Act
    await fixture.runRound()

    // Assert：计划已关闭，账本仍只有一行，金额不再重复加到计划上。
    expect(await fixture.readLedger()).toHaveLength(1)
    const closed = await fixture.readPlan(plan.id)
    expect(closed.state).toBe('closed')
    expect(closed.spentYuan).toBe(6)
  })
})

describe('guard：停机成功待结算的计划', () => {
  it('待结算计划被本轮结算：写一行账、计划转 closed', async () => {
    // Arrange：失败停机成功，计划处于 stopped-pending-settlement，实例还在列表里（停着）。
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-pending',
      instanceId: INSTANCE_ID,
      state: 'stopped-pending-settlement',
    })
    await fixture.seedRun({ runId: 'run-pending', planId: plan.id, instanceId: INSTANCE_ID })

    // Act
    const report = await fixture.runRound()

    // Assert：这类计划不靠「过期」也要被处理，否则钱停了账永远结不掉。
    expect(report.closedPlanIds).toContain(plan.id)
    expect(report.escalatedPlanIds).toEqual([])
    expect((await fixture.readPlan(plan.id)).state).toBe('closed')
    expect(await fixture.readLedger()).toHaveLength(1)
  })

  it('待结算计划已有账本行：只关闭，不写第二行、不调销毁链', async () => {
    // Arrange：失败停机已经写过账（计费终点 = 停机时刻），计划状态是待结算。
    const fixture = await createFixture()
    const stoppedAt = beijingIso(new Date(Date.parse(START_ISO) + 5 * 60_000))
    const recordedEntry: LedgerEntry = {
      planId: 'plan-pending-accounted',
      runId: 'run-pending-accounted',
      instanceId: INSTANCE_ID,
      gpuSpec: 'RTX 5090(32GB)',
      startedAt: START_ISO,
      stoppedAt,
      unitPriceYuanPerHour: 2,
      amountYuan: (2 * 5) / 60,
    }
    await fixture.ledger.append(recordedEntry)
    const plan = await fixture.createPlan({
      id: 'plan-pending-accounted',
      instanceId: INSTANCE_ID,
      spentYuan: recordedEntry.amountYuan,
      state: 'stopped-pending-settlement',
    })
    await fixture.seedRun({
      runId: 'run-pending-accounted',
      planId: plan.id,
      instanceId: INSTANCE_ID,
    })
    fixture.clock.advanceMinutes(120)

    // Act
    const report = await fixture.runRound()

    // Assert（M1）：账本行不变；金额不再累加；计划关闭。
    expect(report.closedPlanIds).toContain(plan.id)
    expect(await fixture.readLedger()).toEqual([recordedEntry])
    const closed = await fixture.readPlan(plan.id)
    expect(closed.state).toBe('closed')
    expect(closed.spentYuan).toBeCloseTo(recordedEntry.amountYuan, 10)
    // 已有账本行时连销毁链都不必走：实例的计费终点已封口。
    expect(fixture.provider.calls).not.toContain(`destroy(${INSTANCE_ID})`)
  })

  it('待结算计划没有绑定实例：直接关闭，不碰控制台', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-pending-no-instance',
      instanceId: null,
      state: 'stopped-pending-settlement',
    })

    // Act
    const report = await fixture.runRound()

    // Assert：没有可结的账，只把计划关掉，避免每轮重复扫到它。
    expect(report.closedPlanIds).toContain(plan.id)
    expect((await fixture.readPlan(plan.id)).state).toBe('closed')
    // 没有实例可销毁：这一轮不出现任何销毁动作（余额层照常读余额）。
    expect(fixture.provider.calls.some((call) => call.startsWith('destroy'))).toBe(false)
  })
})

describe('guard：执行记录缺失', () => {
  it('销毁后找不到执行记录：计划转待结算，账本不写', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-no-run',
      instanceId: INSTANCE_ID,
      spentYuan: 6,
      budgetCapYuan: 6,
    })

    // Act
    const report = await fixture.runRound()

    // Assert：实例已确认消失（钱停了），只是账还差一步。
    expect(report.escalatedPlanIds).toEqual([])
    expect(report.stoppedPendingSettlementPlanIds).toEqual([plan.id])
    expect((await fixture.readPlan(plan.id)).state).toBe('stopped-pending-settlement')
    const pending = eventsNamed(fixture.events, 'guard.plan.stopped-pending-settlement')
    expect(String(pending[0]?.fields?.['reason'])).toContain('run-record-missing')
  })

  it('销毁链自身抛错：计划转 escalated，错误进日志', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-destroy-throws',
      instanceId: INSTANCE_ID,
      spentYuan: 6,
      budgetCapYuan: 6,
    })
    await fixture.seedRun({ runId: 'run-8', planId: plan.id, instanceId: INSTANCE_ID })
    fixture.provider.destroyError = new HumanRequiredError('控制台断线')

    // Act
    const report = await fixture.runRound()

    // Assert
    expect(report.escalatedPlanIds).toEqual([plan.id])
    expect((await fixture.readPlan(plan.id)).state).toBe('escalated')
    const escalated = eventsNamed(fixture.events, 'guard.plan.escalated')
    expect(String(escalated[0]?.fields?.['reason'])).toContain('destroy-chain-failed')
  })
})

describe('guard：现场落点', () => {
  it('销毁动作的证据目录指向绑定该实例那次 run 的目录', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = await fixture.createPlan({
      id: 'plan-log-dir',
      instanceId: INSTANCE_ID,
      spentYuan: 6,
      budgetCapYuan: 6,
    })
    await fixture.seedRun({ runId: 'run-9', planId: plan.id, instanceId: INSTANCE_ID })

    // Act
    await fixture.runRound()

    // Assert
    const expectedRunDirectory = join(fixture.stateDir, RUNS_DIRECTORY, 'run-9')
    expect(fixture.openedLogDirs[0]).toBe(expectedRunDirectory)
  })
})
