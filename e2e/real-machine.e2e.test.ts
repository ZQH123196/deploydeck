import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ConsoleInstanceSnapshot } from '../src/domain/instance.js'
import type { Provider } from '../src/providers/provider.js'
import { addMinutesIso, beijingIso } from '../src/util/time.js'
import {
  estimateTotalYuan,
  formatApprovalBanner,
  readE2eConfig,
  type E2eConfig,
} from './support/gate.js'
import {
  createE2eRecorder,
  formatE2eReport,
  type E2eCaseRecord,
  type E2eRecorder,
} from './support/report.js'
import { createE2eWorkDir, openE2eRuntime, type E2eRuntime } from './support/runtime.js'

/**
 * 真机端到端测试（耗费测试）。
 *
 * 判据（AGENTS.md 测试规范 4.1 / 4.2）：这些用例会真的开关机、克隆与释放实例，
 * 产生真实费用，所以：
 *
 * - 不在 `pnpm test` 里跑，只走 `pnpm test:e2e`（`vitest.e2e.config.ts`）。
 * - 跑之前必须过 `e2e/support/gate.ts` 的授权闸门：三个环境变量缺一个就拒绝。
 * - 只碰两个对象：`DEPLOYDECK_E2E_SOURCE_INSTANCE` 指定的那一台，以及它自己克隆出来的实例。
 * - 失败也要清理：`afterAll` 负责释放克隆产物、关掉源实例。
 *
 * 用例顺序有依赖：克隆要求源实例已关机，所以先跑开关机与定时关机。
 */

/** 定时关机用例等待到点关机的上限。设 2 分钟后关，给 8 分钟余量。 */
const TIMED_SHUTDOWN_WAIT_MS = 8 * 60 * 1000

/** 定时关机相对服务器时间的提前量，分钟。 */
const TIMED_SHUTDOWN_LEAD_MINUTES = 2

/** 克隆用例的超时。实测约 7 分钟，给到 45 分钟。 */
const CLONE_CASE_TIMEOUT_MS = 45 * 60 * 1000

let config: E2eConfig
let runtime: E2eRuntime
let recorder: E2eRecorder
let startedAt: string
/** 本测试创建的实例。清理时逐个释放。 */
const createdInstanceIds: string[] = []

/** 把控制台的占用原文（`55.97%`）解析成数值。解析不出返回 undefined。 */
export function parseUsedPercent(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(text.trim())
  if (match === null) {
    return undefined
  }
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

/** 数据盘拷到这个比例（相对源实例占用）就算拷完。留 10% 余量吸收平台四舍五入。 */
const DATA_DISK_COPY_RATIO = 0.9

/**
 * 等数据盘真的拷完。
 *
 * 真机实测（2026-11-25）：「状态离开克隆锁定中」**不等于**数据盘拷完。
 * 容器先起来、状态先变运行中，数据盘的拷贝在后台继续推进，
 * 同一台实例看到过 3.38% → 36.27% → 55.84%（源 55.97%）。
 *
 * 判据：数据盘占用达到源实例占用的 90% 以上。只断言「不是 0」会漏掉拷贝没完成的情况。
 */
async function waitForDataDiskCopy(
  instanceId: string,
  sourceDataDiskText: string,
  timeoutMs: number,
): Promise<ConsoleInstanceSnapshot> {
  const sourcePercent = parseUsedPercent(sourceDataDiskText)
  if (sourcePercent === undefined) {
    throw new Error(`源实例的数据盘占用读不出百分比：${JSON.stringify(sourceDataDiskText)}`)
  }
  const target = sourcePercent * DATA_DISK_COPY_RATIO
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const snapshots = await runtime.provider.listInstances({ refresh: true })
    const clone = findInstance(snapshots, instanceId)
    if (clone === undefined) {
      throw new Error(`轮询数据盘拷贝进度时实例 ${instanceId} 已不在列表里。`)
    }
    last = `${clone.systemDiskUsed} / ${clone.dataDiskUsed}`
    const current = parseUsedPercent(clone.dataDiskUsed)
    if (current !== undefined && current >= target) {
      return clone
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20_000)
    })
  }
  throw new Error(
    `新实例 ${instanceId} 的数据盘在 ${String(timeoutMs)}ms 内没有拷到源实例的 ${String(
      Math.round(DATA_DISK_COPY_RATIO * 100),
    )}%（源 ${sourceDataDiskText}，需要 >= ${target.toFixed(2)}%，最后读到 ${last}）。`,
  )
}

function findInstance(
  snapshots: readonly ConsoleInstanceSnapshot[],
  instanceId: string,
): ConsoleInstanceSnapshot | undefined {
  return snapshots.find((snapshot) => snapshot.instanceId === instanceId)
}

async function readBalanceYuan(provider: Provider): Promise<number | null> {
  try {
    return await provider.readBalance()
  } catch {
    // 余额读不到不阻塞用例：报告里显示为「读不到」，不冒充 0。
    return null
  }
}

/**
 * 跑一个用例并记账。
 *
 * 余额前后各读一次，差额封口成一条记录。按量计费不是逐秒结算，
 * 所以差额可能小于真实花费；报告里同时给耗时与说明，供人对照。
 */
async function runCase(caseName: string, body: () => Promise<string>): Promise<void> {
  const before = await readBalanceYuan(runtime.provider)
  const caseStartedAt = new Date().toISOString()
  const beginMs = Date.now()
  let note = ''
  try {
    note = await body()
  } finally {
    const after = await readBalanceYuan(runtime.provider)
    const costYuan =
      before === null || after === null ? null : Math.round((before - after) * 100) / 100
    const record: E2eCaseRecord = {
      caseName,
      startedAt: caseStartedAt,
      durationMs: Date.now() - beginMs,
      balanceBeforeYuan: before,
      balanceAfterYuan: after,
      costYuan,
      note,
    }
    recorder.recordCase(record)
  }
}

describe('真机端到端（耗费测试）', () => {
  beforeAll(async () => {
    config = readE2eConfig()
    process.stdout.write(`${formatApprovalBanner(config)}\n`)
    const workDir = await createE2eWorkDir(config.cdpPort)
    runtime = await openE2eRuntime(workDir, config.cdpPort)
    recorder = createE2eRecorder(workDir)
    startedAt = new Date().toISOString()
    process.stdout.write(`工作目录：${workDir.root}\n`)
  })

  afterAll(async () => {
    if (runtime === undefined) {
      return
    }
    // 清理一：释放本测试创建的实例。
    const snapshots = await runtime.provider.listInstances({ refresh: true })
    for (const instanceId of createdInstanceIds) {
      if (findInstance(snapshots, instanceId) === undefined) {
        continue
      }
      try {
        const outcome = await runtime.provider.destroy(instanceId)
        process.stdout.write(`清理：实例 ${instanceId} → ${outcome.state}\n`)
      } catch (error: unknown) {
        process.stdout.write(
          `清理失败：实例 ${instanceId} 未能释放，请人工核对控制台。` +
            `原因：${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    }

    // 清理二：源实例若还在运行就关掉，别让它继续计费。
    const latest = await runtime.provider.listInstances({ refresh: true })
    if (findInstance(latest, config.sourceInstanceId)?.status === 'running') {
      try {
        await runtime.provider.powerOff(config.sourceInstanceId)
        process.stdout.write(`清理：源实例 ${config.sourceInstanceId} 已关机\n`)
      } catch (error: unknown) {
        process.stdout.write(
          `清理失败：源实例 ${config.sourceInstanceId} 未能关机，请人工核对控制台。` +
            `原因：${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    }

    // 清理三：源实例若还留着定时关机记录就清掉，恢复成测试前的样子。
    const afterCleanup = await runtime.provider.listInstances({ refresh: true })
    if (findInstance(afterCleanup, config.sourceInstanceId)?.timedShutdownAt != null) {
      try {
        await runtime.provider.clearTimedShutdown(config.sourceInstanceId)
        process.stdout.write(`清理：源实例 ${config.sourceInstanceId} 的定时关机记录已清除\n`)
      } catch (error: unknown) {
        process.stdout.write(
          `清理失败：源实例 ${config.sourceInstanceId} 的定时关机记录未清除，` +
            `请人工点列表里的「关闭」。原因：${error instanceof Error ? error.message : String(error)}\n`,
        )
      }
    }

    // 清理四：封口报告。
    const written = await recorder.write({
      startedAt,
      approvedCostYuan: config.approvedCostYuan,
      estimatedCostYuan: estimateTotalYuan(),
    })
    process.stdout.write(`${formatE2eReport(written.report)}\n`)
    process.stdout.write(`报告：${written.filePath}\n`)
    await runtime.close()
  })

  it(
    '【耗费·只读】实例列表可解析，源实例存在且已关机',
    async () => {
      await runCase('只读：实例列表可解析', async () => {
        const snapshots = await runtime.provider.listInstances({ refresh: true })
        expect(snapshots.length).toBeGreaterThan(0)
        const source = findInstance(snapshots, config.sourceInstanceId)
        expect(source).toBeDefined()
        if (source === undefined) {
          throw new Error(`实例列表里找不到源实例 ${config.sourceInstanceId}`)
        }
        // 克隆要求源实例已关机。不满足就停下，避免在运行中的实例上做克隆。
        expect(source.status).toBe('stopped')
        expect(source.gpuSpec.length).toBeGreaterThan(0)
        return `源实例 ${source.instanceId} 状态 ${source.statusRaw}，规格 ${source.gpuSpec}`
      })
    },
    5 * 60 * 1000,
  )

  it(
    '【耗费·只读】账户余额与今日克隆配额可读',
    async () => {
      await runCase('只读：余额与克隆配额', async () => {
        const balance = await runtime.provider.readBalance()
        expect(Number.isFinite(balance)).toBe(true)
        const quota = await runtime.provider.readCloneQuota(config.sourceInstanceId)
        expect(Number.isInteger(quota)).toBe(true)
        // 没有配额就不该继续：真正克隆前就该算出来。
        expect(quota).toBeGreaterThan(0)
        return `余额 ${balance.toFixed(2)} 元，今日剩余克隆次数 ${String(quota)}`
      })
    },
    5 * 60 * 1000,
  )

  it(
    '【耗费·UI·慢】开关机：开机等到运行中，关机等到已关机',
    async () => {
      await runCase('开关机（含二次确认）', async () => {
        const on = await runtime.provider.powerOn(config.sourceInstanceId)
        expect(on).toEqual({ ok: true, instanceId: config.sourceInstanceId })
        const running = await runtime.provider.listInstances({ refresh: true })
        expect(findInstance(running, config.sourceInstanceId)?.status).toBe('running')

        await runtime.provider.powerOff(config.sourceInstanceId)
        const stopped = await runtime.provider.listInstances({ refresh: true })
        expect(findInstance(stopped, config.sourceInstanceId)?.status).toBe('stopped')
        return '开机与关机都经确认框，状态各就位'
      })
    },
    10 * 60 * 1000,
  )

  it(
    '【耗费·UI·慢】平台定时关机：到点自动关机',
    async () => {
      await runCase('平台定时关机（到点自动关）', async () => {
        const on = await runtime.provider.powerOn(config.sourceInstanceId)
        expect(on.ok).toBe(true)

        // 时间基准取北京时间；真机实测控制台按北京时间显示。
        const shutdownAt = addMinutesIso(beijingIso(new Date()), TIMED_SHUTDOWN_LEAD_MINUTES)
        const receipt = await runtime.provider.setTimedShutdown(config.sourceInstanceId, shutdownAt)
        expect(receipt.shutdownAt.length).toBeGreaterThan(0)

        // 等平台自己把实例关掉：这一步验证的是云端定时关机，不是 deploydeck 发的关机指令。
        const deadline = Date.now() + TIMED_SHUTDOWN_WAIT_MS
        let lastStatusRaw = '未知'
        let stopped = false
        while (Date.now() < deadline) {
          const snapshots = await runtime.provider.listInstances({ refresh: true })
          const source = findInstance(snapshots, config.sourceInstanceId)
          lastStatusRaw = source?.statusRaw ?? '实例已消失'
          if (source?.status === 'stopped') {
            stopped = true
            break
          }
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 15_000)
          })
        }
        expect(stopped).toBe(true)

        // 平台在触发后不清记录，列表会一直显示那个过去的时刻。顺手清掉并断言真的清空了，
        // 这同时验证 clearTimedShutdown 这一路控制台动作。
        await runtime.provider.clearTimedShutdown(config.sourceInstanceId)
        const cleaned = await runtime.provider.listInstances({ refresh: true })
        expect(findInstance(cleaned, config.sourceInstanceId)?.timedShutdownAt).toBeNull()

        return `定时 ${receipt.shutdownAt}，到点自动关机（最后状态「${lastStatusRaw}」），记录已清除`
      })
    },
    12 * 60 * 1000,
  )

  it(
    '【耗费·UI·慢】克隆 → 改名 → 释放',
    async () => {
      await runCase('克隆 → 改名 → 释放', async () => {
        const before = await runtime.provider.listInstances({ refresh: true })
        const source = findInstance(before, config.sourceInstanceId)
        if (source === undefined) {
          throw new Error(`实例列表里找不到源实例 ${config.sourceInstanceId}`)
        }
        expect(source.status).toBe('stopped')

        const outcome = await runtime.provider.clone({
          sourceInstanceId: config.sourceInstanceId,
          gpuPreference: config.gpuPreference,
          regionPreference: [],
          cloneDataDisk: true,
          instanceName: config.instanceName,
        })
        createdInstanceIds.push(outcome.instanceId)
        expect(outcome.instanceId).not.toBe(config.sourceInstanceId)

        // 交付判据：名字是请求给的那个。平台不复制实例名，靠改名补齐。
        const after = await runtime.provider.listInstances({ refresh: true })
        const renamed = findInstance(after, outcome.instanceId)
        expect(renamed).toBeDefined()
        if (renamed === undefined) {
          throw new Error(`克隆完成但列表里找不到新实例 ${outcome.instanceId}`)
        }
        expect(renamed.name).toBe(config.instanceName)

        // 系统盘与数据盘都拷了：等数据盘真的拷到接近源占用再断言。
        const clone = await waitForDataDiskCopy(
          outcome.instanceId,
          source.dataDiskUsed,
          15 * 60 * 1000,
        )

        const teardown = await runtime.provider.destroy(outcome.instanceId)
        expect(teardown.state).toBe('gone')
        const finalSnapshots = await runtime.provider.listInstances({ refresh: true })
        expect(findInstance(finalSnapshots, outcome.instanceId)).toBeUndefined()

        return (
          `克隆 ${outcome.instanceId}，名字 ${clone.name}，` +
          `系统盘 ${clone.systemDiskUsed} 数据盘 ${clone.dataDiskUsed}，已释放`
        )
      })
    },
    CLONE_CASE_TIMEOUT_MS,
  )
})
