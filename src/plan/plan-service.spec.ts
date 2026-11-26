import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PriceQuote, TeardownPort, TeardownOutcome } from '../console/ports.js'
import type { Plan } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import {
  BudgetExceededError,
  InstanceNotGoneError,
  PlanInvalidError,
} from '../errors.js'
import type { ProviderCapabilities } from '../providers/provider.js'
import type { Clock } from '../util/clock.js'
import { addMinutesIso } from '../util/time.js'
import { createBudgetEnforcement } from './plan-service.js'
import type { PlanService } from './plan-service.js'
import {
  createPlanService,
  SHUTDOWN_SAFETY_MARGIN_MINUTES,
  computeTimedShutdownAt,
} from './plan-service.js'
import { createPlanStore } from './plan-store.js'
import type { PlanStore } from './plan-store.js'
import { createStateStore } from '../state/store.js'

/**
 * 工单 09 的计划服务与预算复核夹具。
 *
 * 状态存储用临时目录里的真实实现（`.tmp/` 下），时钟用假时钟，
 * provider 能力、单价报价与销毁端口用手写假对象。不连真实控制台。
 */

const START_ISO = '2026-01-01T00:00:00+08:00'

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

/** 造一份结构合法的部署配置，只改用例关心的字段。 */
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
    requirePinnedCommit: false,
    deployScript: 'scripts/deploy.sh',
    startScript: 'scripts/start.sh',
    ...overrides,
  }
}

function makeCapabilities(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
  return {
    create: true,
    powerCycle: true,
    noGpuMode: false,
    timedShutdown: true,
    accessInfo: true,
    imageSnapshot: false,
    clone: true,
    ...overrides,
  }
}

function makeQuote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    serverTime: START_ISO,
    unitPriceYuanPerHour: 1,
    estimatedCostYuan: 1,
    ttlMinutes: 60,
    balanceYuan: 100,
    ...overrides,
  }
}

interface FakeTeardown {
  readonly port: TeardownPort
  readonly destroyedInstanceIds: string[]
}

function createFakeTeardown(outcome: TeardownOutcome): FakeTeardown {
  const destroyedInstanceIds: string[] = []
  return {
    destroyedInstanceIds,
    port: {
      destroy: async (instanceId) => {
        destroyedInstanceIds.push(instanceId)
        return outcome
      },
    },
  }
}

interface PlanServiceFixture {
  readonly stateDir: string
  readonly plans: PlanStore
  readonly clock: FakeClock
  readonly service: PlanService
}

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

async function createTemporaryParent(): Promise<string> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'plan-service-spec-'))
  temporaryParents.push(parent)
  return parent
}

async function createFixture(): Promise<PlanServiceFixture> {
  const parent = await createTemporaryParent()
  const stateDir = join(parent, 'state')
  const configDir = join(parent, 'config')
  const store = createStateStore({
    stateDir,
    configDir,
    lockTimeoutMs: 2000,
    lockRetryIntervalMs: 2,
  })
  const plans = createPlanStore(store)
  const clock = createFakeClock(START_ISO)
  return { stateDir, plans, clock, service: createPlanService({ plans, clock }) }
}

async function writePlan(fixture: PlanServiceFixture, plan: Plan): Promise<void> {
  await fixture.plans.create(plan)
}

describe('createPlan', () => {
  it('落盘可读回，时长与预算继承 Profile', async () => {
    // Arrange
    const fixture = await createFixture()

    // Act
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })
    const readBack = await fixture.plans.read(created.id)

    // Assert
    expect(readBack.profileId).toBe('trans-dev')
    expect(readBack.budgetCapYuan).toBe(6)
    expect(readBack.spentYuan).toBe(0)
    expect(readBack.state).toBe('active')
    expect(readBack.instanceId).toBeNull()
    expect(readBack.createdAt).toBe(addMinutesIso(START_ISO, 0))
    expect(readBack.expiresAt).toBe(addMinutesIso(START_ISO, 60))
    expect(readBack.id).toMatch(/^plan-/)
  })

  it('显式覆盖时长与预算时以覆盖值为准', async () => {
    // Arrange
    const fixture = await createFixture()

    // Act
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
      ttlMinutes: 30,
      budgetCapYuan: 2.5,
    })

    // Assert
    expect(created.expiresAt).toBe(addMinutesIso(START_ISO, 30))
    expect(created.budgetCapYuan).toBe(2.5)
  })

  it('provider 不支持创建实例时拒绝创建计划，不落盘', async () => {
    // Arrange
    const fixture = await createFixture()

    // Act + Assert：判据见 docs/provider-contract.md 第 2 节，能力为否必须在 plan create 拒绝。
    await expect(
      fixture.service.createPlan({
        profile: makeProfile(),
        provider: {
          id: 'fake-provider',
          capabilities: makeCapabilities({ create: false }),
        },
      }),
    ).rejects.toThrow(PlanInvalidError)
    await expect(readdir(join(fixture.stateDir, 'plans'))).rejects.toThrow()
  })

  it('provider 不支持平台定时关机时拒绝创建，不落盘', async () => {
    // Arrange
    const fixture = await createFixture()

    // Act + Assert
    await expect(
      fixture.service.createPlan({
        profile: makeProfile(),
        provider: {
          id: 'fake-provider',
          capabilities: makeCapabilities({ timedShutdown: false }),
        },
      }),
    ).rejects.toThrow(PlanInvalidError)
    await expect(readdir(join(fixture.stateDir, 'plans'))).rejects.toThrow()
  })

  it.each([
    ['gpuPreference 为空', { profile: makeProfile({ gpuPreference: [] }) }],
    ['时长不为正', { profile: makeProfile(), ttlMinutes: 0 }],
    ['时长不是整数', { profile: makeProfile(), ttlMinutes: 1.5 }],
    ['预算不为正', { profile: makeProfile(), budgetCapYuan: 0 }],
  ])('创建前校验拒绝非法参数：%s', async (_label, overrides) => {
    // Arrange
    const fixture = await createFixture()

    // Act + Assert
    await expect(
      fixture.service.createPlan({
        provider: { id: 'autodl', capabilities: makeCapabilities() },
        ...overrides,
      }),
    ).rejects.toThrow(PlanInvalidError)
  })
})

describe('requireActivePlan', () => {
  it('计划生效时返回计划本身', async () => {
    // Arrange
    const fixture = await createFixture()
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })

    // Act
    const required = await fixture.service.requireActivePlan(created.id)

    // Assert
    expect(required).toEqual(created)
  })

  it('计划不存在时抛 PlanInvalidError，退出码 1', async () => {
    // Arrange
    const fixture = await createFixture()

    // Act
    let caught: unknown
    try {
      await fixture.service.requireActivePlan('plan-missing')
    } catch (error: unknown) {
      caught = error
    }

    // Assert
    expect(caught).toBeInstanceOf(PlanInvalidError)
    if (!(caught instanceof PlanInvalidError)) {
      throw new Error('期望抛出 PlanInvalidError')
    }
    expect(caught.code).toBe('PLAN_INVALID')
    expect(caught.exitCode).toBe(1)
  })

  it('计划过期后抛 PlanInvalidError，退出码 1', async () => {
    // Arrange
    const fixture = await createFixture()
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })
    fixture.clock.advanceMinutes(61)

    // Act
    let caught: unknown
    try {
      await fixture.service.requireActivePlan(created.id)
    } catch (error: unknown) {
      caught = error
    }

    // Assert
    expect(caught).toBeInstanceOf(PlanInvalidError)
    if (!(caught instanceof PlanInvalidError)) {
      throw new Error('期望抛出 PlanInvalidError')
    }
    expect(caught.exitCode).toBe(1)
    expect(caught.message).toContain('过期')
  })

  it('计划状态不是 active 时抛 PlanInvalidError', async () => {
    // Arrange
    const fixture = await createFixture()
    await writePlan(fixture, {
      id: 'plan-closed',
      profileId: 'trans-dev',
      createdAt: START_ISO,
      expiresAt: addMinutesIso(START_ISO, 60),
      budgetCapYuan: 6,
      spentYuan: 0,
      state: 'closed',
      instanceId: null,
    })

    // Act + Assert
    await expect(fixture.service.requireActivePlan('plan-closed')).rejects.toThrow(PlanInvalidError)
  })
})

describe('showPlan', () => {
  it('剩余时长随时钟推进而减少', async () => {
    // Arrange
    const fixture = await createFixture()
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })

    // Act
    const before = await fixture.service.showPlan(created.id)
    fixture.clock.advanceMinutes(10)
    const after = await fixture.service.showPlan(created.id)

    // Assert
    expect(before.remainingMinutes).toBe(60)
    expect(after.remainingMinutes).toBe(50)
    expect(after.remainingMinutes).toBe(before.remainingMinutes - 10)
  })

  it('平台定时关机时刻等于 expiresAt 减 5 分钟安全余量', async () => {
    // Arrange
    const fixture = await createFixture()
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })

    // Act
    const view = await fixture.service.showPlan(created.id)

    // Assert
    expect(SHUTDOWN_SAFETY_MARGIN_MINUTES).toBe(5)
    expect(view.timedShutdownAt).toBe(addMinutesIso(created.expiresAt, -5))
    expect(view.timedShutdownAt).toBe(computeTimedShutdownAt(created))
  })

  it('计划过期后展示为 expired，剩余时长为 0', async () => {
    // Arrange
    const fixture = await createFixture()
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })
    fixture.clock.advanceMinutes(61)

    // Act
    const view = await fixture.service.showPlan(created.id)

    // Assert
    expect(view.state).toBe('expired')
    expect(view.remainingMinutes).toBe(0)
    // 已花费与预算余量照常展示，人还要核对账。
    expect(view.spentYuan).toBe(0)
    expect(view.remainingBudgetYuan).toBe(6)
  })
})

describe('recheckAfterInstanceReady', () => {
  it('预计花费超上限时销毁实例并抛 BudgetExceededError，退出码 1', async () => {
    // Arrange
    const fixture = await createFixture()
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })
    const teardown = createFakeTeardown({ state: 'gone' })
    const enforcement = createBudgetEnforcement({ plans: fixture.plans, teardown: teardown.port })

    // Act
    let caught: unknown
    try {
      await enforcement.recheckAfterInstanceReady({
        planId: created.id,
        runId: 'run-1',
        instanceId: 'instance-1',
        quote: makeQuote({ unitPriceYuanPerHour: 10, estimatedCostYuan: 10 }),
      })
    } catch (error: unknown) {
      caught = error
    }

    // Assert
    expect(teardown.destroyedInstanceIds).toEqual(['instance-1'])
    expect(caught).toBeInstanceOf(BudgetExceededError)
    if (!(caught instanceof BudgetExceededError)) {
      throw new Error('期望抛出 BudgetExceededError')
    }
    expect(caught.code).toBe('BUDGET_EXCEEDED')
    expect(caught.exitCode).toBe(1)
  })

  it('销毁未确认消失时抛 InstanceNotGoneError，退出码 2，不再抛预算错误', async () => {
    // Arrange
    const fixture = await createFixture()
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })
    const teardown = createFakeTeardown({ state: 'escalated', reason: '释放后实例仍在列表里' })
    const enforcement = createBudgetEnforcement({ plans: fixture.plans, teardown: teardown.port })

    // Act
    let caught: unknown
    try {
      await enforcement.recheckAfterInstanceReady({
        planId: created.id,
        runId: 'run-1',
        instanceId: 'instance-1',
        quote: makeQuote({ unitPriceYuanPerHour: 10, estimatedCostYuan: 10 }),
      })
    } catch (error: unknown) {
      caught = error
    }

    // Assert
    expect(teardown.destroyedInstanceIds).toEqual(['instance-1'])
    expect(caught).toBeInstanceOf(InstanceNotGoneError)
    expect(caught).not.toBeInstanceOf(BudgetExceededError)
    if (!(caught instanceof InstanceNotGoneError)) {
      throw new Error('期望抛出 InstanceNotGoneError')
    }
    expect(caught.code).toBe('INSTANCE_NOT_GONE')
    expect(caught.exitCode).toBe(2)
  })

  it('预算足够时不销毁实例、不抛错', async () => {
    // Arrange
    const fixture = await createFixture()
    const created = await fixture.service.createPlan({
      profile: makeProfile(),
      provider: { id: 'autodl', capabilities: makeCapabilities() },
    })
    const teardown = createFakeTeardown({ state: 'gone' })
    const enforcement = createBudgetEnforcement({ plans: fixture.plans, teardown: teardown.port })

    // Act + Assert
    await expect(
      enforcement.recheckAfterInstanceReady({
        planId: created.id,
        runId: 'run-1',
        instanceId: 'instance-1',
        quote: makeQuote(),
      }),
    ).resolves.toBeUndefined()
    expect(teardown.destroyedInstanceIds).toEqual([])
  })
})
