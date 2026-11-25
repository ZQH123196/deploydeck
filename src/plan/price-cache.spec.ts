import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../errors.js'
import type { StateStore } from '../state/ports.js'
import { createStateStore } from '../state/store.js'
import {
  detectPriceDrift,
  readObservedPrice,
  recordObservedPrice,
} from './price-cache.js'

/**
 * 工单 09 的单价缓存与偏差判据夹具。
 *
 * 状态存储用临时目录里的真实实现（`.tmp/` 下）。偏差判据是纯函数，不需要 IO。
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

async function createStore(): Promise<StateStore> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'price-cache-spec-'))
  temporaryParents.push(parent)
  return createStateStore({
    stateDir: join(parent, 'state'),
    configDir: join(parent, 'config'),
    lockTimeoutMs: 2000,
    lockRetryIntervalMs: 2,
  })
}

const OBSERVATION = {
  unitPriceYuanPerHour: 1.58,
  observedAt: '2026-01-01T00:00:00+08:00',
  gpuSpec: 'vGPU-32GB * 1卡',
}

describe('单价缓存', () => {
  it('写入后可按配置 id 读回同样的观测值', async () => {
    // Arrange
    const store = await createStore()

    // Act
    await recordObservedPrice(store, 'trans-dev', OBSERVATION)
    const readBack = await readObservedPrice(store, 'trans-dev')

    // Assert
    expect(readBack).toEqual(OBSERVATION)
  })

  it('落点是 prices/<profileId>.jsonc', async () => {
    // Arrange
    const store = await createStore()

    // Act
    await recordObservedPrice(store, 'trans-dev', OBSERVATION)
    const filePath = await store.resolve('prices/trans-dev.jsonc')
    const raw: unknown = JSON.parse(await readFile(filePath, 'utf8'))

    // Assert
    expect(raw).toEqual(OBSERVATION)
  })

  it('没有缓存时返回 null，不抛错', async () => {
    // Arrange
    const store = await createStore()

    // Act
    const cached = await readObservedPrice(store, 'trans-dev')

    // Assert
    expect(cached).toBeNull()
  })

  it('配置 id 含路径分隔符时拒绝，不写别的路径', async () => {
    // Arrange
    const store = await createStore()

    // Act + Assert
    await expect(recordObservedPrice(store, 'a/b', OBSERVATION)).rejects.toThrow(ConfigError)
    await expect(readObservedPrice(store, '../escape')).rejects.toThrow(ConfigError)
  })
})

describe('detectPriceDrift', () => {
  it('偏差 10% 时不报', () => {
    // Arrange
    const input = { cachedYuanPerHour: 10, observedYuanPerHour: 11, thresholdRatio: 0.2 }

    // Act
    const result = detectPriceDrift(input)

    // Assert
    expect(result).toEqual({ drifted: false })
  })

  it('偏差 25% 时报告，错误信息说明两个单价与偏差', () => {
    // Arrange
    const input = { cachedYuanPerHour: 10, observedYuanPerHour: 12.5, thresholdRatio: 0.2 }

    // Act
    const result = detectPriceDrift(input)

    // Assert
    expect(result.drifted).toBe(true)
    if (!result.drifted) {
      throw new Error('期望判定为单价漂移')
    }
    expect(result.ratio).toBe(0.25)
    // 文案由工单 06 的实现给出。本工单要求的「历史单价/本次单价/请复核后清理缓存」
    // 措辞与其不一致，已在交接报告说明，这里只锁可观测事实。
    expect(result.message).toContain('12.5 元/时')
    expect(result.message).toContain('10 元/时')
    expect(result.message).toContain('偏差 25.0%')
  })

  it('偏差正好等于阈值 20% 时不报（判据是严格大于）', () => {
    // Arrange
    const input = { cachedYuanPerHour: 10, observedYuanPerHour: 12, thresholdRatio: 0.2 }

    // Act
    const result = detectPriceDrift(input)

    // Assert
    expect(result).toEqual({ drifted: false })
  })

  it.each([
    ['缓存单价为零', { cachedYuanPerHour: 0, observedYuanPerHour: 1, thresholdRatio: 0.2 }],
    ['缓存单价为负', { cachedYuanPerHour: -1, observedYuanPerHour: 1, thresholdRatio: 0.2 }],
    ['本次单价为负', { cachedYuanPerHour: 3, observedYuanPerHour: -1, thresholdRatio: 0.2 }],
    ['阈值为零', { cachedYuanPerHour: 3, observedYuanPerHour: 3.6, thresholdRatio: 0 }],
    ['阈值大于 1', { cachedYuanPerHour: 3, observedYuanPerHour: 3.6, thresholdRatio: 1.5 }],
    ['阈值不是数字', { cachedYuanPerHour: 3, observedYuanPerHour: 3.6, thresholdRatio: Number.NaN }],
  ])('非法入参抛 RangeError：%s', (_label, input) => {
    // Act + Assert
    expect(() => detectPriceDrift(input)).toThrow(RangeError)
  })
})
