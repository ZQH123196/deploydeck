import { readdir } from 'node:fs/promises'
import { PlanSchema, type Plan } from '../domain/plan.js'
import { ConfigError, PlanInvalidError, StateFileMissingError } from '../errors.js'
import type { StateStore } from '../state/ports.js'
import { parseIso } from '../util/time.js'
import { isErrnoCode } from '../util/validate.js'

/**
 * 计划落盘目录。落点约定见 docs/state-layout.md 第 2 节。
 *
 * 一份计划一份文件：`plans/<planId>.jsonc`。机器写，人只读。
 */
export const PLANS_DIRECTORY = 'plans'

const PLAN_FILE_SUFFIX = '.jsonc'

/**
 * 计划结算锁名。
 *
 * `recordSpent` 与 `teardown` 的「写账本 + 改计划」共用这一把锁：两条路径都会
 * 读-改-写整份计划，锁名不同时后写者会拿旧快照覆盖先写者刚写的状态（例如把
 * 刚 closed 的计划写回 active）。CLI 与守护进程并发时这条判据才成立。
 */
export function planSettlementLockName(planId: string): string {
  assertSinglePathSegment(planId, '计划 id')
  return `plan-settle-${planId}`
}

/** 计划的读写。 */
export interface PlanStore {
  /**
   * 写一份新计划。
   *
   * 整段写在锁内：同一份计划的写入不允许与守护进程交错。
   */
  create(plan: Plan): Promise<void>
  /** 按 id 读一份计划。文件不存在即抛 `StateFileMissingError`。 */
  read(planId: string): Promise<Plan>
  /**
   * 整份重写一份已存在的计划。
   *
   * 只用于改计划自己被允许变的字段：`state`（ESCALATED）与 `instanceId`（绑定实例）。
   * 计划不存在即抛错：凭空写出一份计划等于绕过 `plan create` 的校验。
   */
  save(plan: Plan): Promise<void>
  /**
   * 列出仍生效的计划：`state` 为 `active` 且 `expiresAt` 晚于 `now`。
   *
   * 过期判定以传入的时钟为准，存储层不读本机时钟。
   */
  listActive(now: Date): Promise<readonly Plan[]>
  /**
   * 列出全部计划，不做过期过滤。
   *
   * 守护进程要处理「状态还是 active、但已经过期」的计划：`listActive` 会把它们滤掉，
   * 恰好漏掉需要销毁的那一批。损坏的计划文件仍然抛错，不跳过。
   */
  listAll(): Promise<readonly Plan[]>
  /**
   * 把一笔已封口的金额记回计划（先读、加、再写，整段在锁内完成）。
   *
   * 账本是事实，计划上的 `spentYuan` 是它的投影。不投影，预算复核永远读到 0，
   * 同一份计划跑第二次时第一次烧掉的钱在预算里看不见。
   */
  recordSpent(planId: string, amountYuan: number): Promise<Plan>
}

export function createPlanStore(store: StateStore): PlanStore {
  return {
    create: async (plan) => {
      // 先按 schema 校验再落盘：坏数据一写进状态目录就再也修不回来。
      const validated = PlanSchema.parse(plan)
      const relativePath = planRelativePath(validated.id)
      await store.withLock(`plan-${validated.id}`, async () => {
        // 同一 id 的计划已存在时拒绝覆盖：覆盖会丢掉已花费金额，账对不上。
        // id 由时间戳加随机后缀生成，撞号概率极低，但绝不允许静默覆盖。
        try {
          await store.readJson(relativePath, PlanSchema)
        } catch (error: unknown) {
          if (!(error instanceof StateFileMissingError)) {
            throw error
          }
          await store.writeJson(relativePath, validated)
          return
        }
        throw new PlanInvalidError(`计划 id 已存在：${validated.id}，拒绝覆盖已有计划。`)
      })
    },

    read: async (planId) => store.readJson(planRelativePath(planId), PlanSchema),

    save: async (plan) => {
      const validated = PlanSchema.parse(plan)
      const relativePath = planRelativePath(validated.id)
      // 同一份计划的写入不允许与守护进程交错。
      await store.withLock(`plan-${validated.id}`, async () => {
        // 先确认计划存在：读缺失会抛 StateFileMissingError，让「写出一份不存在的计划」失败。
        await store.readJson(relativePath, PlanSchema)
        await store.writeJson(relativePath, validated)
      })
    },

    listAll: async () => {
      return await readAllPlans(store)
    },

    listActive: async (now) => {
      // 目录不存在表示还没创建过计划，这是合法的空集。解析或 schema 失败仍然抛错，
      // 不能把损坏的状态文件当成「没有计划」。
      const directoryPath = await store.resolve(PLANS_DIRECTORY)
      let fileNames: string[]
      try {
        fileNames = await readdir(directoryPath)
      } catch (error: unknown) {
        if (isErrnoCode(error, 'ENOENT')) {
          return []
        }
        throw error
      }

      const nowMillis = now.getTime()
      const activePlans: Plan[] = []
      // 文件名即计划 id，按名字排序让输出稳定，不依赖文件系统的目录顺序。
      for (const fileName of fileNames.sort()) {
        if (!fileName.endsWith(PLAN_FILE_SUFFIX)) {
          continue
        }
        const plan = await store.readJson(`${PLANS_DIRECTORY}/${fileName}`, PlanSchema)
        if (plan.state !== 'active') {
          continue
        }
        if (parseIso(plan.expiresAt).getTime() <= nowMillis) {
          continue
        }
        activePlans.push(plan)
      }
      return activePlans
    },

    recordSpent: async (planId, amountYuan) => {
      if (!Number.isFinite(amountYuan) || amountYuan < 0) {
        throw new RangeError(`记回计划的金额必须是非负有限数：${String(amountYuan)}`)
      }
      const relativePath = planRelativePath(planId)
      // 读、加、写整段在同一把锁内：两个进程同时结算同一份计划时不会只记上其中一笔。
      // 锁名与 teardown 的结算动作相同，避免两边用各自的旧快照互相覆盖。
      return store.withLock(planSettlementLockName(planId), async () => {
        const plan = await store.readJson(relativePath, PlanSchema)
        const updated = PlanSchema.parse({ ...plan, spentYuan: plan.spentYuan + amountYuan })
        await store.writeJson(relativePath, updated)
        return updated
      })
    },
  }
}

/** 读 plans 目录下的全部计划。目录不存在表示还没有创建过计划，是合法的空集。 */
async function readAllPlans(store: StateStore): Promise<readonly Plan[]> {
  const directoryPath = await store.resolve(PLANS_DIRECTORY)
  let fileNames: string[]
  try {
    fileNames = await readdir(directoryPath)
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) {
      return []
    }
    throw error
  }
  const plans: Plan[] = []
  for (const fileName of fileNames.sort()) {
    if (!fileName.endsWith(PLAN_FILE_SUFFIX)) {
      continue
    }
    plans.push(await store.readJson(`${PLANS_DIRECTORY}/${fileName}`, PlanSchema))
  }
  return plans
}

function planRelativePath(planId: string): string {
  assertSinglePathSegment(planId, '计划 id')
  return `${PLANS_DIRECTORY}/${planId}${PLAN_FILE_SUFFIX}`
}

/**
 * 计划 id 与配置 id 都会拼进状态路径与锁名，必须是单段文件名。
 *
 * 状态存储本身拒绝越界路径，但 `plans//etc/passwd.jsonc` 这类带斜杠的 id
 * 会被归一成状态目录内的嵌套路径，看起来像读到了别的计划。这里提前拒绝。
 */
export function assertSinglePathSegment(value: string, label: string): void {
  if (value.length === 0) {
    throw new ConfigError(`${label}不能为空。`)
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new ConfigError(`${label}必须是单段文件名，不能包含路径分隔符：${JSON.stringify(value)}`)
  }
  if (value === '.' || value === '..') {
    throw new ConfigError(`${label}不能是 . 或 ..：${value}`)
  }
}

