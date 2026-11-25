import { describe, expect, it } from 'vitest'
import { ConsoleParseError, EXIT_HUMAN_REQUIRED, LoginRequiredError } from '../errors.js'
import type { Clock } from '../util/clock.js'
import type { ConsoleChannel } from './ports.js'
import { CONSOLE_INSTANCE_LIST_URL } from './selectors.js'
import {
  assertLoggedIn,
  decideLoginState,
  DEFAULT_LOGIN_TIMEOUT_SECONDS,
  parseLoginProbe,
  runLoginCommand,
  type LoginProbe,
} from './login.js'

/** 本文件不连浏览器：页面探测结果一律用伪造的 `ConsoleChannel` 给出。 */

const loggedInProbe: LoginProbe = {
  url: CONSOLE_INSTANCE_LIST_URL,
  readyState: 'complete',
  loginEntryTexts: [],
}

const loggedOutProbe: LoginProbe = {
  url: CONSOLE_INSTANCE_LIST_URL,
  readyState: 'complete',
  loginEntryTexts: ['登录'],
}

class FakeConsoleChannel implements ConsoleChannel {
  readonly gotoUrls: string[] = []
  readonly screenshotPaths: string[] = []
  private probeIndex = 0

  constructor(private readonly probes: readonly unknown[]) {}

  async goto(url: string): Promise<void> {
    this.gotoUrls.push(url)
  }

  async currentUrl(): Promise<string> {
    return CONSOLE_INSTANCE_LIST_URL
  }

  async evaluate<Result>(): Promise<Result> {
    const index = Math.min(this.probeIndex, this.probes.length - 1)
    this.probeIndex += 1
    return this.probes[index] as Result
  }

  async click(): Promise<void> {
    throw new Error('登录态用例不应点击页面')
  }

  async type(): Promise<void> {
    throw new Error('登录态用例不应输入文本')
  }

  async waitFor(): Promise<void> {
    throw new Error('登录态用例不应等待元素')
  }

  async waitForGone(): Promise<void> {
    throw new Error('登录态用例不应等待元素')
  }

  async screenshot(filePath: string): Promise<void> {
    this.screenshotPaths.push(filePath)
  }

  async close(): Promise<void> {
    // 用例不关心关闭。
  }
}

/** 假时钟：轮询不真实等待。 */
function createFakeClock(): Clock & { readonly elapsed: () => number } {
  let current = 0
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds
    },
    elapsed: () => current,
  }
}

describe('登录态判定', () => {
  it('页面出现登录入口即视为未登录', () => {
    expect(decideLoginState(loggedOutProbe)).toBe('login-required')
  })

  it('没有登录入口即视为已登录', () => {
    expect(decideLoginState(loggedInProbe)).toBe('logged-in')
  })

  it('停在登录页时直接判未登录', () => {
    expect(
      decideLoginState({
        url: 'https://www.autodl.com/login',
        readyState: 'complete',
        loginEntryTexts: [],
      }),
    ).toBe('login-required')
  })

  it('页面不在控制台域名下时报错，不猜登录态', () => {
    expect(() =>
      decideLoginState({ url: 'about:blank', readyState: 'complete', loginEntryTexts: [] }),
    ).toThrow(ConsoleParseError)
  })

  it('探测结果形状不符时报错，不当成空结果', () => {
    expect(() => parseLoginProbe({})).toThrow(ConsoleParseError)
    expect(() =>
      parseLoginProbe({ url: CONSOLE_INSTANCE_LIST_URL, readyState: 'complete', loginEntryTexts: [1] }),
    ).toThrow(ConsoleParseError)
  })
})

describe('控制面动作前的登录校验', () => {
  it('未登录时抛 LoginRequiredError，退出码 2 且提示重新登录', async () => {
    const channel = new FakeConsoleChannel([loggedOutProbe])

    let caught: unknown
    try {
      await assertLoggedIn(channel)
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LoginRequiredError)
    if (!(caught instanceof LoginRequiredError)) {
      throw new Error('应当抛出 LoginRequiredError')
    }
    expect(caught.message).toContain('请在专用 Chrome 窗口重新登录')
    expect(caught.exitCode).toBe(EXIT_HUMAN_REQUIRED)
  })

  it('已登录时校验通过', async () => {
    await expect(assertLoggedIn(new FakeConsoleChannel([loggedInProbe]))).resolves.toBeUndefined()
  })
})

describe('login 子命令', () => {
  it('登录完成后最多一个轮询间隔返回成功', async () => {
    const clock = createFakeClock()
    const channel = new FakeConsoleChannel([loggedOutProbe, loggedInProbe])

    const result = await runLoginCommand({
      channel,
      consoleUrl: CONSOLE_INSTANCE_LIST_URL,
      logDir: '.tmp/logs/login',
      clock,
    })

    expect(result.url).toBe(CONSOLE_INSTANCE_LIST_URL)
    // 验收：登录完成后 5 秒内返回。判定耗时只有轮询间隔那一档。
    expect(result.elapsedMs).toBeLessThanOrEqual(5_000)
    expect(channel.gotoUrls).toEqual([CONSOLE_INSTANCE_LIST_URL])
    expect(result.screenshotPaths).toEqual([
      '.tmp/logs/login/login-before.png',
      '.tmp/logs/login/login-after.png',
    ])
  })

  it('不传 timeoutMs 时用唯一常量 300 秒，CLI 与动作模块不各写一份', async () => {
    // Arrange
    const clock = createFakeClock()
    const channel = new FakeConsoleChannel([loggedOutProbe])

    // Act
    const error = await runLoginCommand({
      channel,
      consoleUrl: CONSOLE_INSTANCE_LIST_URL,
      logDir: '.tmp/logs/login',
      clock,
    }).catch((caught: unknown) => caught)

    // Assert
    expect(error).toBeInstanceOf(LoginRequiredError)
    expect(DEFAULT_LOGIN_TIMEOUT_SECONDS).toBe(300)
    expect(clock.elapsed()).toBe(DEFAULT_LOGIN_TIMEOUT_SECONDS * 1_000)
  })

  it('超时仍未登录时抛 LoginRequiredError，且只留登录前的截图', async () => {
    const clock = createFakeClock()
    const channel = new FakeConsoleChannel([loggedOutProbe])

    let caught: unknown
    try {
      await runLoginCommand({
        channel,
        consoleUrl: CONSOLE_INSTANCE_LIST_URL,
        timeoutMs: 2_500,
        logDir: '.tmp/logs/login',
        clock,
      })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LoginRequiredError)
    if (!(caught instanceof LoginRequiredError)) {
      throw new Error('应当抛出 LoginRequiredError')
    }
    expect(caught.message).toContain('请在专用 Chrome 窗口重新登录')
    expect(clock.elapsed()).toBeGreaterThanOrEqual(2_500)
    expect(channel.screenshotPaths).toEqual(['.tmp/logs/login/login-before.png'])
  })
})
