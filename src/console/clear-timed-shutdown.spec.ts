import { describe, expect, it } from 'vitest'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import { ConsoleParseError, HumanRequiredError, InstanceNotFoundError } from '../errors.js'
import type { Clock } from '../util/clock.js'
import { buildConfirmMessageBoxScript } from './confirm.js'
import { buildLocateButtonScript, buildLocateRowScript } from './power.js'
import type { ConsoleChannel, ConsoleRuntimeContext } from './ports.js'
import { INSTANCE_BUTTON_TEXT } from './selectors.js'
import { createPriceActions } from './timed-shutdown.js'

/**
 * 取消定时关机的单测。
 *
 * 真机事实（2026-11-25）：定时关机触发后平台不清记录，列表第 6 列一直显示那个过去的时刻。
 * 清除走「关闭」按钮 + 「取消定时关机」确认框，成功后提示「取消成功」。
 */

const INSTANCE_ID = '6a9f428e64-c7771049'
const ROW_SELECTOR = '.el-table__row:nth-of-type(1)'
const CLEAR_BUTTON_SELECTOR =
  '.el-table__row:nth-of-type(1) > td:nth-of-type(7) > div:nth-of-type(1) > button:nth-of-type(1)'
const CONFIRM_SELECTOR = 'body > div:nth-of-type(9) > div:nth-of-type(1) > button:nth-of-type(2)'
const EXISTING_TIMER = '2026-11-25T06:54:00.000+08:00'

function createSnapshot(timedShutdownAt: string | null): ConsoleInstanceSnapshot {
  return {
    instanceId: INSTANCE_ID,
    name: 'app+asr',
    status: 'stopped',
    statusRaw: '已关机',
    gpuSpec: 'vGPU-32GB * 1卡',
    systemDiskUsed: '35.81%',
    dataDiskUsed: '55.97%',
    health: '正常',
    billingMode: '按量计费',
    autoReleaseAt: null,
    balanceWarning: null,
    timedShutdownAt,
    sshCommand: null,
    noGpuMode: null,
  }
}

/** 假时钟：sleep 直接推进刻度，不做真实等待。 */
function createFakeClock(): Clock {
  let current = 0
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds
    },
  }
}

interface FakeOptions {
  /** 列表里看到的定时关机时刻。null 表示本来就没有记录。 */
  readonly timedShutdownAt: string | null
  /** 「关闭」按钮是否定位得到。 */
  readonly clearButtonVisible?: boolean
  /** 确认框第一次读到的状态。 */
  readonly confirmState?: 'located' | 'unrecognized'
  /** 点过确认之后，列表里是否真的变成没有记录。false 模拟清除不生效。 */
  readonly clearsAfterConfirm?: boolean
  /** 实例是否在列表里。 */
  readonly instanceExists?: boolean
}

interface FakeChannel {
  readonly channel: ConsoleChannel
  readonly clicks: string[]
}

/** 假通道：只认三个脚本（定位行、定位「关闭」按钮、确认框探针）。 */
function createFakeChannel(options: FakeOptions): FakeChannel {
  const clicks: string[] = []
  const locateRowScript = buildLocateRowScript(INSTANCE_ID)
  const locateButtonScript = buildLocateButtonScript(
    ROW_SELECTOR,
    INSTANCE_BUTTON_TEXT.clearTimedShutdown,
  )
  const confirmScript = buildConfirmMessageBoxScript('取消定时关机')
  // 确认框是「点掉就没了」：第一次读到，之后读 absent。
  let confirmReads = 0

  const channel: ConsoleChannel = {
    goto: async () => {},
    currentUrl: async () => 'https://www.autodl.com/console/instance/list',
    evaluate: async <Result>(script: string): Promise<Result> => {
      if (script === locateRowScript) {
        return ROW_SELECTOR as unknown as Result
      }
      if (script === locateButtonScript) {
        return (options.clearButtonVisible === false ? null : CLEAR_BUTTON_SELECTOR) as unknown as Result
      }
      if (script === confirmScript) {
        confirmReads += 1
        if (confirmReads > 1) {
          return { kind: 'absent' } as unknown as Result
        }
        if (options.confirmState === 'unrecognized') {
          return { kind: 'unrecognized', text: '确认释放实例吗？' } as unknown as Result
        }
        return { kind: 'located', selector: CONFIRM_SELECTOR, text: '取消定时关机' } as unknown as Result
      }
      throw new Error(`假通道不认识的求值脚本：${script.slice(0, 80)}`)
    },
    click: async (selector: string) => {
      clicks.push(selector)
    },
    type: async () => {},
    waitFor: async () => {},
    waitForGone: async () => {},
    screenshot: async () => {},
    close: async () => {},
  }

  return { channel, clicks }
}

/**
 * 假列表端口。
 *
 * 第一次读是「动作前」的判定读取；之后点过确认按钮的读，才是「清掉没有」的回读。
 */
function createContext(fake: FakeChannel, options: FakeOptions): ConsoleRuntimeContext {
  let reads = 0
  return {
    channel: fake.channel,
    instances: {
      listInstances: async () => {
        reads += 1
        if (options.instanceExists === false) {
          return []
        }
        const confirmed = fake.clicks.includes(CONFIRM_SELECTOR)
        const cleared = confirmed && (options.clearsAfterConfirm ?? true)
        return [createSnapshot(cleared ? null : options.timedShutdownAt)]
      },
    },
    logDir: 'run-log',
    timeoutMs: 3_000,
    pollIntervalMs: 1_000,
    clock: createFakeClock(),
    // 静默 logger：用例不关心日志，别把动作日志混进测试输出。
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  }
}

function createActions(options: FakeOptions): { actions: ReturnType<typeof createPriceActions>; clicks: string[] } {
  const fake = createFakeChannel(options)
  return { actions: createPriceActions(createContext(fake, options)), clicks: fake.clicks }
}

describe('clearTimedShutdown', () => {
  it('有记录时点「关闭」再点确认，等回读清空', async () => {
    const { actions, clicks } = createActions({ timedShutdownAt: EXISTING_TIMER })

    await expect(actions.clearTimedShutdown(INSTANCE_ID)).resolves.toBeUndefined()

    expect(clicks).toEqual([CLEAR_BUTTON_SELECTOR, CONFIRM_SELECTOR])
  })

  it('本来就没有记录时不点任何按钮', async () => {
    const { actions, clicks } = createActions({ timedShutdownAt: null })

    await expect(actions.clearTimedShutdown(INSTANCE_ID)).resolves.toBeUndefined()

    expect(clicks).toEqual([])
  })

  it('实例不在列表里时抛错，信息含实例 ID', async () => {
    const { actions, clicks } = createActions({ timedShutdownAt: null, instanceExists: false })

    await expect(actions.clearTimedShutdown(INSTANCE_ID)).rejects.toBeInstanceOf(
      InstanceNotFoundError,
    )
    expect(clicks).toEqual([])
  })

  it('有记录但找不到「关闭」按钮时抛错，不静默跳过', async () => {
    const { actions, clicks } = createActions({
      timedShutdownAt: EXISTING_TIMER,
      clearButtonVisible: false,
    })

    await expect(actions.clearTimedShutdown(INSTANCE_ID)).rejects.toBeInstanceOf(ConsoleParseError)
    expect(clicks).toEqual([])
  })

  it('弹出的确认框不是取消定时关机时交人工，不点确定', async () => {
    const { actions, clicks } = createActions({
      timedShutdownAt: EXISTING_TIMER,
      confirmState: 'unrecognized',
    })

    await expect(actions.clearTimedShutdown(INSTANCE_ID)).rejects.toBeInstanceOf(
      HumanRequiredError,
    )
    expect(clicks).toEqual([CLEAR_BUTTON_SELECTOR])
  })

  it('确认后回读一直不清空时抛错', async () => {
    const { actions } = createActions({
      timedShutdownAt: EXISTING_TIMER,
      clearsAfterConfirm: false,
    })

    await expect(actions.clearTimedShutdown(INSTANCE_ID)).rejects.toThrow(/没有在/)
  })
})
