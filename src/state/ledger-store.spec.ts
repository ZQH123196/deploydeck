import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { StateFileInvalidError, StateFileMissingError } from '../errors.js'
import type { LedgerEntry } from './ledger.js'
import { createLedgerStore, LEDGER_RELATIVE_PATH, type LedgerStore } from './ledger-store.js'
import { createStateStore } from './store.js'

interface LedgerFixture {
  readonly stateDir: string
  readonly ledgerPath: string
  readonly ledger: LedgerStore
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

const firstEntry: LedgerEntry = {
  planId: 'plan-20261125',
  runId: 'run-1',
  instanceId: 'instance-1',
  gpuSpec: 'RTX 4090',
  startedAt: '2026-11-25T09:00:00+08:00',
  stoppedAt: '2026-11-25T11:00:00+08:00',
  unitPriceYuanPerHour: 1.5,
  amountYuan: 3,
}

const secondEntry: LedgerEntry = {
  ...firstEntry,
  runId: 'run-2',
  instanceId: 'instance-2',
  stoppedAt: '2026-11-25T10:00:00+08:00',
  amountYuan: 1.5,
}

async function createFixture(): Promise<LedgerFixture> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'ledger-store-spec-'))
  temporaryParents.push(parent)
  const stateDir = join(parent, 'state')
  const store = createStateStore({
    stateDir,
    configDir: join(parent, 'config'),
    lockTimeoutMs: 2000,
    lockRetryIntervalMs: 2,
  })
  return {
    stateDir,
    ledgerPath: join(stateDir, LEDGER_RELATIVE_PATH),
    ledger: createLedgerStore(store),
  }
}

describe('账本', () => {
  it('追加后旧行一字不改', async () => {
    const fixture = await createFixture()

    await fixture.ledger.append(firstEntry)
    const afterFirstAppend = await readFile(fixture.ledgerPath, 'utf8')
    await fixture.ledger.append(secondEntry)
    const afterSecondAppend = await readFile(fixture.ledgerPath, 'utf8')

    const [firstLineBefore] = afterFirstAppend.split('\n')
    const [firstLineAfter] = afterSecondAppend.split('\n')
    expect(firstLineAfter).toBe(firstLineBefore)
    // 新内容只能出现在尾部：旧前缀整体不变。
    expect(afterSecondAppend.startsWith(afterFirstAppend)).toBe(true)
    expect(
      afterSecondAppend.split('\n').filter((line) => line.length > 0),
    ).toHaveLength(2)
  })

  it('读回时逐行按 schema 校验', async () => {
    const fixture = await createFixture()

    await fixture.ledger.append(firstEntry)
    await fixture.ledger.append(secondEntry)

    expect(await fixture.ledger.readAll()).toEqual([firstEntry, secondEntry])
  })

  it('某行不符合 schema 时报出行号', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.stateDir, { recursive: true })
    const brokenLine = JSON.stringify({ ...firstEntry, unitPriceYuanPerHour: '一块五' })
    await writeFile(fixture.ledgerPath, `${JSON.stringify(firstEntry)}\n${brokenLine}\n`, 'utf8')

    let caught: unknown
    try {
      await fixture.ledger.readAll()
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StateFileInvalidError)
    if (!(caught instanceof StateFileInvalidError)) {
      throw new Error('期望抛出 StateFileInvalidError')
    }
    expect(caught.message).toContain('第 2 行')
  })

  it('账本文件不存在时报错，不返回空账本', async () => {
    const fixture = await createFixture()

    await expect(fixture.ledger.readAll()).rejects.toThrow(StateFileMissingError)
  })

  it('readSnapshot 把「文件不存在」与「空账本」分成两种显式状态', async () => {
    // Arrange：没有账本文件。
    const missingFixture = await createFixture()

    // Act
    const missing = await missingFixture.ledger.readSnapshot()

    // Assert
    expect(missing).toEqual({ status: 'missing' })

    // Arrange：写一个空文件，它表示「账本存在但为空」。
    const emptyFixture = await createFixture()
    await mkdir(emptyFixture.stateDir, { recursive: true })
    await writeFile(emptyFixture.ledgerPath, '', 'utf8')

    // Act
    const empty = await emptyFixture.ledger.readSnapshot()

    // Assert
    expect(empty).toEqual({ status: 'present', entries: [] })
  })

  it('写入前按 schema 校验，非法条目不会落盘', async () => {
    const fixture = await createFixture()
    const invalidEntry = { ...firstEntry, planId: '' } as unknown as LedgerEntry

    await expect(fixture.ledger.append(invalidEntry)).rejects.toThrow()
    await expect(stat(fixture.ledgerPath)).rejects.toThrow()
  })
})
