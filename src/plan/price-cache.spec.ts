import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PowerOnMode } from '../console/ports.js'
import { ConfigError } from '../errors.js'
import type { StateStore } from '../state/ports.js'
import { createStateStore } from '../state/store.js'
import {
  detectPriceDrift,
  readObservedPrice,
  recordObservedPrice,
  resolvePriceSlot,
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
  it('写入后按配置 id 与形态槽读回同样的观测值', async () => {
    // Arrange
    const store = await createStore()

    // Act
    await recordObservedPrice(store, 'trans-dev', 'gpu', OBSERVATION)
    const readBack = await readObservedPrice(store, 'trans-dev', 'gpu')

    // Assert
    expect(readBack).toEqual(OBSERVATION)
  })

  it('落点是 prices/<profileId>-<slot>.jsonc', async () => {
    // Arrange
    const store = await createStore()

    // Act
    await recordObservedPrice(store, 'trans-dev', 'no-gpu', OBSERVATION)
    const filePath = await store.resolve('prices/trans-dev-no-gpu.jsonc')
    const raw: unknown = JSON.parse(await readFile(filePath, 'utf8'))

    // Assert
    expect(raw).toEqual(OBSERVATION)
  })

  it('有卡与无卡各是一个槽：写了一个槽，另一个槽读不到', async () => {
    // Arrange
    const store = await createStore()
    await recordObservedPrice(store, 'trans-dev', 'gpu', OBSERVATION)

    // Act
    const observedInNoGpuSlot = await readObservedPrice(store, 'trans-dev', 'no-gpu')

    // Assert
    expect(observedInNoGpuSlot).toBeNull()
  })

  it('切换形态后各自读回自己的观测值，不相互覆盖', async () => {
    // Arrange
    const store = await createStore()
    const gpuObservation = { ...OBSERVATION, unitPriceYuanPerHour: 2.87 }
    const noGpuObservation = { ...OBSERVATION, unitPriceYuanPerHour: 0.0973 }

    // Act
    await recordObservedPrice(store, 'trans-dev', 'gpu', gpuObservation)
    await recordObservedPrice(store, 'trans-dev', 'no-gpu', noGpuObservation)
    const gpuReadBack = await readObservedPrice(store, 'trans-dev', 'gpu')
    const noGpuReadBack = await readObservedPrice(store, 'trans-dev', 'no-gpu')

    // Assert
    expect(gpuReadBack?.unitPriceYuanPerHour).toBe(2.87)
    expect(noGpuReadBack?.unitPriceYuanPerHour).toBe(0.0973)
  })

  it('没有缓存时返回 null，不抛错', async () => {
    // Arrange
    const store = await createStore()

    // Act
    const cached = await readObservedPrice(store, 'trans-dev', 'gpu')

    // Assert
    expect(cached).toBeNull()
  })

  it('配置 id 或槽名含路径分隔符时拒绝，不写别的路径', async () => {
    // Arrange
    const store = await createStore()

    // Act + Assert
    await expect(recordObservedPrice(store, 'a/b', 'gpu', OBSERVATION)).rejects.toThrow(ConfigError)
    await expect(readObservedPrice(store, '../escape', 'gpu')).rejects.toThrow(ConfigError)
    // 槽名只接受两种开机形态：运行期同样卡一道，不靠类型。
    const escapingSlot = '../escape' as PowerOnMode
    const slashSlot = 'a/b' as PowerOnMode
    await expect(recordObservedPrice(store, 'trans-dev', escapingSlot, OBSERVATION)).rejects.toThrow(
      ConfigError,
    )
    await expect(readObservedPrice(store, 'trans-dev', slashSlot)).rejects.toThrow(ConfigError)
  })
})

describe('旧版缓存迁移', () => {
  it('缺省形态读到旧路径 prices/<profileId>.jsonc 时迁移到新路径', async () => {
    // Arrange：旧版只写了 prices/<profileId>.jsonc。
    const store = await createStore()
    const legacy = { ...OBSERVATION, unitPriceYuanPerHour: 1.58 }
    await store.writeJson('prices/trans-dev.jsonc', legacy)

    // Act
    const readBack = await readObservedPrice(store, 'trans-dev', 'gpu')
    const migratedPath = await store.resolve('prices/trans-dev-gpu.jsonc')
    const migrated: unknown = JSON.parse(await readFile(migratedPath, 'utf8'))

    // Assert
    expect(readBack).toEqual(legacy)
    expect(migrated).toEqual(legacy)
  })

  it('旧文件里内容非法时抛错，不当成没有缓存', async () => {
    // Arrange
    const store = await createStore()
    await store.writeJson('prices/trans-dev.jsonc', { unitPriceYuanPerHour: -1 })

    // Act + Assert
    await expect(readObservedPrice(store, 'trans-dev', 'gpu')).rejects.toThrow()
  })

  it('无卡槽不读旧文件：旧文件只可能是缺省形态的单价', async () => {
    // Arrange
    const store = await createStore()
    await store.writeJson('prices/trans-dev.jsonc', OBSERVATION)

    // Act
    const observedInNoGpuSlot = await readObservedPrice(store, 'trans-dev', 'no-gpu')

    // Assert
    expect(observedInNoGpuSlot).toBeNull()
  })

  it('新路径已有观测时以新路径为准，不被旧文件覆盖', async () => {
    // Arrange
    const store = await createStore()
    await store.writeJson('prices/trans-dev.jsonc', { ...OBSERVATION, unitPriceYuanPerHour: 1 })
    await recordObservedPrice(store, 'trans-dev', 'gpu', {
      ...OBSERVATION,
      unitPriceYuanPerHour: 2,
    })

    // Act
    const readBack = await readObservedPrice(store, 'trans-dev', 'gpu')

    // Assert
    expect(readBack?.unitPriceYuanPerHour).toBe(2)
  })
})

describe('resolvePriceSlot', () => {
  it('实例列表给出实测形态时以实测形态为准', () => {
    // Act + Assert
    expect(resolvePriceSlot({ powerOnMode: 'gpu', instanceNoGpuMode: true })).toBe('no-gpu')
    expect(resolvePriceSlot({ powerOnMode: 'no-gpu', instanceNoGpuMode: false })).toBe('gpu')
  })

  it('拿不到实测形态时按部署配置的 powerOnMode 取槽', () => {
    // Act + Assert
    expect(resolvePriceSlot({ powerOnMode: 'gpu', instanceNoGpuMode: null })).toBe('gpu')
    expect(resolvePriceSlot({ powerOnMode: 'no-gpu', instanceNoGpuMode: null })).toBe('no-gpu')
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
