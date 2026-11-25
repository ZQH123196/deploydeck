import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { RunSchema, type Run } from '../domain/run.js'
import { assertSinglePathSegment } from '../plan/plan-store.js'
import type { StateStore } from '../state/ports.js'
import { parseIso } from '../util/time.js'
import { isErrnoCode } from '../util/validate.js'

/**
 * 执行记录的落盘位置。
 *
 * 落点约定见 docs/state-layout.md 第 2 节：
 * `runs/<runId>.jsonc` 是记录，`runs/<runId>/logs/` 放每步完整输出，
 * `runs/<runId>/screenshots/` 放控制台动作截图。容器消失后，这里是人唯一的现场。
 */
export const RUNS_DIRECTORY = 'runs'

const RUN_FILE_SUFFIX = '.jsonc'
const LOGS_DIRECTORY = 'logs'
const SCREENSHOTS_DIRECTORY = 'screenshots'

/** 一次执行的目录布局。全部是绝对路径，直接交给 SSH 通道与日志写入用。 */
export interface RunLayout {
  readonly runId: string
  /** `runs/<runId>` 的绝对路径。 */
  readonly runDirectory: string
  /** `runs/<runId>/logs` 的绝对路径。 */
  readonly logDirectory: string
  /** `runs/<runId>/screenshots` 的绝对路径。 */
  readonly screenshotDirectory: string
}

/**
 * 执行的读写。
 *
 * 一个执行一份记录文件。写整份文件而不是就地改字段：JSONC 没有就地改写的原子语义，
 * 整份重写在锁内完成，读到的要么是旧的完整版本，要么是新的完整版本。
 */
export interface RunStore {
  /**
   * 状态存储。单价缓存的读写也经它，保证整个执行引擎只认一个状态目录。
   *
   * 不额外注入第二个 `StateStore`：两个实例指向不同目录时，日志与单价缓存会落到两个地方。
   */
  readonly stateStore: StateStore
  /** 建 `runs/<runId>/logs/` 与 `runs/<runId>/screenshots/`，返回绝对路径。目录已存在时不报错。 */
  createLayout(runId: string): Promise<RunLayout>
  /** 读 `runs/<runId>.jsonc`。文件不存在即抛 `StateFileMissingError`。 */
  read(runId: string): Promise<Run>
  /**
   * 列出属于某个计划的全部执行记录，按 `startedAt` 升序。
   *
   * `teardown` 靠它找到绑定该实例的那次执行：账本要取该次执行的实例到手时刻、规格与单价。
   * runs 目录不存在视为空集（还没执行过）；某份记录损坏仍然抛错，不跳过。
   */
  listForPlan(planId: string): Promise<readonly Run[]>
  /** 锁内整份重写 `runs/<runId>.jsonc`。写入前按 schema 校验。 */
  save(run: Run): Promise<void>
}

export function createRunStore(store: StateStore): RunStore {
  return {
    stateStore: store,

    createLayout: async (runId) => {
      assertSinglePathSegment(runId, '执行 id')
      // resolve 只建父目录（它是给文件用的），目录本身要显式建。
      // 路径先经 store.resolve 校验：越界与配置目录内的路径在这里就被拒。
      const runDirectory = await store.resolve(runRelativeDirectory(runId))
      const logDirectory = await store.resolve(`${runRelativeDirectory(runId)}/${LOGS_DIRECTORY}`)
      const screenshotDirectory = await store.resolve(
        `${runRelativeDirectory(runId)}/${SCREENSHOTS_DIRECTORY}`,
      )
      await mkdir(logDirectory, { recursive: true })
      await mkdir(screenshotDirectory, { recursive: true })
      return { runId, runDirectory, logDirectory, screenshotDirectory }
    },

    read: async (runId) => {
      assertSinglePathSegment(runId, '执行 id')
      return store.readJson(runRelativePath(runId), RunSchema)
    },

    listForPlan: async (planId) => {
      const directoryPath = await store.resolve(RUNS_DIRECTORY)
      let fileNames: string[]
      try {
        fileNames = await readdir(directoryPath)
      } catch (error: unknown) {
        if (isErrnoCode(error, 'ENOENT')) {
          return []
        }
        throw error
      }

      const records: Run[] = []
      // 文件名即执行 id，排序让输出稳定，不依赖文件系统目录顺序。
      for (const fileName of fileNames.sort()) {
        if (!fileName.endsWith(RUN_FILE_SUFFIX)) {
          continue
        }
        const run = await store.readJson(`${RUNS_DIRECTORY}/${fileName}`, RunSchema)
        if (run.planId === planId) {
          records.push(run)
        }
      }
      // 按真实时刻排序，不按字符串：秒级与毫秒级两种 ISO 形状的字典序与实际先后不一致。
      return records.sort((left, right) => {
        const delta = parseIso(left.startedAt).getTime() - parseIso(right.startedAt).getTime()
        return delta !== 0 ? delta : left.id.localeCompare(right.id)
      })
    },

    save: async (run) => {
      // 先校验再落盘：坏数据一写进状态目录就再也修不回来。
      const validated = RunSchema.parse(run)
      const relativePath = runRelativePath(validated.id)
      // 锁名按执行分：同一次执行的写入互斥，不同执行之间不必排队。
      await store.withLock(`run-${validated.id}`, async () => {
        await store.writeJson(relativePath, validated)
      })
    },
  }
}

/** 某一步的日志文件绝对路径。SSH 通道把完整输出写到这里，Run 记录里也记它。 */
export function stepLogFilePath(layout: RunLayout, stepId: string): string {
  // 步骤 id 直接拼进文件名，必须是单段文件名。
  assertSinglePathSegment(stepId, '步骤 id')
  return join(layout.logDirectory, `${stepId}.log`)
}

function runRelativeDirectory(runId: string): string {
  return `${RUNS_DIRECTORY}/${runId}`
}

function runRelativePath(runId: string): string {
  return `${runRelativeDirectory(runId)}${RUN_FILE_SUFFIX}`
}

