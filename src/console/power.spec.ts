import { describe, expect, it } from 'vitest'
import type { ConsoleInstanceSnapshot, InstanceStatus } from '../domain/instance.js'
import { HumanRequiredError, InstanceNotFoundError, PowerOffTimeoutError } from '../errors.js'
import type { Clock } from '../util/clock.js'
import {
  buildConfirmMessageBoxScript,
  type ConfirmMessageBoxState,
} from './confirm.js'
import {
  buildLocateButtonScript,
  buildLocateRowScript,
  buildReadPageStateScript,
  createPowerActions,
  findNoGpuHint,
  type PowerOnPageState,
} from './power.js'
import type { ConsoleChannel, ConsoleRuntimeContext, InstanceListPort } from './ports.js'
import { INSTANCE_BUTTON_TEXT } from './selectors.js'

/**
 * 工单 04 的验收夹具。
 *
 * 全部 IO 用假的 `ConsoleChannel` 与假的 `InstanceListPort`，时钟用假时钟，
 * 不连真实浏览器、不做真实等待（施工约定第 4 节）。
 */

const INSTANCE_ID = 'af9c49bd44-8ee624d7'
const ROW_SELECTOR = '.el-table__row:nth-of-type(1)'
const POWER_ON_BUTTON_SELECTOR =
  '.el-table__row:nth-of-type(1) > td:nth-of-type(10) > div:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)'
const POWER_OFF_BUTTON_SELECTOR =
  '.el-table__row:nth-of-type(2) > td:nth-of-type(10) > div:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)'

/** 控制台状态原文。实测只见过「已关机」「克隆锁定中」，其余按第 7.1 节的枚举取词。 */
const STATUS_RAW: Record<InstanceStatus, string> = {
  stopped: '已关机',
  starting: '开机中',
  running: '运行中',
  cloning: '克隆锁定中',
  resetting: '重置中',
  unknown: '未知',
}

const EMPTY_PAGE_STATE: PowerOnPageState = { notices: [], statusText: '已关机' }

function createSnapshot(status: InstanceStatus, instanceId: string = INSTANCE_ID): ConsoleInstanceSnapshot {
  return {
    instanceId,
    name: 'app+asr',
    status,
    statusRaw: STATUS_RAW[status],
    gpuSpec: 'vGPU-32GB * 1卡',
    systemDiskUsed: '37.98%',
    dataDiskUsed: '57.93%',
    health: '正常',
    billingMode: '按量计费',
    autoReleaseAt: null,
    balanceWarning: null,
    timedShutdownAt: null,
    sshCommand: null,
  }
}

/**
 * 按调用次数返回状态序列的假列表端口。最后一个状态重复。
 *
 * 运行路径的读列表次数随轮询次数变化，用序列夹具能把「第几次读」与
 * 「页面演化」一一对应。
 */
function createSnapshotListPort(statuses: readonly InstanceStatus[]): InstanceListPort {
  let calls = 0
  return {
    listInstances: async () => {
      const index = Math.min(calls, statuses.length - 1)
      calls += 1
      const status = statuses[index]
      if (status === undefined) {
        throw new Error('测试夹具缺少状态序列')
      }
      return [createSnapshot(status)]
    },
  }
}

/** 只返回别的实例的列表端口，用于「实例不在列表里」。 */
function createMissingInstanceListPort(): InstanceListPort {
  return {
    listInstances: async () => [createSnapshot('stopped', 'b1hcx779z3-6abbac9b')],
  }
}

/** 假时钟：sleep 直接推进 now，不真实等待。 */
function createFakeClock(): Clock & { readonly current: number } {
  let current = 0
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds
    },
    get current() {
      return current
    },
  }
}

interface FakeChannelOptions {
  readonly rowSelector: string | null
  readonly powerOnButtonSelector: string | null
  readonly powerOffButtonSelector: string | null
  /** 每次读页面事实时按序返回，最后一个重复。 */
  readonly pageStates: readonly PowerOnPageState[]
  /**
   * 每次读开机二次确认框时按序返回，最后一个重复。不传视为「没有确认框」。
   *
   * 真机上点「开机」必弹确认框，但个别路径（例如实例已处于开机中）不会弹，
   * 所以默认值取 `absent`，与原来「点完直接等状态变化」的行为一致。
   */
  readonly confirmStates?: readonly ConfirmMessageBoxState[]
}

interface FakeChannel {
  readonly channel: ConsoleChannel
  readonly clicks: string[]
  readonly screenshots: string[]
  readonly scripts: string[]
}

/**
 * 假浏览器通道。
 *
 * `evaluate` 按脚本原文分派：脚本由被测模块的构造函数生成，分派用相等匹配，
 * 这样夹具与实现共用同一份脚本来源，不会因为测试里另抄一份字符串而失真。
 */
function createFakeChannel(options: FakeChannelOptions): FakeChannel {
  const clicks: string[] = []
  const screenshots: string[] = []
  const scripts: string[] = []
  let pageStateCalls = 0

  const nextPageState = (): PowerOnPageState => {
    const index = Math.min(pageStateCalls, options.pageStates.length - 1)
    pageStateCalls += 1
    const pageState = options.pageStates[index]
    if (pageState === undefined) {
      throw new Error('测试夹具缺少页面事实')
    }
    return pageState
  }

  const confirmStates = options.confirmStates ?? [{ kind: 'absent' }]
  let confirmCalls = 0
  const nextConfirmState = (): ConfirmMessageBoxState => {
    const index = Math.min(confirmCalls, confirmStates.length - 1)
    confirmCalls += 1
    const state = confirmStates[index]
    if (state === undefined) {
      throw new Error('测试夹具缺少开机确认框状态')
    }
    return state
  }

  const rowSelector = options.rowSelector ?? ''
  const locateRowScript = buildLocateRowScript(INSTANCE_ID)
  const readPowerOnConfirmScript = buildConfirmMessageBoxScript('确认开机')
  const readPowerOffConfirmScript = buildConfirmMessageBoxScript('确认关机')
  const locatePowerOnScript = buildLocateButtonScript(rowSelector, INSTANCE_BUTTON_TEXT.powerOn)
  const locatePowerOffScript = buildLocateButtonScript(rowSelector, INSTANCE_BUTTON_TEXT.powerOff)
  const readPageStateScript = buildReadPageStateScript(INSTANCE_ID)

  const channel: ConsoleChannel = {
    goto: async () => {},
    currentUrl: async () => 'https://www.autodl.com/console/instance/list',
    evaluate: async <Result>(script: string): Promise<Result> => {
      scripts.push(script)
      if (script === locateRowScript) {
        return options.rowSelector as unknown as Result
      }
      if (script === locatePowerOnScript) {
        return options.powerOnButtonSelector as unknown as Result
      }
      if (script === locatePowerOffScript) {
        return options.powerOffButtonSelector as unknown as Result
      }
      if (script === readPageStateScript) {
        return nextPageState() as unknown as Result
      }
      if (script === readPowerOnConfirmScript || script === readPowerOffConfirmScript) {
        return nextConfirmState() as unknown as Result
      }
      throw new Error(`未预期的页面脚本：${script}`)
    },
    click: async (selector: string) => {
      clicks.push(selector)
    },
    type: async () => {},
    waitFor: async () => {},
    waitForGone: async () => {},
    screenshot: async (filePath: string) => {
      screenshots.push(filePath)
    },
    close: async () => {},
  }

  return { channel, clicks, screenshots, scripts }
}

interface ContextOptions {
  readonly instances: InstanceListPort
  readonly channel: ConsoleChannel
  readonly clock: Clock
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
}

function createContext(options: ContextOptions): ConsoleRuntimeContext {
  return {
    channel: options.channel,
    instances: options.instances,
    logDir: 'run-log',
    timeoutMs: options.timeoutMs ?? 60_000,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    clock: options.clock,
  }
}

describe('powerOn', () => {
  it('已关机实例点击开机后，状态 stopped→starting→running，返回成功并前后各截一张图', async () => {
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: POWER_ON_BUTTON_SELECTOR,
      powerOffButtonSelector: null,
      pageStates: [EMPTY_PAGE_STATE],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['stopped', 'starting', 'running']),
        clock: createFakeClock(),
      }),
    )

    const outcome = await power.powerOn(INSTANCE_ID)

    expect(outcome).toEqual({ ok: true, instanceId: INSTANCE_ID })
    expect(fake.clicks).toEqual([POWER_ON_BUTTON_SELECTOR])
    expect(fake.screenshots).toEqual(['run-log/power-on-before.png', 'run-log/power-on-after.png'])
  })

  it('状态一直停在已关机时返回超时，不抛错', async () => {
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: POWER_ON_BUTTON_SELECTOR,
      powerOffButtonSelector: null,
      pageStates: [EMPTY_PAGE_STATE],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['stopped']),
        clock: createFakeClock(),
        // 轮询间隔取 1 分钟：5 分钟内只探测几次，用例快速走完超时分支。
        pollIntervalMs: 60_000,
      }),
    )

    const outcome = await power.powerOn(INSTANCE_ID)

    if (outcome.ok) {
      throw new Error('预期开机失败，实际返回成功')
    }
    expect(outcome.reason).toBe('timeout')
    expect(outcome.detail).toContain(INSTANCE_ID)
  })

  it('页面出现无可用 GPU 提示时返回 no-gpu，不抛错', async () => {
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: POWER_ON_BUTTON_SELECTOR,
      powerOffButtonSelector: null,
      pageStates: [
        {
          notices: [{ source: 'message', text: '当前主机暂无可分配的 GPU，开机失败' }],
          statusText: '已关机',
        },
      ],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['stopped']),
        clock: createFakeClock(),
        pollIntervalMs: 60_000,
      }),
    )

    const outcome = await power.powerOn(INSTANCE_ID)

    if (outcome.ok) {
      throw new Error('预期开机失败，实际返回成功')
    }
    expect(outcome.reason).toBe('no-gpu')
    expect(outcome.detail).toContain('GPU')
  })

  it('实例不在列表里时抛错，错误信息含实例 ID', async () => {
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: POWER_ON_BUTTON_SELECTOR,
      powerOffButtonSelector: null,
      pageStates: [],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createMissingInstanceListPort(),
        clock: createFakeClock(),
      }),
    )

    await expect(power.powerOn(INSTANCE_ID)).rejects.toBeInstanceOf(InstanceNotFoundError)
    await expect(power.powerOn(INSTANCE_ID)).rejects.toThrow(INSTANCE_ID)
    expect(fake.clicks).toEqual([])
  })

  it('不使用无卡模式开机', async () => {
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: POWER_ON_BUTTON_SELECTOR,
      powerOffButtonSelector: null,
      pageStates: [EMPTY_PAGE_STATE],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['stopped', 'running']),
        clock: createFakeClock(),
      }),
    )

    await power.powerOn(INSTANCE_ID)

    expect(fake.scripts).toContain(buildLocateButtonScript(ROW_SELECTOR, INSTANCE_BUTTON_TEXT.powerOn))
    expect(fake.scripts.some((script) => script.includes('无卡'))).toBe(false)
    expect(fake.clicks).toEqual([POWER_ON_BUTTON_SELECTOR])
  })

  it('点开机后弹二次确认框时点确定，再等状态变成运行中', async () => {
    const confirmSelector = '.el-message-box > div:nth-of-type(3) > button:nth-of-type(2)'
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: POWER_ON_BUTTON_SELECTOR,
      powerOffButtonSelector: null,
      pageStates: [EMPTY_PAGE_STATE],
      // 第一次读到确认框，点掉之后读到「没有框」。
      confirmStates: [
        { kind: 'located', selector: confirmSelector, text: '确认开机吗？ 实例将按￥1.58/时整点扣费' },
        { kind: 'absent' },
      ],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['stopped', 'starting', 'running']),
        clock: createFakeClock(),
      }),
    )

    const outcome = await power.powerOn(INSTANCE_ID)

    expect(outcome).toEqual({ ok: true, instanceId: INSTANCE_ID })
    expect(fake.clicks).toEqual([POWER_ON_BUTTON_SELECTOR, confirmSelector])
  })

  it('弹出的确认框不是开机确认时交人工，不点确定', async () => {
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: POWER_ON_BUTTON_SELECTOR,
      powerOffButtonSelector: null,
      pageStates: [EMPTY_PAGE_STATE],
      confirmStates: [{ kind: 'unrecognized', text: '确认释放实例吗？释放后数据不可恢复' }],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['stopped', 'running']),
        clock: createFakeClock(),
      }),
    )

    await expect(power.powerOn(INSTANCE_ID)).rejects.toBeInstanceOf(HumanRequiredError)
    // 只点了开机按钮，没有点任何确认框里的按钮。
    expect(fake.clicks).toEqual([POWER_ON_BUTTON_SELECTOR])
  })
})

describe('powerOff', () => {
  it('运行中实例点击关机后，状态变为已关机即返回', async () => {
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: null,
      powerOffButtonSelector: POWER_OFF_BUTTON_SELECTOR,
      pageStates: [EMPTY_PAGE_STATE],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['running', 'stopped']),
        clock: createFakeClock(),
      }),
    )

    await expect(power.powerOff(INSTANCE_ID)).resolves.toBeUndefined()

    expect(fake.clicks).toEqual([POWER_OFF_BUTTON_SELECTOR])
    expect(fake.screenshots).toEqual(['run-log/power-off-before.png', 'run-log/power-off-after.png'])
  })

  it('点关机后弹二次确认框时点确定，再等状态变成已关机', async () => {
    // 实测原文：确认关机吗？... 按量计费的实例关机后GPU将会释放 ... 是否继续关机？
    const confirmSelector = '.el-message-box > div:nth-of-type(3) > button:nth-of-type(2)'
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: null,
      powerOffButtonSelector: POWER_OFF_BUTTON_SELECTOR,
      pageStates: [EMPTY_PAGE_STATE],
      confirmStates: [
        { kind: 'located', selector: confirmSelector, text: '确认关机吗？ ... 是否继续关机？' },
        { kind: 'absent' },
      ],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['running', 'stopped']),
        clock: createFakeClock(),
      }),
    )

    await expect(power.powerOff(INSTANCE_ID)).resolves.toBeUndefined()

    expect(fake.clicks).toEqual([POWER_OFF_BUTTON_SELECTOR, confirmSelector])
  })

  it('状态一直停在运行中时超时抛错，错误信息含实例 ID', async () => {
    const fake = createFakeChannel({
      rowSelector: ROW_SELECTOR,
      powerOnButtonSelector: null,
      powerOffButtonSelector: POWER_OFF_BUTTON_SELECTOR,
      pageStates: [EMPTY_PAGE_STATE],
    })
    const power = createPowerActions(
      createContext({
        channel: fake.channel,
        instances: createSnapshotListPort(['running']),
        clock: createFakeClock(),
        timeoutMs: 60_000,
        pollIntervalMs: 60_000,
      }),
    )

    await expect(power.powerOff(INSTANCE_ID)).rejects.toBeInstanceOf(PowerOffTimeoutError)
    await expect(power.powerOff(INSTANCE_ID)).rejects.toThrow(INSTANCE_ID)
  })
})

describe('findNoGpuHint', () => {
  it('状态区的「GPU充足」是正向提示，不是失败', () => {
    expect(findNoGpuHint({ notices: [], statusText: '已关机 GPU充足' })).toBeUndefined()
  })

  it('无可用 GPU 的 toast 命中', () => {
    const hint = findNoGpuHint({
      notices: [{ source: 'message', text: '当前主机暂无可分配的 GPU' }],
      statusText: '已关机',
    })
    expect(hint).toContain('GPU')
  })

  it('状态区文字里的无可用 GPU 也命中', () => {
    expect(findNoGpuHint({ notices: [], statusText: '已关机 无可用GPU' })).toContain('GPU')
  })

  it('不含 GPU 关键词的提示不误判', () => {
    expect(
      findNoGpuHint({
        notices: [{ source: 'alert', text: '账户余额不足，请充值' }],
        statusText: '已关机',
      }),
    ).toBeUndefined()
  })
})
