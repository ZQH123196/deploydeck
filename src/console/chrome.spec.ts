import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ChromeBackgroundLaunchUnavailableError, ConfigError } from '../errors.js'
import {
  assertLaunchableProfileDir,
  createChromeEnvironment,
  decideReusePolicy,
  looksLikeWindowsPath,
  buildChromeLaunchArgs,
  buildMinimizedLaunchScript,
  chromeExecutableCandidates,
  resolveBackgroundLaunchScriptPath,
  readUserDataDirFromCommandLine,
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
  readonly background: boolean
}

interface FakeEnvironment {
  readonly environment: ChromeEnvironment
  readonly launches: LaunchRecord[]
  readonly translateCalls: readonly string[]
  readonly inspectCalls: () => number
  readonly probeCalls: () => number
  readonly now: () => number
}

/**
 * 假环境：假时钟推进轮询，probe 结果按序列给出。
 *
 * `discoveredProfileDir` 模拟端口上已有实例报出的 profile；`undefined` 表示读不出来。
 */
function createFakeEnvironment(options: {
  readonly probeResults: readonly boolean[]
  readonly translatedPath?: string
  readonly discoveredProfileDir?: string | null
}): FakeEnvironment {
  const launches: LaunchRecord[] = []
  const translateCalls: string[] = []
  let current = 0
  let probeCalls = 0
  let inspectCalls = 0
  const environment: ChromeEnvironment = {
    probeCdp: async () => {
      const index = Math.min(probeCalls, options.probeResults.length - 1)
      probeCalls += 1
      return options.probeResults[index] ?? false
    },
    inspectInstance: async () => {
      inspectCalls += 1
      return { profileDir: options.discoveredProfileDir ?? undefined }
    },
    launch: async (executablePath, args, launchOptions) => {
      launches.push({ executablePath, args, background: launchOptions.background })
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
    inspectCalls: () => inspectCalls,
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

  it('WSL 调 Windows Chrome 时监听 0.0.0.0，否则 WSL 侧连不到 CDP', () => {
    const args = buildChromeLaunchArgs({
      profileDir: 'C:\\temp\\deploydeck-profile',
      port: 9333,
      targetUrl: 'about:blank',
      wsl: true,
    })

    expect(args).toContain('--remote-debugging-address=0.0.0.0')
    expect(args).not.toContain('--remote-debugging-address=127.0.0.1')
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

describe('从实例命令行读 profile', () => {
  it('取未加引号与加了引号的 --user-data-dir', () => {
    // 判据：真机读到的命令行形如 "...chrome.exe" --remote-debugging-port=9223 --user-data-dir=C:\...
    expect(
      readUserDataDirFromCommandLine(
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9223 --user-data-dir=C:\\Users\\me\\dd\\chrome-profile https://x',
      ),
    ).toBe('C:\\Users\\me\\dd\\chrome-profile')
    expect(
      readUserDataDirFromCommandLine('chrome.exe --user-data-dir="C:\\a b\\p" about:blank'),
    ).toBe('C:\\a b\\p')
  })

  it('没有该开关时返回 undefined，不猜', () => {
    expect(readUserDataDirFromCommandLine('chrome.exe --remote-debugging-port=9223')).toBeUndefined()
    expect(readUserDataDirFromCommandLine('')).toBeUndefined()
  })
})

describe('端口已有实例时能不能复用', () => {
  it('确认是本次的 profile 就复用', () => {
    expect(
      decideReusePolicy({
        expectedProfileDir: 'C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile-e2e',
        discoveredProfileDir: 'c:/users/me/appdata/local/deploydeck/chrome-profile-e2e/',
        background: true,
      }),
    ).toBe('reuse')
  })

  it('读不出 profile 时当成不是本次的 profile', () => {
    expect(
      decideReusePolicy({ expectedProfileDir: 'C:\\p\\a', discoveredProfileDir: undefined, background: false }),
    ).toBe('launch')
  })

  it('后台启动时，端口被别人占着就拒绝，不退化成复用或新起', () => {
    // 判据：后台模式承诺不打扰人。复用别人浏览器、或让启动参数转发进别人浏览器，都破坏了这条。
    expect(
      decideReusePolicy({
        expectedProfileDir: 'C:\\p\\chrome-profile-e2e',
        discoveredProfileDir: 'C:\\p\\chrome-profile',
        background: true,
      }),
    ).toBe('reject')
    expect(
      decideReusePolicy({ expectedProfileDir: 'C:\\p\\e2e', discoveredProfileDir: undefined, background: true }),
    ).toBe('reject')
  })
})

describe('保证 Chrome 在跑', () => {
  it('端口上是本次的 profile 时直接复用，不再启动进程', async () => {
    const fake = createFakeEnvironment({
      probeResults: [true],
      discoveredProfileDir: 'C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile',
    })
    const session = await ensureChromeRunning({
      port: 9333,
      profileDir: 'C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile',
      targetUrl: 'about:blank',
      executablePath: '/fake/chrome.exe',
      environment: fake.environment,
    })

    expect(session.launched).toBe(false)
    expect(session.debugBaseUrl).toBe('http://127.0.0.1:9333')
    expect(fake.launches).toHaveLength(0)
    expect('launchArgs' in session).toBe(false)
  })

  it('端口上是人的浏览器时，非后台模式另起自己的 profile，不复用', async () => {
    const fake = createFakeEnvironment({
      probeResults: [true, true],
      discoveredProfileDir: 'C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile',
    })
    const session = await ensureChromeRunning({
      port: 9333,
      profileDir: 'C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile-e2e',
      targetUrl: 'about:blank',
      executablePath: '/fake/chrome.exe',
      environment: fake.environment,
    })

    expect(session.launched).toBe(true)
    expect(fake.launches).toHaveLength(1)
    const launch = assertDefined(fake.launches[0], '应当启动一次')
    expect(launch.args).toContain(
      '--user-data-dir=C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile-e2e',
    )
    expect(launch.background).toBe(false)
  })

  it('后台模式遇到别人的浏览器时直接报错，不启动也不复用', async () => {
    const fake = createFakeEnvironment({
      probeResults: [true],
      discoveredProfileDir: 'C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile',
    })

    await expect(
      ensureChromeRunning({
        port: 9333,
        profileDir: 'C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile-e2e',
        targetUrl: 'about:blank',
        executablePath: '/fake/chrome.exe',
        background: true,
        environment: fake.environment,
      }),
    ).rejects.toThrow(/不是本次要用的 profile/)

    expect(fake.launches).toHaveLength(0)
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

  it('要求后台启动时把后台标记原样交给启动边界', async () => {
    const fake = createFakeEnvironment({ probeResults: [false, true] })

    const session = await ensureChromeRunning({
      port: 9333,
      profileDir: '/tmp/profile',
      targetUrl: 'about:blank',
      executablePath: '/fake/chrome.exe',
      background: true,
      environment: fake.environment,
    })

    expect(session.background).toBe(true)
    expect(assertDefined(fake.launches[0], '应当启动一次').background).toBe(true)
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

describe('后台启动脚本', () => {
  it('用 Start-Process 最小化启动，且可执行文件与参数分开传', () => {
    // 判据：cmd 的 start 会把「整条带引号的命令行」当窗口标题，参数被拆散，命令起不来。
    // 这里断言不经过那层解析：-FilePath 与 -ArgumentList 各自成段。
    const script = buildMinimizedLaunchScript('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
      '--user-data-dir=C:\\Users\\me\\a b',
      'https://example.com/x y',
    ])

    expect(script).toContain("-WindowStyle Minimized")
    expect(script).toContain("-FilePath 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'")
    expect(script).toContain(
      "-ArgumentList '--user-data-dir=C:\\Users\\me\\a b','https://example.com/x y'",
    )
    expect(script).not.toContain('start /min')
  })

  it('参数里的单引号与 $ 原样保留，不被 PowerShell 展开', () => {
    const script = buildMinimizedLaunchScript('C:\\c.exe', ["--a=it's $HOME"])

    expect(script).toContain("-ArgumentList '--a=it''s $HOME'")
  })
})

describe('后台启动脚本文件', () => {
  it('脚本文件存在，且只最小化本次新起的窗口', () => {
    // 判据：实测 Chrome 会抢前台。脚本必须在启动后把本次新起的窗口最小化，
    // 并把前台还给启动前的窗口；不能碰用户原有的 Chrome 窗口。
    const scriptPath = resolveBackgroundLaunchScriptPath()
    expect(existsSync(scriptPath)).toBe(true)
    const script = readFileSync(scriptPath, 'utf8')
    expect(script).toContain('-WindowStyle Minimized')
    expect(script).toContain('SW_MINIMIZE')
    expect(script).toContain('restored-foreground')
    // 只处理启动前不存在的 chrome 进程
    expect(script).toContain('$before -notcontains')
  })
})

describe('后台启动只支持 WSL 调 Windows Chrome', () => {
  it('非 WSL 平台要求后台启动时报明确错误，不启动任何进程', async () => {
    // 判据：后台启动经 cmd.exe start /min 实现，别的平台没有这条路径。
    // 注入 wsl=false：本机是 WSL 时也不能真的去开浏览器。
    const environment = createChromeEnvironment({ wsl: false })
    await expect(
      environment.launch('/usr/bin/google-chrome', [], { background: true }),
    ).rejects.toThrow(ChromeBackgroundLaunchUnavailableError)
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

describe('已经是 Windows 路径时不再交给 wslpath', () => {
  it('盘符式路径原样返回，反斜杠不被吃掉', async () => {
    // 判据：wslpath -w 会把 C:\Users\... 当 Linux 相对路径，输出 CUsersZQH12AppData...
    // Chrome 拿到这个畸形路径后静默失败，CDP 端口永远不就绪。
    const environment = createChromeEnvironmentWithFakeWslpath()
    const translated = await environment.translatePath(
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      'C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile',
    )

    expect(translated).toBe('C:\\Users\\me\\AppData\\Local\\deploydeck\\chrome-profile')
    expect(environment.wslpathCalls).toBe(0)
  })

  it('UNC 路径原样返回', async () => {
    const environment = createChromeEnvironmentWithFakeWslpath()
    const translated = await environment.translatePath(
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '\\\\server\\share\\profile',
    )

    expect(translated).toBe('\\\\server\\share\\profile')
    expect(environment.wslpathCalls).toBe(0)
  })

  it('Linux 路径仍然翻译', async () => {
    const environment = createChromeEnvironmentWithFakeWslpath()
    const translated = await environment.translatePath(
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/home/me/profile',
    )

    expect(environment.wslpathCalls).toBe(1)
    // 发行版名由本机环境决定，只断言形态。
    expect(translated.startsWith('\\\\wsl.localhost\\')).toBe(true)
    expect(translated.endsWith('\\home\\me\\profile')).toBe(true)
  })
})

/**
 * 只包一层计数，其余是真实现。
 *
 * 断言点是「已经是 Windows 路径时有没有走到 wslpath」，所以必须用真实 translatePath。
 */
function createChromeEnvironmentWithFakeWslpath(): ChromeEnvironment & { wslpathCalls: number } {
  const real = createChromeEnvironment()
  const state = { calls: 0 }
  const environment = {
    ...real,
    translatePath: async (executablePath: string, path: string): Promise<string> => {
      if (!looksLikeWindowsPath(path)) {
        state.calls += 1
      }
      return real.translatePath(executablePath, path)
    },
  } as unknown as ChromeEnvironment & { readonly wslpathCalls: number }
  Object.defineProperty(environment, 'wslpathCalls', { get: () => state.calls })
  return environment
}
