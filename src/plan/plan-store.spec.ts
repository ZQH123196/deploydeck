import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { Plan } from '../domain/plan.js'
import { ConfigError, PlanInvalidError, StateFileInvalidError, StateFileMissingError } from '../errors.js'
import type { StateStore } from '../state/ports.js'
import { createStateStore } from '../state/store.js'
import type { PlanStore } from './plan-store.js'
import { createPlanStore } from './plan-store.js'

/**
 * 工单 09 的计划落盘夹具。
 *
 * 状态存储用临时目录里的真实实现（`.tmp/` 下），锁参数显式给出；
 * 不连真实浏览器、SSH 与控制台（施工约定第 4 节）。
 */

interface PlanStoreFixture {
  readonly parent: string
  readonly stateDir: string
  readonly store: StateStore
  readonly plans: PlanStore
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
  const parent = await mkdtemp(join(baseDirectory, 'plan-store-spec-'))
  temporaryParents.push(parent)
  return parent
}

async function createFixture(): Promise<PlanStoreFixture> {
  const parent = await createTemporaryParent()
  const stateDir = join(parent, 'state')
  const configDir = join(parent, 'config')
  const store = createStateStore({
    stateDir,
    configDir,
    lockTimeoutMs: 2000,
    lockRetryIntervalMs: 2,
  })
  return { parent, stateDir, store, plans: createPlanStore(store) }
}

/** 造一份结构合法的计划，只改用例关心的字段。 */
function buildPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-20260101000000-0001',
    profileId: 'trans-dev',
    createdAt: '2026-01-01T00:00:00+08:00',
    expiresAt: '2026-01-01T01:00:00+08:00',
    budgetCapYuan: 6,
    spentYuan: 0,
    state: 'active',
    instanceId: null,
    ...overrides,
  }
}

const NOW = new Date('2026-01-01T00:30:00+08:00')

describe('残缺计划文件', () => {
  it('文件缺 state 字段时读回抛 StateFileInvalidError，不补默认值', async () => {
    // Arrange：绕过 create，直接把残缺 JSON 写进计划文件。
    const fixture = await createFixture()
    const partial = {
      id: 'plan-partial',
      profileId: 'trans-dev',
      createdAt: '2026-01-01T00:00:00+08:00',
      expiresAt: '2026-01-01T01:00:00+08:00',
      budgetCapYuan: 6,
      spentYuan: 0,
      instanceId: null,
    }
    await fixture.store.writeJson('plans/plan-partial.jsonc', partial)

    // Act + Assert
    await expect(fixture.plans.read('plan-partial')).rejects.toThrow(StateFileInvalidError)
  })
})

describe('create / read', () => {
  it('写入后可按 id 读回同样的字段', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = buildPlan()

    // Act
    await fixture.plans.create(plan)
    const readBack = await fixture.plans.read(plan.id)

    // Assert
    expect(readBack).toEqual(plan)
  })

  it('创建计划时在锁内写入', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = buildPlan()
    let lockDepth = 0
    const guarded: StateStore = {
      root: fixture.store.root,
      resolve: (relativePath) => fixture.store.resolve(relativePath),
      readJson: <Value>(relativePath: string, schema: z.ZodType<Value>) =>
        fixture.store.readJson(relativePath, schema),
      readJsonLines: <Value>(relativePath: string, schema: z.ZodType<Value>) =>
        fixture.store.readJsonLines(relativePath, schema),
      appendJsonLine: (relativePath, value) => fixture.store.appendJsonLine(relativePath, value),
      writeJson: async (relativePath, value) => {
        if (lockDepth === 0) {
          throw new Error(`writeJson 未在锁内：${relativePath}`)
        }
        await fixture.store.writeJson(relativePath, value)
      },
      withLock: async <Result>(name: string, action: () => Promise<Result>) => {
        lockDepth += 1
        try {
          return await fixture.store.withLock(name, action)
        } finally {
          lockDepth -= 1
        }
      },
    }

    // Act
    await createPlanStore(guarded).create(plan)

    // Assert
    expect(await fixture.plans.read(plan.id)).toEqual(plan)
  })

  it('同一 id 重复创建时拒绝覆盖已有计划', async () => {
    // Arrange
    const fixture = await createFixture()
    const plan = buildPlan()
    await fixture.plans.create(plan)

    // Act + Assert
    await expect(fixture.plans.create(buildPlan({ budgetCapYuan: 99 }))).rejects.toThrow(
      PlanInvalidError,
    )
    // 旧计划一字不改：覆盖会丢掉已花费金额。
    expect((await fixture.plans.read(plan.id)).budgetCapYuan).toBe(6)
  })

  it('计划 id 含路径分隔符时拒绝，不落到别的路径', async () => {
    // Arrange
    const fixture = await createFixture()
    const plans = createPlanStore(fixture.store)

    // Act + Assert
    await expect(plans.read('../escape')).rejects.toThrow(ConfigError)
    await expect(plans.create(buildPlan({ id: 'plan/other' }))).rejects.toThrow(ConfigError)
  })

  it('读取不存在的计划时报错，不返回空值', async () => {
    // Arrange
    const fixture = await createFixture()

    // Act + Assert
    await expect(fixture.plans.read('plan-missing')).rejects.toThrow(StateFileMissingError)
  })
})

describe('listActive', () => {
  it('只列出未过期的 active 计划', async () => {
    // Arrange
    const fixture = await createFixture()
    const effectivePlan = buildPlan({ id: 'plan-effective' })
    const expiredPlan = buildPlan({
      id: 'plan-expired',
      expiresAt: '2026-01-01T00:00:00+08:00',
    })
    await fixture.plans.create(effectivePlan)
    await fixture.plans.create(expiredPlan)

    // Act
    const activePlans = await fixture.plans.listActive(NOW)

    // Assert
    expect(activePlans.map((plan) => plan.id)).toEqual(['plan-effective'])
  })

  it('跳过 closed 与 escalated 状态的计划', async () => {
    // Arrange
    const fixture = await createFixture()
    await fixture.plans.create(buildPlan({ id: 'plan-closed', state: 'closed' }))
    await fixture.plans.create(buildPlan({ id: 'plan-escalated', state: 'escalated' }))

    // Act
    const activePlans = await fixture.plans.listActive(NOW)

    // Assert
    expect(activePlans).toEqual([])
  })

  it('一份计划都没有时返回空列表', async () => {
    // Arrange
    const fixture = await createFixture()

    // Act
    const activePlans = await fixture.plans.listActive(NOW)

    // Assert
    expect(activePlans).toEqual([])
  })
})

describe('recordSpent', () => {
  it('把金额累加到 spentYuan 并落盘，多次记账逐笔相加', async () => {
    // Arrange
    const fixture = await createFixture()
    await fixture.plans.create(buildPlan())

    // Act
    await fixture.plans.recordSpent('plan-20260101000000-0001', 0.5)
    const afterFirst = await fixture.plans.recordSpent('plan-20260101000000-0001', 0.25)

    // Assert
    expect(afterFirst.spentYuan).toBeCloseTo(0.75, 10)
    expect((await fixture.plans.read('plan-20260101000000-0001')).spentYuan).toBeCloseTo(0.75, 10)
  })

  it('金额为负时抛错，计划保持不变', async () => {
    // Arrange
    const fixture = await createFixture()
    await fixture.plans.create(buildPlan())

    // Act + Assert
    await expect(fixture.plans.recordSpent('plan-20260101000000-0001', -1)).rejects.toThrow(
      RangeError,
    )
    expect((await fixture.plans.read('plan-20260101000000-0001')).spentYuan).toBe(0)
  })
})
