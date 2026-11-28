import { join } from 'node:path'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import {
  CloneQuotaExhaustedError,
  CloneSourceUnavailableError,
  CloneTargetUnavailableError,
  CloneTimeoutError,
  ConsoleParseError,
  DeploydeckError,
  HumanRequiredError,
  InstanceNotFoundError,
  StrayInstanceError,
} from '../errors.js'
import { createFanoutLogger, createJsonlFileLogger, createStderrLogger } from '../logging/logger.js'
import { systemClock } from '../util/clock.js'
import type { Clock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'
import { jsString } from './dom.js'
import { buildVerifiedSelectorExpression } from './locate.js'
import { resolveGpuModelPageName, stripGpuAvailability } from './gpu-models.js'
import type { CloneOutcome, ClonePort, CloneRequest, ConsoleRuntimeContext } from './ports.js'
import { buildLocateButtonScript, buildLocateRowScript, parseLocatedSelector } from './power.js'
import { buildLocateVisibleMenuItemScript, parseVisibleMenuItemProbe } from './release.js'
import {
  CLONE_CREATE_FAILURE_NOTICE,
  CLONE_DIALOG,
  CLONE_HOST_CONTROLS,
  CLONE_HOST_PAGE,
  CONSOLE_BUTTON_TAG,
  CONSOLE_CLONE_HOST_URL_PREFIX,
  CONSOLE_INSTANCE_LIST_URL,
  DIALOG,
  DROPDOWN_ITEM_TEXT,
  ELEMENT_PLUS,
  INSTANCE_BUTTON_TEXT,
  INSTANCE_IDENTITY_CELL,
  INSTANCE_LIST,
} from './selectors.js'

/**
 * 克隆实例。
 *
 * 流程分两页：实例列表的「更多」→「克隆实例新」是对话框，点「继续」后跳到
 * `/cloneInstance` 选主机页。页面事实见 docs/refs/autodl/console-selectors.md 第 3 节。
 *
 * 三条实测判据决定了本文件的形状：
 *
 * 1. 关掉弹层只能用对话框右上角 ×。点遮罩会关闭且丢状态。
 * 2. 页面标签在后台时 Element Plus 的过渡不推进，可见性一律按几何尺寸判断。
 * 3. 平台默认值不可信（数据盘默认未勾选、稀疏优化默认未开启），两项都显式设置。
 * 4. 克隆不复制实例名（实测 2026-11-25 真机）。新实例在列表第 0 列显示「设置名称」按钮，
 *    名称为空串。克隆完成后必须按「设置名称」显式改名，否则下次按名字找不到它，会再克隆一台。
 *
 * 定位做法与控制台其余动作一致：页内求值只读，把目标元素转成结构选择器并回验，
 * 之后只按选择器点击。行与行内按钮的定位复用 `power.ts`，「更多」菜单项的定位复用
 * `release.ts`（它按 aria 指向挑当前行的弹层，避免点到另一行的同名菜单项）。
 *
 * 克隆会真的创建实例并计费。本文件不点「创建并开机」以外的任何确认按钮，
 * 创建后按「点击前不存在的实例 ID」识别新实例。
 */

/**
 * 等新实例出现在实例列表的上限。
 *
 * 克隆创建是分钟级动作，不能用 `context.timeoutMs`（那是单次动作的默认超时）。
 * 实测未覆盖创建耗时，这里取保守值。
 */
export const CLONE_CREATE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 等实例离开「克隆锁定中」的上限。
 *
 * 整机盘拷贝耗时未实测，取值保守。超时抛 `CloneTimeoutError`，由执行引擎转 ESCALATED。
 */
export const CLONE_COMPLETE_TIMEOUT_MS = 30 * 60 * 1000

/** 等「更多」菜单出现目标菜单项的上限。菜单是本地渲染，正常几十毫秒。 */
const MENU_OPEN_WAIT_MS = 5_000

/**
 * 「更多」最多点两次。
 *
 * 下拉是开关语义：第一次点击可能是在关掉上一次遗留的弹层，第二次才是打开。
 * 这不是对克隆的重试：只重复点菜单开关，不会重复点「创建并开机」。
 */
const MENU_TOGGLE_ATTEMPTS = 2

/** 点「创建并开机」后先给平台自己跳转的时间，超时才显式导航回实例列表。 */
const CONFIRM_NAVIGATION_WAIT_MS = 10_000

/**
 * 切地区后等数据刷新的最长时间。
 *
 * 数据可能本来就与切换前相同（同型号同价），等满窗口后按稳定处理，不无限等变化。
 */
const REGION_REFRESH_WAIT_MS = 2_000

/** 截图文件名。落进 `context.logDir`。 */
const SCREENSHOT = {
  quotaOpen: 'clone-quota-01-open.png',
  quotaClosed: 'clone-quota-02-closed.png',
  listBeforeOpen: 'clone-01-list-before-open.png',
  dialogOpened: 'clone-02-dialog-opened.png',
  dialogOptions: 'clone-03-dialog-options.png',
  hostPage: 'clone-04-host-page.png',
  billingPayg: 'clone-05-billing-payg.png',
  region: 'clone-06-region.png',
  gpuModel: 'clone-07-gpu-model.png',
  hostSelected: 'clone-08-host-selected.png',
  confirmClicked: 'clone-09-confirm-clicked.png',
  newInstance: 'clone-10-new-instance.png',
  completed: 'clone-11-completed.png',
  renamed: 'clone-12-renamed.png',
} as const

/** 页内公共片段：可回验的 CSS 路径选择器。实现在 `locate.ts`，四个动作模块共用一份。 */
const VERIFIED_SELECTOR_EXPRESSION = buildVerifiedSelectorExpression()

/**
 * 读当前可见的克隆对话框，连同其中每个控件的可点击选择器。
 *
 * 已关闭的对话框留在 DOM 里，只靠 display 隐藏。可见判据用几何尺寸：标签在后台时
 * CSS 过渡不推进，只看 class 会把停在过渡态的旧对话框当成可见。
 */
export function buildReadCloneDialogScript(): string {
  return `(() => {
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim()
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
${VERIFIED_SELECTOR_EXPRESSION}
  const visible = [...document.querySelectorAll(${jsString(DIALOG.root)})].filter(isVisible)
  if (visible.length === 0) return { kind: 'absent' }
  if (visible.length > 1) return { kind: 'ambiguous', count: visible.length }
  const dialog = visible[0]
  const selector = toVerifiedSelector(dialog)
  if (selector === null) return { kind: 'unlocatable' }
  const footer = dialog.querySelector(${jsString(ELEMENT_PLUS.dialogFooter)})
  const title = dialog.querySelector(${jsString(DIALOG.title)})
  const switcher = dialog.querySelector(${jsString(CLONE_DIALOG.switch)})
  const headerButton = dialog.querySelector(${jsString(DIALOG.headerCloseButton)})
  const footerButtons = [...dialog.querySelectorAll(${jsString(DIALOG.footerButton)})]
  const continueButton = footerButtons.find((button) => clean(button.innerText).includes(${jsString(CLONE_DIALOG.button.continue)}))
  const sparseCore = switcher === null ? null : switcher.querySelector(${jsString(CLONE_DIALOG.switchCore)})
  return {
    kind: 'dialog',
    selector,
    title: title === null ? '' : clean(title.innerText),
    footerText: footer === null ? '' : clean(footer.innerText),
    checkboxes: [...dialog.querySelectorAll(${jsString(CLONE_DIALOG.checkbox)})].map((box) => {
      const label = box.querySelector(${jsString(ELEMENT_PLUS.checkboxLabel)})
      return {
        text: clean(box.innerText),
        checked: box.className.includes(${jsString(CLONE_DIALOG.checkedClassName)}),
        disabled: box.className.includes(${jsString(ELEMENT_PLUS.disabledClassName)}),
        toggleSelector: toVerifiedSelector(label === null ? box : label),
      }
    }),
    sparseFileEnabled: switcher !== null && switcher.className.includes(${jsString(CLONE_DIALOG.checkedClassName)}),
    sparseToggleSelector: sparseCore === null ? null : toVerifiedSelector(sparseCore),
    continueSelector: continueButton === undefined ? null : toVerifiedSelector(continueButton),
    closeSelector: headerButton === null ? null : toVerifiedSelector(headerButton),
  }
})()`
}

/**
 * 读选主机页：单选组、GPU 型号复选框、主机表格与「创建并开机」按钮。
 *
 * 每个控件都带回可点击选择器，后续不再重复定位。页面还没渲染出型号列表时
 * 复选框数组里没有带可用数的项，由判定层视为「未就绪」继续轮询。
 */
export function buildReadCloneHostPageScript(): string {
  return `(() => {
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim()
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
${VERIFIED_SELECTOR_EXPRESSION}
  const radioGroups = [...document.querySelectorAll(${jsString(CLONE_HOST_PAGE.radioButtonGroup)})].filter(isVisible).map((group) => ({
    buttons: [...group.querySelectorAll(${jsString(CLONE_HOST_PAGE.radioButton)})].filter(isVisible).map((button) => {
      const input = button.querySelector('input')
      return {
        text: clean(button.innerText),
        checked: input !== null && input.checked === true,
        selector: toVerifiedSelector(button),
      }
    }),
  })).filter((group) => group.buttons.length > 0)
  const checkboxes = [...document.querySelectorAll(${jsString(CLONE_DIALOG.checkbox)})].filter(isVisible).map((box) => {
    const label = box.querySelector(${jsString(ELEMENT_PLUS.checkboxLabel)})
    return {
      text: clean(box.innerText),
      checked: box.className.includes(${jsString(CLONE_DIALOG.checkedClassName)}),
      disabled: box.className.includes(${jsString(ELEMENT_PLUS.disabledClassName)}),
      toggleSelector: toVerifiedSelector(label === null ? box : label),
    }
  })
  const table = [...document.querySelectorAll(${jsString(INSTANCE_LIST.table)})].filter(isVisible)[0]
  const rows = table === undefined ? [] : [...table.querySelectorAll(${jsString(INSTANCE_LIST.row)})].filter(isVisible).map((row) => {
    const radio = row.querySelector(${jsString(CLONE_HOST_PAGE.hostRadio)})
    return {
      cells: [...row.querySelectorAll(${jsString(INSTANCE_LIST.cell)})].map((cell) => clean(cell.innerText)),
      radioChecked: radio !== null && radio.className.includes(${jsString(CLONE_DIALOG.checkedClassName)}),
      radioSelector: radio === null ? null : toVerifiedSelector(radio),
    }
  })
  const buttons = [...document.querySelectorAll(${jsString(CONSOLE_BUTTON_TAG)})].filter(isVisible).map((button) => ({
    text: clean(button.innerText),
    disabled: button.disabled === true,
    selector: toVerifiedSelector(button),
  }))
  const confirmButton = buttons.find((button) => button.text.includes(${jsString(CLONE_HOST_PAGE.confirmButtonText)})) ?? null
  return { radioGroups, checkboxes, rows, confirmButton }
})()`
}

/**
 * 读页面上可见的创建失败提示条。
 *
 * 平台点「创建并开机」后的失败提示实测未覆盖，只按错误态类名识别，不猜文案。
 */
export function buildReadCreateFailureNoticeScript(): string {
  return `(() => {
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim()
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  return {
    notices: [...document.querySelectorAll(${jsString(CLONE_CREATE_FAILURE_NOTICE)})]
      .filter(isVisible)
      .map((element) => clean(element.innerText))
      .filter((text) => text.length > 0),
  }
})()`
}

/**
 * 读实例改名输入框的 value。
 *
 * 输入框不在页面上时返回 null：点「设置名称」后按钮原位才换成输入框，调用方按
 * 返回值继续轮询。写入后读回 value 是第二道校验：`channel.type` 正常返回
 * 不代表组件状态已经更新。
 */
export function buildReadRenameInputValueScript(inputSelector: string): string {
  return `(() => {
  const input = document.querySelector(${jsString(inputSelector)})
  if (input === null) return null
  return input.value
})()`
}

/**
 * 让实例改名输入框失焦。
 *
 * 实测（2026-11-25 真机）：回车不提交改名，必须让输入框失焦才提交。
 * 返回值 false 表示输入框已不在页面上、或失焦没有生效。两种情况都说明改名
 * 可能没有提交，调用方必须按失败处理，不能继续等列表。
 */
export function buildRenameBlurScript(inputSelector: string): string {
  return `(() => {
  const input = document.querySelector(${jsString(inputSelector)})
  if (input === null) return false
  input.blur()
  return document.activeElement !== input
})()`
}

/** 克隆对话框里的一个复选框。 */
export interface CloneDialogCheckboxSnapshot {
  readonly text: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly toggleSelector: string | null
}

/** 克隆对话框读数。所有可点击控件都带选择器。 */
export interface CloneDialogSnapshot {
  readonly selector: string
  readonly title: string
  readonly footerText: string
  readonly checkboxes: readonly CloneDialogCheckboxSnapshot[]
  readonly sparseFileEnabled: boolean
  readonly sparseToggleSelector: string | null
  readonly continueSelector: string | null
  readonly closeSelector: string | null
}

/** 克隆对话框探测结果。0 个可见、多个可见、无法定位都要分开。 */
export type CloneDialogProbe =
  | { readonly kind: 'absent' }
  | { readonly kind: 'ambiguous'; readonly count: number }
  | { readonly kind: 'unlocatable' }
  | { readonly kind: 'dialog'; readonly dialog: CloneDialogSnapshot }

export interface CloneRadioButtonSnapshot {
  readonly text: string
  readonly checked: boolean
  readonly selector: string | null
}

export interface CloneRadioGroupSnapshot {
  readonly buttons: readonly CloneRadioButtonSnapshot[]
}

export interface CloneGpuModelSnapshot {
  readonly text: string
  readonly name: string
  readonly freeCount: number
  readonly totalCount: number
  readonly checked: boolean
  readonly disabled: boolean
  readonly selector: string | null
}

export interface CloneHostRowSnapshot {
  readonly hostId: string
  readonly cells: readonly string[]
  readonly freeGpu: number | undefined
  readonly totalGpu: number | undefined
  readonly unitPriceYuanPerHour: number | undefined
  readonly radioChecked: boolean
  readonly radioSelector: string | null
}

export interface CloneHostButtonSnapshot {
  readonly text: string
  readonly disabled: boolean
  readonly selector: string | null
}

export interface CloneHostPageSnapshot {
  readonly radioGroups: readonly CloneRadioGroupSnapshot[]
  readonly gpuModels: readonly CloneGpuModelSnapshot[]
  readonly hostRows: readonly CloneHostRowSnapshot[]
  readonly confirmButton: CloneHostButtonSnapshot | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConsoleParseError(`${description}不是对象：${JSON.stringify(value)}`)
  }
  return value
}

function readStringField(record: Record<string, unknown>, key: string, description: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new ConsoleParseError(`${description}的 ${key} 不是字符串：${JSON.stringify(value)}`)
  }
  return value
}

function readNullableStringField(
  record: Record<string, unknown>,
  key: string,
  description: string,
): string | null {
  const value = record[key]
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new ConsoleParseError(`${description}的 ${key} 不是字符串或 null：${JSON.stringify(value)}`)
  }
  return value
}

function readBooleanField(record: Record<string, unknown>, key: string, description: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new ConsoleParseError(`${description}的 ${key} 不是布尔值：${JSON.stringify(value)}`)
  }
  return value
}

function readArrayField(
  record: Record<string, unknown>,
  key: string,
  description: string,
): readonly unknown[] {
  const value = record[key]
  if (!Array.isArray(value)) {
    throw new ConsoleParseError(`${description}的 ${key} 不是数组：${JSON.stringify(value)}`)
  }
  return value
}

function parseCreateFailureNotices(raw: unknown): readonly string[] {
  const description = '创建失败提示读数'
  const record = readRecord(raw, description)
  return readArrayField(record, 'notices', description).map((item, index) => {
    if (typeof item !== 'string') {
      throw new ConsoleParseError(`${description}的第 ${index} 项不是字符串：${JSON.stringify(item)}`)
    }
    return item
  })
}

/**
 * 解析页内读到的改名输入框 value。
 *
 * 输入框还没出现时返回 undefined，由轮询继续等。其它形状一律抛错，不猜。
 */
export function parseRenameInputValue(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string') {
    throw new ConsoleParseError(`改名输入框的 value 不是字符串：${JSON.stringify(raw)}`)
  }
  return raw
}

function parseCloneDialogCheckboxes(raw: unknown, description: string): readonly CloneDialogCheckboxSnapshot[] {
  return readArrayField(readRecord(raw, description), 'checkboxes', description).map(
    (item, index): CloneDialogCheckboxSnapshot => {
      const itemDescription = `${description}第 ${index} 个复选框`
      const checkbox = readRecord(item, itemDescription)
      return {
        text: readStringField(checkbox, 'text', itemDescription),
        checked: readBooleanField(checkbox, 'checked', itemDescription),
        disabled: readBooleanField(checkbox, 'disabled', itemDescription),
        toggleSelector: readNullableStringField(checkbox, 'toggleSelector', itemDescription),
      }
    },
  )
}

function parseCloneDialogFromRecord(record: Record<string, unknown>): CloneDialogSnapshot {
  const description = '克隆对话框'
  return {
    selector: readStringField(record, 'selector', description),
    title: readStringField(record, 'title', description),
    footerText: readStringField(record, 'footerText', description),
    checkboxes: parseCloneDialogCheckboxes(record, description),
    sparseFileEnabled: readBooleanField(record, 'sparseFileEnabled', description),
    sparseToggleSelector: readNullableStringField(record, 'sparseToggleSelector', description),
    continueSelector: readNullableStringField(record, 'continueSelector', description),
    closeSelector: readNullableStringField(record, 'closeSelector', description),
  }
}

/** 解析克隆对话框探测结果。形状不符即抛错，不猜。 */
export function parseCloneDialogProbe(raw: unknown): CloneDialogProbe {
  const record = readRecord(raw, '克隆对话框探测结果')
  const kind = record['kind']
  if (kind === 'absent') {
    return { kind: 'absent' }
  }
  if (kind === 'unlocatable') {
    return { kind: 'unlocatable' }
  }
  if (kind === 'ambiguous') {
    const count = record['count']
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
      throw new ConsoleParseError(`克隆对话框探测结果的 count 非法：${JSON.stringify(count)}`)
    }
    return { kind: 'ambiguous', count }
  }
  if (kind === 'dialog') {
    return { kind: 'dialog', dialog: parseCloneDialogFromRecord(record) }
  }
  throw new ConsoleParseError(`克隆对话框探测结果未知类型：${JSON.stringify(kind)}`)
}

function parseGpuModelFromCheckbox(
  checkbox: CloneDialogCheckboxSnapshot,
): CloneGpuModelSnapshot | undefined {
  const match = CLONE_HOST_PAGE.availableCountPattern.exec(checkbox.text)
  if (match === null) {
    // 「全部」等非型号项没有可用数，跳过。
    return undefined
  }
  const freeCount = Number.parseInt(match[1] ?? '', 10)
  const totalCount = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isInteger(freeCount) || !Number.isInteger(totalCount)) {
    throw new ConsoleParseError(`GPU 型号的可用数不是整数：${checkbox.text}`)
  }
  return {
    text: checkbox.text,
    name: stripGpuAvailability(checkbox.text),
    freeCount,
    totalCount,
    checked: checkbox.checked,
    disabled: checkbox.disabled,
    selector: checkbox.toggleSelector,
  }
}

function parseHostRow(raw: unknown, index: number): CloneHostRowSnapshot {
  const description = `选主机页第 ${index} 行`
  const record = readRecord(raw, description)
  const cells = readArrayField(record, 'cells', description).map((cell, cellIndex) => {
    if (typeof cell !== 'string') {
      throw new ConsoleParseError(`${description}的第 ${cellIndex} 个单元格不是字符串：${JSON.stringify(cell)}`)
    }
    return cell
  })
  const hostId = cells[0]?.trim() ?? ''
  if (hostId.length === 0) {
    throw new ConsoleParseError(`${description}没有主机 ID。`)
  }
  const freeGpuCell = cells
    .map((cell) => parseFreeGpu(cell))
    .find((parsed) => parsed !== undefined)
  const unitPriceYuanPerHour = cells
    .map((cell) => parseUnitPriceYuanPerHour(cell))
    .find((parsed) => parsed !== undefined)
  return {
    hostId,
    cells,
    freeGpu: freeGpuCell?.free,
    totalGpu: freeGpuCell?.total,
    unitPriceYuanPerHour,
    radioChecked: readBooleanField(record, 'radioChecked', description),
    radioSelector: readNullableStringField(record, 'radioSelector', description),
  }
}

/** 解析选主机页读数。形状不符即抛错；型号列表为空时返回空读数由调用方判断就绪。 */
export function parseCloneHostPageSnapshot(raw: unknown): CloneHostPageSnapshot {
  const description = '选主机页快照'
  const record = readRecord(raw, description)
  const radioGroups = readArrayField(record, 'radioGroups', description).map(
    (group, groupIndex): CloneRadioGroupSnapshot => {
      const groupDescription = `${description}第 ${groupIndex} 个单选组`
      const groupRecord = readRecord(group, groupDescription)
      const buttons = readArrayField(groupRecord, 'buttons', groupDescription).map(
        (button, buttonIndex): CloneRadioButtonSnapshot => {
          const buttonDescription = `${groupDescription}的第 ${buttonIndex} 个按钮`
          const buttonRecord = readRecord(button, buttonDescription)
          return {
            text: readStringField(buttonRecord, 'text', buttonDescription),
            checked: readBooleanField(buttonRecord, 'checked', buttonDescription),
            selector: readNullableStringField(buttonRecord, 'selector', buttonDescription),
          }
        },
      )
      return { buttons }
    },
  )
  const checkboxes = parseCloneDialogCheckboxes(record, description)
  const gpuModels: CloneGpuModelSnapshot[] = []
  for (const checkbox of checkboxes) {
    const model = parseGpuModelFromCheckbox(checkbox)
    if (model !== undefined) {
      gpuModels.push(model)
    }
  }
  const hostRows = readArrayField(record, 'rows', description).map((row, index) =>
    parseHostRow(row, index),
  )
  const confirmRaw = record['confirmButton']
  const confirmButton =
    confirmRaw === null
      ? null
      : ((): CloneHostButtonSnapshot => {
          const confirmDescription = `${description}的确认按钮`
          const confirm = readRecord(confirmRaw, confirmDescription)
          return {
            text: readStringField(confirm, 'text', confirmDescription),
            disabled: readBooleanField(confirm, 'disabled', confirmDescription),
            selector: readNullableStringField(confirm, 'selector', confirmDescription),
          }
        })()
  return { radioGroups, gpuModels, hostRows, confirmButton }
}

/**
 * 从对话框页脚读剩余克隆次数。
 *
 * 页面原文形如「今天剩余克隆次数：10次」。
 */
export function parseCloneQuota(footerText: string): number {
  const prefixIndex = footerText.indexOf(CLONE_DIALOG.quotaPrefix)
  if (prefixIndex < 0) {
    throw new ConsoleParseError(`克隆对话框页脚没有「${CLONE_DIALOG.quotaPrefix}」：${footerText}`)
  }
  const rest = footerText.slice(prefixIndex + CLONE_DIALOG.quotaPrefix.length).trim()
  const match = /^(\d+)/.exec(rest)
  const digits = match?.[1]
  if (digits === undefined) {
    throw new ConsoleParseError(`克隆对话框页脚没有剩余次数数字：${footerText}`)
  }
  return Number.parseInt(digits, 10)
}

/** 解析主机行的空闲 GPU，原文形如 `1 / 8`。 */
export function parseFreeGpu(
  cellText: string,
): { readonly free: number; readonly total: number } | undefined {
  const match = CLONE_HOST_PAGE.freeGpuPattern.exec(cellText.trim())
  if (match === null) {
    return undefined
  }
  const free = Number.parseInt(match[1] ?? '', 10)
  const total = Number.parseInt(match[2] ?? '', 10)
  if (!Number.isInteger(free) || !Number.isInteger(total)) {
    return undefined
  }
  return { free, total }
}

/** 解析主机行的单价，原文形如 `￥1.58/时`。第一处即当前价，后面是划掉的原价。 */
export function parseUnitPriceYuanPerHour(cellText: string): number | undefined {
  const match = CLONE_HOST_PAGE.pricePattern.exec(cellText)
  if (match === null) {
    return undefined
  }
  const price = Number.parseFloat(match[1] ?? '')
  return Number.isFinite(price) ? price : undefined
}

/** 主机行是否属于某个型号。行内规格原文形如 `vGPU-32GB 32GB`。 */
export function hostRowMatchesGpuModel(row: CloneHostRowSnapshot, modelName: string): boolean {
  return row.cells.some((cell) => {
    if (cell === modelName) {
      return true
    }
    if (!cell.startsWith(`${modelName} `)) {
      return false
    }
    // 型号名可能互相包含（RTX 5090 与 RTX 5090 D）。只有「型号 + 显存」才算命中。
    return /^\d+\s*GB$/i.test(cell.slice(modelName.length + 1).trim())
  })
}

/**
 * 从选主机页 URL 读源实例 ID。
 *
 * 实测 URL 形如 `.../cloneInstance?region=west-B&id=<源实例ID>&name=...`。
 */
export function readCloneHostSourceId(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get('id') ?? undefined
  } catch {
    return undefined
  }
}

function findCloneDialogCheckbox(
  snapshot: CloneDialogSnapshot,
  label: string,
): CloneDialogCheckboxSnapshot {
  const checkbox = snapshot.checkboxes.find((candidate) => candidate.text.includes(label))
  if (checkbox === undefined) {
    throw new ConsoleParseError(`克隆对话框没有「${label}」复选框。`)
  }
  return checkbox
}

function findBillingRadioGroup(snapshot: CloneHostPageSnapshot): CloneRadioGroupSnapshot {
  const group = snapshot.radioGroups.find((candidate) =>
    candidate.buttons.some((button) => button.text === CLONE_HOST_CONTROLS.billingPaygLabel),
  )
  if (group === undefined) {
    throw new ConsoleParseError(`选主机页没有「${CLONE_HOST_CONTROLS.billingPaygLabel}」计费方式选项。`)
  }
  return group
}

function isRegionButton(button: CloneRadioButtonSnapshot): boolean {
  return (
    button.text.endsWith(CLONE_HOST_CONTROLS.regionSuffix) &&
    !button.text.endsWith(CLONE_HOST_CONTROLS.zoneSuffix)
  )
}

function findRegionRadioGroup(snapshot: CloneHostPageSnapshot): CloneRadioGroupSnapshot {
  const group = snapshot.radioGroups.find(
    (candidate) => candidate.buttons.length > 0 && candidate.buttons.every(isRegionButton),
  )
  if (group === undefined) {
    throw new ConsoleParseError('选主机页没有地区选项。')
  }
  return group
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, '').trim()
}

function pickGpuModel(
  snapshot: CloneHostPageSnapshot,
  preferences: readonly string[],
): CloneGpuModelSnapshot {
  const availableNames = snapshot.gpuModels.map((model) => model.name)
  const unavailable: string[] = []
  for (const preference of preferences) {
    const wanted = resolveGpuModelPageName(preference)
    const model = snapshot.gpuModels.find((candidate) => candidate.name === wanted)
    if (model === undefined) {
      continue
    }
    if (model.disabled) {
      unavailable.push(`${model.name}（页面不可选）`)
      continue
    }
    if (model.freeCount > 0) {
      return model
    }
    unavailable.push(`${model.name}（可用数 0）`)
  }
  const availableText = availableNames.length === 0 ? '无' : availableNames.join('、')
  if (unavailable.length === 0) {
    throw new CloneTargetUnavailableError(
      `GPU 型号偏好 ${preferences.join('、')} 与选主机页可选型号一条都对不上。页面可选型号：${availableText}。`,
    )
  }
  throw new CloneTargetUnavailableError(
    `GPU 型号偏好命中的型号都不可用：${unavailable.join('、')}。页面可选型号：${availableText}。`,
  )
}

/**
 * 主机行「每 GPU 分配」里的 CPU 核数。
 *
 * 该格原文形如 `CPU：16核 内存：62GB`。读不出返 `undefined`：
 * 控制台格式变了要能被发现，不能当成 0 核。
 */
export function readHostCpuCores(row: CloneHostRowSnapshot): number | undefined {
  const text = row.cells[CLONE_HOST_PAGE.hostColumn.allocation] ?? ''
  const match = /CPU\s*[：:]\s*(\d+)\s*核/.exec(text)
  if (match === null) {
    return undefined
  }
  const cores = Number(match[1])
  return Number.isFinite(cores) ? cores : undefined
}

/**
 * 从可用主机里挑一台。
 *
 * 判据：先要求「空闲 GPU 大于 0」，再按每 GPU 分配的 CPU 核数从多到少取第一台。
 * 核数读不出的主机排在读得出的后面，同分时保持页面顺序（`Array.prototype.sort` 稳定）。
 * 挑错的代价是多花几台机器的钱，所以规则写死在这里，不交给调用方传排序键。
 */
function pickHostRow(rows: readonly CloneHostRowSnapshot[], modelName: string): CloneHostRowSnapshot {
  const candidates = rows.filter((row) => (row.freeGpu ?? 0) > 0)
  const candidate = candidates[0]
  if (candidate === undefined) {
    const detail = rows
      .map((row) => `${row.hostId}（${String(row.freeGpu ?? 0)}/${String(row.totalGpu ?? 0)}）`)
      .join('、')
    throw new CloneTargetUnavailableError(
      `型号「${modelName}」的主机列表里没有空闲 GPU 大于 0 的主机。主机：${detail}。`,
    )
  }
  return [...candidates].sort(
    (left, right) => (readHostCpuCores(right) ?? -1) - (readHostCpuCores(left) ?? -1),
  )[0] ?? candidate
}

/**
 * 选主机页数据的指纹。用来判断页面是否已经把地区切换后的数据刷完。
 *
 * 判据：连续两次读数完全一致才认为刷新结束。实测未覆盖地区切换的刷新时序，
 * 这是保守的启发式，不是实测结论。
 */
export function hostPageSnapshotSignature(snapshot: CloneHostPageSnapshot): string {
  return JSON.stringify({
    models: snapshot.gpuModels.map((model) => [
      model.name,
      model.freeCount,
      model.totalCount,
      model.checked,
    ]),
    rows: snapshot.hostRows.map((row) => [row.hostId, row.freeGpu, row.totalGpu, row.radioChecked]),
    radios: snapshot.radioGroups.map((group) => group.buttons.map((button) => [button.text, button.checked])),
  })
}

function requireSelector(selector: string | null, description: string): string {
  if (selector === null) {
    throw new ConsoleParseError(`${description}在页面上无法转成可点击选择器，控制台结构可能已改版。`)
  }
  return selector
}

/** 错误转统一形态：分类只读 code 字段，这里只保证拿到一个 `DeploydeckError`。 */
function asDeploydeckError(error: unknown): DeploydeckError {
  if (error instanceof DeploydeckError) {
    return error
  }
  return new ConsoleParseError(error instanceof Error ? error.message : String(error), {
    cause: error,
  })
}

export function createCloneActions(context: ConsoleRuntimeContext): ClonePort {
  const { channel } = context
  const clock: Clock = context.clock ?? systemClock
  // 两条出口：动作证据文件落本次 run 目录，运行日志走装配方给的日志器（缺省 stderr）。
  const logger = createFanoutLogger(
    createJsonlFileLogger(join(context.logDir, 'clone-steps.jsonl')),
    context.logger ?? createStderrLogger(),
  )

  function pollOptions(): {
    readonly intervalMs: number
    readonly now: () => number
    readonly sleep: (milliseconds: number) => Promise<void>
  } {
    return {
      intervalMs: context.pollIntervalMs,
      now: () => clock.now(),
      sleep: (milliseconds) => clock.sleep(milliseconds),
    }
  }

  function elapsedSeconds(startedAt: number): number {
    return Math.max(0, Math.round((clock.now() - startedAt) / 1000))
  }

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function screenshot(fileName: string): Promise<void> {
    await channel.screenshot(join(context.logDir, fileName))
  }

  /**
   * 点「创建并开机」后若平台给出错误提示，立即停下。
   *
   * 平台点击后的失败行为未实测；这里不猜文案，只按错误态类名识别。命中即抛错，
   * 因为实例可能没有创建，也可能创建了但页面报错，必须人工核对。
   */
  async function assertNoCreateFailureNotice(): Promise<void> {
    const notices = parseCreateFailureNotices(
      await channel.evaluate<unknown>(buildReadCreateFailureNoticeScript()),
    )
    if (notices.length > 0) {
      throw new HumanRequiredError(
        `点「${CLONE_HOST_PAGE.confirmButtonText}」后平台提示错误：${notices.join('；')}。` +
          '实例可能没有创建，请在控制台确认。',
      )
    }
  }

  async function readCloneDialogOnPage(): Promise<CloneDialogSnapshot | undefined> {
    const probe = parseCloneDialogProbe(await channel.evaluate<unknown>(buildReadCloneDialogScript()))
    if (probe.kind === 'ambiguous') {
      throw new ConsoleParseError(`页面上有 ${String(probe.count)} 个可见对话框，无法判定哪一个是克隆对话框。`)
    }
    if (probe.kind === 'unlocatable') {
      throw new ConsoleParseError('可见的克隆对话框无法转成可点击选择器，控制台结构可能已改版。')
    }
    return probe.kind === 'dialog' ? probe.dialog : undefined
  }

  async function waitForCloneDialog(): Promise<CloneDialogSnapshot> {
    const startedAt = clock.now()
    const outcome = await pollUntil<CloneDialogSnapshot>({
      description: '等待「克隆实例」对话框出现',
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const dialog = await readCloneDialogOnPage()
        return dialog !== undefined && dialog.title === CLONE_DIALOG.title ? dialog : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `「${CLONE_DIALOG.title}」对话框没有出现（已等 ${String(elapsedSeconds(startedAt))} 秒）。`,
      )
    }
    return outcome.value
  }

  async function requireCloneDialog(action: string): Promise<CloneDialogSnapshot> {
    const dialog = await readCloneDialogOnPage()
    if (dialog === undefined) {
      throw new ConsoleParseError(`${action}：克隆对话框不在页面上。`)
    }
    return dialog
  }

  /** 用对话框右上角 × 关掉任何可见对话框，并等到它消失。不许点遮罩。 */
  async function closeVisibleDialog(action: string): Promise<void> {
    const dialog = await readCloneDialogOnPage()
    if (dialog === undefined) {
      return
    }
    const selector = requireSelector(dialog.closeSelector, `${action}：对话框右上角 ×`)
    await channel.click(selector)
    const startedAt = clock.now()
    const outcome = await pollUntil<true>({
      description: `${action}：等待对话框关闭`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => ((await readCloneDialogOnPage()) === undefined ? true : undefined),
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(`${action}：对话框没有关闭（已等 ${String(elapsedSeconds(startedAt))} 秒）。`)
    }
  }

  /** 定位源实例所在行，返回可回验的行选择器。 */
  async function locateInstanceRow(instanceId: string): Promise<string> {
    const startedAt = clock.now()
    const outcome = await pollUntil<string>({
      description: `定位实例 ${instanceId} 的列表行`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => parseLocatedSelector(await channel.evaluate<unknown>(buildLocateRowScript(instanceId))),
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `实例列表里找不到实例 ${instanceId} 的行（已等 ${String(elapsedSeconds(startedAt))} 秒）。`,
      )
    }
    return outcome.value
  }

  /** 在给定作用域里按文字定位按钮，返回可回验的选择器。 */
  async function locateButton(scopeSelector: string, buttonText: string): Promise<string> {
    const startedAt = clock.now()
    const outcome = await pollUntil<string>({
      description: `在 ${scopeSelector} 内定位「${buttonText}」按钮`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () =>
        parseLocatedSelector(
          await channel.evaluate<unknown>(buildLocateButtonScript(scopeSelector, buttonText)),
        ),
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `页面上找不到「${buttonText}」按钮（已等 ${String(elapsedSeconds(startedAt))} 秒）。`,
      )
    }
    return outcome.value
  }

  /**
   * 打开源实例行的「更多」，定位「克隆实例新」菜单项。
   *
   * 下拉是开关语义：第一次点击可能是在关掉上一步遗留的弹层。菜单项归属靠
   * `release.ts` 的 aria 指向判据挑本行的弹层，避免点到另一行的同名项。
   */
  async function locateCloneMenuItem(rowSelector: string): Promise<string> {
    const moreSelector = await locateButton(rowSelector, INSTANCE_BUTTON_TEXT.more)
    let lastProbeKind = 'no-visible-popper'
    for (let attempt = 1; attempt <= MENU_TOGGLE_ATTEMPTS; attempt += 1) {
      await channel.click(moreSelector)
      logger.info('clone.menu-toggle', { attempt })
      const outcome = await pollUntil<string>({
        description: `「更多」菜单出现可见的「${DROPDOWN_ITEM_TEXT.clone}」`,
        timeoutMs: MENU_OPEN_WAIT_MS,
        ...pollOptions(),
        probe: async () => {
          const probe = parseVisibleMenuItemProbe(
            await channel.evaluate<unknown>(
              buildLocateVisibleMenuItemScript({ rowSelector, itemText: DROPDOWN_ITEM_TEXT.clone }),
            ),
          )
          lastProbeKind = probe.kind
          return probe.kind === 'located' ? probe.selector : undefined
        },
      })
      if (outcome.status === 'matched') {
        return outcome.value
      }
      logger.warn('clone.menu-toggle-timeout', { attempt, lastProbeKind })
    }
    throw new ConsoleParseError(
      `点了 ${String(MENU_TOGGLE_ATTEMPTS)} 次「${INSTANCE_BUTTON_TEXT.more}」后仍未看到可见的` +
        `「${DROPDOWN_ITEM_TEXT.clone}」菜单项（最后一次探测：${lastProbeKind}）。`,
    )
  }

  /**
   * 打开源实例的克隆对话框。
   *
   * 先落到实例列表页，再关掉可能残留的对话框（遮罩会挡住整页点击）。
   */
  async function openCloneDialog(sourceInstanceId: string): Promise<CloneDialogSnapshot> {
    await channel.goto(CONSOLE_INSTANCE_LIST_URL)
    await closeVisibleDialog('打开克隆对话框前清理残留弹层')
    const rowSelector = await locateInstanceRow(sourceInstanceId)
    const menuItemSelector = await locateCloneMenuItem(rowSelector)
    await channel.click(menuItemSelector)
    return waitForCloneDialog()
  }

  /** 等对话框里的复选框变成期望状态。 */
  async function waitForDialogCheckbox(
    label: string,
    desired: boolean,
  ): Promise<CloneDialogSnapshot> {
    const startedAt = clock.now()
    const outcome = await pollUntil<CloneDialogSnapshot>({
      description: `等待「${label}」复选框变为${desired ? '勾选' : '未勾选'}`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const dialog = await requireCloneDialog(`等待「${label}」复选框`)
        return findCloneDialogCheckbox(dialog, label).checked === desired ? dialog : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `「${label}」复选框没有变成期望状态（已等 ${String(elapsedSeconds(startedAt))} 秒）。`,
      )
    }
    return outcome.value
  }

  /** 等「优化稀疏文件拷贝」开关变为开启。 */
  async function waitForSparseFileEnabled(): Promise<CloneDialogSnapshot> {
    const startedAt = clock.now()
    const outcome = await pollUntil<CloneDialogSnapshot>({
      description: `等待「${CLONE_DIALOG.sparseFileLabel}」开关开启`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const dialog = await requireCloneDialog(`等待「${CLONE_DIALOG.sparseFileLabel}」开关`)
        return dialog.sparseFileEnabled ? dialog : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `「${CLONE_DIALOG.sparseFileLabel}」开关没有开启（已等 ${String(elapsedSeconds(startedAt))} 秒）。`,
      )
    }
    return outcome.value
  }

  /**
   * 显式设置两个克隆选项。
   *
   * 平台默认值不可信：数据盘实测默认未勾选，稀疏优化实测默认未开启。
   * 数据盘按 Profile 勾或不勾都显式对齐一次：与期望相同就不点（点一次会翻成相反状态），
   * 但要读回确认，仍然不依赖平台默认值。
   */
  async function applyCloneDialogOptions(
    initial: CloneDialogSnapshot,
    cloneDataDisk: boolean,
  ): Promise<CloneDialogSnapshot> {
    let dialog = initial
    const dataDisk = findCloneDialogCheckbox(dialog, CLONE_DIALOG.dataDiskLabel)
    if (dataDisk.checked !== cloneDataDisk) {
      if (dataDisk.disabled) {
        throw new HumanRequiredError(
          `「${CLONE_DIALOG.dataDiskLabel}」复选框被平台禁用，无法按 Profile 的 cloneDataDisk=${String(cloneDataDisk)} 设置。`,
        )
      }
      const selector = requireSelector(dataDisk.toggleSelector, `「${CLONE_DIALOG.dataDiskLabel}」复选框`)
      await channel.click(selector)
      dialog = await waitForDialogCheckbox(CLONE_DIALOG.dataDiskLabel, cloneDataDisk)
    }
    if (!dialog.sparseFileEnabled) {
      const selector = requireSelector(
        dialog.sparseToggleSelector,
        `「${CLONE_DIALOG.sparseFileLabel}」开关`,
      )
      await channel.click(selector)
      dialog = await waitForSparseFileEnabled()
    }
    const finalDataDisk = findCloneDialogCheckbox(dialog, CLONE_DIALOG.dataDiskLabel)
    if (finalDataDisk.checked !== cloneDataDisk) {
      throw new ConsoleParseError(
        `「${CLONE_DIALOG.dataDiskLabel}」复选框最终状态与 Profile 不一致（期望 ${String(cloneDataDisk)}）。`,
      )
    }
    if (!dialog.sparseFileEnabled) {
      throw new ConsoleParseError(`「${CLONE_DIALOG.sparseFileLabel}」开关最终没有开启。`)
    }
    return dialog
  }

  /** 校验选主机页确实是源实例的克隆页。URL 的 id 参数就是源实例 ID。 */
  function assertCloneHostPageSource(url: string, sourceInstanceId: string): void {
    const sourceFromUrl = readCloneHostSourceId(url)
    if (sourceFromUrl === undefined) {
      throw new ConsoleParseError(`选主机页 URL 没有 id 参数，无法确认克隆的是哪台实例：${url}`)
    }
    if (sourceFromUrl !== sourceInstanceId) {
      throw new HumanRequiredError(
        `选主机页的源实例是 ${sourceFromUrl}，与请求的 ${sourceInstanceId} 不一致，已停止克隆。请核对控制台。`,
      )
    }
  }

  async function readHostPage(): Promise<CloneHostPageSnapshot> {
    return parseCloneHostPageSnapshot(await channel.evaluate<unknown>(buildReadCloneHostPageScript()))
  }

  async function waitForHostPageReady(): Promise<CloneHostPageSnapshot> {
    const startedAt = clock.now()
    const outcome = await pollUntil<CloneHostPageSnapshot>({
      description: '等待选主机页就绪',
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const snapshot = await readHostPage()
        return snapshot.gpuModels.length > 0 ? snapshot : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new CloneTimeoutError(
        `选主机页在 ${String(elapsedSeconds(startedAt))} 秒内没有就绪（没有读到 GPU 型号列表）。`,
      )
    }
    return outcome.value
  }

  /** 进入选主机页并确认 URL 指向的是请求的源实例。 */
  async function continueToCloneHostPage(sourceInstanceId: string): Promise<void> {
    const dialog = await requireCloneDialog(`点击「${CLONE_DIALOG.button.continue}」`)
    const selector = requireSelector(dialog.continueSelector, `「${CLONE_DIALOG.button.continue}」按钮`)
    await channel.click(selector)
    const startedAt = clock.now()
    const outcome = await pollUntil<string>({
      description: '等待进入选主机页',
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const url = await channel.currentUrl()
        return url.startsWith(CONSOLE_CLONE_HOST_URL_PREFIX) ? url : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new CloneTimeoutError(
        `点击「${CLONE_DIALOG.button.continue}」后 ${String(elapsedSeconds(startedAt))} 秒内没有进入选主机页。`,
      )
    }
    assertCloneHostPageSource(outcome.value, sourceInstanceId)
  }

  /**
   * 等地区切换后的数据刷新完成。
   *
   * 地区单选会先变成选中，型号可用数与主机表随后才刷新。判据分两段：
   * 先等数据签名相对点击前发生变化，再要求连续两次读数一致。
   * 数据本来就不变的地区（例如同型号同价）等一段固定窗口后按稳定处理。
   */
  async function readHostPageAfterRegionSettled(
    baselineSignature: string,
  ): Promise<CloneHostPageSnapshot> {
    const startedAt = clock.now()
    const changeDeadline = startedAt + REGION_REFRESH_WAIT_MS
    let previous: CloneHostPageSnapshot | undefined
    const outcome = await pollUntil<CloneHostPageSnapshot>({
      description: '等待选主机页数据刷新完成',
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const snapshot = await readHostPage()
        const signature = hostPageSnapshotSignature(snapshot)
        if (signature === baselineSignature && clock.now() < changeDeadline) {
          previous = snapshot
          return undefined
        }
        if (previous !== undefined && hostPageSnapshotSignature(previous) === signature) {
          return snapshot
        }
        previous = snapshot
        return undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `选主机页数据在 ${String(elapsedSeconds(startedAt))} 秒内没有稳定下来。`,
      )
    }
    return outcome.value
  }

  /** 选计费方式「按量计费」。 */
  async function selectBillingPayg(snapshot: CloneHostPageSnapshot): Promise<CloneHostPageSnapshot> {
    const group = findBillingRadioGroup(snapshot)
    const target = group.buttons.find(
      (button) => button.text === CLONE_HOST_CONTROLS.billingPaygLabel,
    )
    if (target === undefined) {
      throw new ConsoleParseError(`选主机页没有「${CLONE_HOST_CONTROLS.billingPaygLabel}」计费方式选项。`)
    }
    if (target.checked) {
      return snapshot
    }
    const selector = requireSelector(target.selector, `「${CLONE_HOST_CONTROLS.billingPaygLabel}」计费方式`)
    await channel.click(selector)
    const startedAt = clock.now()
    const outcome = await pollUntil<CloneHostPageSnapshot>({
      description: `等待计费方式切换为「${CLONE_HOST_CONTROLS.billingPaygLabel}」`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const current = await readHostPage()
        const currentGroup = findBillingRadioGroup(current)
        return currentGroup.buttons.find(
          (button) => button.text === CLONE_HOST_CONTROLS.billingPaygLabel,
        )?.checked === true
          ? current
          : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `计费方式没有切换到「${CLONE_HOST_CONTROLS.billingPaygLabel}」（已等 ${String(elapsedSeconds(startedAt))} 秒）。`,
      )
    }
    return outcome.value
  }

  /**
   * 按 `regionPreference` 顺序选地区。
   *
   * 一条都匹配不上时抛错并列出页面可选地区，不退回默认地区。
   * 切换地区后型号可用数与主机表会异步刷新，等数据稳定后再选型号。
   */
  async function selectRegion(
    snapshot: CloneHostPageSnapshot,
    preferences: readonly string[],
  ): Promise<CloneHostPageSnapshot> {
    if (preferences.length === 0) {
      return snapshot
    }
    const regionBaselineSignature = hostPageSnapshotSignature(snapshot)
    const group = findRegionRadioGroup(snapshot)
    const available = group.buttons.map((button) => button.text)
    let matched: string | undefined
    for (const preference of preferences) {
      const wanted = normalizeText(preference)
      const found = available.find((text) => normalizeText(text) === wanted)
      if (found !== undefined) {
        matched = found
        break
      }
    }
    if (matched === undefined) {
      throw new CloneTargetUnavailableError(
        `地区偏好 ${preferences.join('、')} 与选主机页可选地区都不匹配。页面可选地区：${available.join('、')}。`,
      )
    }
    const target = group.buttons.find((button) => button.text === matched)
    if (target === undefined) {
      throw new ConsoleParseError(`选主机页地区「${matched}」不在读数里，页面可能刚刷新。`)
    }
    if (target.checked) {
      return snapshot
    }
    const selector = requireSelector(target.selector, `地区「${matched}」`)
    await channel.click(selector)
    const startedAt = clock.now()
    const outcome = await pollUntil<CloneHostPageSnapshot>({
      description: `等待地区切换为「${matched}」`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const current = await readHostPage()
        const currentGroup = findRegionRadioGroup(current)
        return currentGroup.buttons.find((button) => button.text === matched)?.checked === true
          ? current
          : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `地区没有切换到「${matched}」（已等 ${String(elapsedSeconds(startedAt))} 秒）。`,
      )
    }
    return readHostPageAfterRegionSettled(regionBaselineSignature)
  }

  /**
   * 按 `gpuPreference` 顺序选 GPU 型号。
   *
   * 第一个「可用数 > 0」的型号即选它。不跳档、不先选低配再升降。
   */
  async function selectGpuModel(
    snapshot: CloneHostPageSnapshot,
    preferences: readonly string[],
  ): Promise<{ readonly snapshot: CloneHostPageSnapshot; readonly model: CloneGpuModelSnapshot }> {
    const model = pickGpuModel(snapshot, preferences)
    if (!model.checked) {
      const selector = requireSelector(model.selector, `GPU 型号「${model.name}」`)
      await channel.click(selector)
    }
    let current = await waitForGpuModelChecked(model.name)
    // 型号列表可能允许多选。旧型号仍勾着时取消它们，保证只有目标型号。
    const extraChecked = current.gpuModels.filter(
      (candidate) => candidate.checked && candidate.name !== model.name,
    )
    for (const candidate of extraChecked) {
      const selector = requireSelector(candidate.selector, `GPU 型号「${candidate.name}」`)
      await channel.click(selector)
    }
    if (extraChecked.length > 0) {
      current = await waitForOnlyGpuModelChecked(model.name)
    }
    const checkedNames = current.gpuModels
      .filter((candidate) => candidate.checked)
      .map((candidate) => candidate.name)
    if (checkedNames.length !== 1 || checkedNames[0] !== model.name) {
      throw new ConsoleParseError(
        `GPU 型号勾选状态不符合预期：${checkedNames.length === 0 ? '无' : checkedNames.join('、')}。`,
      )
    }
    return { snapshot: current, model }
  }

  async function waitForGpuModelChecked(modelName: string): Promise<CloneHostPageSnapshot> {
    const startedAt = clock.now()
    const outcome = await pollUntil<CloneHostPageSnapshot>({
      description: `等待 GPU 型号「${modelName}」被勾选`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const current = await readHostPage()
        return current.gpuModels.some((model) => model.name === modelName && model.checked)
          ? current
          : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `GPU 型号「${modelName}」没有勾上（已等 ${String(elapsedSeconds(startedAt))} 秒）。`,
      )
    }
    return outcome.value
  }

  async function waitForOnlyGpuModelChecked(modelName: string): Promise<CloneHostPageSnapshot> {
    const startedAt = clock.now()
    const outcome = await pollUntil<CloneHostPageSnapshot>({
      description: `等待只勾选 GPU 型号「${modelName}」`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const current = await readHostPage()
        const checked = current.gpuModels.filter((candidate) => candidate.checked)
        return checked.length === 1 && checked[0]?.name === modelName ? current : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `GPU 型号勾选状态在 ${String(elapsedSeconds(startedAt))} 秒内没有收敛到「${modelName}」。`,
      )
    }
    return outcome.value
  }

  /**
   * 等主机表格按所选型号刷新完成。
   *
   * 表格是异步刷新的。判据是每行的规格文字都属于该型号且空闲 GPU 与单价都可读，
   * 不用固定等待时间。
   */
  async function waitForHostTable(
    modelName: string,
  ): Promise<readonly CloneHostRowSnapshot[]> {
    const startedAt = clock.now()
    const outcome = await pollUntil<readonly CloneHostRowSnapshot[]>({
      description: `等待型号「${modelName}」的主机表格刷新`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const snapshot = await readHostPage()
        if (snapshot.hostRows.length === 0) {
          return undefined
        }
        const settled = snapshot.hostRows.every(
          (row) =>
            row.freeGpu !== undefined &&
            row.totalGpu !== undefined &&
            row.unitPriceYuanPerHour !== undefined &&
            hostRowMatchesGpuModel(row, modelName),
        )
        return settled ? snapshot.hostRows : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new CloneTargetUnavailableError(
        `所选型号「${modelName}」在 ${String(elapsedSeconds(startedAt))} 秒内没有可读的主机行。`,
      )
    }
    return outcome.value
  }

  /** 点主机行的单选，并等选中状态出现。 */
  async function selectHostRow(row: CloneHostRowSnapshot): Promise<void> {
    const selector = requireSelector(row.radioSelector, `主机 ${row.hostId} 的单选按钮`)
    await channel.click(selector)
    const startedAt = clock.now()
    const outcome = await pollUntil<true>({
      description: `等待主机 ${row.hostId} 被选中`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const current = await readHostPage()
        const selected = current.hostRows.find((candidate) => candidate.hostId === row.hostId)
        return selected?.radioChecked === true ? true : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `主机 ${row.hostId} 在 ${String(elapsedSeconds(startedAt))} 秒内没有被选中。`,
      )
    }
  }

  /** 点「创建并开机」。按钮禁用时说明主机没真正选中，交给人确认。 */
  async function clickConfirmButton(snapshot: CloneHostPageSnapshot): Promise<void> {
    const confirm = snapshot.confirmButton
    if (confirm === null) {
      throw new ConsoleParseError(`选主机页没有「${CLONE_HOST_PAGE.confirmButtonText}」按钮。`)
    }
    if (confirm.disabled) {
      throw new HumanRequiredError(
        `「${CLONE_HOST_PAGE.confirmButtonText}」按钮不可用，通常表示主机行没有真正选中。`,
      )
    }
    await channel.click(requireSelector(confirm.selector, `「${CLONE_HOST_PAGE.confirmButtonText}」按钮`))
  }

  /**
   * 点「创建并开机」后等回到实例列表页。
   *
   * 平台点击后的行为未实测：先给平台自己跳转的时间，超时才显式导航回列表。
   * 立即导航可能打断平台自己的成功跳转与失败提示。
   */
  async function waitForInstanceListPage(): Promise<void> {
    const outcome = await pollUntil<true>({
      description: '等待回到实例列表页',
      timeoutMs: CONFIRM_NAVIGATION_WAIT_MS,
      ...pollOptions(),
      probe: async () => {
        await assertNoCreateFailureNotice()
        return (await channel.currentUrl()).startsWith(CONSOLE_INSTANCE_LIST_URL) ? true : undefined
      },
    })
    if (outcome.status === 'timeout') {
      await channel.goto(CONSOLE_INSTANCE_LIST_URL)
    }
  }

  /** 轮询列表，直到出现点击前不存在的实例 ID。读列表必须带 refresh，否则读到旧 DOM。 */
  async function waitForCreatedInstance(
    beforeIds: ReadonlySet<string>,
  ): Promise<ConsoleInstanceSnapshot> {
    const startedAt = clock.now()
    const outcome = await pollUntil<ConsoleInstanceSnapshot>({
      description: '等待克隆出的新实例出现在列表',
      timeoutMs: CLONE_CREATE_TIMEOUT_MS,
      ...pollOptions(),
      probe: async () => {
        await assertNoCreateFailureNotice()
        const snapshots = await context.instances.listInstances({ refresh: true })
        const created = snapshots.filter((snapshot) => !beforeIds.has(snapshot.instanceId))
        if (created.length === 0) {
          return undefined
        }
        if (created.length > 1) {
          throw new HumanRequiredError(
            `点「${CLONE_HOST_PAGE.confirmButtonText}」后列表里出现 ${String(created.length)} 台新实例：${created
              .map((snapshot) => snapshot.instanceId)
              .join('、')}，无法判定哪一台是本次克隆。请人工核对。`,
          )
        }
        const createdInstance = created[0]
        if (createdInstance === undefined) {
          throw new ConsoleParseError('新实例列表为空，无法判定克隆结果。')
        }
        return createdInstance
      },
    })
    if (outcome.status === 'timeout') {
      throw new CloneTimeoutError(
        `点「${CLONE_HOST_PAGE.confirmButtonText}」后 ${String(elapsedSeconds(startedAt))} 秒内没有在实例列表看到新实例。`,
      )
    }
    return outcome.value
  }

  /**
   * 克隆已受理后的回读判据：抛错前先读一次列表，判本次克隆有没有真的创建出实例。
   *
   * 判据（缺口 8.1）：点「创建并开机」之后，平台可能已受理克隆并扣掉配额，但页面报错、
   * 跳转失败或读数解析失败。此时直接抛原错误会丢掉实例 ID，执行引擎接管不了它，
   * 账也记不上。因此本函数读一次列表，按两种已知事实判定：
   *
   * 1. `knownInstanceId` 非空：已判定过是本次克隆的那台，读回它的快照即可；
   *    读不到按「已获取但状态未知」返回，`snapshot` 为 `null`。
   * 2. `beforeIds` 非空：还没判定过是哪台，用「点击前不存在的 ID」比对；
   *    恰好一台按本次克隆返回，多于一台无法判定，按原错误抛错交人工。
   *
   * 两种都判不出结果时原错误照旧抛：没有判据支持「本次克隆创建了实例」。
   * 读列表本身失败也只抛原错误：回读是尽力而为，不能让它的失败盖掉真实原因。
   */
  async function readBackAfterCloneStarted(
    error: DeploydeckError,
    input: {
      readonly sourceInstanceId: string
      readonly knownInstanceId: string | null
      readonly beforeIds: ReadonlySet<string>
    },
  ): Promise<StrayInstanceError | null> {
    let snapshots: readonly ConsoleInstanceSnapshot[]
    try {
      snapshots = await context.instances.listInstances({ refresh: true })
    } catch (readError: unknown) {
      logger.warn('clone.readback-failed', {
        sourceInstanceId: input.sourceInstanceId,
        reason: messageOf(error),
        readError: messageOf(readError),
      })
      return null
    }
    if (input.knownInstanceId !== null) {
      const snapshot = snapshots.find(
        (candidate) => candidate.instanceId === input.knownInstanceId,
      ) ?? null
      logger.warn('clone.instance-state-unknown', {
        sourceInstanceId: input.sourceInstanceId,
        instanceId: input.knownInstanceId,
        foundInList: snapshot !== null,
        reason: messageOf(error),
      })
      return new StrayInstanceError(error, {
        instanceId: input.knownInstanceId,
        snapshot,
      })
    }
    const created = snapshots.filter((snapshot) => !input.beforeIds.has(snapshot.instanceId))
    if (created.length !== 1) {
      logger.warn('clone.readback-no-single-instance', {
        sourceInstanceId: input.sourceInstanceId,
        createdCount: created.length,
        reason: messageOf(error),
      })
      return null
    }
    const createdInstance = created[0]
    if (createdInstance === undefined) {
      return null
    }
    logger.warn('clone.instance-recovered-by-readback', {
      sourceInstanceId: input.sourceInstanceId,
      instanceId: createdInstance.instanceId,
      status: createdInstance.status,
      reason: messageOf(error),
    })
    return new StrayInstanceError(error, {
      instanceId: createdInstance.instanceId,
      snapshot: createdInstance,
    })
  }

  /**
   * 轮询新实例状态，直到离开「克隆锁定中」。
   *
   * 已关机与运行中都算完成。开机中等过渡态继续等；超时抛 CloneTimeoutError，
   * 由执行引擎转 ESCALATED（实例可能仍在计费）。
   *
   * 已看到的实例快照留在这里而不丢：超时抛错时它就是「状态未知的实例」，
   * 调用方回读判据要用它判断实例当前是否还在列表里，不必再读一次列表。
   */
  async function waitForCloneComplete(instanceId: string): Promise<ConsoleInstanceSnapshot> {
    const startedAt = clock.now()
    let lastStatusRaw = '未知'
    const outcome = await pollUntil<ConsoleInstanceSnapshot>({
      description: `等待实例 ${instanceId} 结束克隆锁定`,
      timeoutMs: CLONE_COMPLETE_TIMEOUT_MS,
      ...pollOptions(),
      probe: async () => {
        const snapshots = await context.instances.listInstances({ refresh: true })
        const target = snapshots.find((snapshot) => snapshot.instanceId === instanceId)
        if (target === undefined) {
          return undefined
        }
        lastStatusRaw = target.statusRaw
        if (target.status === 'stopped' || target.status === 'running') {
          return target
        }
        return undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new StrayInstanceError(
        new CloneTimeoutError(
          `实例 ${instanceId} 等待克隆完成超时（已等 ${String(elapsedSeconds(startedAt))} 秒），最后状态「${lastStatusRaw}」。`,
        ),
        { instanceId, snapshot: null },
      )
    }
    return outcome.value
  }

  /** 等改名输入框出现在目标行内。点「设置名称」后按钮原位才换成输入框。 */
  async function waitForRenameInput(inputSelector: string): Promise<void> {
    const startedAt = clock.now()
    const outcome = await pollUntil<true>({
      description: '等待实例改名输入框出现',
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const value = parseRenameInputValue(
          await channel.evaluate<unknown>(buildReadRenameInputValueScript(inputSelector)),
        )
        return value === undefined ? undefined : true
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `点「${INSTANCE_IDENTITY_CELL.renameButtonText}」后 ${String(elapsedSeconds(startedAt))} 秒内没有出现改名输入框。`,
      )
    }
  }

  /**
   * 给克隆出的实例改名。
   *
   * 实测（2026-11-25 真机）：克隆不复制实例名，新实例的 name 是空串。不改名的话，
   * 下次按 `Profile.instanceNamePattern` 找不到它，会再克隆一台，白烧每日克隆配额与费用。
   *
   * 改名交互：点行内「设置名称」→ 按钮原位变成输入框 → 写入名字 → 让输入框失焦才提交
   * （回车不提交）→ 回读列表确认 name 已变成新名字。
   * 名字已经是目标值时直接返回，不点按钮：重跑时改名只应发生一次。
   */
  async function renameCreatedInstance(instanceId: string, name: string): Promise<void> {
    const snapshots = await context.instances.listInstances({ refresh: true })
    const current = snapshots.find((snapshot) => snapshot.instanceId === instanceId)
    if (current === undefined) {
      throw new ConsoleParseError(`实例列表里找不到实例 ${instanceId}，无法改名。`)
    }
    if (current.name === name) {
      logger.info('clone.rename.skipped', { instanceId, name })
      return
    }
    logger.info('clone.rename.start', { instanceId, name, currentName: current.name })

    const rowSelector = await locateInstanceRow(instanceId)
    const renameButtonSelector = await locateButton(
      rowSelector,
      INSTANCE_IDENTITY_CELL.renameButtonText,
    )
    await channel.click(renameButtonSelector)
    const inputSelector = `${rowSelector} ${INSTANCE_IDENTITY_CELL.renameInput}`
    await waitForRenameInput(inputSelector)

    await channel.type(inputSelector, name)
    const writtenValue = parseRenameInputValue(
      await channel.evaluate<unknown>(buildReadRenameInputValueScript(inputSelector)),
    )
    if (writtenValue !== name) {
      // 不失焦就停下：失焦会提交，提交错名字比停在这里更难恢复。
      throw new ConsoleParseError(
        `改名输入框读回的 value 是「${String(writtenValue)}」，与目标名字「${name}」不一致。`,
      )
    }
    const blurred = await channel.evaluate<unknown>(buildRenameBlurScript(inputSelector))
    if (blurred !== true) {
      throw new ConsoleParseError(
        `实例 ${instanceId} 的改名输入框失焦失败，改名可能没有提交，请在控制台核对。`,
      )
    }

    const startedAt = clock.now()
    const outcome = await pollUntil<ConsoleInstanceSnapshot>({
      description: `等待实例 ${instanceId} 的名字变成「${name}」`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const latest = await context.instances.listInstances({ refresh: true })
        const target = latest.find((snapshot) => snapshot.instanceId === instanceId)
        return target?.name === name ? target : undefined
      },
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `实例 ${instanceId} 的名字在 ${String(elapsedSeconds(startedAt))} 秒内没有变成「${name}」。`,
      )
    }
    await screenshot(SCREENSHOT.renamed)
    logger.info('clone.renamed', { instanceId, name, previousName: current.name })
  }

  async function readCloneQuota(sourceInstanceId: string): Promise<number> {
    logger.info('clone.quota.start', { sourceInstanceId })
    const dialog = await openCloneDialog(sourceInstanceId)
    await screenshot(SCREENSHOT.quotaOpen)
    const remaining = parseCloneQuota(dialog.footerText)
    await closeVisibleDialog('关闭克隆配额对话框')
    await screenshot(SCREENSHOT.quotaClosed)
    logger.info('clone.quota.read', { sourceInstanceId, remaining })
    return remaining
  }

  async function clone(request: CloneRequest): Promise<CloneOutcome> {
    logger.info('clone.start', {
      sourceInstanceId: request.sourceInstanceId,
      // 克隆不复制实例名（实测 2026-11-25）：选主机页没有改名入口，request.instanceName
      // 在创建时用不上，克隆完成后由 renameCreatedInstance 用列表的「设置名称」写入。
      instanceName: request.instanceName,
      gpuPreference: [...request.gpuPreference],
      regionPreference: [...request.regionPreference],
      cloneDataDisk: request.cloneDataDisk,
    })

    // 1. 前置校验：源实例存在且已关机。任一不满足即失败，不打开对话框。
    // 列表不自动刷新，所以状态判定前显式刷新一次，避免拿旧状态去克隆。
    const before = await context.instances.listInstances({ refresh: true })
    const source = before.find((instance) => instance.instanceId === request.sourceInstanceId)
    if (source === undefined) {
      throw new InstanceNotFoundError(request.sourceInstanceId)
    }
    if (source.status !== 'stopped') {
      throw new CloneSourceUnavailableError(
        `源实例 ${request.sourceInstanceId} 当前状态为「${source.statusRaw}」，克隆前必须先关机。`,
      )
    }
    // 新实例靠「点击前不存在的 ID」识别。这份集合必须在本步取：打开选主机页后
    // 再回列表会丢掉已选的型号与主机。
    const beforeIds: ReadonlySet<string> = new Set(before.map((instance) => instance.instanceId))
    logger.info('clone.precheck', { sourceInstanceId: source.instanceId, status: source.status })

    // 2. 打开对话框，显式设置数据盘与稀疏优化。
    await screenshot(SCREENSHOT.listBeforeOpen)
    const dialog = await openCloneDialog(request.sourceInstanceId)
    await screenshot(SCREENSHOT.dialogOpened)

    // 配额就地读已打开的对话框页脚，不另开一次对话框：执行引擎已经在动任何实例之前
    // 用它自己的读法查过配额（spec 第 7.3 节的次序判据）。这里只兜「对话框打开期间
    // 配额被别的进程用掉」，判据来自同一份页面事实。
    const remaining = parseCloneQuota(dialog.footerText)
    if (remaining <= 0) {
      await closeVisibleDialog('关闭克隆配额对话框')
      throw new CloneQuotaExhaustedError(remaining)
    }
    logger.info('clone.quota.ok', { remaining })

    const options = await applyCloneDialogOptions(dialog, request.cloneDataDisk)
    await screenshot(SCREENSHOT.dialogOptions)
    logger.info('clone.dialog.options', {
      cloneDataDisk: findCloneDialogCheckbox(options, CLONE_DIALOG.dataDiskLabel).checked,
      sparseFileEnabled: options.sparseFileEnabled,
    })

    // 4. 进选主机页，并等型号列表渲染出来。
    await continueToCloneHostPage(request.sourceInstanceId)
    const ready = await waitForHostPageReady()
    await screenshot(SCREENSHOT.hostPage)
    logger.info('clone.host-page')

    // 5. 计费方式、地区、GPU 型号。
    const afterBilling = await selectBillingPayg(ready)
    await screenshot(SCREENSHOT.billingPayg)
    const afterRegion = await selectRegion(afterBilling, request.regionPreference)
    await screenshot(SCREENSHOT.region)
    const selection = await selectGpuModel(afterRegion, request.gpuPreference)
    await screenshot(SCREENSHOT.gpuModel)
    logger.info('clone.gpu-model', {
      pageModelName: selection.model.name,
      freeCount: selection.model.freeCount,
    })

    // 6. 等表格刷新后选第一台空闲 GPU 大于 0 的主机。
    const rows = await waitForHostTable(selection.model.name)
    const hostRow = pickHostRow(rows, selection.model.name)
    await selectHostRow(hostRow)
    await screenshot(SCREENSHOT.hostSelected)
    // CloneOutcome 没有单价字段（端口形状已定）。单价落进步骤日志，供预算复核取用。
    logger.info('clone.host-row', {
      hostId: hostRow.hostId,
      freeGpu: hostRow.freeGpu,
      totalGpu: hostRow.totalGpu,
      unitPriceYuanPerHour: hostRow.unitPriceYuanPerHour,
    })

    // 7. 点创建并开机。
    await clickConfirmButton(await readHostPage())
    logger.info('clone.confirm', {
      sourceInstanceId: request.sourceInstanceId,
      hostId: hostRow.hostId,
      unitPriceYuanPerHour: hostRow.unitPriceYuanPerHour,
    })
    await screenshot(SCREENSHOT.confirmClicked)

    // 8. 轮询列表出现新实例，再等它离开克隆锁定中。
    let created: ConsoleInstanceSnapshot
    try {
      await waitForInstanceListPage()
      created = await waitForCreatedInstance(beforeIds)
    } catch (error: unknown) {
      // 平台可能已受理克隆：抛错前回读一次列表，判出实例就按「已获取但状态未知」交引擎接管。
      const recovered = await readBackAfterCloneStarted(asDeploydeckError(error), {
        sourceInstanceId: request.sourceInstanceId,
        knownInstanceId: null,
        beforeIds,
      })
      throw recovered ?? error
    }
    // 规格文本按控制台原文记录。对不上只告警不改变结果：实例已经创建，不能丢结果。
    if (!created.gpuSpec.includes(selection.model.name)) {
      logger.warn('clone.gpu-spec-unexpected', {
        instanceId: created.instanceId,
        expectedModelName: selection.model.name,
        gpuSpec: created.gpuSpec,
      })
    }
    await screenshot(SCREENSHOT.newInstance)
    logger.info('clone.new-instance', {
      instanceId: created.instanceId,
      sourceInstanceId: request.sourceInstanceId,
      status: created.status,
    })
    let completed: ConsoleInstanceSnapshot
    try {
      completed = await waitForCloneComplete(created.instanceId)
    } catch (error: unknown) {
      // 实例已判定是本轮克隆，状态未知也要把 ID 交出去，让引擎绑定并记账。
      const reason = asDeploydeckError(error)
      const recovered = await readBackAfterCloneStarted(
        reason instanceof StrayInstanceError ? reason.cause as DeploydeckError : reason,
        {
          sourceInstanceId: request.sourceInstanceId,
          knownInstanceId: created.instanceId,
          beforeIds,
        },
      )
      throw recovered ?? error
    }
    await screenshot(SCREENSHOT.completed)
    logger.info('clone.completed', {
      instanceId: completed.instanceId,
      sourceInstanceId: request.sourceInstanceId,
      status: completed.status,
      statusRaw: completed.statusRaw,
    })
    // 9. 给新实例改名。克隆不复制实例名，不改名会让下一次执行按名字找不到它。
    // 这一步失败不丢实例：实例已经确认存在，只是名字没改成，按「已获取但状态未知」返回。
    try {
      await renameCreatedInstance(completed.instanceId, request.instanceName)
    } catch (error: unknown) {
      const recovered = await readBackAfterCloneStarted(asDeploydeckError(error), {
        sourceInstanceId: request.sourceInstanceId,
        knownInstanceId: completed.instanceId,
        beforeIds,
      })
      throw recovered ?? error
    }
    return { instanceId: completed.instanceId, sourceInstanceId: request.sourceInstanceId }
  }

  return { readCloneQuota, clone }
}
