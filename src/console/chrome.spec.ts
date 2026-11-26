import { describe, expect, it } from 'vitest'
import { ChromeLaunchError, ConfigError } from '../errors.js'
import {
  assertLaunchableProfileDir,
  buildChromeLaunchArgs,
  chromeExecutableCandidates,
  ensureChromeRunning,
  needsWindowsPathTranslation,
  resolveChromeExecutable,
  type ChromeEnvironment,
  type ChromeExecutableLookup,
} from './chrome.js'

/** 本文件不启动任何进程：启动决策与参数构造全部经注入的假环境验证。 */

interface LaunchRecord {
  readonly executablePath: string
  readonly args: readonly string[]
}

interface FakeEnvironment {
  readonly environment: ChromeEnvironment
  readonly launches: LaunchRecord[]
  readonly translateCalls: readonly string[]
  readonly probeCalls: () => number
  readonly now: () => number
}

/** 假环境：假时钟推进轮询，probe 结果按序列给出。 */
function createFakeEnvironment(options: {
  readonly probeResults: readonly boolean[]
  readonly translatedPath?: string
}): FakeEnvironment {
  const launches: LaunchRecord[] = []
  const translateCalls: string[] = []
  let current = 0
  let probeCalls = 0
  const environment: ChromeEnvironment = {
    probeCdp: async () => {
      const index = Math.min(probeCalls, options.probeResults.length - 1)
      probeCalls += 1
      return options.probeResults[index] ?? false
    },
    launch: async (executablePath, args) => {
      launches.push({ executablePath, args })
    },
    translatePath: async (executablePath, path) => {
      translateCalls.push(`${executablePath}→${path}`)
      return options.translatedPath ?? path
    },
    clock: {
      now: () => current,
      sleep: async (milliseconds) => {
        current += milliseconds
      },
    },
  }
  return {
    environment,
    launches,
    translateCalls,
    probeCalls: () => probeCalls,
    now: () => current,
  }
}

function assertDefined<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) {
    throw new Error(message)
  }
  return value
}

function createLookup(options: {
  readonly env?: Readonly<Record<string, string>>
  readonly platform?: NodeJS.Platform
  readonly wsl?: boolean
  readonly existing?: readonly string[]
}): ChromeExecutableLookup {
  const existing = options.existing ?? []
  const env = options.env ?? {}
  return {
    readExecutableOverride: () => env['DEPLOYDECK_CHROME_EXECUTABLE'] ?? '',
    platform: options.platform ?? 'linux',
    wsl: options.wsl ?? false,
    fileExists: (path) => existing.includes(path),
  }
}

describe('Chrome 启动参数', () => {
  it('包含固定调试端口、独立 profile 目录与目标 URL', () => {
    const args = buildChromeLaunchArgs({
      profileDir: 'C:\\temp\\deploydeck-profile',
      port: 9333,
      targetUrl: 'https://www.autodl.com/console/instance/list',
    })

    expect(args).toContain('--remote-debugging-port=9333')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args).toContain('--user-data-dir=C:\\temp\\deploydeck-profile')
    expect(args).toContain('--no-first-run')
    // 目标 URL 放最后：Chrome 把第一个非开关参数当初始页面。
    expect(args[args.length - 1]).toBe('https://www.autodl.com/console/instance/list')
  })

  it('端口非法时抛配置错误，不猜默认值', () => {
    expect(() =>
      buildChromeLaunchArgs({ profileDir: '/tmp/profile', port: 0, targetUrl: 'about:blank' }),
    ).toThrow(ConfigError)
    expect(() =>
      buildChromeLaunchArgs({ profileDir: '/tmp/profile', port: 70_000, targetUrl: 'about:blank' }),
    ).toThrow(ConfigError)
  })
})

describe('保证 Chrome 在跑', () => {
  it('端口上已有实例时直接复用，不再启动进程', async () => {
    const fake = createFakeEnvironment({ probeResults: [true] })
    const session = await ensureChromeRunning({
      port: 9333,
      profileDir: '/tmp/profile',
      targetUrl: 'about:blank',
      executablePath: '/fake/chrome.exe',
      environment: fake.environment,
    })

    expect(session.launched).toBe(false)
    expect(session.debugBaseUrl).toBe('http://127.0.0.1:9333')
    expect(fake.launches).toHaveLength(0)
    expect('launchArgs' in session).toBe(false)
  })

  it('冷启动时启动一次，并用翻译后的 profile 路径等到端口就绪', async () => {
    const fake = createFakeEnvironment({
      probeResults: [false, true],
      translatedPath: 'C:\\Users\\zqh\\AppData\\Local\\deploydeck\\chrome-profile',
    })
    const session = await ensureChromeRunning({
      port: 9333,
      profileDir: '/home/zqh/chrome-profile',
      targetUrl: 'about:blank',
      executablePath: '/fake/chrome.exe',
      environment: fake.environment,
    })

    expect(fake.launches).toHaveLength(1)
    expect(session.launched).toBe(true)
    const launch = assertDefined(fake.launches[0], '应当启动一次')
    expect(launch.executablePath).toBe('/fake/chrome.exe')
    expect(launch.args).toContain(
      '--user-data-dir=C:\\Users\\zqh\\AppData\\Local\\deploydeck\\chrome-profile',
    )
    expect(session.launchArgs).toEqual(launch.args)
    expect(fake.translateCalls).toEqual(['/fake/chrome.exe→/home/zqh/chrome-profile'])
  })

  it('CDP 端口在超时内没就绪时抛 ChromeLaunchError', async () => {
    const fake = createFakeEnvironment({ probeResults: [false] })

    await expect(
      ensureChromeRunning({
        port: 9333,
        profileDir: '/tmp/profile',
        targetUrl: 'about:blank',
        executablePath: '/fake/chrome.exe',
        startupTimeoutMs: 100,
        environment: fake.environment,
      }),
    ).rejects.toThrow(/CDP 端口未就绪/)

    // 用假时钟推进：超时判定不靠真实等待。
    expect(fake.now()).toBeGreaterThanOrEqual(100)
    expect(fake.probeCalls()).toBeGreaterThanOrEqual(2)
  })
})

describe('Chrome 可执行文件解析', () => {
  it('环境变量指定的路径优先，且必须是存在的文件', () => {
    const lookup = createLookup({
      env: { DEPLOYDECK_CHROME_EXECUTABLE: '/opt/special/chrome' },
      existing: ['/opt/special/chrome'],
    })
    expect(resolveChromeExecutable(lookup)).toBe('/opt/special/chrome')

    const missing = createLookup({
      env: { DEPLOYDECK_CHROME_EXECUTABLE: '/opt/missing/chrome' },
      existing: [],
    })
    expect(() => resolveChromeExecutable(missing)).toThrow(ConfigError)
  })

  it('WSL 下按实测路径找 Windows Chrome', () => {
    const candidates = chromeExecutableCandidates('linux', true)
    expect(candidates[0]).toBe('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe')

    const lookup = createLookup({ wsl: true, existing: [candidates[0] ?? ''] })
    expect(resolveChromeExecutable(lookup)).toBe(candidates[0])
  })

  it('候选路径都不存在时报错并列出已查找路径', () => {
    const lookup = createLookup({ wsl: true, existing: [] })
    expect(() => resolveChromeExecutable(lookup)).toThrow(/找不到 Chrome 可执行文件/)
  })
})

describe('Windows 路径翻译判据', () => {
  it('WSL 里调 Windows Chrome 时需要翻译', () => {
    expect(needsWindowsPathTranslation('linux', '/mnt/c/Program Files/chrome.exe')).toBe(true)
    expect(needsWindowsPathTranslation('linux', '/usr/bin/chrome.exe')).toBe(true)
  })

  it('Linux 原生与 Windows 原生都不需要翻译', () => {
    expect(needsWindowsPathTranslation('linux', '/usr/bin/google-chrome')).toBe(false)
    expect(needsWindowsPathTranslation('win32', 'C:\\chrome.exe')).toBe(false)
  })
})

describe('拒绝对 WSL 网络路径启动 Chrome', () => {
  it('\\wsl.localhost 路径拒绝启动', () => {
    // 判据：Chrome 在 9p 上无法给 LevelDB 加锁，登录态写不进磁盘。
    expect(() =>
      assertLaunchableProfileDir(
        '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\state\\chrome-profile',
      ),
    ).toThrow(ConfigError)
  })

  it('\\wsl$ 路径同样拒绝', () => {
    expect(() => assertLaunchableProfileDir('\\\\wsl$\\Ubuntu\\home\\me\\profile')).toThrow(
      ConfigError,
    )
  })

  it('Windows 本地路径放行', () => {
    expect(() =>
      assertLaunchableProfileDir('C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile'),
    ).not.toThrow()
  })

  it('Linux 原生路径放行', () => {
    expect(() => assertLaunchableProfileDir('/home/me/.local/state/deploydeck/chrome-profile')).not.toThrow()
  })
})
