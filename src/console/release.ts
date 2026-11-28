import { join } from 'node:path'
import { z } from 'zod'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import { ConsoleParseError } from '../errors.js'
import { createFanoutLogger, createJsonlFileLogger, createStderrLogger, type Logger } from '../logging/logger.js'
import { systemClock, type Clock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'
import { minutesBetweenIso } from '../util/time.js'
import { jsString } from './dom.js'
import { buildVerifiedSelectorExpression } from './locate.js'
import type { ConsoleRuntimeContext, InstanceListPort, TeardownOutcome, TeardownPort } from './ports.js'
import { buildLocateButtonScript, buildLocateRowScript, parseLocatedSelector } from './power.js'
import { confirmMessageBoxIfAsked } from './confirm.js'
import {
  CONFIRM_BUTTON_TEXTS,
  CONSOLE_BUTTON_TAG,
  CONSOLE_INSTANCE_LIST_URL,
  DIALOG,
  DROPDOWN,
  DROPDOWN_ITEM_TEXT,
  INSTANCE_BUTTON_TEXT,
  MESSAGE_BOX,
  POWER_OFF_CONFIRM,
} from './selectors.js'

/**
 * 关机、释放与终态验证。
 *
 * 判据（spec 第 7.6 节）：销毁链的终态是「实例从列表消失」，不是「关机请求返回成功」，
 * 也不是「释放请求返回成功」。计费按实例存在判定，所以列表里还能读到该 ID
 * 就说明钱可能还在烧。
 *
 * 控制台事实见 docs/refs/autodl/console-selectors.md；三条决定本文件的形状：
 *
 * 1. 行内按钮与「更多」按钮没有稳定类名，只能按文字定位，且必须限定在目标行内。
 * 2. 每一行都有自己的「更多」弹层，全部留在 DOM 里。必须取当前可见的那个，
 *    不能取第一个，否则可能点到另一行的「释放实例」。
 * 3. 释放不可恢复。本模块只点一次「释放实例」，任何环节失败都返回 ESCALATED，
 *    不自动重试。
 *
 * 行与行内按钮的定位复用 `power.ts` 的页内脚本：按实例 ID 定位行、按文字定位按钮，
 * 选择器生成时回验指回同一元素。菜单项与确认按钮在页面上没有唯一文字作用域，
 * 本文件额外生成「路径选择器」，同样回验后才交给 `channel.click`。
 */

/** 步骤日志文件名。落进 `context.logDir`。 */
export const TEARDOWN_LOG_FILE = 'teardown.jsonl'

/** 截图文件名前缀。 */
const SCREENSHOT_PREFIX = 'teardown'

/**
 * 等「更多」菜单出现「释放实例」的上限。
 *
 * 菜单是本地渲染，正常几十毫秒。上限只用来兜住页面卡死。
 */
const MENU_OPEN_WAIT_MS = 5_000

/**
 * 等二次确认弹窗的上限。
 *
 * 有的账号配置不弹确认窗。等不到就继续，但必须记日志说明「没等到」。
 */
const RELEASE_CONFIRM_WAIT_MS = 10_000

/**
 * 「更多」最多点两次。
 *
 * 下拉是开关语义：第一次点击可能是在关掉上一次遗留的弹层，第二次才是打开。
 * 这不是对销毁动作的重试：只重复点菜单开关，不会重复点「释放实例」。
 */
const MENU_TOGGLE_ATTEMPTS = 2

/** 菜单项定位脚本的返回结构。 */
const VisibleMenuItemProbeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('located'),
    selector: z.string().min(1),
    itemText: z.string().min(1),
    /** `aria-hint` 表示弹层由本行的 aria 指向确认；`single-visible` 表示只有它一个可见。 */
    matchedBy: z.enum(['aria-hint', 'single-visible']),
  }),
  z.object({ kind: z.literal('no-visible-popper') }),
  z.object({ kind: z.literal('popper-ambiguous'), count: z.number().int().positive() }),
  z.object({ kind: z.literal('item-missing') }),
  z.object({ kind: z.literal('unlocatable') }),
])

export type VisibleMenuItemProbe = z.infer<typeof VisibleMenuItemProbeSchema>
export type LocatedMenuItemProbe = Extract<VisibleMenuItemProbe, { readonly kind: 'located' }>

/** 二次确认弹窗定位脚本的返回结构。 */
const ConfirmDialogProbeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }),
  z.object({
    kind: z.literal('located'),
    selector: z.string().min(1),
    source: z.enum(['message-box', 'dialog']),
    title: z.string(),
    buttonText: z.string().min(1),
  }),
  z.object({
    kind: z.literal('unrecognized'),
    source: z.enum(['message-box', 'dialog']),
    title: z.string(),
    buttons: z.array(z.string()),
  }),
  z.object({ kind: z.literal('ambiguous'), titles: z.array(z.string()) }),
  z.object({ kind: z.literal('unlocatable') }),
])

export type ConfirmDialogProbe = z.infer<typeof ConfirmDialogProbeSchema>
export type LocatedConfirmDialogProbe = Extract<ConfirmDialogProbe, { readonly kind: 'located' }>
type UnrecognizedConfirmDialogProbe = Extract<ConfirmDialogProbe, { readonly kind: 'unrecognized' }>

/** 页面返回的结构不符合预期时抛 ConsoleParseError。页面改版必须报错，不得猜。 */
export function parseVisibleMenuItemProbe(raw: unknown): VisibleMenuItemProbe {
  const parsed = VisibleMenuItemProbeSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConsoleParseError(`「更多」菜单定位脚本返回的结构非法：${JSON.stringify(raw)}`)
  }
  return parsed.data
}

export function parseConfirmDialogProbe(raw: unknown): ConfirmDialogProbe {
  const parsed = ConfirmDialogProbeSchema.safeParse(raw)
  if (!parsed.success) {
    throw new ConsoleParseError(`二次确认弹窗定位脚本返回的结构非法：${JSON.stringify(raw)}`)
  }
  return parsed.data
}

/**
 * 读页面：在「属于本行、当前可见」的下拉弹层里按文字找菜单项，返回可点击的选择器。
 *
 * 弹层多行共存，全部留在 DOM 里，必须取当前可见的那个，否则可能点到另一行的
 * 「释放实例」。点击前先找正面证据：实测本行 `div.el-dropdown` 带
 * `aria-describedby` 属性，若它指向某个可见弹层，那个弹层就是本行的。
 * 命中不到时退化为「只有一个可见弹层」判据；多个可见且无证据时报 ambiguous，不猜。
 *
 * 可见判据（2026-11-26 真机修正）：
 * 1. `display !== 'none'` 且 `visibility !== 'hidden'`。
 * 2. **不要求几何尺寸。** Element Plus 的弹层在过渡期间 `opacity: 0`、高度为 0，
 *    但它是「正在出现」而不是「不存在」。按尺寸判会把刚点开的菜单判成没打开，
 *    轮询到超时。归属由 `aria-describedby` 正面证据裁决，不靠尺寸。
 * 3. 「未失效」判据用 `aria-hidden`：Element Plus 关闭弹层时设 `aria-hidden="true"`。
 */
export function buildLocateVisibleMenuItemScript(input: {
  readonly rowSelector: string
  readonly itemText: string
}): string {
  return `(() => {
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim()
${buildVerifiedSelectorExpression()}
  const isOpen = (element) => {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    return element.getAttribute('aria-hidden') !== 'true'
  }
  const row = document.querySelector(${jsString(input.rowSelector)})
  const hintElements = []
  if (row !== null) {
    hintElements.push(...row.querySelectorAll('[aria-describedby]'))
    const trigger = row.querySelector(${jsString(DROPDOWN.trigger)})
    if (trigger !== null) hintElements.push(trigger)
  }
  const hints = []
  for (const element of hintElements) {
    const hint = element.getAttribute('aria-describedby')
    if (hint !== null && !hints.includes(hint)) hints.push(hint)
  }
  const matchesHint = (popper) =>
    hints.some((hint) => popper.id === hint || [...popper.querySelectorAll('[id]')].some((element) => element.id === hint))
  const poppers = [...document.querySelectorAll(${jsString(DROPDOWN.popper)})].filter(isOpen)
  if (poppers.length === 0) return { kind: 'no-visible-popper' }
  const hinted = poppers.filter(matchesHint)
  if (hinted.length > 1) return { kind: 'popper-ambiguous', count: hinted.length }
  if (hinted.length === 0 && poppers.length > 1) return { kind: 'popper-ambiguous', count: poppers.length }
  const popper = hinted.length === 1 ? hinted[0] : poppers[0]
  const matchedBy = hinted.length === 1 ? 'aria-hint' : 'single-visible'
  const items = [...popper.querySelectorAll(${jsString(DROPDOWN.menuItem)})]
  const item = items.find((candidate) => clean(candidate.innerText).includes(${jsString(input.itemText)}))
  if (item === undefined) return { kind: 'item-missing' }
  const selector = toVerifiedSelector(item)
  if (selector === null) return { kind: 'unlocatable' }
  return { kind: 'located', selector, itemText: clean(item.innerText), matchedBy }
})()`
}

/**
 * 读页面：找当前可见的二次确认弹窗，返回它里面确认按钮的可点击选择器。
 *
 * 兼容 Element Plus 的两种形态：消息框（`.el-message-box`）与对话框（`.el-dialog`）。
 * 弹窗形态与按钮文字本轮未实测：释放不可恢复，只能由人工发起。因此按钮按文字包含匹配。
 */
export function buildLocateConfirmButtonScript(): string {
  return `(() => {
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim()
${buildVerifiedSelectorExpression()}
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const confirmTexts = ${JSON.stringify(CONFIRM_BUTTON_TEXTS)}
  const containers = []
  for (const element of [...document.querySelectorAll(${jsString(MESSAGE_BOX.root)})]) {
    if (isVisible(element)) containers.push({ source: 'message-box', element, titleSelector: ${jsString(MESSAGE_BOX.title)} })
  }
  for (const element of [...document.querySelectorAll(${jsString(DIALOG.root)})]) {
    if (isVisible(element)) containers.push({ source: 'dialog', element, titleSelector: ${jsString(DIALOG.title)} })
  }
  const describeTitle = (container) => {
    const titleElement = container.element.querySelector(container.titleSelector)
    return titleElement === null ? '' : clean(titleElement.innerText)
  }
  if (containers.length === 0) return { kind: 'absent' }
  if (containers.length > 1) return { kind: 'ambiguous', titles: containers.map(describeTitle) }
  const container = containers[0]
  const title = describeTitle(container)
  const buttons = [...container.element.querySelectorAll(${jsString(CONSOLE_BUTTON_TAG)})]
  const confirmButton = buttons.find((button) => confirmTexts.some((text) => clean(button.innerText).includes(text)))
  if (confirmButton === undefined) {
    return {
      kind: 'unrecognized',
      source: container.source,
      title,
      buttons: buttons.map((button) => clean(button.innerText)),
    }
  }
  const selector = toVerifiedSelector(confirmButton)
  if (selector === null) return { kind: 'unlocatable' }
  return { kind: 'located', selector, source: container.source, title, buttonText: clean(confirmButton.innerText) }
})()`
}

interface TeardownRun {
  readonly context: ConsoleRuntimeContext
  readonly logger: Logger
  readonly clock: Clock
  readonly instanceId: string
}

type PowerOffPollResult = 'stopped' | 'vanished'

function readClock(context: ConsoleRuntimeContext): Clock {
  return context.clock ?? systemClock
}

async function readInstance(
  instances: InstanceListPort,
  instanceId: string,
): Promise<ConsoleInstanceSnapshot | undefined> {
  // 控制台列表页不自动刷新，读之前先让控制台取一次新数据。
  const snapshots = await instances.listInstances({ refresh: true })
  return snapshots.find((snapshot) => snapshot.instanceId === instanceId)
}

/** 截图落盘并记日志。截图是事后回查的唯一现场。 */
async function recordScreenshot(run: TeardownRun, step: string): Promise<string> {
  const filePath = join(run.context.logDir, `${SCREENSHOT_PREFIX}-${step}.png`)
  await run.context.channel.screenshot(filePath)
  run.logger.info('teardown.screenshot', { step, path: filePath })
  return filePath
}

/**
 * 页面结构不符合预期时先留截图与错误日志，再抛 ConsoleParseError。
 *
 * 这类失败需要人看现场：只抛异常的话，唯一的现场只剩退出码。
 */
async function failWithScreenshot(run: TeardownRun, step: string, message: string): Promise<never> {
  run.logger.error('teardown.failed', { instanceId: run.instanceId, reason: message })
  await recordScreenshot(run, step)
  throw new ConsoleParseError(message)
}

/** 按实例 ID 定位列表行，返回可交给通道的行为作用域选择器。 */
async function locateRow(run: TeardownRun): Promise<string> {
  const raw = await run.context.channel.evaluate<unknown>(buildLocateRowScript(run.instanceId))
  const selector = parseLocatedSelector(raw)
  if (selector === undefined) {
    return failWithScreenshot(run, '01-row-missing', `控制台页面上找不到实例 ${run.instanceId} 所在的列表行。`)
  }
  return selector
}

/** 在行作用域内按文字定位按钮，返回可点击的选择器。 */
async function locateRowButton(
  run: TeardownRun,
  rowSelector: string,
  buttonText: string,
  failureStep: string,
): Promise<string> {
  const raw = await run.context.channel.evaluate<unknown>(buildLocateButtonScript(rowSelector, buttonText))
  const selector = parseLocatedSelector(raw)
  if (selector === undefined) {
    return failWithScreenshot(
      run,
      failureStep,
      `实例 ${run.instanceId} 所在行内找不到文字为「${buttonText}」的按钮。`,
    )
  }
  return selector
}

function pollOptions(run: TeardownRun): {
  readonly intervalMs: number
  readonly now: () => number
  readonly sleep: (milliseconds: number) => Promise<void>
} {
  return {
    intervalMs: run.context.pollIntervalMs,
    now: () => run.clock.now(),
    sleep: (milliseconds) => run.clock.sleep(milliseconds),
  }
}

/**
 * 关机：点行内「关机」，轮询到 `stopped`。
 *
 * 返回 `undefined` 表示已到已关机状态，可以继续释放。返回结果表示链在这里结束：
 * 超时 → ESCALATED；关机期间实例从列表消失 → 视为已消失。
 */
async function runPowerOff(run: TeardownRun, statusRaw: string): Promise<TeardownOutcome | undefined> {
  const rowSelector = await locateRow(run)
  const buttonSelector = await locateRowButton(
    run,
    rowSelector,
    INSTANCE_BUTTON_TEXT.powerOff,
    '02-power-off-target-missing',
  )
  run.logger.info('teardown.power-off.click', { instanceId: run.instanceId, statusRaw, selector: buttonSelector })
  await run.context.channel.click(buttonSelector)
  // 实测：点「关机」还会弹「确认关机吗？」消息框，不点「确定」实例不会停。
  await confirmMessageBoxIfAsked(
    run.context,
    POWER_OFF_CONFIRM.questionPrefix,
    INSTANCE_BUTTON_TEXT.powerOff,
  )
  await recordScreenshot(run, '02-after-power-off-click')

  let attempts = 0
  const outcome = await pollUntil<PowerOffPollResult>({
    description: `实例 ${run.instanceId} 变为已关机`,
    timeoutMs: run.context.timeoutMs,
    ...pollOptions(run),
    probe: async () => {
      attempts += 1
      const instance = await readInstance(run.context.instances, run.instanceId)
      if (instance === undefined) {
        return 'vanished'
      }
      return instance.status === 'stopped' ? 'stopped' : undefined
    },
  })

  if (outcome.status === 'timeout') {
    const reason =
      `关机后 ${String(run.context.timeoutMs)}ms 内实例 ${run.instanceId} 未变为已关机` +
      `（轮询 ${String(attempts)} 轮）`
    run.logger.warn('teardown.power-off.timeout', { instanceId: run.instanceId, reason })
    await recordScreenshot(run, '03-escalated-power-off')
    return { state: 'escalated', reason }
  }
  if (outcome.value === 'vanished') {
    run.logger.warn('teardown.power-off.vanished', { instanceId: run.instanceId })
    return { state: 'gone' }
  }
  run.logger.info('teardown.power-off.stopped', { instanceId: run.instanceId, attempts })
  return undefined
}

/**
 * 打开目标行的「更多」，在可见弹层里定位「释放实例」。
 *
 * 只做定位，不点击菜单项。返回后调用方点一次该项。
 */
async function locateReleaseMenuItem(run: TeardownRun): Promise<LocatedMenuItemProbe> {
  const rowSelector = await locateRow(run)
  const moreSelector = await locateRowButton(run, rowSelector, INSTANCE_BUTTON_TEXT.more, '03-more-target-missing')

  let lastProbeKind: VisibleMenuItemProbe['kind'] = 'no-visible-popper'
  for (let attempt = 1; attempt <= MENU_TOGGLE_ATTEMPTS; attempt += 1) {
    await run.context.channel.click(moreSelector)
    run.logger.info('teardown.release.menu-toggle', { instanceId: run.instanceId, attempt })
    const outcome = await pollUntil<LocatedMenuItemProbe>({
      description: `「更多」菜单出现可见的「${DROPDOWN_ITEM_TEXT.release}」`,
      timeoutMs: MENU_OPEN_WAIT_MS,
      ...pollOptions(run),
      probe: async () => {
        const probe = parseVisibleMenuItemProbe(
          await run.context.channel.evaluate<unknown>(
            buildLocateVisibleMenuItemScript({ rowSelector, itemText: DROPDOWN_ITEM_TEXT.release }),
          ),
        )
        lastProbeKind = probe.kind
        if (probe.kind === 'located') {
          return probe
        }
        if (probe.kind === 'unlocatable') {
          return failWithScreenshot(
            run,
            '03-release-menu-unlocatable',
            `「${DROPDOWN_ITEM_TEXT.release}」菜单项位置无法转成可点击选择器：实例 ${run.instanceId}`,
          )
        }
        return undefined
      },
    })
    if (outcome.status === 'matched') {
      run.logger.info('teardown.release.menu-open', {
        instanceId: run.instanceId,
        attempt,
        itemText: outcome.value.itemText,
        matchedBy: outcome.value.matchedBy,
        selector: outcome.value.selector,
      })
      return outcome.value
    }
    run.logger.warn('teardown.release.menu-toggle-timeout', {
      instanceId: run.instanceId,
      attempt,
      lastProbeKind,
    })
  }

  return failWithScreenshot(
    run,
    '03-release-menu-missing',
    `点了 ${String(MENU_TOGGLE_ATTEMPTS)} 次「${INSTANCE_BUTTON_TEXT.more}」后仍未看到可见的` +
      `「${DROPDOWN_ITEM_TEXT.release}」菜单项：实例 ${run.instanceId}（最后一次探测：${lastProbeKind}）`,
  )
}

/**
 * 等二次确认弹窗并点确认。
 *
 * 返回是否点过确认按钮。弹窗没出现也算继续：有的账号配置不弹确认，但必须记日志。
 */
async function confirmRelease(run: TeardownRun): Promise<boolean> {
  let lastProbeKind: ConfirmDialogProbe['kind'] = 'absent'
  const outcome = await pollUntil<LocatedConfirmDialogProbe>({
    description: `实例 ${run.instanceId} 的释放二次确认弹窗`,
    timeoutMs: RELEASE_CONFIRM_WAIT_MS,
    ...pollOptions(run),
    probe: async () => {
      const probe = parseConfirmDialogProbe(
        await run.context.channel.evaluate<unknown>(buildLocateConfirmButtonScript()),
      )
      lastProbeKind = probe.kind
      if (probe.kind === 'located') {
        return probe
      }
      // 弹窗可能在下一次轮询才渲染完；同时出现多个可见弹窗时也不猜，继续等。
      if (probe.kind === 'absent' || probe.kind === 'ambiguous') {
        return undefined
      }
      if (probe.kind === 'unlocatable') {
        return failWithScreenshot(
          run,
          '05-release-confirm-unlocatable',
          `释放确认按钮位置无法转成可点击选择器：实例 ${run.instanceId}`,
        )
      }
      return failWithScreenshot(run, '05-release-confirm-unrecognized', describeConfirmDialogFailure(probe, run.instanceId))
    },
  })

  if (outcome.status === 'timeout') {
    run.logger.warn('teardown.release.confirm-absent', {
      instanceId: run.instanceId,
      waitedMs: RELEASE_CONFIRM_WAIT_MS,
      lastProbeKind,
    })
    return false
  }

  run.logger.info('teardown.release.confirm-click', {
    instanceId: run.instanceId,
    source: outcome.value.source,
    title: outcome.value.title,
    buttonText: outcome.value.buttonText,
    selector: outcome.value.selector,
  })
  await run.context.channel.click(outcome.value.selector)
  return true
}

/**
 * 弹窗可见但找不到确认按钮。此时不能猜一个按钮点：猜错可能点了「取消」。
 *
 * 多个可见弹窗只算「还没稳定」，由调用方继续轮询；只有这里才是真的结构不符。
 */
function describeConfirmDialogFailure(probe: UnrecognizedConfirmDialogProbe, instanceId: string): string {
  const kindText = probe.source === 'message-box' ? '消息框' : '对话框'
  return (
    `实例 ${instanceId} 出现可见的${kindText}（标题「${probe.title}」），` +
    `但找不到确认按钮。按钮文字：${probe.buttons.join(' / ')}`
  )
}

/** 终态验证：轮询列表，直到该实例 ID 不再出现。 */
async function waitUntilGone(run: TeardownRun): Promise<TeardownOutcome> {
  let attempts = 0
  const outcome = await pollUntil<true>({
    description: `实例 ${run.instanceId} 从实例列表消失`,
    timeoutMs: run.context.timeoutMs,
    ...pollOptions(run),
    probe: async () => {
      attempts += 1
      const instance = await readInstance(run.context.instances, run.instanceId)
      return instance === undefined ? true : undefined
    },
  })

  if (outcome.status === 'timeout') {
    const reason =
      `释放后 ${String(run.context.timeoutMs)}ms 内实例 ${run.instanceId} 仍在实例列表中出现` +
      `（轮询 ${String(attempts)} 轮）`
    run.logger.warn('teardown.gone.timeout', { instanceId: run.instanceId, reason })
    await recordScreenshot(run, '06-escalated-still-listed')
    return { state: 'escalated', reason }
  }

  run.logger.info('teardown.gone', { instanceId: run.instanceId, attempts })
  await recordScreenshot(run, '06-gone')
  return { state: 'gone' }
}

export function createTeardownActions(context: ConsoleRuntimeContext): TeardownPort {
  return {
    async destroy(instanceId: string): Promise<TeardownOutcome> {
      // 两条出口：动作证据文件落本次 run 目录，运行日志走装配方给的日志器（缺省 stderr）。
      const logger = createFanoutLogger(
        createJsonlFileLogger(join(context.logDir, TEARDOWN_LOG_FILE)),
        context.logger ?? createStderrLogger(),
      )
      const run: TeardownRun = { context, logger, clock: readClock(context), instanceId }
      logger.info('teardown.start', { instanceId })
      await context.channel.goto(CONSOLE_INSTANCE_LIST_URL)
      await recordScreenshot(run, '01-list-before')

      const initial = await readInstance(context.instances, instanceId)
      if (initial === undefined) {
        logger.info('teardown.gone', { instanceId, phase: 'before-destroy' })
        return { state: 'gone' }
      }

      if (initial.status === 'running' || initial.status === 'starting') {
        const powerOffOutcome = await runPowerOff(run, initial.statusRaw)
        if (powerOffOutcome !== undefined) {
          return powerOffOutcome
        }
      } else if (initial.status !== 'stopped') {
        const reason =
          `实例 ${instanceId} 的控制台状态是「${initial.statusRaw}」，` +
          '不在可销毁状态（运行中 / 开机中 / 已关机）'
        logger.warn('teardown.escalated', { instanceId, phase: 'precondition', reason })
        await recordScreenshot(run, '02-escalated-status')
        return { state: 'escalated', reason }
      }

      const menuItem = await locateReleaseMenuItem(run)
      await recordScreenshot(run, '03-menu-open')
      await context.channel.click(menuItem.selector)
      logger.info('teardown.release.click', { instanceId, selector: menuItem.selector })
      await recordScreenshot(run, '04-after-release-click')

      const confirmed = await confirmRelease(run)
      if (confirmed) {
        await recordScreenshot(run, '05-after-confirm')
      }

      return waitUntilGone(run)
    },
  }
}

/**
 * 账本金额：金额 = 单价 × 时长（小时）。
 *
 * 纯函数：不读时钟，起止时刻都由调用方给（工单 10 记时间与金额用）。
 * 时长用北京时间的绝对时刻换算，跨日与偏移都正确。
 */
export function computeLedgerAmount(input: {
  unitPriceYuanPerHour: number
  startedAt: string
  stoppedAt: string
}): number {
  if (!Number.isFinite(input.unitPriceYuanPerHour) || input.unitPriceYuanPerHour < 0) {
    throw new RangeError(`单价必须是非负有限数：${String(input.unitPriceYuanPerHour)}`)
  }
  const durationMinutes = minutesBetweenIso(input.startedAt, input.stoppedAt)
  if (durationMinutes < 0) {
    throw new RangeError(`停止时刻早于开始时刻：${input.startedAt} → ${input.stoppedAt}`)
  }
  return input.unitPriceYuanPerHour * (durationMinutes / 60)
}
