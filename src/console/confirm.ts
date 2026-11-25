import type { ConsoleChannel } from './ports.js'
import { jsString } from './dom.js'
import { buildVerifiedSelectorExpression } from './locate.js'
import { CONSOLE_BUTTON_TAG, MESSAGE_BOX, MESSAGE_BOX_BUTTON } from './selectors.js'
import { ConsoleParseError, HumanRequiredError } from '../errors.js'
import { systemClock, type Clock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'

/**
 * Element Plus 二次确认消息框的通用处理。
 *
 * 判据（2026-11-25 真机实测）：AutoDL 控制台把「会花钱或不可逆」的动作都做成两步——
 * 点行内按钮只弹消息框，再点「确定」才真正执行。已实测的四种：
 *
 * | 动作 | 消息框正文 |
 * |---|---|
 * | 开机 | 确认开机吗？/ 实例将按￥1.58/时整点扣费 |
 * | 关机 | 确认关机吗？/ …关机后GPU将会释放…是否继续关机？ |
 * | 释放实例 | 释放后将会清除实例的所有系统盘和数据盘数据… |
 * | 取消定时关机 | 取消定时关机 |
 *
 * 不点「确定」，动作不会发生，外部只看到超时或「没有变化」。
 * 控制台把历史消息框留在 DOM 里，所以按尺寸过滤可见性，并取最后一个（后弹的叠在上面）。
 *
 * 判据：**只确认正文含给定问句前缀的框**。出现别的框一律交人工——
 * 点错确认的代价可能是关机或释放，不能靠猜。
 */

/** 等确认框出现的上限。实测四类确认框都在点按钮后 1 秒内出现。 */
const CONFIRM_WAIT_MS = 15_000

/** 页面上的二次确认框状态。 */
export type ConfirmMessageBoxState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'located'; readonly selector: string; readonly text: string }
  | { readonly kind: 'unrecognized'; readonly text: string }

/** 确认框处理需要的最小上下文。开机、关机、销毁链、取消定时关机共用。 */
export interface ConfirmContext {
  readonly channel: ConsoleChannel
  readonly timeoutMs: number
  readonly pollIntervalMs: number
  readonly clock?: Clock
}

/**
 * 找当前可见的二次确认消息框，返回它「确定」按钮的已回验选择器。
 *
 * `questionPrefix` 是正文里的问句前缀，例如「确认开机」「确认关机」「取消定时关机」。
 * 只按前缀认框，不整句等值比较：金额、实例名、盘信息都会变。
 */
export function buildConfirmMessageBoxScript(questionPrefix: string): string {
  return `(() => {
  const clean = (text) => (text || '').replace(/\\s+/g, ' ').trim()
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const boxes = [...document.querySelectorAll(${jsString(MESSAGE_BOX.root)})].filter(isVisible)
  if (boxes.length === 0) return { kind: 'absent' }
  const box = boxes[boxes.length - 1]
  const text = clean(box.innerText)
  if (!text.includes(${jsString(questionPrefix)})) {
    return { kind: 'unrecognized', text }
  }
  const confirm = [...box.querySelectorAll(${jsString(CONSOLE_BUTTON_TAG)})]
    .find((button) => clean(button.innerText) === ${jsString(MESSAGE_BOX_BUTTON.confirm)})
  if (confirm === undefined) {
    return { kind: 'unrecognized', text }
  }
${buildVerifiedSelectorExpression()}
  const selector = toVerifiedSelector(confirm)
  if (selector === null) return { kind: 'unrecognized', text }
  return { kind: 'located', selector, text }
})()`
}

/** 校验页内求值返回的确认框状态。形状不符即抛错，不猜。 */
export function parseConfirmMessageBoxState(raw: unknown): ConfirmMessageBoxState {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConsoleParseError(`页面返回的确认框状态非法：${JSON.stringify(raw)}`)
  }
  const record = raw as Record<string, unknown>
  const kind = record['kind']
  if (kind === 'absent') {
    return { kind: 'absent' }
  }
  const text = record['text']
  if (typeof text !== 'string') {
    throw new ConsoleParseError(`页面返回的确认框状态缺少正文：${JSON.stringify(raw)}`)
  }
  if (kind === 'unrecognized') {
    return { kind: 'unrecognized', text }
  }
  const selector = record['selector']
  if (kind === 'located' && typeof selector === 'string' && selector.length > 0) {
    return { kind: 'located', selector, text }
  }
  throw new ConsoleParseError(`页面返回的确认框状态非法：${JSON.stringify(raw)}`)
}

/**
 * 有确认框就点「确定」，没有就直接返回。
 *
 * 「没有确认框」是合法情况：控制台改版去掉确认时，动作本身仍然有效，
 * 这里不把它当失败。超过 {@link CONFIRM_WAIT_MS} 仍未出现即按「不需要确认」处理。
 */
export async function confirmMessageBoxIfAsked(
  context: ConfirmContext,
  questionPrefix: string,
  actionText: string,
): Promise<void> {
  const channel = context.channel
  const clock: Clock = context.clock ?? systemClock
  const script = buildConfirmMessageBoxScript(questionPrefix)
  const pollOptions = () =>
    ({
      now: () => clock.now(),
      sleep: (milliseconds: number) => clock.sleep(milliseconds),
      intervalMs: context.pollIntervalMs,
    }) as const

  const asked = await pollUntil<Exclude<ConfirmMessageBoxState, { kind: 'absent' }>>({
    description: `等待「${actionText}」二次确认框`,
    timeoutMs: CONFIRM_WAIT_MS,
    ...pollOptions(),
    probe: async () => {
      const state = parseConfirmMessageBoxState(await channel.evaluate<unknown>(script))
      return state.kind === 'absent' ? undefined : state
    },
  })
  if (asked.status === 'timeout') {
    return
  }
  const state = asked.value
  if (state.kind === 'unrecognized') {
    throw new HumanRequiredError(
      `点「${actionText}」后控制台弹出了未识别的确认框：` +
        `「${state.text}」。它不是「${questionPrefix}」确认，deploydeck 不会替你点，请人工确认后重试。`,
    )
  }
  await channel.click(state.selector)
  const dismissed = await pollUntil<true>({
    description: `等待「${actionText}」二次确认框消失`,
    timeoutMs: context.timeoutMs,
    ...pollOptions(),
    probe: async () => {
      const next = parseConfirmMessageBoxState(await channel.evaluate<unknown>(script))
      return next.kind === 'absent' ? true : undefined
    },
  })
  if (dismissed.status === 'timeout') {
    throw new ConsoleParseError(
      `「${actionText}」二次确认框没有在 ${String(context.timeoutMs)}ms 内消失。`,
    )
  }
}
