import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import type { Clock } from '../util/clock.js'
import {
  addMinutesIso,
  formatBeijingMinute,
  minutesBetweenIso,
  parseBeijingDateTimeText,
} from '../util/time.js'
import type { Logger } from '../logging/logger.js'
import { buildLocateRowScript } from './power.js'
import type { ConsoleChannel, ConsoleRuntimeContext, InstanceListPort } from './ports.js'
import {
  CONSOLE_INSTANCE_LIST_URL,
  DIALOG,
  INSTANCE_LIST_COLUMN,
  TIMED_SHUTDOWN_DIALOG,
  TIMED_SHUTDOWN_DIALOG_ELEMENT,
} from './selectors.js'
import {
  buildTimedShutdownDialogReadScript,
  buildVisibleDialogCountScript,
  createPriceActions,
  detectPriceDrift,
} from './timed-shutdown.js'

/**
 * 夹具取自 2026-11-25 的真机实测：
 * 服务器时间 01:34、填入 02:34（60 分钟）、预计消费 ￥ 1.58、余额 ￥ 54.57。
 * 数字与 docs/refs/autodl/console-selectors.md 第 2.2 节的实测表一致。
 */
const INSTANCE_ID = 'af9c49bd44-8ee624d7'
const MISSING_INSTANCE_ID = 'ffffffff-ffffffff'
const COST_UNSET_TEXT = TIMED_SHUTDOWN_DIALOG.costUnsetText
const LOG_DIR = join(process.cwd(), '.tmp', 'deploydeck-spec', 'timed-shutdown')
const SERVER_TIME_TEXT = '2026-11-25 01:33'
const SERVER_TIME_ISO = '2026-11-25T01:33:00.000+08:00'
/** 假页面里可见对话框的结构选择器。真实实现由求值脚本按 DOM 生成并回验。 */
const DIALOG_SELECTOR = 'body > div:nth-of-type(7) > div:nth-of-type(1) > div:nth-of-type(1)'
const RELEASE_CELL_ORDINAL = INSTANCE_LIST_COLUMN.release + 1

const ROWS: readonly FakeRow[] = [
  { instanceId: INSTANCE_ID, name: 'app+asr' },
  { instanceId: '00000000-11112222', name: 'app+tts' },
]

interface FakeRow {
  readonly instanceId: string
  readonly name: string
}

/** 页内求值返回的原始结构。形状与 timed-shutdown.ts 的读取脚本一致。 */
interface FakeDialogFormItem {
  readonly label: string | null
  readonly text: string | null
  readonly inputValue: string | null
}

interface FakeDialogRead {
  readonly visibleDialogCount: number
  readonly dialogSelector: string | null
  readonly title: string | null
  readonly items: readonly FakeDialogFormItem[]
  readonly footerButtons: readonly string[]
  readonly formErrors: readonly string[]
  readonly activeElementTag: string | null
}

const FILLED_60_MINUTE_DIALOG: FakeDialogRead = {
  visibleDialogCount: 1,
  dialogSelector: DIALOG_SELECTOR,
  title: TIMED_SHUTDOWN_DIALOG.title,
  items: [
    {
      label: '当前服务器时间：',
      text: '2026-11-25 01:34 如和您本地时间有差异，以下定时关机时间请以服务器时间为准',
      inputValue: null,
    },
    { label: '定时关机时间：', text: '', inputValue: '2026-11-25 02:34' },
    { label: '预计消费：', text: '￥ 1.58', inputValue: null },
    { label: '账户余额：', text: '￥ 54.57', inputValue: null },
    { label: '账户代金券：', text: '￥ 0.00', inputValue: null },
  ],
  footerButtons: ['取消', '确定'],
  formErrors: [],
  activeElementTag: 'body',
}

interface FakeDialogState {
  readonly rowInstanceId: string
  /** 打开对话框时输入框里的值，模拟失焦回退时用它。 */
  readonly initialInputValue: string
  serverTimeText: string
  inputValue: string
  costText: string
  focused: boolean
}

/**
 * 假的定时关机对话框页面。
 *
 * 只模拟本工单用到的那一块：按实例 ID 定位行、点行内按钮开对话框、写输入框、
 * 点标题失焦后重算预计消费、点「确定」落关机时刻、点 × 关闭、重开时回填已设置的时刻。
 * 求值脚本按「与模块导出的构造器全等」分派，避免选择器与脚本悄悄漂移。
 */
class FakeConsoleChannel implements ConsoleChannel {
  readonly rows: readonly FakeRow[]
  readonly clickedSelectors: string[] = []
  readonly typedTexts: string[] = []
  readonly screenshots: string[] = []
  /** 实测单价：vGPU-32GB 是 1.58 元/时。 */
  pricePerHourYuan = 1.58
  serverTimeText = SERVER_TIME_TEXT
  /** 失焦后服务器时间前进的分钟数。真实页面读数时刻会晚于填值时刻。 */
  serverAdvanceOnBlurMinutes = 0
  /** 写入不生效：模拟输入框没吃到文本。 */
  dropTypedText = false
  /** 点「确定」后平台写入的值比输入值晚 10 分钟：模拟回读不一致。 */
  corruptConfirmedShutdown = false
  /** 失焦时日期控件把输入框回退成打开时的旧值：模拟实测遇到的回退。 */
  revertOnBlur = false
  /** 对话框可见但定位不到它：模拟结构选择器生成失败。 */
  breakDialogSelector = false
  confirmedShutdownAt: string | null = null
  /** 静态对话框夹具。设置后求值直接返回它。 */
  dialogFixture: FakeDialogRead | undefined
  dialog: FakeDialogState | null = null
  private readonly shutdownAtByInstance = new Map<string, string>()

  constructor(rows: readonly FakeRow[]) {
    this.rows = rows
  }

  async goto(url: string): Promise<void> {
    if (url !== CONSOLE_INSTANCE_LIST_URL) {
      throw new Error(`假 channel 只会停在实例列表页，被要求打开：${url}`)
    }
  }

  async currentUrl(): Promise<string> {
    return CONSOLE_INSTANCE_LIST_URL
  }

  async evaluate<Result>(script: string): Promise<Result> {
    if (script === buildVisibleDialogCountScript()) {
      return (this.dialog === null ? 0 : 1) as unknown as Result
    }
    if (script === buildTimedShutdownDialogReadScript()) {
      return this.readDialog() as unknown as Result
    }
    for (const [index, row] of this.rows.entries()) {
      if (script === buildLocateRowScript(row.instanceId)) {
        return `.el-table__row:nth-of-type(${index + 1})` as unknown as Result
      }
    }
    throw new Error(`假 channel 不认识的求值脚本：${script.slice(0, 60)}…`)
  }

  async click(selector: string): Promise<void> {
    this.clickedSelectors.push(selector)
    const matchedRow = /el-table__row:nth-of-type\((\d+)\)/.exec(selector)
    if (matchedRow !== null && selector.endsWith(`td:nth-of-type(${RELEASE_CELL_ORDINAL}) button`)) {
      const ordinalText = matchedRow[1]
      if (ordinalText === undefined) {
        throw new Error(`行序号解析失败：${selector}`)
      }
      this.openDialog(Number(ordinalText) - 1)
      return
    }
    if (selector === `${DIALOG_SELECTOR} ${TIMED_SHUTDOWN_DIALOG_ELEMENT.titleSpan}`) {
      this.blur()
      return
    }
    if (selector === `${DIALOG_SELECTOR} ${DIALOG.headerCloseButton}`) {
      this.requireDialog()
      this.dialog = null
      return
    }
    if (
      selector ===
      `${DIALOG_SELECTOR} ${DIALOG.footerButton}:nth-of-type(${TIMED_SHUTDOWN_DIALOG_ELEMENT.confirmButtonOrdinal})`
    ) {
      this.confirm()
      return
    }
    throw new Error(`假 channel 不认识的点击选择器：${selector}`)
  }

  async type(selector: string, text: string): Promise<void> {
    if (selector !== `${DIALOG_SELECTOR} ${DIALOG.textInput}`) {
      throw new Error(`假 channel 只会往时间输入框写字，被要求：${selector}`)
    }
    const dialog = this.requireDialog()
    this.typedTexts.push(text)
    dialog.focused = true
    if (!this.dropTypedText) {
      dialog.inputValue = text
    }
  }

  async waitFor(selector: string, _timeoutMs: number): Promise<void> {
    throw new Error(`本动作不应使用 waitFor：${selector}`)
  }

  async waitForGone(selector: string, _timeoutMs: number): Promise<void> {
    throw new Error(`本动作不应使用 waitForGone：${selector}`)
  }

  async screenshot(filePath: string): Promise<void> {
    this.screenshots.push(filePath)
  }

  async close(): Promise<void> {
    // 连接由调用方管理，动作不关连接。
  }

  /** 预置一条已经设置过的定时关机，用来模拟重开对话框时的回填。 */
  seedShutdownAt(instanceId: string, shutdownAtText: string): void {
    this.shutdownAtByInstance.set(instanceId, shutdownAtText)
  }

  private requireDialog(): FakeDialogState {
    if (this.dialog === null) {
      throw new Error('假页面没有打开的对话框')
    }
    return this.dialog
  }

  private openDialog(rowIndex: number): void {
    const row = this.rows[rowIndex]
    if (row === undefined) {
      throw new Error(`假页面没有第 ${rowIndex + 1} 行`)
    }
    const existing = this.shutdownAtByInstance.get(row.instanceId) ?? ''
    this.dialog = {
      rowInstanceId: row.instanceId,
      initialInputValue: existing,
      serverTimeText: this.serverTimeText,
      inputValue: existing,
      costText:
        existing === ''
          ? COST_UNSET_TEXT
          : this.costTextFor(this.serverTimeText, existing),
      focused: false,
    }
  }

  private blur(): void {
    const dialog = this.requireDialog()
    dialog.focused = false
    dialog.serverTimeText = formatBeijingMinute(
      addMinutesIso(parseBeijingDateTimeText(dialog.serverTimeText), this.serverAdvanceOnBlurMinutes),
    )
    if (this.revertOnBlur) {
      dialog.inputValue = dialog.initialInputValue
    }
    dialog.costText =
      dialog.inputValue === ''
        ? COST_UNSET_TEXT
        : this.costTextFor(dialog.serverTimeText, dialog.inputValue)
  }

  private confirm(): void {
    const dialog = this.requireDialog()
    const inputIso = parseBeijingDateTimeText(dialog.inputValue)
    const accepted = this.corruptConfirmedShutdown
      ? formatBeijingMinute(addMinutesIso(inputIso, 10))
      : dialog.inputValue
    this.confirmedShutdownAt = accepted
    this.shutdownAtByInstance.set(dialog.rowInstanceId, accepted)
    this.dialog = null
  }

  private costTextFor(serverTimeText: string, shutdownAtText: string): string {
    const durationMinutes = minutesBetweenIso(
      parseBeijingDateTimeText(serverTimeText),
      parseBeijingDateTimeText(shutdownAtText),
    )
    if (durationMinutes <= 0) {
      return '￥ 0.00'
    }
    return `￥ ${(this.pricePerHourYuan * (durationMinutes / 60)).toFixed(2)}`
  }

  private readDialog(): FakeDialogRead {
    if (this.dialogFixture !== undefined) {
      return {
        ...this.dialogFixture,
        visibleDialogCount: this.dialog === null ? 0 : 1,
        dialogSelector: this.dialog === null ? null : this.dialogFixture.dialogSelector,
      }
    }
    if (this.dialog === null) {
      return {
        visibleDialogCount: 0,
        dialogSelector: null,
        title: null,
        items: [],
        footerButtons: [],
        formErrors: [],
        activeElementTag: null,
      }
    }
    const dialog = this.dialog
    return {
      visibleDialogCount: 1,
      dialogSelector: this.breakDialogSelector ? null : DIALOG_SELECTOR,
      title: TIMED_SHUTDOWN_DIALOG.title,
      items: [
        {
          label: '当前服务器时间：',
          text: `${dialog.serverTimeText} 如和您本地时间有差异，以下定时关机时间请以服务器时间为准`,
          inputValue: null,
        },
        {
          label: '定时关机时间：',
          text: dialog.inputValue === '' ? '请设置定时关机时间' : '',
          inputValue: dialog.inputValue,
        },
        { label: '预计消费：', text: dialog.costText, inputValue: null },
        { label: '账户余额：', text: '￥ 54.57', inputValue: null },
        { label: '账户代金券：', text: '￥ 0.00', inputValue: null },
      ],
      footerButtons: ['取消', '确定'],
      formErrors: [],
      activeElementTag: dialog.focused ? 'input' : 'body',
    }
  }
}

class FakeClock implements Clock {
  private milliseconds: number

  constructor(startIso: string) {
    this.milliseconds = Date.parse(startIso)
  }

  now(): number {
    return this.milliseconds
  }

  async sleep(milliseconds: number): Promise<void> {
    this.milliseconds += milliseconds
  }
}

function buildSnapshot(row: FakeRow): ConsoleInstanceSnapshot {
  return {
    instanceId: row.instanceId,
    name: row.name,
    status: 'stopped',
    statusRaw: '已关机',
    gpuSpec: 'vGPU-32GB * 1卡',
    systemDiskUsed: '系统盘 37.98%',
    dataDiskUsed: '数据盘 57.93%',
    health: '正常',
    billingMode: '按量计费',
    autoReleaseAt: null,
    balanceWarning: null,
    timedShutdownAt: null,
    sshCommand: null,
  }
}

interface Fixture {
  readonly channel: FakeConsoleChannel
  readonly clock: FakeClock
  readonly actions: ReturnType<typeof createPriceActions>
}

function createFixture(
  options: { readonly clockStartIso?: string; readonly logger?: Logger } = {},
): Fixture {
  const channel = new FakeConsoleChannel(ROWS)
  const clock = new FakeClock(options.clockStartIso ?? SERVER_TIME_ISO)
  const instances: InstanceListPort = {
    listInstances: async () => ROWS.map((row) => buildSnapshot(row)),
  }
  const context: ConsoleRuntimeContext = {
    channel,
    logDir: LOG_DIR,
    timeoutMs: 600,
    pollIntervalMs: 10,
    clock,
    instances,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  }
  return { channel, clock, actions: createPriceActions(context) }
}

/** 把假 channel 写出的 stderr 日志行解析成结构化记录。 */
function stderrRecords(): readonly Record<string, unknown>[] {
  const writes = vi.mocked(process.stderr.write).mock.calls
  return writes.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
}

beforeEach(() => {
  // 动作内部的日志走 stderr；测试里静音，需要断言的用例再读 mock 记录。
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readPriceQuote', () => {
  it('用实测夹具反推单价', async () => {
    const { channel, actions } = createFixture()
    channel.dialogFixture = FILLED_60_MINUTE_DIALOG

    const quote = await actions.readPriceQuote(INSTANCE_ID, 60)

    expect(quote.serverTime).toBe('2026-11-25T01:34:00.000+08:00')
    expect(quote.estimatedCostYuan).toBe(1.58)
    expect(quote.unitPriceYuanPerHour).toBeCloseTo(1.58, 6)
    expect(quote.ttlMinutes).toBe(60)
    expect(quote.balanceYuan).toBe(54.57)
    // 读单价不得点「确定」：那会真的改平台关机行为。
    expect(channel.confirmedShutdownAt).toBeNull()
    // 用右上角 × 关闭对话框。
    expect(channel.dialog).toBeNull()
    expect(channel.screenshots.length).toBeGreaterThan(0)
    expect(channel.screenshots.every((path) => path.startsWith(LOG_DIR))).toBe(true)
  })

  it('59 分钟 ￥1.55 能反推回 1.58', async () => {
    const { channel, actions } = createFixture()
    // 失焦时服务器时间已走过一分钟，实际时长是 59 分钟，预计消费按 59 分钟重算。
    channel.serverAdvanceOnBlurMinutes = 1

    const quote = await actions.readPriceQuote(INSTANCE_ID, 60)

    expect(quote.ttlMinutes).toBe(59)
    expect(quote.estimatedCostYuan).toBe(1.55)
    expect(quote.unitPriceYuanPerHour).toBeGreaterThan(1.58 - 0.02)
    expect(quote.unitPriceYuanPerHour).toBeLessThan(1.58 + 0.02)
  })

  it('120 分钟 ￥3.16 能反推回 1.58', async () => {
    const { actions } = createFixture()

    const quote = await actions.readPriceQuote(INSTANCE_ID, 120)

    expect(quote.ttlMinutes).toBe(120)
    expect(quote.estimatedCostYuan).toBe(3.16)
    expect(quote.unitPriceYuanPerHour).toBeCloseTo(1.58, 4)
  })

  it('输入框写入后值不符就抛错', async () => {
    const { channel, actions } = createFixture()
    channel.dropTypedText = true

    await expect(actions.readPriceQuote(INSTANCE_ID, 60)).rejects.toThrow(
      /定时关机时间输入框写入后值不符/,
    )
  })

  it('时长不大于 0 就抛错', async () => {
    const { channel, actions } = createFixture()
    // 服务器时间在失焦时前进了 61 分钟，超过填入的 60 分钟，时长变成 -1。
    channel.serverAdvanceOnBlurMinutes = 61

    await expect(actions.readPriceQuote(INSTANCE_ID, 60)).rejects.toThrow(/无法反推单价/)

    expect(channel.dialog).toBeNull()
  })

  it('失焦后输入框的值被改回就抛错', async () => {
    const { channel, actions } = createFixture()
    // 打开对话框时已有一个设置过的时刻；失焦时日期控件把输入框回退成它。
    channel.seedShutdownAt(INSTANCE_ID, '2026-11-25 02:00')
    channel.revertOnBlur = true

    await expect(actions.readPriceQuote(INSTANCE_ID, 60)).rejects.toThrow(
      /失焦后定时关机时间输入框的值变成/,
    )
  })

  it('定位不到可见对话框就抛错', async () => {
    const { channel, actions } = createFixture()
    channel.breakDialogSelector = true

    await expect(actions.readPriceQuote(INSTANCE_ID, 60)).rejects.toThrow(
      /定位不到当前可见的/,
    )
  })

  it('实例不在列表里就抛错', async () => {
    const { actions } = createFixture()

    await expect(actions.readPriceQuote(MISSING_INSTANCE_ID, 60)).rejects.toThrow(
      /找不到实例/,
    )
  })
})

describe('readPriceQuote 的服务器时间基准', () => {
  it('服务器时间与本机偏差超过 5 分钟时告警，仍用服务器时间', async () => {
    // 本机 01:50，服务器 01:33，差 17 分钟。
    const { actions } = createFixture({ clockStartIso: '2026-11-25T01:50:00+08:00' })

    const quote = await actions.readPriceQuote(INSTANCE_ID, 60)

    expect(quote.serverTime).toBe(SERVER_TIME_ISO)
    const skewRecords = stderrRecords().filter(
      (record) => record['event'] === 'timed_shutdown.clock_skew',
    )
    expect(skewRecords).toHaveLength(1)
    expect(skewRecords[0]?.['level']).toBe('warn')
    expect(skewRecords[0]?.['skewMinutes']).toBe(17)
  })

  it('偏差正好 5 分钟不告警', async () => {
    const { actions } = createFixture({ clockStartIso: '2026-11-25T01:38:00+08:00' })

    await actions.readPriceQuote(INSTANCE_ID, 60)

    const skewRecords = stderrRecords().filter(
      (record) => record['event'] === 'timed_shutdown.clock_skew',
    )
    expect(skewRecords).toHaveLength(0)
  })
})

describe('setTimedShutdown', () => {
  it('设置后回读一致，返回回执并关掉对话框', async () => {
    const { channel, actions } = createFixture()

    const receipt = await actions.setTimedShutdown(INSTANCE_ID, '2026-11-25T02:00:00+08:00')

    expect(receipt).toEqual({
      serverTime: SERVER_TIME_ISO,
      shutdownAt: '2026-11-25T02:00:00.000+08:00',
    })
    expect(channel.confirmedShutdownAt).toBe('2026-11-25 02:00')
    expect(channel.dialog).toBeNull()
  })

  it('回读不一致就抛错', async () => {
    const { channel, actions } = createFixture()
    // 平台实际写入的时刻与输入值不同，回读能发现。
    channel.corruptConfirmedShutdown = true

    await expect(
      actions.setTimedShutdown(INSTANCE_ID, '2026-11-25T02:00:00+08:00'),
    ).rejects.toThrow(/回读不一致/)

    expect(channel.dialog).toBeNull()
  })

  it('关机时刻不晚于服务器时间就抛错', async () => {
    const { actions } = createFixture()

    await expect(
      actions.setTimedShutdown(INSTANCE_ID, '2026-11-25T01:00:00+08:00'),
    ).rejects.toThrow(/不晚于控制台服务器时间/)
  })

  it('关机时刻不是带时区的 ISO 串就抛错', async () => {
    const { actions } = createFixture()

    await expect(actions.setTimedShutdown(INSTANCE_ID, '2026-11-25')).rejects.toThrow(
      /带时区的 ISO 时间串/,
    )
  })
})

describe('readBalance', () => {
  it('从第一行的定时关机对话框读余额后关闭', async () => {
    const { channel, actions } = createFixture()

    const balance = await actions.readBalance()

    expect(balance).toBe(54.57)
    expect(channel.dialog).toBeNull()
    expect(channel.confirmedShutdownAt).toBeNull()
  })
})

describe('detectPriceDrift', () => {
  it('偏差 10% 不报', () => {
    expect(
      detectPriceDrift({ cachedYuanPerHour: 1.58, observedYuanPerHour: 1.738, thresholdRatio: 0.2 }),
    ).toEqual({ drifted: false })
  })

  it('偏差 25% 报错并提示更新缓存', () => {
    const result = detectPriceDrift({
      cachedYuanPerHour: 1.58,
      observedYuanPerHour: 1.975,
      thresholdRatio: 0.2,
    })

    expect(result.drifted).toBe(true)
    if (result.drifted) {
      expect(result.ratio).toBeCloseTo(0.25, 6)
      expect(result.message).toContain('更新')
    }
  })

  it('偏差正好等于阈值 20% 不报', () => {
    expect(
      detectPriceDrift({ cachedYuanPerHour: 100, observedYuanPerHour: 120, thresholdRatio: 0.2 }),
    ).toEqual({ drifted: false })
  })

  it('浮点误差不把「正好等于阈值」算成漂移', () => {
    // 3 → 3.6 的比值是 20.000000000000004%，没有容差会被误报成漂移。
    expect(
      detectPriceDrift({ cachedYuanPerHour: 3, observedYuanPerHour: 3.6, thresholdRatio: 0.2 }),
    ).toEqual({ drifted: false })
  })

  it('偏差刚超过阈值 20% 就报', () => {
    const result = detectPriceDrift({
      cachedYuanPerHour: 100,
      observedYuanPerHour: 120.01,
      thresholdRatio: 0.2,
    })

    expect(result.drifted).toBe(true)
  })

  it('缓存单价不是正数就抛错', () => {
    expect(() =>
      detectPriceDrift({ cachedYuanPerHour: 0, observedYuanPerHour: 1.58, thresholdRatio: 0.2 }),
    ).toThrow(RangeError)
  })
})

describe('动作模块的运行日志出口', () => {
  it('装配方给了 logger 时走它，不再写 stderr', async () => {
    // Arrange
    const events: string[] = []
    const logger: Logger = {
      info: (event) => {
        events.push(event)
      },
      warn: (event) => {
        events.push(event)
      },
      error: (event) => {
        events.push(event)
      },
    }
    const fixture = createFixture({ logger })
    fixture.channel.dialogFixture = FILLED_60_MINUTE_DIALOG

    // Act
    await fixture.actions.readPriceQuote(INSTANCE_ID, 60)

    // Assert：日志进注入的 logger，stderr 一条都没有。
    expect(events).toContain('timed_shutdown.quote_read')
    expect(stderrRecords()).toEqual([])
  })
})
