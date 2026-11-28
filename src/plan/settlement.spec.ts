import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Plan } from '../domain/plan.js'
import { createPlanStore } from './plan-store.js'
import {
  buildLedgerEntry,
  closePlanWithLedger,
  findInstanceEntry,
  type PlanSettlementStores,
} from './settlement.js'
import { createLedgerStore } from '../state/ledger-store.js'
import type { LedgerEntry } from '../state/ledger.js'
import { createStateStore } from '../state/store.js'

/**
 * 结算层的账本判据。
 *
 * 这里是账本封口的最后一道闸：同一实例生命周期只允许一行账。
 * 上一道闸在各调用方（`teardown` / `guard`）自己判断「要不要造 entry」，
 * 但两个进程可能同时判断，所以本层必须再判一次。本文件锁死这一次。
 *
 * 状态目录用 `.tmp/` 下的真实临时目录，不连数据库、不连网络。
 */

const START_ISO = '2026-01-01T00:00:00+08:00'
const PLAN_ID = 'plan-settlement'
const INSTANCE_ID = 'af9c49bd44-8ee624d7'

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

interface Fixture {
  readonly stores: PlanSettlementStores
  readonly plan: Plan
}

async function createFixture(): Promise<Fixture> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'settlement-spec-'))
  temporaryParents.push(parent)
  const stateStore = createStateStore({
    stateDir: join(parent, 'state'),
    configDir: join(parent, 'config'),
    lockTimeoutMs: 5_000,
    lockRetryIntervalMs: 5,
  })
  const planStore = createPlanStore(stateStore)
  const ledger = createLedgerStore(stateStore)
  const plan: Plan = {
    id: PLAN_ID,
    profileId: 'trans-dev',
    createdAt: START_ISO,
    expiresAt: '2026-01-01T01:00:00+08:00',
    budgetCapYuan: 6,
    spentYuan: 0,
    state: 'stopped-pending-settlement',
    instanceId: INSTANCE_ID,
  }
  await planStore.create(plan)
  return { stores: { stateStore, planStore, ledger }, plan }
}

function entryAt(stoppedAt: string, unitPriceYuanPerHour = 2): LedgerEntry {
  return buildLedgerEntry({
    planId: PLAN_ID,
    runId: 'run-1',
    instanceId: INSTANCE_ID,
    gpuSpec: 'RTX 5090(32GB)',
    startedAt: START_ISO,
    stoppedAt,
    unitPriceYuanPerHour,
  })
}

describe('closePlanWithLedger：同一实例生命周期只写一行', () => {
  it('账本已有该实例的行时，调用方传进来的 entry 不写、也不累加金额', async () => {
    // Arrange：停机时刻已经封过一行。
    const { stores } = await createFixture()
    const first = entryAt('2026-01-01T00:10:00+08:00')
    await closePlanWithLedger(stores, PLAN_ID, INSTANCE_ID, first)
    // 计划重新处于待结算（模拟另一个进程又在结算同一实例）。
    await stores.planStore.save({ ...(await stores.planStore.read(PLAN_ID)), state: 'stopped-pending-settlement', spentYuan: first.amountYuan })

    // Act：调用方仍然传了一个「用更晚钟点造出来的」entry。
    // 判据：本层必须自己再判一次，不能信任调用方已经判过。
    const second = entryAt('2026-01-01T00:50:00+08:00')
    const result = await closePlanWithLedger(stores, PLAN_ID, INSTANCE_ID, second)

    // Assert：第二行没写，金额没累加，计费终点仍是第一次的停机时刻。
    expect(result.writtenEntry).toBeNull()
    expect(result.existingEntry).toEqual(first)
    expect(await stores.ledger.readAll()).toEqual([first])
    expect(result.plan.spentYuan).toBeCloseTo(first.amountYuan, 10)
    expect(result.plan.state).toBe('closed')
  })

  it('账本没有该实例的行时写一行，并把金额记回计划', async () => {
    // Arrange
    const { stores } = await createFixture()
    const entry = entryAt('2026-01-01T00:10:00+08:00')

    // Act
    const result = await closePlanWithLedger(stores, PLAN_ID, INSTANCE_ID, entry)

    // Assert
    expect(result.writtenEntry).toEqual(entry)
    expect(result.existingEntry).toBeNull()
    expect(await stores.ledger.readAll()).toEqual([entry])
    expect(result.plan.spentYuan).toBeCloseTo(entry.amountYuan, 10)
  })

  it('传 null 时不写账，只把计划关闭', async () => {
    // Arrange
    const { stores } = await createFixture()

    // Act
    const result = await closePlanWithLedger(stores, PLAN_ID, INSTANCE_ID, null)

    // Assert
    expect(result.writtenEntry).toBeNull()
    expect(result.plan.state).toBe('closed')
    expect(result.plan.spentYuan).toBe(0)
  })
})

describe('findInstanceEntry', () => {
  it('账本文件不存在时返回 null，不编造金额', async () => {
    // Arrange
    const { stores } = await createFixture()

    // Act
    const found = await findInstanceEntry(stores.ledger, PLAN_ID, INSTANCE_ID)

    // Assert
    expect(found).toBeNull()
  })

  it('只按 (planId, instanceId) 匹配：同实例在别的计划下的行不算', async () => {
    // Arrange
    const { stores } = await createFixture()
    await closePlanWithLedger(stores, PLAN_ID, INSTANCE_ID, entryAt('2026-01-01T00:10:00+08:00'))

    // Act
    const otherPlan = await findInstanceEntry(stores.ledger, 'plan-other', INSTANCE_ID)

    // Assert
    expect(otherPlan).toBeNull()
  })

  it('返回该实例那一行的计费终点', async () => {
    // Arrange
    const { stores } = await createFixture()
    const entry = entryAt('2026-01-01T00:10:00+08:00')
    await closePlanWithLedger(stores, PLAN_ID, INSTANCE_ID, entry)

    // Act
    const found = await findInstanceEntry(stores.ledger, PLAN_ID, INSTANCE_ID)

    // Assert
    expect(found?.stoppedAt).toBe(entry.stoppedAt)
  })
})
