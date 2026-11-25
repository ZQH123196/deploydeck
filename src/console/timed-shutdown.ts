import { join } from 'node:path'
import { ConsoleParseError, InstanceNotFoundError } from '../errors.js'
import { createStderrLogger, type Logger } from '../logging/logger.js'
import type { Clock } from '../util/clock.js'
import { systemClock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'
import {
  addMinutesIso,
  beijingIso,
  formatBeijingMinute,
  minutesBetweenIso,
  parseBeijingDateTimeText,
} from '../util/time.js'
import { jsString } from './dom.js'
import { buildVerifiedSelectorExpression } from './locate.js'
import { confirmMessageBoxIfAsked } from './confirm.js'
import { buildLocateButtonScript, buildLocateRowScript, parseLocatedSelector } from './power.js'
import type { ConsoleRuntimeContext, PricePort, PriceQuote, TimedShutdownReceipt } from './ports.js'
import {
  CLEAR_TIMED_SHUTDOWN_CONFIRM,
  CONSOLE_INSTANCE_LIST_URL,
  DIALOG,
  INSTANCE_BUTTON_TEXT,
  INSTANCE_LIST_COLUMN,
  TIMED_SHUTDOWN_DIALOG,
  TIMED_SHUTDOWN_DIALOG_ELEMENT,
} from './selectors.js'

/**
 * 定时关机对话框：单价反推、设置平台定时关机、读账户余额。
 *
 * 页面事实见 docs/refs/autodl/console-selectors.md 第 2 节。
 * 时间基准一律取对话框显示的服务器时间；本机时钟只用来判断偏差是否需要告警。
 *
 * 只有 `setTimedShutdown` 会点「确定」。`readPriceQuote` 与 `readBalance` 只用右上角 × 关闭。
 *
 * 定位做法与工单 04 一致：页内按实例 ID 找到行与可见对话框，生成结构选择器并回验，
 * 之后只按这些选择器点击与写入。控制台把已关闭的对话框留在 DOM 里，不能用
 * document 级选择器直接取第一个。
 */

/** 服务器时间与本机时间偏差超过这个分钟数时告警。 */
const CLOCK_SKEW_WARNING_MINUTES = 5

/** 反推单价的保留小数位。控制台金额是分，除完是元/时，四位足够做偏差判定。 */
const UNIT_PRICE_DECIMAL_PLACES = 4

/** 页内读回的原始结构。这里只做字段搬运，业务判断在纯函数里做。 */
interface RawDialogFormItem {
  readonly label: string | null
  readonly text: string | null
  readonly inputValue: string | null
}

interface RawDialogRead {
  readonly visibleDialogCount: number
  /** 指向当前可见对话框的结构选择器。不唯一或生成失败时为 null。 */
  readonly dialogSelector: string | null
  readonly title: string | null
  readonly items: readonly RawDialogFormItem[]
  readonly footerButtons: readonly string[]
  readonly formErrors: readonly string[]
  readonly activeElementTag: string | null
}

/** 对话框字段的归一结果。时间都是北京时间 ISO 串。 */
interface TimedShutdownDialogSnapshot {
  /** 指向这个对话框的结构选择器，供后续点击与写入使用。 */
  readonly dialogSelector: string
  readonly serverTime: string
  /** 时间输入框当前文本。没设置过时是空串。 */
  readonly shutdownAtText: string
  readonly estimatedCostText: string
  readonly balanceText: string
  readonly couponText: string
  readonly footerButtons: readonly string[]
  readonly formErrors: readonly string[]
  /** 当前焦点元素的标签名，小写。失焦校验用它。 */
  readonly activeElementTag: string | null
}

/** 同一时刻读到的一组报价数据。 */
interface DialogQuote {
  readonly snapshot: TimedShutdownDialogSnapshot
}

/** 数当前可见的对话框。可见判据是几何尺寸，因为标签在后台时 CSS 过渡不推进。 */
export function buildVisibleDialogCountScript(): string {
  return `(() => {
  const isVisible = (dialog) => {
    const rect = dialog.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  return [...document.querySelectorAll(${jsString(DIALOG.root)})].filter(isVisible).length
})()`
}

/**
 * 挑出当前可见的定时关机对话框，生成指向它的结构选择器，并把它里面的字段原样读出来。
 *
 * 选择器按真实 DOM 的「标签 + 同层同名序号」逐级生成，再从 body 回查一次，
 * 必须指回同一个元素才返回。生成失败返回 null，由判定层报错。
 */
export function buildTimedShutdownDialogReadScript(): string {
  const formItemSelector = jsString(DIALOG.formItem)
  const labelSelector = jsString(DIALOG.formLabel)
  const contentSelector = jsString(DIALOG.formContent)
  const footerButtonSelector = jsString(DIALOG.footerButton)
  const formErrorSelector = jsString(DIALOG.formError)
  const titleSelector = jsString(TIMED_SHUTDOWN_DIALOG_ELEMENT.titleSpan)
  const textInputSelector = jsString(DIALOG.textInput)
  return `(() => {
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim()
  const isVisible = (dialog) => {
    const rect = dialog.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const visible = [...document.querySelectorAll(${jsString(DIALOG.root)})].filter(isVisible)
  if (visible.length !== 1) {
    return {
      visibleDialogCount: visible.length,
      dialogSelector: null,
      title: null,
      items: [],
      footerButtons: [],
      formErrors: [],
      activeElementTag: null,
    }
  }
  const dialog = visible[0]
${buildVerifiedSelectorExpression()}
  const dialogSelector = toVerifiedSelector(dialog)
  if (dialogSelector === null) {
    return {
      visibleDialogCount: 1,
      dialogSelector: null,
      title: null,
      items: [],
      footerButtons: [],
      formErrors: [],
      activeElementTag: null,
    }
  }
  const active = document.activeElement
  const title = dialog.querySelector(${titleSelector})
  return {
    visibleDialogCount: 1,
    dialogSelector,
    title: title === null ? null : clean(title.innerText),
    items: [...dialog.querySelectorAll(${formItemSelector})].map((item) => {
      const label = item.querySelector(${labelSelector})
      const content = item.querySelector(${contentSelector})
      const input = item.querySelector(${textInputSelector})
      return {
        label: label === null ? null : clean(label.innerText),
        text: content === null ? null : clean(content.innerText),
        inputValue: input === null ? null : input.value,
      }
    }),
    footerButtons: [...dialog.querySelectorAll(${footerButtonSelector})].map((button) => clean(button.innerText)),
    formErrors: [...dialog.querySelectorAll(${formErrorSelector})].map((element) => clean(element.innerText)),
    activeElementTag: active === null ? null : active.tagName.toLowerCase(),
  }
})()`
}

/** 对话框内部选择器。对话框自身的选择器来自 `TimedShutdownDialogSnapshot.dialogSelector`。 */
function dialogScoped(dialogSelector: string, innerSelector: string): string {
  return `${dialogSelector} ${innerSelector}`
}

/** 行内释放列（第 6 列）的「设置定时关机」按钮。该列实测只有这一个按钮。 */
function releaseCellButtonSelector(rowSelector: string): string {
  const releaseCellOrdinal = INSTANCE_LIST_COLUMN.release + 1
  return `${rowSelector} td:nth-of-type(${releaseCellOrdinal}) button`
}

/** 控制台日期时间文本的前缀。列表与对话框都只显示到分钟，允许带秒。 */
const CONSOLE_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)/

/** 金额文本。实测形如 `￥ 1.58`。允许千位分隔符，不做四舍五入。 */
const MONEY_TEXT_PATTERN = /^[￥¥]\s*([0-9][0-9,]*(?:\.[0-9]+)?)$/

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function roundTo(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces
  return Math.round(value * factor) / factor
}

/** 时长必须是正整数分钟：输入框只到分钟，带小数的时长会被静默截断。 */
function assertPositiveIntegerMinutes(ttlMinutes: number): void {
  if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0) {
    throw new RangeError(`定时关机时长必须是正整数分钟，实际 ${ttlMinutes}。`)
  }
}

/** 输入的时间串必须自带时区。裸日期会被 `Date.parse` 当 UTC，静默错八小时。 */
function assertIsoTextWithZone(text: string, field: string): void {
  const trimmed = text.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new RangeError(`${field}必须是带时区的 ISO 时间串，实际「${text}」。`)
  }
}

function assertDialogSelector(raw: RawDialogRead): string {
  if (raw.dialogSelector === null || raw.dialogSelector === '') {
    throw new ConsoleParseError(
      `定位不到当前可见的「${TIMED_SHUTDOWN_DIALOG.title}」对话框（可见 ${raw.visibleDialogCount} 个）。`,
    )
  }
  return raw.dialogSelector
}

function findDialogFormItem(
  items: readonly RawDialogFormItem[],
  labelPrefix: string,
): RawDialogFormItem {
  const item = items.find(
    (candidate) => candidate.label !== null && candidate.label.startsWith(labelPrefix),
  )
  if (item === undefined) {
    throw new ConsoleParseError(`定时关机对话框里找不到「${labelPrefix}」，控制台可能已改版。`)
  }
  return item
}

function parseDialogDateTimeText(text: string, field: string): string {
  const matched = CONSOLE_DATETIME_PATTERN.exec(text.trim())
  const dateTimeText = matched === null ? undefined : matched[1]
  if (dateTimeText === undefined) {
    throw new ConsoleParseError(`读不到${field}：${text === '' ? '（空）' : `「${text}」`}。`)
  }
  try {
    return parseBeijingDateTimeText(dateTimeText)
  } catch (error: unknown) {
    throw new ConsoleParseError(`解析不了${field}「${text}」：${toErrorMessage(error)}`)
  }
}

function parseYuanText(text: string, field: string): number {
  const matched = MONEY_TEXT_PATTERN.exec(text.trim())
  const digits = matched === null ? undefined : matched[1]
  if (digits === undefined) {
    throw new ConsoleParseError(`「${field}」不是金额文本：「${text}」。`)
  }
  return Number(digits.replaceAll(',', ''))
}

/** 把页内原始结构归一成对话框字段。字段缺失或形状不符即抛错，不猜。 */
function parseTimedShutdownDialog(raw: RawDialogRead): TimedShutdownDialogSnapshot {
  if (raw.visibleDialogCount !== 1) {
    throw new ConsoleParseError(
      `应恰好有 1 个可见的「${TIMED_SHUTDOWN_DIALOG.title}」对话框，实际可见 ${raw.visibleDialogCount} 个。`,
    )
  }
  const dialogSelector = assertDialogSelector(raw)
  if (raw.title === null || !raw.title.includes(TIMED_SHUTDOWN_DIALOG.title)) {
    throw new ConsoleParseError(
      `当前可见对话框不是「${TIMED_SHUTDOWN_DIALOG.title}」：标题「${raw.title ?? ''}」。`,
    )
  }
  const serverItem = findDialogFormItem(raw.items, TIMED_SHUTDOWN_DIALOG.serverTimeLabel)
  const shutdownItem = findDialogFormItem(raw.items, TIMED_SHUTDOWN_DIALOG.shutdownAtLabel)
  const costItem = findDialogFormItem(raw.items, TIMED_SHUTDOWN_DIALOG.estimatedCostLabel)
  const balanceItem = findDialogFormItem(raw.items, TIMED_SHUTDOWN_DIALOG.balanceLabel)
  const couponItem = findDialogFormItem(raw.items, TIMED_SHUTDOWN_DIALOG.couponLabel)
  if (shutdownItem.inputValue === null) {
    throw new ConsoleParseError('定时关机对话框里找不到时间输入框，控制台可能已改版。')
  }
  return {
    dialogSelector,
    serverTime: parseDialogDateTimeText(serverItem.text ?? '', '「当前服务器时间」'),
    shutdownAtText: shutdownItem.inputValue,
    estimatedCostText: costItem.text ?? '',
    balanceText: balanceItem.text ?? '',
    couponText: couponItem.text ?? '',
    footerButtons: raw.footerButtons,
    formErrors: raw.formErrors,
    activeElementTag: raw.activeElementTag,
  }
}

function describeDialogSnapshot(snapshot: TimedShutdownDialogSnapshot | undefined): string {
  if (snapshot === undefined) {
    return '最后一次读取没有返回数据。'
  }
  return [
    `服务器时间=${snapshot.serverTime}`,
    `输入框=${snapshot.shutdownAtText === '' ? '空' : snapshot.shutdownAtText}`,
    `预计消费=${snapshot.estimatedCostText === '' ? '空' : snapshot.estimatedCostText}`,
    `焦点=${snapshot.activeElementTag ?? '未知'}`,
    `表单错误=${snapshot.formErrors.length === 0 ? '无' : snapshot.formErrors.join('；')}`,
  ].join('，')
}

/** 校验页脚按钮顺序，保证按序号点的「确定」真是「确定」。 */
function assertFooterButtons(snapshot: TimedShutdownDialogSnapshot): void {
  const confirmOrdinal = TIMED_SHUTDOWN_DIALOG_ELEMENT.confirmButtonOrdinal
  const confirmText = snapshot.footerButtons[confirmOrdinal - 1]
  const cancelText = snapshot.footerButtons[confirmOrdinal - 2]
  if (cancelText === undefined || !cancelText.includes(TIMED_SHUTDOWN_DIALOG.button.cancel)) {
    throw new ConsoleParseError(
      `定时关机对话框页脚第 ${confirmOrdinal - 1} 个按钮应是「${TIMED_SHUTDOWN_DIALOG.button.cancel}」：${snapshot.footerButtons.join('、') || '（无按钮）'}。`,
    )
  }
  if (confirmText === undefined || !confirmText.includes(TIMED_SHUTDOWN_DIALOG.button.confirm)) {
    throw new ConsoleParseError(
      `定时关机对话框页脚第 ${confirmOrdinal} 个按钮应是「${TIMED_SHUTDOWN_DIALOG.button.confirm}」：${snapshot.footerButtons.join('、') || '（无按钮）'}。`,
    )
  }
}

export interface PriceDriftInput {
  /** 部署配置里缓存的历史单价，元/时。 */
  readonly cachedYuanPerHour: number
  /** 本次反推的单价，元/时。 */
  readonly observedYuanPerHour: number
  /** 允许的相对偏差。20% 传 0.2，由调用方给。 */
  readonly thresholdRatio: number
}

export type PriceDriftResult =
  | { readonly drifted: false }
  | { readonly drifted: true; readonly ratio: number; readonly message: string }

/**
 * 判断反推单价与缓存单价的偏差是否超过阈值。
 *
 * 阈值由调用方传入：spec 第 9.2 节的缓存写入与比较在工单 09 落地，
 * 本函数只做纯计算，不碰状态与配置。
 * 判据是严格大于：偏差正好等于阈值不算漂移。
 */
/**
 * 偏差判据的浮点容差。
 *
 * 判据：比值是浮点运算，正好等于阈值的输入会算出比阈值大一点点。
 * 容差只吸收浮点误差，不放宽判据。
 */
const DRIFT_RATIO_EPSILON = 1e-9

export function detectPriceDrift(input: PriceDriftInput): PriceDriftResult {
  const { cachedYuanPerHour, observedYuanPerHour, thresholdRatio } = input
  if (!(cachedYuanPerHour > 0)) {
    throw new RangeError(`缓存单价必须是正数，实际 ${cachedYuanPerHour}。`)
  }
  if (!(observedYuanPerHour >= 0)) {
    throw new RangeError(`反推单价不能是负数，实际 ${observedYuanPerHour}。`)
  }
  if (!(thresholdRatio > 0) || thresholdRatio > 1) {
    throw new RangeError(`偏差阈值必须落在 (0, 1] 内，实际 ${thresholdRatio}。`)
  }
  const ratio = Math.abs(observedYuanPerHour - cachedYuanPerHour) / cachedYuanPerHour
  // 判据：3 → 3.6 这类「正好等于阈值」的算例会算出 20.000000000000004%，
  // 不加浮点容差会被误报成漂移。
  if (ratio <= thresholdRatio + DRIFT_RATIO_EPSILON) {
    return { drifted: false }
  }
  const message =
    `历史单价 ${cachedYuanPerHour} 元/时，本次单价 ${observedYuanPerHour} 元/时，` +
    `偏差 ${(ratio * 100).toFixed(1)}%，超过阈值 ${(thresholdRatio * 100).toFixed(0)}%。` +
    '请复核后更新或清理状态目录里缓存的单价再重试。'
  return { drifted: true, ratio, message }
}

/**
 * 创建单价与定时关机动作。
 *
 * 单价只能从定时关机对话框反推，见 spec 第 7.5 节。
 * `readPriceQuote` 与 `readBalance` 不改变实例状态：它们用右上角 × 关闭对话框。
 */
export function createPriceActions(context: ConsoleRuntimeContext): PricePort {
  const { channel } = context
  const clock: Clock = context.clock ?? systemClock
  // 装配方给了本次运行的日志器就用它（日志落 run 目录），没给才落回 stderr。
  const logger: Logger = context.logger ?? createStderrLogger()

  async function screenshot(fileName: string): Promise<void> {
    await channel.screenshot(join(context.logDir, `timed-shutdown-${fileName}.png`))
  }

  /** 服务器时间与本机时间偏差超过 5 分钟时告警。计算仍用服务器时间。 */
  function warnWhenServerClockSkewed(serverTime: string): void {
    const localTime = beijingIso(new Date(clock.now()))
    const skewMinutes = minutesBetweenIso(serverTime, localTime)
    if (Math.abs(skewMinutes) > CLOCK_SKEW_WARNING_MINUTES) {
      logger.warn('timed_shutdown.clock_skew', { serverTime, localTime, skewMinutes })
    }
  }

  async function readVisibleDialogCount(): Promise<number> {
    return channel.evaluate<number>(buildVisibleDialogCountScript())
  }

  async function readDialogSnapshot(): Promise<TimedShutdownDialogSnapshot> {
    const raw = await channel.evaluate<RawDialogRead>(buildTimedShutdownDialogReadScript())
    return parseTimedShutdownDialog(raw)
  }

  async function waitForVisibleDialogCount(expected: number): Promise<void> {
    const outcome = await pollUntil<number>({
      description: expected === 0 ? '等待定时关机对话框关闭' : '等待定时关机对话框出现',
      probe: async () => {
        const count = await readVisibleDialogCount()
        return count === expected ? count : undefined
      },
      timeoutMs: context.timeoutMs,
      intervalMs: context.pollIntervalMs,
      now: () => clock.now(),
      sleep: (milliseconds) => clock.sleep(milliseconds),
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `定时关机对话框${expected === 0 ? '未在超时内关闭' : '未在超时内出现'}` +
          `（等待 ${context.timeoutMs}ms）。`,
      )
    }
  }

  /**
   * 等对话框打开并读到完整表单。
   *
   * 实测（2026-11-25 真机）：点「设置定时关机」后对话框外壳（标题与 ×）先出现，
   * `.el-form-item` 要再等约 130ms 才渲染出来。只等「可见对话框数量」会把
   * 「外壳出现」当成「表单就绪」，紧接着的一次读取必然报「找不到当前服务器时间」。
   * 所以这里按「整份表单能否解析」轮询，超时把最后一次失败原因带进错误里。
   */
  async function waitForTimedShutdownDialog(): Promise<TimedShutdownDialogSnapshot> {
    let lastFailure = ''
    const outcome = await pollUntil<TimedShutdownDialogSnapshot>({
      description: `等待「${TIMED_SHUTDOWN_DIALOG.title}」对话框渲染出表单`,
      timeoutMs: context.timeoutMs,
      intervalMs: context.pollIntervalMs,
      now: () => clock.now(),
      sleep: (milliseconds) => clock.sleep(milliseconds),
      probe: async () => {
        try {
          return await readDialogSnapshot()
        } catch (error: unknown) {
          lastFailure = toErrorMessage(error)
          return undefined
        }
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `「${TIMED_SHUTDOWN_DIALOG.title}」对话框没有在 ${String(context.timeoutMs)}ms 内渲染出完整表单。` +
          (lastFailure.length === 0 ? '最后一次读取没有失败信息。' : `最后一次读取失败：${lastFailure}`),
      )
    }
    return outcome.value
  }

  /** 打开某一行实例的定时关机对话框，并返回打开时读到的字段。 */
  async function openTimedShutdownDialog(
    instanceId: string,
    label: string,
  ): Promise<TimedShutdownDialogSnapshot> {
    await channel.goto(CONSOLE_INSTANCE_LIST_URL)
    const snapshots = await context.instances.listInstances()
    if (!snapshots.some((snapshot) => snapshot.instanceId === instanceId)) {
      throw new InstanceNotFoundError(instanceId)
    }
    const visibleCount = await readVisibleDialogCount()
    if (visibleCount !== 0) {
      throw new ConsoleParseError(
        `打开定时关机对话框前页面上已有 ${visibleCount} 个未关闭的对话框，无法确定点击目标。请人工关闭后重试。`,
      )
    }
    const rowSelector = await locateInstanceRow(instanceId)
    await screenshot(`${label}-1-list`)
    await channel.click(releaseCellButtonSelector(rowSelector))
    const snapshot = await waitForTimedShutdownDialog()
    await screenshot(`${label}-2-dialog`)
    return snapshot
  }

  async function locateInstanceRow(instanceId: string): Promise<string> {
    const located = parseLocatedSelector(
      await channel.evaluate<unknown>(buildLocateRowScript(instanceId)),
    )
    if (located === undefined) {
      throw new ConsoleParseError(
        `控制台页面上找不到实例 ${instanceId} 所在的列表行，无法打开定时关机对话框。`,
      )
    }
    return located
  }

  async function closeDialog(
    snapshot: TimedShutdownDialogSnapshot,
    label: string,
  ): Promise<void> {
    await channel.click(dialogScoped(snapshot.dialogSelector, DIALOG.headerCloseButton))
    await waitForVisibleDialogCount(0)
    await screenshot(`${label}-closed`)
  }

  /**
   * 写入关机时刻、校验写入、点标题失焦，等到「预计消费」重算。
   *
   * 不许按回车（会提交表单），不许点遮罩（会关掉对话框）。
   * 返回的字段取自同一时刻的一次求值：服务器时间、预计消费、输入框值。
   */
  async function fillShutdownTimeAndBlur(
    opened: TimedShutdownDialogSnapshot,
    shutdownAtText: string,
    label: string,
  ): Promise<DialogQuote> {
    await channel.type(dialogScoped(opened.dialogSelector, DIALOG.textInput), shutdownAtText)
    const typed = await readDialogSnapshot()
    if (typed.shutdownAtText !== shutdownAtText) {
      throw new ConsoleParseError(
        `定时关机时间输入框写入后值不符：期望「${shutdownAtText}」，实际「${typed.shutdownAtText}」。`,
      )
    }
    await screenshot(`${label}-3-filled`)
    await channel.click(dialogScoped(typed.dialogSelector, TIMED_SHUTDOWN_DIALOG_ELEMENT.titleSpan))
    let last: TimedShutdownDialogSnapshot | undefined
    const outcome = await pollUntil<DialogQuote>({
      description: '等待失焦后「预计消费」重算',
      probe: async () => {
        const snapshot = await readDialogSnapshot()
        last = snapshot
        if (snapshot.activeElementTag === 'input') {
          return undefined
        }
        if (snapshot.formErrors.length > 0) {
          return undefined
        }
        if (snapshot.estimatedCostText === TIMED_SHUTDOWN_DIALOG.costUnsetText) {
          return undefined
        }
        return { snapshot }
      },
      timeoutMs: context.timeoutMs,
      intervalMs: context.pollIntervalMs,
      now: () => clock.now(),
      sleep: (milliseconds) => clock.sleep(milliseconds),
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `失焦后「预计消费」未重算，无法反推单价。${describeDialogSnapshot(last)}`,
      )
    }
    const quoted = outcome.value
    // 实测遇过：日期控件在失焦时把输入框回退成模型里的旧值。这条不校验就会按错的时长算单价。
    if (quoted.snapshot.shutdownAtText !== shutdownAtText) {
      throw new ConsoleParseError(
        `失焦后定时关机时间输入框的值变成「${quoted.snapshot.shutdownAtText === '' ? '（空）' : quoted.snapshot.shutdownAtText}」，` +
          `期望「${shutdownAtText}」。`,
      )
    }
    await screenshot(`${label}-4-quoted`)
    return quoted
  }

  async function readPriceQuote(instanceId: string, ttlMinutes: number): Promise<PriceQuote> {
    assertPositiveIntegerMinutes(ttlMinutes)
    const opened = await openTimedShutdownDialog(instanceId, 'price-quote')
    warnWhenServerClockSkewed(opened.serverTime)
    const shutdownAtText = formatBeijingMinute(addMinutesIso(opened.serverTime, ttlMinutes))
    const quoted = await fillShutdownTimeAndBlur(opened, shutdownAtText, 'price-quote')
    // 先关对话框再算：解析或校验失败时页面上不留半开的对话框。
    await closeDialog(quoted.snapshot, 'price-quote')
    const snapshot = quoted.snapshot
    const shutdownAt = parseDialogDateTimeText(snapshot.shutdownAtText, '「定时关机时间」')
    const durationMinutes = minutesBetweenIso(snapshot.serverTime, shutdownAt)
    if (durationMinutes <= 0) {
      throw new ConsoleParseError(
        `控制台服务器时间 ${snapshot.serverTime} 不早于关机时刻 ${shutdownAt}，` +
          `时长 ${durationMinutes} 分钟，无法反推单价。`,
      )
    }
    const estimatedCostYuan = parseYuanText(snapshot.estimatedCostText, '预计消费')
    const unitPriceYuanPerHour = roundTo(
      estimatedCostYuan / (durationMinutes / 60),
      UNIT_PRICE_DECIMAL_PLACES,
    )
    const balanceYuan = parseYuanText(snapshot.balanceText, '账户余额')
    const couponYuan = parseYuanText(snapshot.couponText, '账户代金券')
    logger.info('timed_shutdown.quote_read', {
      instanceId,
      serverTime: snapshot.serverTime,
      shutdownAt,
      ttlMinutes: durationMinutes,
      estimatedCostYuan,
      unitPriceYuanPerHour,
      balanceYuan,
      couponYuan,
    })
    return {
      serverTime: snapshot.serverTime,
      unitPriceYuanPerHour,
      estimatedCostYuan,
      ttlMinutes: durationMinutes,
      balanceYuan,
    }
  }

  async function setTimedShutdown(
    instanceId: string,
    shutdownAt: string,
  ): Promise<TimedShutdownReceipt> {
    assertIsoTextWithZone(shutdownAt, '关机时刻')
    const shutdownAtText = formatBeijingMinute(shutdownAt)
    const normalizedShutdownAt = parseBeijingDateTimeText(shutdownAtText)
    const opened = await openTimedShutdownDialog(instanceId, 'set-shutdown')
    warnWhenServerClockSkewed(opened.serverTime)
    const leadMinutes = minutesBetweenIso(opened.serverTime, normalizedShutdownAt)
    if (leadMinutes <= 0) {
      throw new RangeError(
        `关机时刻 ${normalizedShutdownAt} 不晚于控制台服务器时间 ${opened.serverTime}。`,
      )
    }
    const quoted = await fillShutdownTimeAndBlur(opened, shutdownAtText, 'set-shutdown')
    // 设置路径只需要确认「预计消费」已出现，不用它的数值。
    parseYuanText(quoted.snapshot.estimatedCostText, '预计消费')
    assertFooterButtons(quoted.snapshot)
    // 本模块唯一会改变实例行为的点击。
    await channel.click(
      dialogScoped(
        quoted.snapshot.dialogSelector,
        `${DIALOG.footerButton}:nth-of-type(${TIMED_SHUTDOWN_DIALOG_ELEMENT.confirmButtonOrdinal})`,
      ),
    )
    await waitForVisibleDialogCount(0)
    await screenshot('set-shutdown-5-confirmed')
    // 列表页看不出是否已设置，回读靠重新打开对话框看输入框回填。
    const readback = await openTimedShutdownDialog(instanceId, 'set-shutdown-readback')
    await closeDialog(readback, 'set-shutdown-readback')
    if (readback.shutdownAtText !== shutdownAtText) {
      throw new ConsoleParseError(
        `设置定时关机后回读不一致：期望「${shutdownAtText}」，实际` +
          `「${readback.shutdownAtText === '' ? '（空）' : readback.shutdownAtText}」。`,
      )
    }
    logger.info('timed_shutdown.set', {
      instanceId,
      serverTime: opened.serverTime,
      shutdownAt: normalizedShutdownAt,
      leadMinutes,
    })
    return { serverTime: opened.serverTime, shutdownAt: normalizedShutdownAt }
  }

  async function readBalance(): Promise<number> {
    // 余额是账户级数据，与实例无关。定时关机对话框只从列表行进入，所以用第一行。
    const rows = await context.instances.listInstances()
    const first = rows[0]
    if (first === undefined) {
      throw new ConsoleParseError(
        '控制台实例列表为空，无法打开定时关机对话框读取账户余额。',
      )
    }
    const opened = await openTimedShutdownDialog(first.instanceId, 'balance')
    await closeDialog(opened, 'balance')
    const balanceYuan = parseYuanText(opened.balanceText, '账户余额')
    logger.info('timed_shutdown.balance_read', { balanceYuan })
    return balanceYuan
  }

  /**
   * 取消平台定时关机。
   *
   * 实测（2026-11-25 真机）：定时关机到点触发后，列表第 6 列仍显示那个已过去的时刻，
   * 平台不会自动清除。清除入口是该列的「关闭」按钮，点后弹「取消定时关机」消息框，
   * 点「确定」后提示「取消成功」，该列回到「设置定时关机」按钮。
   *
   * 幂等：列表回读里 `timedShutdownAt` 为空时什么都不做，不点任何按钮。
   * 有记录却找不到「关闭」按钮时报错，不静默跳过：那是页面结构变了。
   */
  async function clearTimedShutdown(instanceId: string): Promise<void> {
    await channel.goto(CONSOLE_INSTANCE_LIST_URL)
    const snapshots = await context.instances.listInstances({ refresh: true })
    const snapshot = snapshots.find((candidate) => candidate.instanceId === instanceId)
    if (snapshot === undefined) {
      throw new InstanceNotFoundError(instanceId)
    }
    if (snapshot.timedShutdownAt === null) {
      logger.info('timed_shutdown.clear.skipped', { instanceId, reason: '列表里没有定时关机记录' })
      return
    }

    const rowSelector = await locateInstanceRow(instanceId)
    const buttonSelector = parseLocatedSelector(
      await channel.evaluate<unknown>(
        buildLocateButtonScript(rowSelector, INSTANCE_BUTTON_TEXT.clearTimedShutdown),
      ),
    )
    if (buttonSelector === undefined) {
      throw new ConsoleParseError(
        `实例 ${instanceId} 有定时关机记录，但列表里找不到「${INSTANCE_BUTTON_TEXT.clearTimedShutdown}」按钮。` +
          '控制台结构可能已变。',
      )
    }
    logger.info('timed_shutdown.clear.start', { instanceId, shutdownAt: snapshot.timedShutdownAt })
    await channel.click(buttonSelector)
    await confirmMessageBoxIfAsked(
      context,
      CLEAR_TIMED_SHUTDOWN_CONFIRM.questionPrefix,
      '取消定时关机',
    )

    const outcome = await pollUntil<true>({
      description: `等待实例 ${instanceId} 的定时关机记录被清掉`,
      timeoutMs: context.timeoutMs,
      intervalMs: context.pollIntervalMs,
      now: () => clock.now(),
      sleep: (milliseconds: number) => clock.sleep(milliseconds),
      probe: async () => {
        const latest = await context.instances.listInstances({ refresh: true })
        const current = latest.find((candidate) => candidate.instanceId === instanceId)
        return current !== undefined && current.timedShutdownAt === null ? true : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `实例 ${instanceId} 的定时关机记录没有在 ${String(context.timeoutMs)}ms 内清掉。`,
      )
    }
    logger.info('timed_shutdown.cleared', { instanceId })
  }

  return { readPriceQuote, setTimedShutdown, clearTimedShutdown, readBalance }
}
