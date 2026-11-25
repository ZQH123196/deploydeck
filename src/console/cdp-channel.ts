import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BrowserChannelError, ConsoleParseError } from '../errors.js'
import { pollUntil } from '../util/poll.js'
import { jsString } from './dom.js'
import type { ConsoleChannel } from './ports.js'

/**
 * 浏览器通道：CDP over WebSocket。
 *
 * 三条实测事实决定了本文件的形状：
 *
 * 1. 点击必须走 `Input.dispatchMouseEvent`。JS `.click()` 对 Element Plus 按钮无效。
 * 2. 控制台表格比视口宽，右侧「操作」列默认在视口外。点击前必须先把元素滚进可视区。
 * 3. 页面标签在后台（`visibilityState === 'hidden'`）时 CSS 过渡不推进，
 *    弹层卡在半开状态、`getBoundingClientRect()` 高度为 0。
 *
 * 对第 3 条，本通道不依赖「动画是否跑完」，改成两道保险：
 *
 * - 每次连接后往页面注入零时长过渡/动画样式，并对新文档预注册注入脚本。
 *   过渡时长为 0 时浏览器直接落最终样式，后台标签也能读到正确几何。
 * - 点击前轮询几何尺寸，要求连续两次读数一致、非退化、中心点在视口内，才发鼠标事件。
 *   判定只看几何事实与时间上限，不看动画事件。
 *
 * 传输层单独抽出（`CdpTransport`）：自动测试用假传输验证 id 关联、超时与重连，
 * 不连真实浏览器。
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
const DEFAULT_GEOMETRY_SETTLE_TIMEOUT_MS = 2_000
const DEFAULT_GEOMETRY_SETTLE_INTERVAL_MS = 20
const NAVIGATION_POLL_INTERVAL_MS = 100

/**
 * 一次请求因断线允许的重连次数。
 *
 * 只重连一次：连续断线说明 Chrome 侧不稳定，继续重连会让上层分不清
 * 「短暂抖动」与「浏览器已经不可用」。第二次失败原样报错。
 */
const MAX_RECONNECTS_PER_REQUEST = 1

const NO_ANIMATION_STYLE_ID = 'deploydeck-no-animation'
const NO_ANIMATION_CSS =
  '*, *::before, *::after {' +
  ' transition-duration: 0s !important;' +
  ' transition-delay: 0s !important;' +
  ' animation-duration: 0s !important;' +
  ' animation-delay: 0s !important;' +
  ' scroll-behavior: auto !important;' +
  ' }'

/** 页面元素的视口几何。CDP 鼠标事件坐标与 `getBoundingClientRect()` 同源。 */
export interface ElementRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ViewportSize {
  readonly width: number
  readonly height: number
}

export interface PageGeometry {
  readonly rect: ElementRect
  readonly viewport: ViewportSize
}

/** 一条已建立的 CDP 连接。真实实现是 WebSocket 会话；测试用假实现。 */
export interface CdpConnection {
  /** 发送一条文本帧。连接已断时应抛错。 */
  send(payload: string): void
  /** 关闭连接。必须幂等。 */
  close(): void
  setMessageHandler(handler: (payload: string) => void): void
  /** 连接被动断开时回调。本端调用 `close()` 不应触发它。 */
  setCloseHandler(handler: (reason: string) => void): void
}

/** CDP 连接工厂。生产实现走 Node 22 自带的全局 WebSocket，不新增依赖。 */
export interface CdpTransport {
  connect(webSocketUrl: string): Promise<CdpConnection>
}

/** CDP 发现端点里的页面标签。 */
export interface CdpPageTarget {
  readonly id: string
  readonly url: string
  readonly webSocketDebuggerUrl: string
}

/** CDP 的 HTTP 发现端点。与 WebSocket 通道分开，便于替换与单测。 */
export interface CdpDiscovery {
  listPages(): Promise<readonly CdpPageTarget[]>
  createPage(url: string): Promise<CdpPageTarget>
}

export interface CdpChannelOptions {
  /** 解析要连的页面 CDP 地址。每次（重）连接前调用一次。 */
  resolveWebSocketUrl(): Promise<string>
  /** 传输实现。默认走全局 WebSocket。 */
  transport?: CdpTransport
  /** 单条 CDP 请求的超时。 */
  requestTimeoutMs?: number
  /** 等待 `document.readyState === 'complete'` 的超时。 */
  navigationTimeoutMs?: number
  /** 等待点击目标几何稳定的超时。 */
  geometrySettleTimeoutMs?: number
  /** 等待几何稳定的轮询间隔。 */
  geometrySettleIntervalMs?: number
}

/**
 * 建立通道。
 *
 * 首次调用任一动作时才连接：构造通道本身不碰网络。
 */
export function createCdpChannel(options: CdpChannelOptions): ConsoleChannel {
  return new CdpConsoleChannel(options)
}

/**
 * 注入零时长过渡与动画。脚本幂等：已注入时不再挂第二份。
 *
 * 难点在注入时机。作为「新文档预注册脚本」执行时，文档刚创建，
 * `document.documentElement` 还可能不存在，直接 append 会抛 TypeError。
 * 所以先试一次，挂不上就在 DOMContentLoaded / load 时再试。
 */
export function buildNoAnimationScript(): string {
  return `(() => {
  const styleId = ${jsString(NO_ANIMATION_STYLE_ID)}
  const install = () => {
    if (document.getElementById(styleId) !== null) return
    const parent = document.head ?? document.documentElement
    if (parent === null) return
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = ${jsString(NO_ANIMATION_CSS)}
    parent.appendChild(style)
  }
  install()
  if (document.readyState !== 'complete') {
    document.addEventListener('DOMContentLoaded', install, { once: true })
    window.addEventListener('load', install, { once: true })
  }
})()`
}

/**
 * 读元素几何。`scrollIntoView` 为真时先把元素滚到视口中心再读。
 *
 * 不用 smooth 滚动：后台标签的平滑滚动同样不推进，会把坐标读在半路。
 */
export function buildReadGeometryScript(selector: string, scrollIntoView: boolean): string {
  const scrollStatement = scrollIntoView
    ? `  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })\n`
    : ''
  return `(() => {
  const element = document.querySelector(${jsString(selector)})
  if (element === null) return null
${scrollStatement}  const rect = element.getBoundingClientRect()
  return {
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
})()`
}

/** 元素是否存在。`waitFor` / `waitForGone` 用它。 */
export function buildHasElementScript(selector: string): string {
  return `document.querySelector(${jsString(selector)}) !== null`
}

/** 读输入框当前值。`type` 用它校验写入是否生效。 */
export function buildReadInputValueScript(selector: string): string {
  return `(() => {
  const element = document.querySelector(${jsString(selector)})
  if (element === null) return null
  const value = element.value
  return typeof value === 'string' ? value : null
})()`
}

/** 校验页内求值返回的几何结构。形状不符即抛错，不猜。 */
export function parsePageGeometry(raw: unknown): PageGeometry | undefined {
  if (raw === null || raw === undefined) {
    return undefined
  }
  if (typeof raw !== 'object') {
    throw new ConsoleParseError(`页面返回的几何结构非法：${JSON.stringify(raw)}`)
  }
  const record = raw as Record<string, unknown>
  const rectRecord = record['rect']
  const viewportRecord = record['viewport']
  if (typeof rectRecord !== 'object' || rectRecord === null) {
    throw new ConsoleParseError(`页面返回的几何结构缺少 rect：${JSON.stringify(raw)}`)
  }
  if (typeof viewportRecord !== 'object' || viewportRecord === null) {
    throw new ConsoleParseError(`页面返回的几何结构缺少 viewport：${JSON.stringify(raw)}`)
  }
  const rectSource = rectRecord as Record<string, unknown>
  const viewportSource = viewportRecord as Record<string, unknown>
  return {
    rect: {
      x: readFiniteNumber(rectSource, 'x'),
      y: readFiniteNumber(rectSource, 'y'),
      width: readFiniteNumber(rectSource, 'width'),
      height: readFiniteNumber(rectSource, 'height'),
    },
    viewport: {
      width: readFiniteNumber(viewportSource, 'width'),
      height: readFiniteNumber(viewportSource, 'height'),
    },
  }
}

/**
 * 几何是否可点击。
 *
 * 退化的高度/宽度说明弹层还停在过渡的半开状态，鼠标落点会落空。
 * 中心点必须在视口内，否则 CDP 会按坐标点击画布外。
 */
export function isClickableGeometry(geometry: PageGeometry): boolean {
  const { rect, viewport } = geometry
  if (rect.width <= 0 || rect.height <= 0) {
    return false
  }
  const centerX = rect.x + rect.width / 2
  const centerY = rect.y + rect.height / 2
  return centerX >= 0 && centerX <= viewport.width && centerY >= 0 && centerY <= viewport.height
}

/** 两次读数的矩形是否一致。留半像素容差：滚动落定后可能有亚像素抖动。 */
export function isSameElementRect(left: ElementRect, right: ElementRect): boolean {
  const tolerance = 0.5
  return (
    Math.abs(left.x - right.x) <= tolerance &&
    Math.abs(left.y - right.y) <= tolerance &&
    Math.abs(left.width - right.width) <= tolerance &&
    Math.abs(left.height - right.height) <= tolerance
  )
}

/** 选出要驱动的页面标签：优先已在控制台域名下的页面，否则用第一个页面。 */
export function selectPageTarget(
  pages: readonly CdpPageTarget[],
  consoleUrl: string,
): CdpPageTarget | undefined {
  const consoleOrigin = new URL(consoleUrl).origin
  const onConsole = pages.find((page) => page.url.startsWith(consoleOrigin))
  if (onConsole !== undefined) {
    return onConsole
  }
  return pages[0]
}

/** 真实传输：Node 22 自带的全局 `WebSocket`。 */
export function createWebSocketTransport(): CdpTransport {
  return {
    connect: async (webSocketUrl) => {
      const socket = new WebSocket(webSocketUrl)
      let messageHandler: ((payload: string) => void) | undefined
      let closeHandler: ((reason: string) => void) | undefined
      let closed = false

      const opened = new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => {
          resolve()
        })
        socket.addEventListener('error', () => {
          reject(new BrowserChannelError(`CDP 连接失败：${webSocketUrl}`))
        })
      })

      const markClosed = (reason: string): void => {
        if (closed) {
          return
        }
        closed = true
        closeHandler?.(reason)
      }

      socket.addEventListener('message', (event) => {
        const payload = typeof event.data === 'string' ? event.data : String(event.data)
        messageHandler?.(payload)
      })
      socket.addEventListener('close', (event) => {
        markClosed(`CDP 连接被关闭（code=${String(event.code)}）`)
      })
      socket.addEventListener('error', () => {
        markClosed('CDP 连接出错')
      })

      await opened

      return {
        send: (payload) => {
          if (closed) {
            throw new BrowserChannelError(`CDP 连接已关闭，无法发送：${webSocketUrl}`)
          }
          socket.send(payload)
        },
        close: () => {
          // 本端主动关闭不算断线：标记后再关 socket，close 事件不会转成断线回调。
          closed = true
          socket.close()
        },
        setMessageHandler: (handler) => {
          messageHandler = handler
        },
        setCloseHandler: (handler) => {
          closeHandler = handler
        },
      }
    },
  }
}

/** 真实发现端点：`/json/list` 与 `/json/new`。 */
export function createHttpDiscovery(debugBaseUrl: string): CdpDiscovery {
  return {
    listPages: async () => {
      const response = await fetch(`${debugBaseUrl}/json/list`)
      if (!response.ok) {
        throw new BrowserChannelError(`读取 CDP 页面清单失败：HTTP ${String(response.status)}`)
      }
      const payload: unknown = await response.json()
      if (!Array.isArray(payload)) {
        throw new BrowserChannelError(`CDP 页面清单不是数组：${JSON.stringify(payload)}`)
      }
      const pages: CdpPageTarget[] = []
      for (const entry of payload) {
        const page = parsePageTarget(entry)
        if (page !== undefined && isPageEntry(entry)) {
          pages.push(page)
        }
      }
      return pages
    },
    createPage: async (url) => {
      // Chrome 只接受 PUT，且地址参数是裸 query string。
      const response = await fetch(`${debugBaseUrl}/json/new?${encodeURIComponent(url)}`, {
        method: 'PUT',
      })
      if (!response.ok) {
        throw new BrowserChannelError(
          `新建页面标签失败：HTTP ${String(response.status)}（${await response.text()}）`,
        )
      }
      const page = parsePageTarget(await response.json())
      if (page === undefined) {
        throw new BrowserChannelError('新建页面标签的响应缺少 webSocketDebuggerUrl')
      }
      return page
    },
  }
}

function isPageEntry(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) {
    return false
  }
  const record = raw as Record<string, unknown>
  return record['type'] === 'page'
}

function parsePageTarget(raw: unknown): CdpPageTarget | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const record = raw as Record<string, unknown>
  const id = record['id']
  const url = record['url']
  const webSocketDebuggerUrl = record['webSocketDebuggerUrl']
  if (typeof id !== 'string' || typeof url !== 'string' || typeof webSocketDebuggerUrl !== 'string') {
    return undefined
  }
  return { id, url, webSocketDebuggerUrl }
}

function readFiniteNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConsoleParseError(`页面返回的几何结构里 ${key} 不是有限数字：${JSON.stringify(value)}`)
  }
  return value
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeGeometry(geometry: PageGeometry): string {
  const { rect, viewport } = geometry
  const round = (value: number): number => Math.round(value * 100) / 100
  return (
    `rect=(${String(round(rect.x))},${String(round(rect.y))},` +
    `${String(round(rect.width))}x${String(round(rect.height))}) ` +
    `viewport=${String(viewport.width)}x${String(viewport.height)}`
  )
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

interface RuntimeEvaluateResponse {
  readonly result?: { readonly value?: unknown }
  readonly exceptionDetails?: {
    readonly text?: string
    readonly exception?: { readonly description?: string }
  }
}

interface CaptureScreenshotResponse {
  readonly data?: unknown
}

/**
 * 连接断开导致的失败。只在通道内部流转：请求循环据此重连一次，
 * 用尽重试后包装成 `BrowserChannelError` 抛出。
 * 用显式字段而不是继承层级来识别，避免调用方按类名做分支。
 */
class CdpConnectionLostError extends BrowserChannelError {
  readonly connectionLost = true

  constructor(detail: string, options?: { readonly cause?: unknown }) {
    super(`CDP 连接断开：${detail}`, options)
    this.name = 'CdpConnectionLostError'
  }
}

function isConnectionLostFailure(error: unknown): error is CdpConnectionLostError {
  if (error === null || typeof error !== 'object') {
    return false
  }
  return (error as { readonly connectionLost?: unknown }).connectionLost === true
}

class CdpConsoleChannel implements ConsoleChannel {
  private readonly options: CdpChannelOptions
  private readonly transport: CdpTransport
  private readonly requestTimeoutMs: number
  private readonly navigationTimeoutMs: number
  private readonly geometrySettleTimeoutMs: number
  private readonly geometrySettleIntervalMs: number
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 0
  private connection: CdpConnection | undefined
  private connecting: Promise<CdpConnection> | undefined
  private closed = false

  constructor(options: CdpChannelOptions) {
    this.options = options
    this.transport = options.transport ?? createWebSocketTransport()
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.navigationTimeoutMs = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS
    this.geometrySettleTimeoutMs = options.geometrySettleTimeoutMs ?? DEFAULT_GEOMETRY_SETTLE_TIMEOUT_MS
    this.geometrySettleIntervalMs =
      options.geometrySettleIntervalMs ?? DEFAULT_GEOMETRY_SETTLE_INTERVAL_MS
  }

  async goto(url: string): Promise<void> {
    const currentUrl = await this.currentUrl()
    if (currentUrl === url) {
      return
    }
    await this.sendCommand('Page.navigate', { url })
    await this.waitForDocumentReady(url)
    // 导航产生的文档要再注入一次：预注册脚本在文档创建期可能挂不上节点（实测会静默失败）。
    await this.injectNoAnimationStyles()
  }

  async currentUrl(): Promise<string> {
    const url = await this.evaluate<unknown>('location.href')
    if (typeof url !== 'string') {
      throw new ConsoleParseError(`读取页面 URL 失败：${JSON.stringify(url)}`)
    }
    return url
  }

  async evaluate<Result>(script: string): Promise<Result> {
    const response = await this.sendCommand<RuntimeEvaluateResponse>('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    })
    if (response.exceptionDetails !== undefined) {
      throw new ConsoleParseError(`页面求值抛错：${describeExceptionDetails(response.exceptionDetails)}`)
    }
    if (response.result === undefined) {
      throw new BrowserChannelError('CDP Runtime.evaluate 未返回结果')
    }
    return response.result.value as Result
  }

  async click(selector: string): Promise<void> {
    // 先滚进可视区再读几何：控制台表格比视口宽，右侧列默认在视口外。
    const scrolled = await this.readGeometry(selector, true)
    if (scrolled === undefined) {
      throw new ConsoleParseError(`选择器匹配不到元素：${selector}`)
    }
    const geometry = await this.waitForClickableGeometry(selector, scrolled)
    const x = geometry.rect.x + geometry.rect.width / 2
    const y = geometry.rect.y + geometry.rect.height / 2
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      clickCount: 0,
    })
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
    await this.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    })
  }

  async type(selector: string, text: string): Promise<void> {
    await this.click(selector)
    // 先清空再写。Element Plus 输入框只认真实按键事件，直接改 value 不会更新组件状态。
    await this.dispatchKey({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await this.dispatchKey({ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await this.sendCommand('Input.insertText', { text })
    await this.waitForInputValue(selector, text)
  }

  async waitFor(selector: string, timeoutMs: number): Promise<void> {
    const outcome = await pollUntil<true>({
      description: `等待元素出现：${selector}`,
      probe: async () => ((await this.hasElement(selector)) ? true : undefined),
      timeoutMs,
      intervalMs: this.geometrySettleIntervalMs,
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(`等待元素出现超时（${String(timeoutMs)}ms）：${selector}`)
    }
  }

  async waitForGone(selector: string, timeoutMs: number): Promise<void> {
    const outcome = await pollUntil<true>({
      description: `等待元素消失：${selector}`,
      probe: async () => ((await this.hasElement(selector)) ? undefined : true),
      timeoutMs,
      intervalMs: this.geometrySettleIntervalMs,
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(`等待元素消失超时（${String(timeoutMs)}ms）：${selector}`)
    }
  }

  async screenshot(filePath: string): Promise<void> {
    const response = await this.sendCommand<CaptureScreenshotResponse>('Page.captureScreenshot', {
      format: 'png',
    })
    const data = response.data
    if (typeof data !== 'string' || data.length === 0) {
      throw new BrowserChannelError('CDP Page.captureScreenshot 未返回图片数据')
    }
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, Buffer.from(data, 'base64'))
  }

  /** 只关连接，不关浏览器。可重复调用。 */
  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    const connection = this.connection
    this.connection = undefined
    this.rejectAllPending(new BrowserChannelError('浏览器通道已关闭，未完成的请求已作废'))
    connection?.close()
  }

  private async readGeometry(selector: string, scrollIntoView: boolean): Promise<PageGeometry | undefined> {
    const raw = await this.evaluate<unknown>(buildReadGeometryScript(selector, scrollIntoView))
    return parsePageGeometry(raw)
  }

  /**
   * 等到几何稳定再点。
   *
   * 判据是连续两次读数一致、非退化、中心点在视口内。不看动画事件，
   * 所以页面标签在后台、过渡停在半开状态时同样能判出来（要么稳定后点，要么超时报错）。
   */
  private async waitForClickableGeometry(
    selector: string,
    initial: PageGeometry,
  ): Promise<PageGeometry> {
    let previous: PageGeometry | undefined
    const outcome = await pollUntil<PageGeometry>({
      description: `等待元素几何稳定：${selector}`,
      probe: async () => {
        const geometry = await this.readGeometry(selector, false)
        if (geometry === undefined || !isClickableGeometry(geometry)) {
          previous = undefined
          return undefined
        }
        const stable = previous !== undefined && isSameElementRect(previous.rect, geometry.rect)
        previous = geometry
        return stable ? geometry : undefined
      },
      timeoutMs: this.geometrySettleTimeoutMs,
      intervalMs: this.geometrySettleIntervalMs,
    })
    if (outcome.status === 'timeout') {
      const last = previous
      const detail = last === undefined ? '元素不存在或几何退化' : describeGeometry(last)
      throw new ConsoleParseError(
        `元素无法点击：${selector} 在 ${String(this.geometrySettleTimeoutMs)}ms 内没有稳定几何（${detail}；刚滚动时为 ${describeGeometry(initial)}）`,
      )
    }
    return outcome.value
  }

  private async hasElement(selector: string): Promise<boolean> {
    const present = await this.evaluate<unknown>(buildHasElementScript(selector))
    if (typeof present !== 'boolean') {
      throw new ConsoleParseError(`元素存在性求值失败：${selector}（${JSON.stringify(present)}）`)
    }
    return present
  }

  private async waitForInputValue(selector: string, text: string): Promise<void> {
    const outcome = await pollUntil<string>({
      description: `等待输入框写入：${selector}`,
      probe: async () => {
        const value = await this.evaluate<unknown>(buildReadInputValueScript(selector))
        if (typeof value !== 'string') {
          return undefined
        }
        return value.includes(text) ? value : undefined
      },
      timeoutMs: this.geometrySettleTimeoutMs,
      intervalMs: this.geometrySettleIntervalMs,
    })
    if (outcome.status === 'timeout') {
      throw new ConsoleParseError(
        `输入框写入未生效：${selector} 的值里没有「${text}」（${String(this.geometrySettleTimeoutMs)}ms）`,
      )
    }
  }

  private async dispatchKey(input: {
    readonly key: string
    readonly code: string
    readonly windowsVirtualKeyCode: number
    readonly modifiers?: number
  }): Promise<void> {
    const base = {
      key: input.key,
      code: input.code,
      windowsVirtualKeyCode: input.windowsVirtualKeyCode,
      nativeVirtualKeyCode: input.windowsVirtualKeyCode,
    }
    const withModifiers =
      input.modifiers === undefined ? base : { ...base, modifiers: input.modifiers }
    await this.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...withModifiers })
    await this.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...withModifiers })
  }

  /** 往当前文档注入零时长样式。幂等，重复注入不会挂第二份。 */
  private async injectNoAnimationStyles(): Promise<void> {
    await this.evaluate<unknown>(buildNoAnimationScript())
  }

  private async waitForDocumentReady(targetUrl: string): Promise<void> {
    const outcome = await pollUntil<true>({
      description: `等待页面加载完成：${targetUrl}`,
      probe: async () => {
        if (this.closed) {
          throw new BrowserChannelError('浏览器通道已关闭')
        }
        try {
          const state = await this.evaluate<unknown>('document.readyState')
          return state === 'complete' ? true : undefined
        } catch (error: unknown) {
          // 导航会销毁旧执行上下文，求值会短暂失败。这是预期内的，继续等。
          if (error instanceof BrowserChannelError || error instanceof ConsoleParseError) {
            return undefined
          }
          throw error
        }
      },
      timeoutMs: this.navigationTimeoutMs,
      intervalMs: NAVIGATION_POLL_INTERVAL_MS,
    })
    if (outcome.status === 'timeout') {
      throw new BrowserChannelError(
        `页面加载超时（${String(this.navigationTimeoutMs)}ms）：${targetUrl}`,
      )
    }
  }

  private async connectionOrConnect(): Promise<CdpConnection> {
    if (this.closed) {
      throw new BrowserChannelError('浏览器通道已关闭，不能再发起请求')
    }
    const existing = this.connection
    if (existing !== undefined) {
      return existing
    }
    return this.connect()
  }

  private async connect(): Promise<CdpConnection> {
    const connecting = this.connecting
    if (connecting !== undefined) {
      return connecting
    }
    const promise = this.openConnection()
    this.connecting = promise
    try {
      return await promise
    } finally {
      this.connecting = undefined
    }
  }

  private async openConnection(): Promise<CdpConnection> {
    const webSocketUrl = await this.options.resolveWebSocketUrl()
    const connection = await this.transport.connect(webSocketUrl)
    connection.setMessageHandler((payload) => {
      this.handleMessage(connection, payload)
    })
    connection.setCloseHandler((reason) => {
      this.handleConnectionClosed(connection, reason)
    })
    this.connection = connection
    try {
      await this.initializeSession(connection)
      if (this.closed) {
        throw new BrowserChannelError('浏览器通道已关闭')
      }
    } catch (error: unknown) {
      this.invalidateConnection(connection)
      throw error
    }
    return connection
  }

  private async initializeSession(connection: CdpConnection): Promise<void> {
    await this.sendOnConnection(connection, 'Runtime.enable', {})
    await this.sendOnConnection(connection, 'Page.enable', {})
    const noAnimationScript = buildNoAnimationScript()
    // 对后续文档预注册：控制台是 SPA，但导航到别的页面后样式仍要存在。
    await this.sendOnConnection(connection, 'Page.addScriptToEvaluateOnNewDocument', {
      source: noAnimationScript,
    })
    // 当前文档也要注入一次：预注册脚本只对新文档生效。
    await this.sendOnConnection(connection, 'Runtime.evaluate', {
      expression: noAnimationScript,
      returnByValue: true,
    })
    // 后台标签里 Vue 的 rAF 驱动逻辑不推进；把窗口提到前面是最省事的一道保险。
    await this.sendOnConnection(connection, 'Page.bringToFront', {})
    // 实测（2026-11-25 真机）：浏览器窗口被其它窗口遮挡或最小化时，页面的
    // `document.visibilityState` 是 `hidden`。此时 rAF 不推进，Element Plus 的对话框
    // 过渡停在半路：外壳渲染出来但表单不出现，点 × 后也不会真正关闭。
    // `Page.bringToFront` 只能激活标签页，不能解除窗口遮挡，所以必须显式模拟「聚焦且活跃」。
    await this.sendOnConnection(connection, 'Emulation.setFocusEmulationEnabled', { enabled: true })
  }

  private async sendCommand<Result>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Result> {
    let reconnectsUsed = 0
    for (;;) {
      const connection = await this.connectionOrConnect()
      try {
        return await this.sendOnConnection<Result>(connection, method, params)
      } catch (error: unknown) {
        if (!isConnectionLostFailure(error)) {
          throw error
        }
        this.invalidateConnection(connection)
        if (reconnectsUsed >= MAX_RECONNECTS_PER_REQUEST) {
          throw new BrowserChannelError(
            `CDP 连接断开后重连仍未成功：${method}（${error.message}）`,
            { cause: error },
          )
        }
        reconnectsUsed += 1
      }
    }
  }

  private sendOnConnection<Result>(
    connection: CdpConnection,
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result> {
    const id = ++this.nextId
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserChannelError(`CDP 请求超时（${String(this.requestTimeoutMs)}ms）：${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as Result)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        connection.send(JSON.stringify({ id, method, params }))
      } catch (error: unknown) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new CdpConnectionLostError(`发送 ${method} 时失败（${describeCause(error)}）`))
      }
    })
  }

  private handleMessage(connection: CdpConnection, payload: string): void {
    if (this.connection !== connection) {
      return
    }
    let message: unknown
    try {
      message = JSON.parse(payload)
    } catch {
      this.failConnection(connection, '收到的 CDP 消息不是合法 JSON')
      return
    }
    if (typeof message !== 'object' || message === null) {
      this.failConnection(connection, '收到的 CDP 消息不是对象')
      return
    }
    const record = message as Record<string, unknown>
    const rawId = record['id']
    if (typeof rawId !== 'number') {
      // 事件帧：本通道只做请求应答，不等事件。
      return
    }
    const pending = this.pending.get(rawId)
    if (pending === undefined) {
      // 超时后迟到的响应：已经判过失败了，直接丢弃。
      return
    }
    this.pending.delete(rawId)
    const error = record['error']
    if (error !== undefined) {
      pending.reject(new BrowserChannelError(`CDP ${pending.method} 失败：${JSON.stringify(error)}`))
      return
    }
    pending.resolve(record['result'])
  }

  private handleConnectionClosed(connection: CdpConnection, reason: string): void {
    if (this.connection !== connection) {
      return
    }
    this.connection = undefined
    this.rejectAllPending(new CdpConnectionLostError(reason))
  }

  private failConnection(connection: CdpConnection, reason: string): void {
    this.invalidateConnection(connection)
    this.rejectAllPending(new CdpConnectionLostError(reason))
  }

  private invalidateConnection(connection: CdpConnection): void {
    if (this.connection === connection) {
      this.connection = undefined
    }
    connection.close()
  }

  private rejectAllPending(error: unknown): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) {
      entry.reject(error)
    }
  }
}

function describeExceptionDetails(
  details: NonNullable<RuntimeEvaluateResponse['exceptionDetails']>,
): string {
  const exception = details.exception
  if (exception !== undefined && exception.description !== undefined) {
    return exception.description
  }
  if (details.text !== undefined) {
    return details.text
  }
  return '页面异常没有给出描述'
}
