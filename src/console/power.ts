import { join } from 'node:path'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import {
  ConsoleParseError,
  HumanRequiredError,
  InstanceNotFoundError,
  PowerOffTimeoutError,
} from '../errors.js'
import { systemClock, type Clock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'
import { confirmMessageBoxIfAsked } from './confirm.js'
import { jsString } from './dom.js'
import type { LocatedMenuItemProbe } from './release.js'
import {
  buildLocateVisibleMenuItemScript,
  parseVisibleMenuItemProbe,
} from './release.js'
import { buildVerifiedSelectorExpression } from './locate.js'
import type {
  ConsoleChannel,
  ConsoleRuntimeContext,
  PowerOnMode,
  PowerOnOutcome,
  PowerPort,
} from './ports.js'
import {
  CONSOLE_BUTTON_TAG,
  CONSOLE_NOTICE,
  DROPDOWN_ITEM_TEXT,
  INSTANCE_BUTTON_TEXT,
  INSTANCE_LIST,
  INSTANCE_LIST_COLUMN,
  POWER_OFF_CONFIRM,
  POWER_ON_CONFIRM,
} from './selectors.js'

/**
 * 开机与关机。
 *
 * 两个动作共用一条流程：按实例 ID 从列表定位行 → 页内按按钮文字定位 →
 * 经通道点击 → 轮询列表直到目标状态。页面读取与业务判断分开：
 * 页内脚本只取原始结构，解析与判定由本文件的纯函数完成，便于单测。
 *
 * 判据来源：spec 第 4.1 节与第 7.2 节、工单 04、控制台实测清单第 1 节。
 */

/**
 * 开机后等 GPU 可用的上限，5 分钟。
 *
 * 取自 spec 第 4.1 节：「开机后 5 分钟内 GPU 不可用即失败」。
 * 不用 `context.timeoutMs`：它是单次动作的通用超时，开机有单独的验收时长。
 */
export const POWER_ON_TIMEOUT_MS = 5 * 60 * 1000

/** 动作前后截图文件名。落进 `context.logDir`。 */
const SCREENSHOT = {
  powerOnBefore: 'power-on-before.png',
  powerOnAfter: 'power-on-after.png',
  powerOffBefore: 'power-off-before.png',
  powerOffAfter: 'power-off-after.png',
} as const

const NOTICE_SELECTOR = `${CONSOLE_NOTICE.message}, ${CONSOLE_NOTICE.alert}`

/** 「更多」菜单的打开等待上限与重试次数。与释放链取同一组经验值。 */
const NO_GPU_MENU_OPEN_WAIT_MS = 5_000
const NO_GPU_MENU_TOGGLE_ATTEMPTS = 2

/**
 * 「无卡模式开机」的二次确认。
 *
 * 实测未确认：控制台弹不弹确认框未知。按「弹了就点确定」处理，
 * 与开机确认共用同一条实现；不弹也不报错。
 */
const NO_GPU_POWER_ON_CONFIRM = { questionPrefix: '确认' } as const

/**
 * 页面提示条的文本。
 *
 * `source` 是提示出现的位置，只用于日志与详情描述；判据只看文本。
 */
export interface ConsoleNotice {
  readonly source: 'message' | 'alert'
  readonly text: string
}

/**
 * 开机期间从当前页面读到的原始事实。
 *
 * `statusText` 是目标实例状态单元格的全部文字（含 `.gpuTips` 补充）。
 * 控制台把「无可用 GPU」同时放在状态区的情况尚未实测，所以状态区文字也参与判定。
 */
export interface PowerOnPageState {
  readonly notices: readonly ConsoleNotice[]
  readonly statusText: string | null
}

/**
 * 无可用 GPU 的关键词。
 *
 * 判据文案实测未确认：控制台实测清单第 4 节列出「开机」未实测。
 * 这里只认「同时出现 GPU 与不可用表述」的提示，避免把状态区的「GPU充足」
 * 误判成失败。实测到真实文案后应先补关键词，再补夹具。
 */
const GPU_UNAVAILABLE_MARKERS = [
  '无可用',
  '没有可用',
  '没有空闲',
  '无空闲',
  '暂无',
  '不可用',
  '不足',
  '紧张',
  '被占用',
  '已占用',
  '被占满',
  '占满',
  '已满',
  '无法',
  '失败',
] as const

/** 状态区的正向提示。它含 GPU 关键词，但不是失败。 */
const GPU_AVAILABLE_TIP = 'GPU充足'

/** 文本是否是「GPU 不可用」类提示。 */
function isGpuUnavailableHint(text: string): boolean {
  const compact = text.replace(/\s+/g, '').toUpperCase()
  if (!compact.includes('GPU')) {
    return false
  }
  if (compact.includes(GPU_AVAILABLE_TIP)) {
    return false
  }
  return GPU_UNAVAILABLE_MARKERS.some((marker) => compact.includes(marker))
}

/**
 * 从页面事实里找「无可用 GPU」提示。找不到返回 `undefined`。
 *
 * 找不到任何提示时调用方必须归为 `timeout`：没有证据时不得猜 no-gpu。
 * 返回值是匹配到的原文，供失败详情回读。
 */
export function findNoGpuHint(state: PowerOnPageState): string | undefined {
  for (const notice of state.notices) {
    if (isGpuUnavailableHint(notice.text)) {
      return normalizeDetail(notice.text)
    }
  }
  if (state.statusText !== null && isGpuUnavailableHint(state.statusText)) {
    return normalizeDetail(state.statusText)
  }
  return undefined
}

function normalizeDetail(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 校验页内求值返回的行或按钮选择器。形状不符即抛错，不猜。 */
export function parseLocatedSelector(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ConsoleParseError(`页面返回的选择器非法：${JSON.stringify(raw)}`)
  }
  return raw
}

/** 校验页内求值返回的页面事实。形状不符即抛错，不猜。 */
export function parsePowerOnPageState(raw: unknown): PowerOnPageState {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConsoleParseError(`页面返回的提示结构非法：${JSON.stringify(raw)}`)
  }
  const record = raw as Record<string, unknown>
  const rawNotices = record['notices']
  if (!Array.isArray(rawNotices)) {
    throw new ConsoleParseError(`页面返回的提示结构缺少 notices：${JSON.stringify(raw)}`)
  }
  const notices: ConsoleNotice[] = []
  for (const item of rawNotices) {
    if (typeof item !== 'object' || item === null) {
      throw new ConsoleParseError(`页面返回的提示条目非法：${JSON.stringify(item)}`)
    }
    const notice = item as Record<string, unknown>
    const source = notice['source']
    const text = notice['text']
    if (source !== 'message' && source !== 'alert') {
      throw new ConsoleParseError(`页面返回的提示来源非法：${JSON.stringify(source)}`)
    }
    if (typeof text !== 'string') {
      throw new ConsoleParseError(`页面返回的提示文本非法：${JSON.stringify(text)}`)
    }
    notices.push({ source, text })
  }
  const rawStatus = record['statusText']
  if (rawStatus !== null && typeof rawStatus !== 'string') {
    throw new ConsoleParseError(`页面返回的状态区文字非法：${JSON.stringify(rawStatus)}`)
  }
  return { notices, statusText: rawStatus }
}

/** 行定位脚本用到的页内公共片段：按实例 ID 找行。 */
function buildRowLookupExpression(instanceId: string): string {
  return `[...document.querySelectorAll(${jsString(INSTANCE_LIST.row)})].find((candidate) => {
    const cells = candidate.querySelectorAll(${jsString(INSTANCE_LIST.cell)})
    const identity = cells[${String(INSTANCE_LIST_COLUMN.identity)}]
    return identity !== undefined && (identity.innerText || '').includes(${jsString(instanceId)})
  })`
}

/**
 * 在实例列表里按实例 ID 定位行，返回可用于后续作用域的选择器。
 *
 * 行选择器在运行时按真实 DOM 的同层同名序号生成，不写死控制台内部结构。
 * 生成后立刻回验：选择器必须指回同一行，否则返回 null。页面上有多张表时，
 * 行序号可能落到别的表上，回验能把它变成显式失败而不是点错行。
 */
export function buildLocateRowScript(instanceId: string): string {
  return `(() => {
  const row = ${buildRowLookupExpression(instanceId)}
  if (row === undefined) return null
  let index = 1
  for (let sibling = row.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
    if (sibling.localName === row.localName) index += 1
  }
  const selector = ${jsString(INSTANCE_LIST.row)} + ':nth-of-type(' + String(index) + ')'
  return document.querySelector(selector) === row ? selector : null
})()`
}

/**
 * 在行作用域内按按钮文字定位，返回可直接交给 `channel.click` 的选择器。
 *
 * 按钮匹配用「去空白后相等」，不是「包含」。原因是「开机」是
 * 「无卡模式开机」的子串：包含匹配可能点到无卡模式，而工单 04 明令禁止自动走无卡模式。
 * 从目标元素到作用域的路径也在运行时按真实 DOM 生成，并回验指回同一元素。
 */
export function buildLocateButtonScript(scopeSelector: string, buttonText: string): string {
  return `(() => {
  const scope = document.querySelector(${jsString(scopeSelector)})
  if (scope === null) return null
  const normalize = (text) => (text || '').replace(/\\s+/g, '')
  const target = [...scope.querySelectorAll(${jsString(CONSOLE_BUTTON_TAG)})].find((button) => normalize(button.innerText) === ${jsString(buttonText)})
  if (target === undefined) return null
${buildVerifiedSelectorExpression()}
  return toVerifiedSelector(target)
})()`
}

/**
 * 读开机期间可能出现的失败提示与目标行状态区文字。
 *
 * 可见判据用 `checkVisibility()` 或计算样式，不用几何尺寸：标签在后台时
 * 过渡不推进、几何尺寸可能为 0（控制台实测清单第 0 节）。控制台把历史提示
 * 留在 DOM 里的情况未实测，按可见性过滤可以避免把隐藏的旧提示当成新失败。
 */
export function buildReadPageStateScript(instanceId: string): string {
  return `(() => {
  const isVisible = (element) => {
    if (typeof element.checkVisibility === 'function') return element.checkVisibility()
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const notices = []
  for (const element of document.querySelectorAll(${jsString(NOTICE_SELECTOR)})) {
    if (!isVisible(element)) continue
    const source = element.matches(${jsString(CONSOLE_NOTICE.message)}) ? 'message' : 'alert'
    notices.push({ source, text: element.innerText || '' })
  }
  const row = ${buildRowLookupExpression(instanceId)}
  let statusText = null
  if (row !== undefined) {
    const statusCell = row.querySelectorAll(${jsString(INSTANCE_LIST.cell)})[${String(INSTANCE_LIST_COLUMN.status)}]
    if (statusCell !== undefined) statusText = statusCell.innerText || ''
  }
  return { notices, statusText }
})()`
}

/** 轮询探测结果。命中即结束轮询，未命中返回 `undefined`。 */
type PowerOnWait =
  | { readonly kind: 'running' }
  | { readonly kind: 'no-gpu'; readonly detail: string }

/**
 * 实现开机与关机。
 *
 * 工厂签名见工单 04：执行引擎按 `createPowerActions(context)` 装配。
 */
export function createPowerActions(context: ConsoleRuntimeContext): PowerPort {
  const channel: ConsoleChannel = context.channel
  const clock: Clock = context.clock ?? systemClock

  const screenshot = async (fileName: string): Promise<void> => {
    await channel.screenshot(join(context.logDir, fileName))
  }

  const findSnapshot = async (instanceId: string): Promise<ConsoleInstanceSnapshot> => {
    // 控制台列表页不自动刷新，读之前先让控制台取一次新数据，
    // 否则轮询会一直读到旧状态并把「状态没变」误判成超时。
    const snapshots = await context.instances.listInstances({ refresh: true })
    const snapshot = snapshots.find((candidate) => candidate.instanceId === instanceId)
    if (snapshot === undefined) {
      throw new InstanceNotFoundError(instanceId)
    }
    return snapshot
  }

  const locateRow = async (instanceId: string): Promise<string> => {
    const raw = await channel.evaluate<unknown>(buildLocateRowScript(instanceId))
    const selector = parseLocatedSelector(raw)
    if (selector === undefined) {
      throw new ConsoleParseError(`控制台页面上找不到实例 ${instanceId} 所在的列表行。`)
    }
    return selector
  }

  const locateButton = async (rowSelector: string, buttonText: string): Promise<string> => {
    const raw = await channel.evaluate<unknown>(buildLocateButtonScript(rowSelector, buttonText))
    const selector = parseLocatedSelector(raw)
    if (selector === undefined) {
      throw new ConsoleParseError(`实例行 ${rowSelector} 内找不到文字为「${buttonText}」的按钮。`)
    }
    return selector
  }

  const readPageState = async (instanceId: string): Promise<PowerOnPageState> => {
    const raw = await channel.evaluate<unknown>(buildReadPageStateScript(instanceId))
    return parsePowerOnPageState(raw)
  }

  const pollOptions = () =>
    ({
      now: () => clock.now(),
      sleep: (milliseconds: number) => clock.sleep(milliseconds),
      intervalMs: context.pollIntervalMs,
    }) as const

  const confirmIfAsked = async (questionPrefix: string, actionText: string): Promise<void> =>
    await confirmMessageBoxIfAsked(context, questionPrefix, actionText)

  /**
   * 接口：开机并等到 running。失败按 `PowerOnOutcome` 返回，不抛错，
   * 由执行引擎决定是否改走克隆（spec 第 4 节）。找不到实例、页面结构不符、
   * 状态不可开机这三类事实异常仍然抛错：它们不是「开机失败」，不能静默降级成克隆。
   */
  const powerOn = async (instanceId: string, mode: PowerOnMode): Promise<PowerOnOutcome> => {
    const initial = await findSnapshot(instanceId)
    if (initial.status !== 'stopped' && initial.status !== 'starting' && initial.status !== 'running') {
      throw new HumanRequiredError(
        `实例 ${instanceId} 当前状态为「${initial.statusRaw}」，无法执行开机。请在控制台确认后重试。`,
      )
    }
    // 形态判定看状态格标记，不看状态词：无卡开机中的状态词是「开机中」，与有卡相同。
    const wantedNoGpu = mode === 'no-gpu'
    if (initial.status === 'running' && initial.noGpuMode !== null && initial.noGpuMode !== wantedNoGpu) {
      // 运行中但形态不对。切换形态要先关机再开机，会打断正在跑的服务。
      throw new HumanRequiredError(
        `实例 ${instanceId} 正在以${initial.noGpuMode ? '无卡' : '有卡'}形态运行，` +
          `与配置要求的${wantedNoGpu ? '无卡' : '有卡'}模式不一致。` +
          '切换形态要先关机再开机，会打断正在跑的服务，deploydeck 不会替你重开。' +
          '请人工决定：接受当前形态，或先关机后重试。',
      )
    }
    // 已经在开机且形态正确：不重复点，直接等它起来。

    await screenshot(SCREENSHOT.powerOnBefore)
    if (initial.status === 'stopped') {
      const rowSelector = await locateRow(instanceId)
      if (mode === 'no-gpu') {
        await startNoGpuPowerOn(rowSelector)
      } else {
        const buttonSelector = await locateButton(rowSelector, INSTANCE_BUTTON_TEXT.powerOn)
        await channel.click(buttonSelector)
        await confirmIfAsked(POWER_ON_CONFIRM.questionPrefix, INSTANCE_BUTTON_TEXT.powerOn)
      }
    }
    await screenshot(SCREENSHOT.powerOnAfter)

    if (initial.status === 'running') {
      // 绑定实例已经在运行：目标状态已达成，不点击。判据仍以列表事实为准。
      return { ok: true, instanceId }
    }

    let lastStatusRaw = initial.statusRaw
    const waitOutcome = await pollUntil<PowerOnWait>({
      description: `等待实例 ${instanceId} 进入运行中`,
      timeoutMs: POWER_ON_TIMEOUT_MS,
      ...pollOptions(),
      probe: async () => {
        const snapshot = await findSnapshot(instanceId)
        lastStatusRaw = snapshot.statusRaw
        if (snapshot.status === 'running') {
          // 判据：形态要对着配置。有卡配置遇到无卡实例、无卡配置遇到有卡实例都不算成功。
          // 形态要和配置一致。标记读不到（null）时按状态词判：控制台改文案时
          // 不能静默当成「形态正确」，但也不该把一条真在跑的实例永远判成失败。
          if (snapshot.noGpuMode !== null && snapshot.noGpuMode !== wantedNoGpu) {
            return undefined
          }
          return { kind: 'running' }
        }
        if (mode === 'no-gpu') {
          // 无卡模式不依赖空闲 GPU，不存在「无可用 GPU」这一类失败。
          return undefined
        }
        const hint = findNoGpuHint(await readPageState(instanceId))
        if (hint !== undefined) {
          return { kind: 'no-gpu', detail: hint }
        }
        return undefined
      },
    })

    if (waitOutcome.status === 'matched') {
      if (waitOutcome.value.kind === 'running') {
        return { ok: true, instanceId }
      }
      return {
        ok: false,
        reason: 'no-gpu',
        detail: `实例 ${instanceId} 开机失败：控制台提示「${waitOutcome.value.detail}」。`,
      }
    }
    return {
      ok: false,
      reason: 'timeout',
      detail:
        `实例 ${instanceId} 在 ${String(POWER_ON_TIMEOUT_MS / 60_000)} 分钟内未进入运行中` +
        `（最后状态：${lastStatusRaw}）。`,
    }
  }

  /**
   * 无卡模式开机：点「更多」→「无卡模式开机」→ 必要时点确认。
   *
   * 判据（docs/refs/autodl/console-selectors.md 第 1.5 节）：
   * 菜单项文字是「无卡模式开机」，它不在行内按钮里，只在「更多」下拉里。
   * 菜单项按可见弹层定位，弹层归属判定复用释放链的同一份实现，不另写一套。
   */
  const startNoGpuPowerOn = async (rowSelector: string): Promise<void> => {
    const moreSelector = await locateButton(rowSelector, INSTANCE_BUTTON_TEXT.more)
    let lastProbeKind = 'no-visible-popper'
    for (let attempt = 1; attempt <= NO_GPU_MENU_TOGGLE_ATTEMPTS; attempt += 1) {
      await channel.click(moreSelector)
      const outcome = await pollUntil<LocatedMenuItemProbe>({
        description: `「${INSTANCE_BUTTON_TEXT.more}」菜单出现可见的「${DROPDOWN_ITEM_TEXT.noGpuPowerOn}」`,
        timeoutMs: NO_GPU_MENU_OPEN_WAIT_MS,
        ...pollOptions(),
        probe: async () => {
          const probe = parseVisibleMenuItemProbe(
            await channel.evaluate<unknown>(
              buildLocateVisibleMenuItemScript({
                rowSelector,
                itemText: DROPDOWN_ITEM_TEXT.noGpuPowerOn,
              }),
            ),
          )
          lastProbeKind = probe.kind
          return probe.kind === 'located' ? probe : undefined
        },
      })
      if (outcome.status === 'matched') {
        await channel.click(outcome.value.selector)
        await confirmIfAsked(NO_GPU_POWER_ON_CONFIRM.questionPrefix, DROPDOWN_ITEM_TEXT.noGpuPowerOn)
        return
      }
    }
    throw new ConsoleParseError(
      `点了 ${String(NO_GPU_MENU_TOGGLE_ATTEMPTS)} 次「${INSTANCE_BUTTON_TEXT.more}」后` +
        `仍未看到可见的「${DROPDOWN_ITEM_TEXT.noGpuPowerOn}」菜单项（最后一次探测：${lastProbeKind}）。`,
    )
  }

  /**
   * 接口：关机并等到 stopped。超时抛错：调用方不必把「可能仍在计费」当成普通失败处理。
   */
  const powerOff = async (instanceId: string): Promise<void> => {
    const initial = await findSnapshot(instanceId)
    if (initial.status !== 'stopped' && initial.status !== 'running') {
      throw new HumanRequiredError(
        `实例 ${instanceId} 当前状态为「${initial.statusRaw}」，无法执行关机。请在控制台确认后重试。`,
      )
    }

    await screenshot(SCREENSHOT.powerOffBefore)
    if (initial.status === 'running') {
      const rowSelector = await locateRow(instanceId)
      const buttonSelector = await locateButton(rowSelector, INSTANCE_BUTTON_TEXT.powerOff)
      await channel.click(buttonSelector)
      await confirmIfAsked(POWER_OFF_CONFIRM.questionPrefix, INSTANCE_BUTTON_TEXT.powerOff)
    }
    await screenshot(SCREENSHOT.powerOffAfter)

    if (initial.status === 'stopped') {
      return
    }

    let lastStatusRaw = initial.statusRaw
    const waitOutcome = await pollUntil<ConsoleInstanceSnapshot>({
      description: `等待实例 ${instanceId} 关机`,
      timeoutMs: context.timeoutMs,
      ...pollOptions(),
      probe: async () => {
        const snapshot = await findSnapshot(instanceId)
        lastStatusRaw = snapshot.statusRaw
        return snapshot.status === 'stopped' ? snapshot : undefined
      },
    })
    if (waitOutcome.status === 'timeout') {
      throw new PowerOffTimeoutError(instanceId, context.timeoutMs, lastStatusRaw)
    }
  }

  return { powerOn, powerOff }
}
