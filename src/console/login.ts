import { join } from 'node:path'
import { ConsoleParseError, LoginRequiredError } from '../errors.js'
import { systemClock, type Clock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'
import { jsString } from './dom.js'
import type { ConsoleChannel } from './ports.js'
import { CONSOLE_INSTANCE_LIST_URL } from './selectors.js'

/**
 * 登录态检测与 `login` 子命令的动作序列。
 *
 * 判据来自 spec 第 6.3 节：页面出现登录入口即视为未登录。
 * 未登录时抛 `LoginRequiredError`（退出码 2，消息里带「请在专用 Chrome 窗口重新登录」）。
 *
 * 不做的两件事：不填账号密码，不保存任何凭据。登录只由人完成。
 */

/**
 * 登录入口选择器。放本文件内部，因为 `selectors.ts` 收的是实例列表页的结构，
 * 登录页由本文件负责。后续工单若要在别处判定登录态，再把它并入 `selectors.ts`。
 *
 * 判据：登录入口按可见文本识别。未登录时控制台会跳到登录页，
 * 页面上有「登录」按钮；退出态也可能显示「立即登录」或「登录 / 注册」。
 * 按文本识别比按 class 稳，但要同时要求元素可见，
 * 否则隐藏的弹层模板会把已登录页面判成未登录。
 */
const LOGIN_ENTRY_SELECTOR = 'a, button, [role="button"]'
const LOGIN_ENTRY_TEXT_PATTERN = /^(登录|立即登录|登录\s*\/\s*注册|注册\s*\/\s*登录)$/

/** 判定登录态时接受的控制台域名。主域名取自 selectors.ts，`autodl.com` 覆盖裸域跳转。 */
const CONSOLE_HOSTS: readonly string[] = [new URL(CONSOLE_INSTANCE_LIST_URL).host, 'autodl.com']

/** 登录轮询间隔。验收要求「登录完成后 5 秒内返回成功」，1 秒留足余量。 */
const LOGIN_POLL_INTERVAL_MS = 1_000

/**
 * `login` 等待人完成登录的默认上限。
 *
 * 唯一来源：CLI 的 `--timeout` 默认值与 `runLoginCommand` 的缺省值都读它，
 * 不各自写 300。单位秒，供命令行展示；内部换算成毫秒。
 */
export const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300

/** 内部用的毫秒形式。由秒派生，避免两份数字各自漂移。 */
const DEFAULT_LOGIN_TIMEOUT_MS = DEFAULT_LOGIN_TIMEOUT_SECONDS * 1_000

export type LoginState = 'logged-in' | 'login-required'

/** 页面探测的原始结论。形状由 `parseLoginProbe` 校验。 */
export interface LoginProbe {
  readonly url: string
  readonly readyState: string
  /** 可见登录入口的文本。为空表示没看到登录入口。 */
  readonly loginEntryTexts: readonly string[]
}

/** 页内探测脚本。只取值、不做判断。 */
export function buildLoginProbeScript(): string {
  return `(() => {
  const normalizeText = (text) => (text ?? '').replace(/\\s+/g, ' ').trim()
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const pattern = new RegExp(${jsString(LOGIN_ENTRY_TEXT_PATTERN.source)})
  const texts = [...document.querySelectorAll(${jsString(LOGIN_ENTRY_SELECTOR)})]
    .filter(isVisible)
    .map((element) => normalizeText(element.innerText ?? element.textContent))
    .filter((text) => pattern.test(text))
  return {
    url: location.href,
    readyState: document.readyState,
    loginEntryTexts: [...new Set(texts)].slice(0, 5),
  }
})()`
}

/** 校验探测结果。形状不符即抛错，不按空结果处理。 */
export function parseLoginProbe(raw: unknown): LoginProbe {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConsoleParseError(`登录探测结果不是对象：${JSON.stringify(raw)}`)
  }
  const record = raw as Record<string, unknown>
  const url = record['url']
  const readyState = record['readyState']
  const loginEntryTexts = record['loginEntryTexts']
  if (typeof url !== 'string' || url.length === 0) {
    throw new ConsoleParseError(`登录探测结果缺少 url：${JSON.stringify(raw)}`)
  }
  if (typeof readyState !== 'string') {
    throw new ConsoleParseError(`登录探测结果缺少 readyState：${JSON.stringify(raw)}`)
  }
  if (!Array.isArray(loginEntryTexts) || !loginEntryTexts.every((text) => typeof text === 'string')) {
    throw new ConsoleParseError(`登录探测结果的 loginEntryTexts 不是字符串数组：${JSON.stringify(raw)}`)
  }
  return { url, readyState, loginEntryTexts: loginEntryTexts as readonly string[] }
}

/**
 * 判登录态。纯函数：只读探测结果，不碰页面。
 *
 * 页面不在控制台域名下时报错：此时没有登录态可言，判成「已登录」会让后续动作在错误页面上乱点。
 */
export function decideLoginState(probe: LoginProbe): LoginState {
  if (!isConsoleUrl(probe.url)) {
    throw new ConsoleParseError(
      `当前页面不是 AutoDL 控制台，无法判定登录态：${probe.url}。请先导航到 ${CONSOLE_INSTANCE_LIST_URL}。`,
    )
  }
  if (probe.url.includes('/login')) {
    return 'login-required'
  }
  if (probe.loginEntryTexts.length > 0) {
    return 'login-required'
  }
  return 'logged-in'
}

/** 读登录态探测结果。 */
export async function readLoginProbe(channel: ConsoleChannel): Promise<LoginProbe> {
  return parseLoginProbe(await channel.evaluate<unknown>(buildLoginProbeScript()))
}

/** 未登录即抛 `LoginRequiredError`。任何控制面动作开始前都要过这一关。 */
export async function assertLoggedIn(channel: ConsoleChannel): Promise<void> {
  if (decideLoginState(await readLoginProbe(channel)) === 'login-required') {
    throw new LoginRequiredError()
  }
}

export interface LoginCommandOptions {
  readonly channel: ConsoleChannel
  readonly consoleUrl: string
  /** 等待人在专用窗口完成登录的上限。 */
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
  /** 给定时登录前后各截一张图，落在该目录。 */
  readonly logDir?: string
  /** 时钟与等待。测试注入假时钟。 */
  readonly clock?: Clock
}

export interface LoginCommandResult {
  readonly url: string
  readonly elapsedMs: number
  readonly screenshotPaths: readonly string[]
}

/**
 * `login` 子命令的动作序列：打开控制台、等人登录、确认登录完成。
 *
 * 判据是页面不再出现登录入口，不是「窗口被打开过」。
 * 超时抛 `LoginRequiredError`：人没完成登录，进程不该假装成功。
 */
export async function runLoginCommand(options: LoginCommandOptions): Promise<LoginCommandResult> {
  const clock = options.clock ?? systemClock
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS
  const startedAt = clock.now()
  const screenshotPaths: string[] = []

  await options.channel.goto(options.consoleUrl)
  await captureScreenshot(options.channel, options.logDir, 'login-before', screenshotPaths)

  const outcome = await pollUntil<LoginProbe>({
    description: '等待在专用 Chrome 窗口完成登录',
    probe: async () => {
      try {
        const probe = await readLoginProbe(options.channel)
        return decideLoginState(probe) === 'logged-in' ? probe : undefined
      } catch (error: unknown) {
        // 登录过程中页面跳转、弹层重绘，探测可能短暂读不到形状。继续等。
        if (error instanceof ConsoleParseError) {
          return undefined
        }
        throw error
      }
    },
    timeoutMs,
    intervalMs: pollIntervalMs,
    now: () => clock.now(),
    sleep: (milliseconds) => clock.sleep(milliseconds),
  })

  if (outcome.status === 'timeout') {
    throw new LoginRequiredError()
  }

  await captureScreenshot(options.channel, options.logDir, 'login-after', screenshotPaths)

  return { url: outcome.value.url, elapsedMs: clock.now() - startedAt, screenshotPaths }
}

function isConsoleUrl(url: string): boolean {
  let host: string
  try {
    host = new URL(url).host
  } catch {
    throw new ConsoleParseError(`无法解析页面 URL，判定不了登录态：${url}`)
  }
  return CONSOLE_HOSTS.includes(host)
}

async function captureScreenshot(
  channel: ConsoleChannel,
  logDir: string | undefined,
  name: string,
  sink: string[],
): Promise<void> {
  if (logDir === undefined) {
    return
  }
  const filePath = join(logDir, `${name}.png`)
  await channel.screenshot(filePath)
  sink.push(filePath)
}
