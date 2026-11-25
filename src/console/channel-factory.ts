import type { Logger } from '../logging/logger.js'
import {
  createCdpChannel,
  createHttpDiscovery,
  createWebSocketTransport,
  selectPageTarget,
  type CdpDiscovery,
  type CdpTransport,
} from './cdp-channel.js'
import {
  ensureChromeRunning,
  type ChromeEnvironment,
  type ChromeSession,
} from './chrome.js'
import { assertLoggedIn, decideLoginState, readLoginProbe } from './login.js'
import type { ConsoleChannel } from './ports.js'

/**
 * 控制面门面：把 Chrome 启动、CDP 通道、登录态判定装成单一入口。
 *
 * 后续工单只依赖本门面：取 `channel` 做动作，动作前先 `ensureLoggedIn()`。
 * 上层不需要知道 CDP、WebSocket、页面标签怎么选。
 */

export interface ConsoleSessionOptions {
  /** 控制台地址。也是 Chrome 冷启动时打开的页面。 */
  readonly consoleUrl: string
  readonly port: number
  /** 专用 Chrome 的 user-data-dir。登录态存在这里。 */
  readonly chromeProfileDir: string
  readonly chromeExecutablePath?: string
  readonly startupTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly navigationTimeoutMs?: number
  /** 外部边界。只给测试与特殊环境注入，正常运行不用传。 */
  readonly environment?: ChromeEnvironment
  readonly transport?: CdpTransport
  readonly discovery?: CdpDiscovery
  readonly logger?: Logger
}

export interface ConsoleSession {
  readonly channel: ConsoleChannel
  readonly chrome: ChromeSession
  /** 判断登录态。未登录返回 false。 */
  isLoggedIn(): Promise<boolean>
  /** 未登录即抛 `LoginRequiredError`（退出码 2）。 */
  ensureLoggedIn(): Promise<void>
  /** 关闭通道。不关闭浏览器：登录态要留到下一次运行。 */
  close(): Promise<void>
}

/** 打开控制面：保证 Chrome 在跑 → 连上 CDP → 导航到控制台。不判登录态。 */
export async function openConsoleSession(options: ConsoleSessionOptions): Promise<ConsoleSession> {
  const chrome = await ensureChromeRunning({
    port: options.port,
    profileDir: options.chromeProfileDir,
    targetUrl: options.consoleUrl,
    ...(options.chromeExecutablePath === undefined
      ? {}
      : { executablePath: options.chromeExecutablePath }),
    ...(options.startupTimeoutMs === undefined
      ? {}
      : { startupTimeoutMs: options.startupTimeoutMs }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  })

  const discovery = options.discovery ?? createHttpDiscovery(chrome.debugBaseUrl)
  const transport = options.transport ?? createWebSocketTransport()

  const channel = createCdpChannel({
    resolveWebSocketUrl: async () => {
      const pages = await discovery.listPages()
      const selected = selectPageTarget(pages, options.consoleUrl)
      if (selected !== undefined) {
        return selected.webSocketDebuggerUrl
      }
      const created = await discovery.createPage(options.consoleUrl)
      return created.webSocketDebuggerUrl
    },
    transport,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.navigationTimeoutMs === undefined
      ? {}
      : { navigationTimeoutMs: options.navigationTimeoutMs }),
  })

  await channel.goto(options.consoleUrl)

  return {
    channel,
    chrome,
    isLoggedIn: async () => decideLoginState(await readLoginProbe(channel)) === 'logged-in',
    ensureLoggedIn: async () => {
      await assertLoggedIn(channel)
    },
    close: async () => {
      await channel.close()
    },
  }
}
