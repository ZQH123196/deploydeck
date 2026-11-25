import { z } from 'zod'
import { StateFileMissingError } from '../errors.js'
import type { StateStore } from '../state/ports.js'
import { assertSinglePathSegment } from './plan-store.js'

/**
 * 单价缓存。落点 `prices/<profileId>.jsonc`，已在 docs/state-layout.md 第 2 节登记。
 *
 * 单价只能从控制台的定时关机对话框反推（spec 第 7.5 节），每次都要点开对话框。
 * 缓存它是为了给下一次报价留对照：缓存过期或控制台计价口径变了，
 * 偏差判据会把这次观测拦下来，交给人复核。
 */
export const PRICE_CACHE_DIRECTORY = 'prices'

/**
 * 一次单价观测。
 *
 * 观测时刻取控制台对话框显示的服务器时间，不用本机时钟：spec 第 7.4 节规定
 * 时间基准以服务器时间为准，本机时钟可能偏。
 */
export const PriceObservationSchema = z.object({
  /** 反推的单价，元/小时。 */
  unitPriceYuanPerHour: z.number().nonnegative(),
  /** 观测时刻，北京时间 ISO 串。 */
  observedAt: z.string().min(1),
  /** 观测时选用的算力规格。 */
  gpuSpec: z.string().min(1),
})

export type PriceObservation = z.infer<typeof PriceObservationSchema>

/**
 * 读缓存单价。
 *
 * 没有缓存表示还没观测过，是合法的首次状态，返回 `null`。
 * 文件存在但内容非法仍然抛错：缓存坏了不能当成「没有缓存」。
 */
export async function readObservedPrice(
  store: StateStore,
  profileId: string,
): Promise<PriceObservation | null> {
  try {
    return await store.readJson(priceCacheRelativePath(profileId), PriceObservationSchema)
  } catch (error: unknown) {
    if (error instanceof StateFileMissingError) {
      return null
    }
    throw error
  }
}

/** 把观测值写回缓存。写入整段在锁内：CLI 与守护进程会同时写同一个配置。 */
export async function recordObservedPrice(
  store: StateStore,
  profileId: string,
  observation: PriceObservation,
): Promise<void> {
  const validated = PriceObservationSchema.parse(observation)
  // 先算路径再取锁：非法 id 应当在碰锁之前就被拒绝。
  const relativePath = priceCacheRelativePath(profileId)
  await store.withLock(`price-${profileId}`, async () => {
    await store.writeJson(relativePath, validated)
  })
}

/**
 * 单价偏差判据与工单 06 共用一份，定义在 `src/console/timed-shutdown.ts`。
 *
 * 这里只转发导出，plan 侧仍从一个入口取用，避免两份实现随时间漂移。
 * 阈值由调用方传入（20% 传 0.2）；判据是严格大于，偏差正好等于阈值不算漂移。
 */
export { detectPriceDrift } from '../console/timed-shutdown.js'
export type { PriceDriftInput, PriceDriftResult } from '../console/timed-shutdown.js'

function priceCacheRelativePath(profileId: string): string {
  // 配置 id 会拼进状态路径与锁名，必须是单段文件名。
  assertSinglePathSegment(profileId, '部署配置 id')
  return `${PRICE_CACHE_DIRECTORY}/${profileId}.jsonc`
}
