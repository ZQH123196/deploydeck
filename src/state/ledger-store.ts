import { StateFileMissingError } from '../errors.js'
import { LedgerEntrySchema, type LedgerEntry } from './ledger.js'
import type { StateStore } from './ports.js'

/** 账本固定落在状态目录根下。一行一个实例生命周期。 */
export const LEDGER_RELATIVE_PATH = 'ledger.jsonl'

/**
 * 一次账本读取的显式状态。
 *
 * 判据（docs/state-layout.md 第 7 节）：空账本与账本文件丢失必须能区分。
 * 账本按需创建：从没有实例生命周期结算过时文件不存在，这不是错误；
 * 但调用方必须知道「没有文件」这个事实，才能发现账本被误删。
 */
export type LedgerSnapshot =
  | { readonly status: 'missing' }
  | { readonly status: 'present'; readonly entries: readonly LedgerEntry[] }

/** 账本。只追加，不重写。 */
export interface LedgerStore {
  /** 追加一行。写入前按 schema 校验，坏行一落盘就再也修不回来。 */
  append(entry: LedgerEntry): Promise<void>
  /**
   * 读全部行，逐行按 schema 校验。文件不存在即抛 `StateFileMissingError`。
   *
   * 只用于「文件必须存在」的场合。需要区分缺失与为空时用 `readSnapshot`。
   */
  readAll(): Promise<readonly LedgerEntry[]>
  /** 读全部行；文件不存在翻译成显式状态 `missing`，不伪装成空账本。 */
  readSnapshot(): Promise<LedgerSnapshot>
}

/**
 * 创建账本存储。
 *
 * 只追加的语义由底层 `appendJsonLine` 的 O_APPEND 保证：并发追加不会覆盖旧行。
 * 一行写坏时读取会指出行号并抛错，不跳过。
 */
export function createLedgerStore(store: StateStore): LedgerStore {
  return {
    append: async (entry) => {
      const validated = LedgerEntrySchema.parse(entry)
      await store.appendJsonLine(LEDGER_RELATIVE_PATH, validated)
    },
    readAll: async () => store.readJsonLines(LEDGER_RELATIVE_PATH, LedgerEntrySchema),
    readSnapshot: async () => {
      try {
        return {
          status: 'present',
          entries: await store.readJsonLines(LEDGER_RELATIVE_PATH, LedgerEntrySchema),
        }
      } catch (error: unknown) {
        if (error instanceof StateFileMissingError) {
          return { status: 'missing' }
        }
        throw error
      }
    },
  }
}
