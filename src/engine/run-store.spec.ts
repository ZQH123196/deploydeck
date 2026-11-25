import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Run } from '../domain/run.js'
import { StateFileMissingError } from '../errors.js'
import { createStateStore } from '../state/store.js'
import { createRunStore, RUNS_DIRECTORY, stepLogFilePath } from './run-store.js'

/**
 * 执行记录的落盘。状态存储用 `.tmp/` 下的真实临时目录，不碰用户的状态目录。
 */

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

interface RunStoreFixture {
  readonly stateDir: string
  readonly store: ReturnType<typeof createRunStore>
}

async function createFixture(): Promise<RunStoreFixture> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'run-store-spec-'))
  temporaryParents.push(parent)
  const stateDir = join(parent, 'state')
  const stateStore = createStateStore({
    stateDir,
    configDir: join(parent, 'config'),
    lockTimeoutMs: 2_000,
    lockRetryIntervalMs: 5,
  })
  return { stateDir, store: createRunStore(stateStore) }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-20260101-000000-0001',
    planId: 'plan-20260101-000000-0001',
    mode: 'reuse',
    instanceId: 'af9c49bd44-8ee624d7',
    commitSha: null,
    state: 'running',
    startedAt: '2026-01-01T00:00:00+08:00',
    finishedAt: null,
    logDir: '/tmp/placeholder',
    instanceAcquiredAt: null,
    gpuSpec: null,
    unitPriceYuanPerHour: null,
    steps: [],
    ...overrides,
  }
}

describe('createRunStore', () => {
  it('建出 runs/<runId>/logs 与 runs/<runId>/screenshots', async () => {
    const fixture = await createFixture()

    const layout = await fixture.store.createLayout('run-1')

    expect(layout.runDirectory).toBe(join(fixture.stateDir, RUNS_DIRECTORY, 'run-1'))
    expect((await stat(layout.logDirectory)).isDirectory()).toBe(true)
    expect((await stat(layout.screenshotDirectory)).isDirectory()).toBe(true)
  })

  it('写进去的记录能原样读回', async () => {
    const fixture = await createFixture()
    const run = makeRun()

    await fixture.store.save(run)

    expect(await fixture.store.read(run.id)).toEqual(run)
  })

  it('读不存在的记录抛 StateFileMissingError，不返回空值', async () => {
    const fixture = await createFixture()

    await expect(fixture.store.read('run-missing')).rejects.toBeInstanceOf(StateFileMissingError)
  })

  it('执行 id 含路径分隔符时抛错，不把记录写到别的目录', async () => {
    const fixture = await createFixture()

    await expect(fixture.store.save(makeRun({ id: '../escape' }))).rejects.toThrow(
      /单段文件名/,
    )
  })

  it('步骤日志落在 logs 目录下，文件名即步骤 id', async () => {
    const fixture = await createFixture()
    const layout = await fixture.store.createLayout('run-1')

    expect(stepLogFilePath(layout, 'deploy-script')).toBe(
      join(fixture.stateDir, RUNS_DIRECTORY, 'run-1', 'logs', 'deploy-script.log'),
    )
  })
})

describe('listForPlan', () => {
  it('按开始时刻升序返回该计划的执行记录，忽略别的计划', async () => {
    // Arrange：两条同一计划的记录，一条带毫秒、一条不带，字典序与真实先后的关系因格式而异。
    const fixture = await createFixture()
    const later = makeRun({
      id: 'run-later',
      planId: 'plan-a',
      startedAt: '2026-01-01T00:10:00.500+08:00',
    })
    const earlier = makeRun({
      id: 'run-earlier',
      planId: 'plan-a',
      startedAt: '2026-01-01T00:10:00+08:00',
    })
    const other = makeRun({ id: 'run-other', planId: 'plan-b' })
    for (const run of [later, other, earlier]) {
      await fixture.store.save(run)
    }

    // Act
    const records = await fixture.store.listForPlan('plan-a')

    // Assert
    expect(records.map((run) => run.id)).toEqual(['run-earlier', 'run-later'])
  })

  it('runs 目录不存在时返回空列表', async () => {
    const fixture = await createFixture()

    expect(await fixture.store.listForPlan('plan-a')).toEqual([])
  })
})
