import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolveChromeExecutableOverride, resolveWslDistroName } from '../config/paths.js'
import { ChromeLaunchError, ConfigError } from '../errors.js'
import type { Logger } from '../logging/logger.js'
import { systemClock, type Clock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'

/**
 * 从 WSL 启动 Windows Chrome，并保证 CDP 端口就绪。
 *
 * 三条约束来自实测与 spec 第 6.1 节：
 *
 * 1. 专用 Chrome 用独立 user-data-dir，与日常浏览互不干扰。登录态存在这个目录里。
 * 2. CDP 端口固定。端口上已有实例时不再启动，避免多开抢同一个 profile。
 * 3. 等待 CDP 就绪有明确超时。超时立刻报错，不无限等。
 *
 * 实测（2026-11-25）：WSL 里 Chrome 位于
 * `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`；
 * 把 WSL 路径用 `wslpath -w` 翻成 `\\wsl.localhost\...` 后，
 * Windows Chrome 接受它作为 user-data-dir。
 */

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const CDP_READY_POLL_INTERVAL_MS = 250
const CDP_PROBE_TIMEOUT_MS = 2_000

/** Chrome 启动参数里与登录态无关的开关。少了会在新 profile 上弹首次运行提示。 */
const STABLE_CHROME_FLAGS: readonly string[] = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
]

export interface ChromeLaunchArgsInput {
  /** 已翻译成目标平台可用形式的 profile 目录。Windows Chrome 必须给 Windows 路径。 */
  readonly profileDir: string
  readonly port: number
  readonly targetUrl: string
}

/**
 * 构造 Chrome 启动参数。
 *
 * 纯函数：单测断言参数形状，不启动任何进程。
 */
export function buildChromeLaunchArgs(input: ChromeLaunchArgsInput): readonly string[] {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new ConfigError(`CDP 端口必须是 1-65535 的整数，当前值：${String(input.port)}`)
  }
  if (input.profileDir.length === 0) {
    throw new ConfigError('Chrome 的 user-data-dir 不能为空')
  }
  if (input.targetUrl.length === 0) {
    throw new ConfigError('Chrome 的目标 URL 不能为空')
  }
  return [
    `--remote-debugging-port=${String(input.port)}`,
    // CDP 没有认证。只监听回环地址，不要把浏览器暴露到局域网。
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${input.profileDir}`,
    ...STABLE_CHROME_FLAGS,
    input.targetUrl,
  ]
}

export interface ChromeSession {
  readonly port: number
  readonly debugBaseUrl: string
  /** 本次是否真的启动了进程。false 表示端口上已有实例，直接复用。 */
  readonly launched: boolean
  readonly executablePath: string
  /** 配置里的 profile 目录。启动时用的是翻译后的路径。 */
  readonly profileDir: string
  /** 本次实际使用的启动参数。复用已有实例时没有这个字段。 */
  readonly launchArgs?: readonly string[]
}

/** 浏览器启动依赖的外部边界。抽出来是为了让「起没起、起几次、超时」能在单测里验证。 */
export interface ChromeEnvironment {
  /** 探测 CDP 是否已在该端口就绪。连不上返回 false，不抛错。 */
  probeCdp(debugBaseUrl: string): Promise<boolean>
  /** 启动进程后立即返回，不等它退出。 */
  launch(executablePath: string, args: readonly string[]): Promise<void>
  /** 把本机路径翻译成 Chrome 进程所在平台能用的路径。不需要翻译时原样返回。 */
  translatePath(executablePath: string, path: string): Promise<string>
  /** 时钟与等待。等待 CDP 就绪的轮询经它，测试注入假时钟。 */
  readonly clock: Clock
}

export interface ChromeExecutableLookup {
  /** 读 `DEPLOYDECK_CHROME_EXECUTABLE`。空串表示没有覆盖。取值由配置入口给出。 */
  readonly readExecutableOverride: () => string
  readonly platform: NodeJS.Platform
  readonly wsl: boolean
  readonly fileExists: (path: string) => boolean
}

/** 按平台列出候选 Chrome 可执行文件。WSL 排在最前，因为本期只验收 WSL 调 Windows Chrome。 */
export function chromeExecutableCandidates(
  platform: NodeJS.Platform,
  wsl: boolean,
): readonly string[] {
  if (wsl) {
    return [
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ]
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
}

/** 解析 Chrome 可执行文件。候选路径都不存在时抛错，不猜。 */
export function resolveChromeExecutable(
  lookup: ChromeExecutableLookup = defaultChromeExecutableLookup(),
): string {
  const override = lookup.readExecutableOverride()
  if (override.length > 0) {
    if (!lookup.fileExists(override)) {
      throw new ConfigError(`DEPLOYDECK_CHROME_EXECUTABLE 指向的文件不存在：${override}`)
    }
    return override
  }
  const candidates = chromeExecutableCandidates(lookup.platform, lookup.wsl)
  const found = candidates.find((candidate) => lookup.fileExists(candidate))
  if (found === undefined) {
    throw new ConfigError(
      `找不到 Chrome 可执行文件。已查找：\n${candidates.join('\n')}\n` +
        '可用 DEPLOYDECK_CHROME_EXECUTABLE 指定绝对路径。',
    )
  }
  return found
}

/** 从 WSL 调 Windows Chrome 时必须换成 Windows 路径：Windows 进程理解不了 `/home/...`。 */
export function needsWindowsPathTranslation(
  platform: NodeJS.Platform,
  executablePath: string,
): boolean {
  if (platform !== 'linux') {
    return false
  }
  return executablePath.startsWith('/mnt/') || executablePath.toLowerCase().endsWith('.exe')
}

/** 是否运行在 WSL 里。`WSL_DISTRO_NAME` 由 WSL 注入；缺失时退回读内核版本串。 */
export function detectWsl(): boolean {
  if (process.platform !== 'linux') {
    return false
  }
  if (resolveWslDistroName().length > 0) {
    return true
  }
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

/** 真实环境：HTTP 探测 + 分离进程启动 + `wslpath` 路径翻译。 */
export function createChromeEnvironment(): ChromeEnvironment {
  const execFileAsync = promisify(execFile)
  return {
    probeCdp: async (debugBaseUrl) => {
      try {
        const response = await fetch(`${debugBaseUrl}/json/version`, {
          signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS),
        })
        return response.ok
      } catch {
        // 连不上就是「还没起来」。这是探针的语义，不是吞掉故障。
        return false
      }
    },
    launch: async (executablePath, args) => {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executablePath, [...args], { detached: true, stdio: 'ignore' })
        child.once('error', reject)
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
      })
    },
    translatePath: async (executablePath, path) => {
      if (!needsWindowsPathTranslation(process.platform, executablePath)) {
        return path
      }
      let stdout: string
      try {
        const result = await execFileAsync('wslpath', ['-w', path])
        stdout = result.stdout
      } catch (error: unknown) {
        throw new ChromeLaunchError(
          `无法把路径翻译成 Windows 路径：${path}（${describeCause(error)}）`,
          { cause: error },
        )
      }
      const translated = stdout.trim()
      if (translated.length === 0) {
        throw new ChromeLaunchError(`wslpath 没有返回 Windows 路径：${path}`)
      }
      return translated
    },
    clock: systemClock,
  }
}

export interface EnsureChromeOptions {
  readonly port: number
  /** 配置里的 profile 目录。翻译成 Chrome 平台的路径由环境负责。 */
  readonly profileDir: string
  readonly targetUrl: string
  readonly executablePath?: string
  readonly startupTimeoutMs?: number
  readonly environment?: ChromeEnvironment
  readonly logger?: Logger
}

/**
 * 保证 CDP 端口上有可用的 Chrome。
 *
 * 端口上已经有实例时直接复用：同一个 user-data-dir 再启动一个 Chrome 只会被转发到已有实例，
 * 两种写法都会让人误判「我启动成功了」，所以显式区分 `launched`。
 */
export async function ensureChromeRunning(options: EnsureChromeOptions): Promise<ChromeSession> {
  const environment = options.environment ?? createChromeEnvironment()
  const executablePath = options.executablePath ?? resolveChromeExecutable()
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const debugBaseUrl = `http://127.0.0.1:${String(options.port)}`

  if (await environment.probeCdp(debugBaseUrl)) {
    options.logger?.info('chrome.reuse', { port: options.port, debugBaseUrl })
    return {
      port: options.port,
      debugBaseUrl,
      launched: false,
      executablePath,
      profileDir: options.profileDir,
    }
  }

  const launchProfileDir = await environment.translatePath(executablePath, options.profileDir)
  const launchArgs = buildChromeLaunchArgs({
    profileDir: launchProfileDir,
    port: options.port,
    targetUrl: options.targetUrl,
  })
  const command = [executablePath, ...launchArgs].join(' ')
  // 命令类操作在执行前记录完整命令。失败时这条日志就是现场。
  options.logger?.info('chrome.launch', { command })
  const startedAt = environment.clock.now()
  try {
    await environment.launch(executablePath, launchArgs)
  } catch (error: unknown) {
    throw new ChromeLaunchError(`启动 Chrome 失败：${command}（${describeCause(error)}）`, {
      cause: error,
    })
  }

  const outcome = await pollUntil<true>({
    description: `等待 Chrome 在 ${String(options.port)} 端口就绪`,
    probe: async () => ((await environment.probeCdp(debugBaseUrl)) ? true : undefined),
    timeoutMs: startupTimeoutMs,
    intervalMs: CDP_READY_POLL_INTERVAL_MS,
    now: () => environment.clock.now(),
    sleep: (milliseconds) => environment.clock.sleep(milliseconds),
  })
  if (outcome.status === 'timeout') {
    throw new ChromeLaunchError(
      `Chrome 已启动，但 ${String(startupTimeoutMs)}ms 内 CDP 端口未就绪：${debugBaseUrl}（命令：${command}）`,
    )
  }
  options.logger?.info('chrome.ready', {
    port: options.port,
    debugBaseUrl,
    elapsedMs: environment.clock.now() - startedAt,
  })

  return {
    port: options.port,
    debugBaseUrl,
    launched: true,
    executablePath,
    profileDir: options.profileDir,
    launchArgs,
  }
}

function defaultChromeExecutableLookup(): ChromeExecutableLookup {
  return {
    readExecutableOverride: () => resolveChromeExecutableOverride(),
    platform: process.platform,
    wsl: detectWsl(),
    fileExists: (path) => existsSync(path),
  }
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
