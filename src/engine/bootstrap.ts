import { z } from 'zod'
import { ConfigError, StateFileMissingError } from '../errors.js'
import type { StateStore } from '../state/ports.js'
import { assertSinglePathSegment } from '../plan/plan-store.js'

/**
 * 一次性引导的落盘记录。
 *
 * 判据（工单 B3）：引导只在实例首次就绪时跑一次，重启不重跑。
 * 「跑过没有」必须是一个可查的落盘事实，不能靠进程内存：`run` 每次都是新进程，
 * 内存状态在进程退出时就没了，第二次执行会把一次几十分钟的模型下载再跑一遍。
 *
 * 落点 `bootstrap/<instanceId>.jsonc`，已在 docs/state-layout.md 第 2 节登记。
 *
 * 记录在**引导成功后**才写。判据：失败与超时都不能被记成「已跑过」。
 * 引导失败时实例会留着（执行引擎把「实例到手后的失败」统一落 `stray`，
 * `destroy-container` 策略下也不再销毁），人可以进去看现场；
 * 修好原因后再跑一次 `run` 会重新执行引导，因为记录没写、日志在上一轮的 run 目录里没被覆盖。
 */

export const BOOTSTRAP_DIRECTORY = 'bootstrap'

/**
 * 引导记录 schema。
 *
 * `profileId` 与 `projectId` 是判据的一部分：同一个实例被换了部署配置或项目之后，
 * 老记录不能再当作「这个项目已经装好了」。判据不匹配即视为没跑过，重跑一次。
 */
export const BootstrapRecordSchema = z.object({
  instanceId: z.string().min(1),
  profileId: z.string().min(1),
  projectId: z.string().min(1),
  /** 引导脚本的仓库内相对路径。换了脚本即视为没跑过。 */
  script: z.string().min(1),
  /** 记录封口时刻，北京时间 ISO。 */
  finishedAt: z.string().min(1),
  /** 引导进程的退出码。只记 0 的记录：非 0 时不写记录。 */
  exitCode: z.number().int(),
})

export type BootstrapRecord = z.infer<typeof BootstrapRecordSchema>

/** 一次引导是否已经跑过的判定输入。 */
export interface BootstrapIdentity {
  readonly instanceId: string
  readonly profileId: string
  readonly projectId: string
  readonly script: string
}

/** 判定结果。`reason` 只在没跑过时给出，用于把人读输出与日志写清楚。 */
export type BootstrapState =
  | { readonly kind: 'not-run'; readonly reason: 'no-record' | 'identity-mismatch' }
  | { readonly kind: 'done'; readonly record: BootstrapRecord }

/** 引导记录的相对路径。实例 ID 会拼进状态路径，必须是单段文件名。 */
export function bootstrapRecordPath(instanceId: string): string {
  assertSinglePathSegment(instanceId, '实例 ID')
  return `${BOOTSTRAP_DIRECTORY}/${instanceId}.jsonc`
}

/**
 * 读一次引导的状态。
 *
 * 文件不存在 = 没跑过。文件存在但身份不匹配 = 没跑过（换配置或换项目）。
 * 文件损坏即抛错，不当作「没跑过」：损坏的记录说明有人手工改过或写盘中断，
 * 静默重跑一次几十分钟的引导会把真正的状态问题盖掉。
 */export async function readBootstrapState(
  store: StateStore,
  identity: BootstrapIdentity,
): Promise<BootstrapState> {
  const relativePath = bootstrapRecordPath(identity.instanceId)
  let record: BootstrapRecord
  try {
    record = await store.readJson(relativePath, BootstrapRecordSchema)
  } catch (error: unknown) {
    // 文件不存在就是没跑过。这是唯一一种「没跑过」的自动判定。
    if (error instanceof StateFileMissingError) {
      return { kind: 'not-run', reason: 'no-record' }
    }
    throw error
  }
  if (
    record.instanceId !== identity.instanceId ||
    record.profileId !== identity.profileId ||
    record.projectId !== identity.projectId ||
    record.script !== identity.script
  ) {
    return { kind: 'not-run', reason: 'identity-mismatch' }
  }
  return { kind: 'done', record }
}

/**
 * 写引导记录。只允许写退出码为 0 的记录。
 *
 * 判据：失败的引导不能被记成已跑过。实例不会因此消失（执行引擎把「实例到手后的失败」
 * 统一落 `stray`），现场留在上一轮的 `runs/<runId>/logs/bootstrap-script.log` 里，
 * 人修好原因后重跑 `run` 时引导会重新执行。
 */
export async function writeBootstrapRecord(
  store: StateStore,
  record: BootstrapRecord,
): Promise<void> {
  const validated = BootstrapRecordSchema.parse(record)
  if (validated.exitCode !== 0) {
    throw new ConfigError(
      `引导记录的退出码必须是 0，当前值：${String(validated.exitCode)}。` +
        '失败的引导必须能在下一次执行时重跑，不能被记成已跑过。',
    )
  }
  const relativePath = bootstrapRecordPath(validated.instanceId)
  await store.withLock(`bootstrap-${validated.instanceId}`, async () => {
    await store.writeJson(relativePath, validated)
  })
}
