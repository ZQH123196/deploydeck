import { z } from 'zod'

/**
 * 账本一行。每次实例生命周期写一行，只追加，不修改。
 *
 * 字段含义见 docs/specs/deploydeck-phase2.md 第 11.4 节。
 */
export const LedgerEntrySchema = z.object({
  planId: z.string().min(1),
  runId: z.string().min(1),
  instanceId: z.string().min(1),
  gpuSpec: z.string().min(1),
  startedAt: z.string().min(1),
  stoppedAt: z.string().min(1),
  unitPriceYuanPerHour: z.number().nonnegative(),
  amountYuan: z.number().nonnegative(),
})

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>
