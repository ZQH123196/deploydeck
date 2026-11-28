import { z } from 'zod'
import type { PowerOnMode } from '../console/ports.js'
import { ConfigError, StateFileMissingError } from '../errors.js'
import type { StateStore } from '../state/ports.js'
import { assertSinglePathSegment } from './plan-store.js'

/**
 * 单价缓存，按开机形态分槽。
 *
 * 新落点 `prices/<profileId>-<slot>.jsonc`，已在 docs/state-layout.md 第 2 节登记。
 * 判据：同一配置在有卡与无卡两种形态下的单价不同源（有卡按 GPU 计，无卡不占 GPU），
 * 把两种形态的价格放进同一个槽比较，偏差必然超过阈值，每次切换形态都会被判成漂移。
 *
 * 单价只能从控制台的定时关机对话框反推（spec 第 7.5 节），每次都要点开对话框。
 * 缓存它是为了给下一次报价留对照：缓存过期或控制台计价口径变了，
 * 偏差判据会把这次观测拦下来，交给人复核。
 */
export const PRICE_CACHE_DIRECTORY = 'prices'

/**
 * 旧版缓存路径 `prices/<profileId>.jsonc` 里那笔观测所属的形态，也是缺省形态。
 *
 * 判据：旧文件没有形态字段，而本改动之前所有观测都在缺省形态下取，
 * 所以旧文件里的单价只可能是缺省形态的单价（实测 2.87 元/时的有卡价）。
 * 迁移目标槽必须是「这笔观测对应的形态」= 缺省形态，不是当前形态：
 * 当前形态是 `no-gpu` 时把有卡价搬进无卡槽，下一次无卡开机必然报漂移，
 * 等于把要修的 bug 换一个位置重新埋一遍。
 * 因此旧文件只在读取缺省形态时读、也只迁移进缺省形态的槽；其它形态不读它。
 */
export const DEFAULT_POWER_ON_MODE: PowerOnMode = 'gpu'

/** 单价缓存槽。取值只有两种开机形态，进状态路径与锁名；形态类型取控制台端口的定义。 */
export type PriceSlot = PowerOnMode

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
  slot: PriceSlot,
): Promise<PriceObservation | null> {
  // 先算路径再碰状态目录：非法入参必须在任何读写之前被拒绝。
  const relativePath = priceCacheRelativePath(profileId, slot)
  // 旧文件只属于缺省形态那一槽：别的形态读它就是把有卡价当成无卡价的对照。
  const legacyPath = isDefaultSlot(slot) ? legacyPriceCacheRelativePath(profileId) : null
  try {
    return await store.readJson(relativePath, PriceObservationSchema)
  } catch (error: unknown) {
    if (!(error instanceof StateFileMissingError)) {
      throw error
    }
  }
  if (legacyPath === null) {
    return null
  }
  let legacyObservation: PriceObservation
  try {
    legacyObservation = await store.readJson(legacyPath, PriceObservationSchema)
  } catch (error: unknown) {
    if (error instanceof StateFileMissingError) {
      return null
    }
    throw error
  }
  // 迁移目标槽由 resolvePriceSlot 给出，只可能是缺省形态那一槽（见 DEFAULT_POWER_ON_MODE）。
  // 只写新路径，不删旧文件：旧文件留着供人核对，删除不是读取方的事。
  await writeObservedPrice(store, relativePath, profileId, slot, legacyObservation)
  return legacyObservation
}

/** 把观测值写回缓存。写入整段在锁内：CLI 与守护进程会同时写同一个配置。 */
export async function recordObservedPrice(
  store: StateStore,
  profileId: string,
  slot: PriceSlot,
  observation: PriceObservation,
): Promise<void> {
  const validated = PriceObservationSchema.parse(observation)
  // 先算路径再取锁：非法入参应当在碰锁之前就被拒绝。
  const relativePath = priceCacheRelativePath(profileId, slot)
  await writeObservedPrice(store, relativePath, profileId, slot, validated)
}

async function writeObservedPrice(
  store: StateStore,
  relativePath: string,
  profileId: string,
  slot: PriceSlot,
  observation: PriceObservation,
): Promise<void> {
  await store.withLock(`price-${profileId}-${slot}`, async () => {
    await store.writeJson(relativePath, observation)
  })
}

/**
 * 一次单价观测所属的缓存槽。
 *
 * 判据：开机形态不同，单价不同源。取实例时已知实际形态时用实测值；
 * 实例还没开机（例如 `plan create` 提前读缓存）时按部署配置的 `powerOnMode`。
 */
export function resolvePriceSlot(input: {
  readonly powerOnMode: PowerOnMode
  readonly instanceNoGpuMode: boolean | null
}): PriceSlot {
  if (input.instanceNoGpuMode !== null) {
    return input.instanceNoGpuMode ? 'no-gpu' : 'gpu'
  }
  return input.powerOnMode
}

/**
 * 单价偏差判据与工单 06 共用一份，定义在 `src/console/timed-shutdown.ts`。
 *
 * 这里只转发导出，plan 侧仍从一个入口取用，避免两份实现随时间漂移。
 * 阈值由调用方传入（20% 传 0.2）；判据是严格大于，偏差正好等于阈值不算漂移。
 */
export { detectPriceDrift } from '../console/timed-shutdown.js'
export type { PriceDriftInput, PriceDriftResult } from '../console/timed-shutdown.js'

function priceCacheRelativePath(profileId: string, slot: PriceSlot): string {
  // 配置 id 会拼进状态路径，必须是单段文件名；槽的合法性由 assertPriceSlot 卡。
  assertSinglePathSegment(profileId, '部署配置 id')
  assertPriceSlot(slot)
  return `${PRICE_CACHE_DIRECTORY}/${profileId}-${slot}.jsonc`
}

/**
 * 槽必须落在 `PriceSlot` 的闭合取值集合内。
 *
 * 判据：TypeScript 的类型在运行期不存在，锁名与状态路径都由它拼成。运行期不卡这一道，
 * 带斜杠或 `..` 的槽名会落进别的路径，或者落进别的作用域。
 */
function assertPriceSlot(slot: PriceSlot): void {
  if (slot !== 'gpu' && slot !== 'no-gpu') {
    assertFailedSlotName(slot)
  }
}

function assertFailedSlotName(slot: unknown): never {
  throw new ConfigError(
    `单价缓存槽必须是 ${PRICE_SLOT_VALUES.join(' 或 ')}，当前值：${JSON.stringify(slot)}。`,
  )
}

/** 单测与错误信息共用的一份取值清单，不各写一遍。 */
export const PRICE_SLOT_VALUES: readonly PriceSlot[] = ['gpu', 'no-gpu']

function legacyPriceCacheRelativePath(profileId: string): string {
  assertSinglePathSegment(profileId, '部署配置 id')
  return `${PRICE_CACHE_DIRECTORY}/${profileId}.jsonc`
}

function isDefaultSlot(slot: PriceSlot): boolean {
  return slot === DEFAULT_POWER_ON_MODE
}
