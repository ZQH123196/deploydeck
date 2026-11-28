import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveChromeExecutableOverride, resolveWslDistroName } from '../config/paths.js'
import {
  ChromeBackgroundLaunchUnavailableError,
  ChromeLaunchError,
  ConfigError,
} from '../errors.js'
import type { Logger } from '../logging/logger.js'
import { systemClock, type Clock } from '../util/clock.js'
import { pollUntil } from '../util/poll.js'

/**
 * 从 WSL 启动 Windows Chrome，并保证 CDP 端口就绪。
 *
 * 三条约束来自实测与 spec 第 6.1 节：
 *
 * 1. 专用 Chrome 用独立 user-data-dir，与日常浏览互不干扰。登录态存在这个目录里。
 * 2. CDP 端口上已有能启动的实例时不再启动，避免多开抢同一个 profile。
 * 3. 等待 CDP 就绪有明确超时。超时立刻报错，不无限等。
 *
 * 「不能启动、只能复用」是本文件里最容易被写错的一条，见 `ChromeReusePolicy`：
 * 端口上已有的实例可能属于人正在使用的浏览器，复用前必须能确认它是本进程的 profile。
 *
 * 实测（2026-11-25）：WSL 里 Chrome 位于
 * `/mnt/c/Program Files/Google/Chrome/Application/chrome.exe`；
 * 把 WSL 路径用 `wslpath -w` 翻成 `\\wsl.localhost\...` 后，
 * Windows Chrome 接受它作为 user-data-dir。
 */

const execFileAsync = promisify(execFile)

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const CDP_READY_POLL_INTERVAL_MS = 250
const CDP_PROBE_TIMEOUT_MS = 2_000

/** Chrome 启动参数里与登录态无关的开关。少了会在新 profile 上弹首次运行提示。 */
const STABLE_CHROME_FLAGS: readonly string[] = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
]

/**
 * `--remote-debugging-address` 的取值。
 *
 * 非 WSL 平台 Chrome 只接受回环地址与 `0.0.0.0`。WSL 调 Windows Chrome 时，
 * 浏览器不在 WSL 的 loopback 上：写 127.0.0.1 时只有 Windows 自己能连，
 * WSL 侧永远等不到 CDP 就绪。实测取值是 `0.0.0.0`。
 */
export const CDP_DEBUG_ADDRESS_LOOPBACK = '127.0.0.1'
export const CDP_DEBUG_ADDRESS_WSL = '0.0.0.0'

export interface ChromeLaunchArgsInput {
  /** 已翻译成目标平台可用形式的 profile 目录。Windows Chrome 必须给 Windows 路径。 */
  readonly profileDir: string
  readonly port: number
  readonly targetUrl: string
  /** 是否由 WSL 启动 Windows Chrome。默认 false。 */
  readonly wsl?: boolean
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
    `--remote-debugging-address=${input.wsl === true ? CDP_DEBUG_ADDRESS_WSL : CDP_DEBUG_ADDRESS_LOOPBACK}`,
    `--user-data-dir=${input.profileDir}`,
    ...STABLE_CHROME_FLAGS,
    input.targetUrl,
  ]
}

/**
 * 一次发现的 Chrome 实例。端口上已有实例时才读。
 *
 * `profileDir` 是该实例自己的 user-data-dir。取值来自 Windows 进程表里它的启动命令行
 * （见 `readDiscoveredInstanceProfile`）。读不到时为 undefined：
 * 此时无法证明这个实例属于本次要用的 profile。
 */
export interface DiscoveredChromeInstance {
  readonly profileDir: string | undefined
}

/**
 * 端口上已有实例时，允不允许直接用它。
 *
 * - `reuse`：确认是本进程要用的 profile，直接用。
 * - `launch`：端口上的实例属于别的 profile。启动本次的 profile，不复用它。
 * - `reject`：既不复用也不新起，直接报错。详见 `ensureChromeRunning`。
 */
export type ChromeReusePolicy = 'reuse' | 'launch' | 'reject'

export interface ChromeSession {
  readonly port: number
  readonly debugBaseUrl: string
  /** 本次是否真的启动了进程。false 表示端口上已有本进程的实例，直接复用。 */
  readonly launched: boolean
  readonly executablePath: string
  /** 配置里的 profile 目录。启动时用的是翻译后的路径。 */
  readonly profileDir: string
  /** 本次实际使用的启动参数。复用已有实例时没有这个字段。 */
  readonly launchArgs?: readonly string[]
  /** 本次启动是否在后台（不抢前台）；复用已有实例时没有这个字段。 */
  readonly background?: boolean
}

/** 浏览器启动依赖的外部边界。抽出来是为了让「起没起、起几次、超时」能在单测里验证。 */
export interface ChromeEnvironment {
  /** 探测 CDP 是否已在该端口就绪。连不上返回 false，不抛错。 */
  probeCdp(debugBaseUrl: string): Promise<boolean>
  /** 读出端口上已有实例的 user-data-dir。读不到返回 `{ profileDir: undefined }`，不抛错。 */
  inspectInstance(debugBaseUrl: string): Promise<DiscoveredChromeInstance>
  /** 启动进程后立即返回，不等它退出。`background` 为真时不把窗口拉到前台。 */
  launch(executablePath: string, args: readonly string[], options: { readonly background: boolean }): Promise<void>
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

/** 是否已经是 Windows 能直接用的路径：盘符式或 UNC。 */
export function looksLikeWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')
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

/**
 * 真实环境：HTTP 探测 + CDP 读命令行 + 分离进程启动 + `wslpath` 路径翻译。
 *
 * `wsl` 可注入：后台启动只支持 WSL，测试要在不启动任何进程的前提下验证这条判据。
 */
export function createChromeEnvironment(options: { readonly wsl?: boolean } = {}): ChromeEnvironment {
  const wsl = options.wsl ?? detectWsl()
  const translatePath = async (executablePath: string, path: string): Promise<string> => {
    if (!needsWindowsPathTranslation(process.platform, executablePath)) {
      return path
    }
    // 已经是 Windows 路径时不能再问 wslpath：它把 `C:\Users\...` 当 Linux 相对路径，
    // 反斜杠会被逐个吃掉，输出 `CUsersZQH12AppData...`。Chrome 拿到这个路径后静默失败。
    if (looksLikeWindowsPath(path)) {
      return path
    }
    let stdout: string
    try {
      const result = await execFileAsync('wslpath', ['-w', path])
      stdout = result.stdout
    } catch (error: unknown) {
      throw new ChromeLaunchError(`无法把路径翻译成 Windows 路径：${path}（${describeCause(error)}）`, {
        cause: error,
      })
    }
    const translated = stdout.trim()
    if (translated.length === 0) {
      throw new ChromeLaunchError(`wslpath 没有返回 Windows 路径：${path}`)
    }
    return translated
  }
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
    inspectInstance: async (debugBaseUrl) =>
      await readDiscoveredInstanceProfile(debugBaseUrl),
    launch: async (executablePath, args, launchOptions) => {
      // 先判平台再建进程：不支持后台启动时必须在启动任何东西之前失败。
      if (launchOptions.background && !wsl) {
        throw new ChromeBackgroundLaunchUnavailableError(
          'DEPLOYDECK_CHROME_LAUNCH_BACKGROUND=1 只支持 WSL 调 Windows Chrome。' +
            '其他平台请改为 0（窗口出现在桌面上）。未启动任何浏览器。',
        )
      }
      if (!launchOptions.background) {
        await launchChromeProcess(executablePath, args, false)
        return
      }
      // 后台启动由 Windows 侧的 PowerShell 执行，它没有 WSL 路径映射：
      // 实测（2026-11-27）传 `/mnt/c/...` 报「系统找不到指定的文件」。
      await launchChromeProcess(
        await translatePath(executablePath, executablePath),
        args,
        true,
      )
    },
    translatePath,
    clock: systemClock,
  }
}

/** 读一次读就不留连接：只为了取 `--user-data-dir`，取完立即断开，关掉不影响浏览器。 */
const INSTANCE_INSPECT_TIMEOUT_MS = 5_000

/**
 * 让端口上的浏览器正常退出。
 *
 * 判据：只用于关闭本进程自己启动的浏览器。调用前必须先用 `ensureChromeRunning` 的返回值
 * 确认它是本次启动的（`launched === true`），否则会关掉人的浏览器。
 *
 * 走 CDP 的 `Browser.close` 而不是按进程号强杀：强杀会留下脏的 profile 锁与「未正常退出」标记，
 * 后续删除副本目录会因锁文件被拒（实测 EACCES）。
 * 关不掉时返回错误信息，不抛错：收尾清理要继续往下走。
 */
export async function closeChrome(debugBaseUrl: string): Promise<string | undefined> {
  let endpoint: string
  try {
    const response = await fetch(`${debugBaseUrl}/json/version`, {
      signal: AbortSignal.timeout(INSTANCE_INSPECT_TIMEOUT_MS),
    })
    if (!response.ok) {
      return undefined
    }
    const webSocketDebuggerUrl = readStringField(await response.json(), 'webSocketDebuggerUrl')
    if (webSocketDebuggerUrl === undefined) {
      return undefined
    }
    endpoint = webSocketDebuggerUrl
  } catch {
    // 连不上说明它已经没了，等价于已关闭。
    return undefined
  }

  try {
    await sendRawCdpCommand(endpoint, 'Browser.close')
    return undefined
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}


/**
 * 从端口上的实例读它自己的启动命令行。
 *
 * 为什么绕道 Windows 进程表，而不是直接问 CDP：
 * `Browser.getBrowserCommandLine` 在没开 `--enable-automation` 时返回错误
 * （实测 Chrome 158：`Command line not returned because --enable-automation not set.`）。
 * 收尾消息里也拿不到 profile。可靠做法是 CDP 只取浏览器进程号，命令行去 Windows 侧读。
 *
 * 只发只读命令，不发 `goto`、不点任何东西：读别人的浏览器时不能留下动作。
 * 任何一步读不到都返回 `{ profileDir: undefined }`，由策略层决定拒绝还是放行。
 */
async function readDiscoveredInstanceProfile(
  debugBaseUrl: string,
): Promise<DiscoveredChromeInstance> {
  const browserProcessId = await readBrowserProcessId(debugBaseUrl)
  if (browserProcessId === undefined) {
    return { profileDir: undefined }
  }
  return { profileDir: await readProcessUserDataDir(browserProcessId) }
}

/** 经 CDP 读浏览器进程号。读不到返回 undefined。 */
async function readBrowserProcessId(debugBaseUrl: string): Promise<number | undefined> {
  let endpoint: string
  try {
    const response = await fetch(`${debugBaseUrl}/json/version`, {
      signal: AbortSignal.timeout(INSTANCE_INSPECT_TIMEOUT_MS),
    })
    if (!response.ok) {
      return undefined
    }
    const webSocketDebuggerUrl = readStringField(await response.json(), 'webSocketDebuggerUrl')
    if (webSocketDebuggerUrl === undefined) {
      return undefined
    }
    endpoint = webSocketDebuggerUrl
  } catch {
    return undefined
  }

  const browserProcessId = await sendCdpCommand(endpoint, 'SystemInfo.getProcessInfo')
  if (browserProcessId === undefined || typeof browserProcessId !== 'object' || browserProcessId === null) {
    return undefined
  }
  const processInfo = (browserProcessId as { readonly processInfo?: unknown }).processInfo
  if (!Array.isArray(processInfo)) {
    return undefined
  }
  for (const entry of processInfo) {
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const candidate = entry as { readonly type?: unknown; readonly id?: unknown }
    if (candidate.type === 'browser' && typeof candidate.id === 'number') {
      return candidate.id
    }
  }
  return undefined
}

/** 发一条不会回结果的命令（如 `Browser.close`）后立即断开。连接失败时抛错。 */
async function sendRawCdpCommand(endpoint: string, method: string): Promise<void> {
  const socket = new WebSocket(endpoint)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ChromeLaunchError(`连接 CDP 超时：${method}`))
      }, INSTANCE_INSPECT_TIMEOUT_MS)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new ChromeLaunchError(`连接 CDP 失败：${method}`))
      })
    })
    socket.send(JSON.stringify({ id: 1, method }))
  } finally {
    socket.close()
  }
}

/** 用一条最简 CDP 连接发一条命令并返回 `result`，读完立即断开。失败返回 undefined。 */
async function sendCdpCommand(endpoint: string, method: string): Promise<unknown> {
  const socket = new WebSocket(endpoint)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ChromeLaunchError(`连接 CDP 超时：${method}`))
      }, INSTANCE_INSPECT_TIMEOUT_MS)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new ChromeLaunchError(`连接 CDP 失败：${method}`))
      })
    })

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ChromeLaunchError(`等待 CDP 结果超时：${method}`))
      }, INSTANCE_INSPECT_TIMEOUT_MS)
      socket.addEventListener('message', (event) => {
        const message = parseCdpMessage(event.data)
        if (message === undefined || message.id !== 1) {
          return
        }
        clearTimeout(timer)
        if (message.error !== undefined) {
          reject(new ChromeLaunchError(`CDP 命令返回错误：${method}`))
          return
        }
        resolve(message.result)
      })
      socket.send(JSON.stringify({ id: 1, method }))
    })
  } catch {
    // 读不到命令行是「无法确认它属于谁」这一事实，不是异常：拒绝与否由策略层决定。
    return undefined
  } finally {
    socket.close()
  }
}

/**
 * 从 Windows 进程表读某个进程的命令行，取 `--user-data-dir`。
 *
 * 经 PowerShell 的 `Get-CimInstance`：它不需要额外权限就能读命令行。
 * 读不到返回 undefined，不猜。
 */
async function readProcessUserDataDir(processId: number): Promise<string | undefined> {
  const script =
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${String(processId)}").CommandLine`
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: INSTANCE_INSPECT_TIMEOUT_MS * 2, cwd: '/mnt/c' },
    )
    return readUserDataDirFromCommandLine(stdout)
  } catch {
    return undefined
  }
}

/** 从一条命令行里取 `--user-data-dir`。取不到返回 undefined。纯函数。 */
export function readUserDataDirFromCommandLine(commandLine: string): string | undefined {
  const match = /--user-data-dir=(?:"([^"]*)"|(\S+))/i.exec(commandLine)
  const value = match?.[1] ?? match?.[2]
  return value !== undefined && value.length > 0 ? value : undefined
}

interface CdpMessage {
  readonly id?: number
  readonly result?: unknown
  readonly error?: unknown
}

function parseCdpMessage(data: unknown): CdpMessage | undefined {
  if (typeof data !== 'string') {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined
    }
    const candidate = parsed as { id?: unknown; result?: unknown; error?: unknown }
    const message: { id?: number; result?: unknown; error?: unknown } = {}
    if (typeof candidate.id === 'number') {
      message.id = candidate.id
    }
    if (candidate.result !== undefined) {
      message.result = candidate.result
    }
    if (candidate.error !== undefined) {
      message.error = candidate.error
    }
    return message
  } catch {
    return undefined
  }
}

function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const field = (value as Readonly<Record<string, unknown>>)[key]
  return typeof field === 'string' ? field : undefined
}

/**
 * 启动 Chrome 进程后立即返回，不等它退出。
 *
 * 后台启动走 PowerShell 的 `Start-Process -WindowStyle Minimized`，不走 `cmd.exe start /min`。
 * 实测（2026-11-27）：把「整条已转义引号的命令行」当单个参数交给 `start` 时，
 * `start` 把第一个带引号的参数当成窗口标题，后面的参数被拆成多个独立 argv，
 * 命令永远起不来。`Start-Process` 用 `-FilePath` 与 `-ArgumentList` 分开传，不经过这层解析。
 *
 * WSL 必须从 `/mnt/c` 发起 interop：WSL 让 Windows 进程继承当前目录，
 * 目录在 `\\wsl.localhost\...` 上时 cmd.exe 会先打两行「UNC paths are not supported」
 * 再退到 `C:\Windows`。不是配置错误，但会把无关警告混进测试输出。
 */
async function launchChromeProcess(
  executablePath: string,
  args: readonly string[],
  background: boolean,
): Promise<void> {
  if (!background) {
    const child = spawn(executablePath, [...args], { detached: true, stdio: 'ignore' })
    await waitForSpawn(child)
    return
  }
  await launchMinimizedViaPowerShell(executablePath, args)
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** PowerShell 单引号字面量：内部单引号按两个写。参数里的 `$`、`"` 都不会被展开。 */
function quoteForPowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * 后台启动脚本的路径。
 *
 * 脚本负责三件事：最小化启动、只把本次新起的 Chrome 窗口最小化、把前台还给启动前的窗口。
 * 为什么不能只靠 `-WindowStyle Minimized`：实测（2026-11-28）Chrome 自己创建窗口时仍会抢前台，
 * 前台窗口从用户的窗口变成了测试打开的页面。
 */
export function resolveBackgroundLaunchScriptPath(): string {
  return fileURLToPath(new URL('./scripts/launch-chrome-background.ps1', import.meta.url))
}

/**
 * 构造后台启动用的 PowerShell 脚本。
 *
 * 纯函数：单测断言脚本形状，不启动任何进程。
 */
export function buildMinimizedLaunchScript(
  executablePath: string,
  args: readonly string[],
): string {
  const argumentList = args.map((arg) => quoteForPowerShellLiteral(arg)).join(',')
  return (
    `Start-Process -FilePath ${quoteForPowerShellLiteral(executablePath)} ` +
    `-ArgumentList ${argumentList} -WindowStyle Minimized`
  )
}

/**
 * 经 PowerShell 最小化启动 Chrome，并确认 Windows 侧真的把进程拉起来了。
 *
 * 判据：`Start-Process` 失败时 PowerShell 退出码为 1，stderr 里带原因。
 * 只看 `spawn` 事件会把「Windows 侧拒绝启动」误判成成功，后面只能靠 CDP 超时兜底。
 */
/** 把 WSL 路径翻译成 Windows 能打开的路径。已是 Windows 形式时原样返回。 */
async function translatePathForLaunch(path: string): Promise<string> {
  if (looksLikeWindowsPath(path)) {
    return path
  }
  try {
    const { stdout } = await execFileAsync('wslpath', ['-w', path])
    const translated = stdout.trim()
    if (translated.length === 0) {
      throw new ChromeLaunchError(`wslpath 没有返回 Windows 路径：${path}`)
    }
    return translated
  } catch (error: unknown) {
    if (error instanceof ChromeLaunchError) {
      throw error
    }
    throw new ChromeLaunchError(`无法把路径翻译成 Windows 路径：${path}（${describeCause(error)}）`, {
      cause: error,
    })
  }
}

async function launchMinimizedViaPowerShell(
  executablePath: string,
  args: readonly string[],
): Promise<void> {
  // PowerShell 跑在 Windows 侧，读不了 `/home/...`：脚本路径也要先翻译。
  const scriptPath = await translatePathForLaunch(resolveBackgroundLaunchScriptPath())
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-ExecutablePath',
        executablePath,
        '-ArgumentListJson',
        JSON.stringify(args),
      ],
      { cwd: '/mnt/c', detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const stderrChunks: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      child.unref()
      if (code !== 0) {
        const detail = Buffer.concat(stderrChunks).toString('utf8').trim()
        reject(
          new ChromeLaunchError(
            `Windows 侧后台启动 Chrome 失败（退出码 ${String(code)}）：${detail}`,
          ),
        )
        return
      }
      resolve()
    })
  })
}

export interface EnsureChromeOptions {
  readonly port: number
  /** 配置里的 profile 目录。翻译成 Chrome 平台的路径由环境负责。 */
  readonly profileDir: string
  readonly targetUrl: string
  readonly executablePath?: string
  readonly startupTimeoutMs?: number
  /**
   * 是否由 WSL 启动 Windows Chrome。
   *
   * 必须与传给 `ChromeEnvironment` 的同一取值同源：两个地方各探测一次，
   * 会在 `WSL_DISTRO_NAME` 缺失且 `/proc` 探测失败时出现「参数按非 WSL 构造、启动按 WSL 走」。
   * 缺省时按运行环境探测。
   */
  readonly wsl?: boolean
  /** 启动时不抢前台。默认 false。 */
  readonly background?: boolean
  readonly environment?: ChromeEnvironment
  readonly logger?: Logger
}

/** 目录归属判定：两侧都按 Windows 不区分大小写、忽略尾部分隔符比较。 */
function isSameProfileDir(expected: string, actual: string): boolean {
  const normalize = (value: string): string => value.trim().replaceAll('/', '\\').replace(/\\+$/, '')
  return normalize(expected).toLowerCase() === normalize(actual).toLowerCase()
}

/**
 * 保证 CDP 端口上有本进程可用的 Chrome。
 *
 * 端口上已有实例时不能一律复用。两种情况的后果都是让命令落进人正在用的浏览器：
 *
 * - 端口上的实例属于别的 profile：再启动一个 Chrome 只会把参数转发过去，
 *   新 profile 永远起不来，动作全部发生在人的浏览器里。
 * - 明明确认了 profile 对不上，却把「本次启动」当成成功。
 *
 * 因此分三档：
 *
 * - 能启动、读到的 profile 就是本次要用的 → 复用，`launched=false`。
 * - 能启动、读到的 profile 是别的，或读不出来 → 启动本次的 profile，
 *   再启动的 Chrome 发现端口被占时不会接管，本次 profile 的 CDP 端口自然就绪，随后走正常流程。
 * - 要求后台启动且端口被别的实例占着 → 直接报错。
 *   此时复用与后台新起都有落进别人浏览器的风险，宁可报错让人关掉占用端口的浏览器。
 *
 * 「能启动」指非后台的分离进程：它不受已有实例转发影响，后台启动则可能被端口上的实例接走。
 */
export async function ensureChromeRunning(options: EnsureChromeOptions): Promise<ChromeSession> {
  // WSL 事实只取一次，参数构造与启动边界都用它：两处各探测会得出不一致的结论。
  const wsl = options.wsl ?? detectWsl()
  const environment = options.environment ?? createChromeEnvironment({ wsl })
  const executablePath = options.executablePath ?? resolveChromeExecutable()
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const background = options.background ?? false
  const debugBaseUrl = `http://127.0.0.1:${String(options.port)}`

  if (await environment.probeCdp(debugBaseUrl)) {
    const discovered = await environment.inspectInstance(debugBaseUrl)
    const policy = decideReusePolicy({
      expectedProfileDir: options.profileDir,
      discoveredProfileDir: discovered.profileDir,
      background,
    })
    if (policy === 'reuse') {
      options.logger?.info('chrome.reuse', {
        port: options.port,
        debugBaseUrl,
        profileDir: options.profileDir,
      })
      return {
        port: options.port,
        debugBaseUrl,
        launched: false,
        executablePath,
        profileDir: options.profileDir,
      }
    }
    if (policy === 'reject') {
      throw new ChromeLaunchError(
        `CDP 端口 ${String(options.port)} 上已有 Chrome 实例（profile：${
          discovered.profileDir ?? '读不出来'
        }），但不是本次要用的 profile：${options.profileDir}。\n` +
          (background
            ? '后台模式不复用、也不往别的 profile 转发，因此拒绝继续。\n' +
              '请先释放该端口（退出占用它的 Chrome），再重试。'
            : '不能直接复用别人的 profile：Chrome 会把新参数转发给已有实例。\n' +
              '请先释放该端口（退出占用它的 Chrome），再重试。'),
      )
    }
    options.logger?.info('chrome.port-occupied-by-other-profile', {
      port: options.port,
      discoveredProfileDir: discovered.profileDir ?? null,
      expectedProfileDir: options.profileDir,
    })
  }

  const launchProfileDir = await environment.translatePath(executablePath, options.profileDir)
  assertLaunchableProfileDir(launchProfileDir)
  const launchArgs = buildChromeLaunchArgs({
    profileDir: launchProfileDir,
    port: options.port,
    targetUrl: options.targetUrl,
    wsl,
  })
  const command = [executablePath, ...launchArgs].join(' ')
  // 命令类操作在执行前记录完整命令。失败时这条日志就是现场。
  options.logger?.info('chrome.launch', { command, background })
  const startedAt = environment.clock.now()
  try {
    await environment.launch(executablePath, launchArgs, { background })
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
    background,
  })

  return {
    port: options.port,
    debugBaseUrl,
    launched: true,
    executablePath,
    profileDir: options.profileDir,
    launchArgs,
    background,
  }
}

export interface ReuseDecisionInput {
  /** 本次要用的 profile 目录（配置里的值）。 */
  readonly expectedProfileDir: string
  /** 端口上已有实例报出的 profile 目录。读不出来时为 undefined。 */
  readonly discoveredProfileDir: string | undefined
  /** 本次是否要求后台启动。 */
  readonly background: boolean
}

/**
 * 端口上已有实例时的决策。纯函数：单测直接断言三档。
 *
 * 判据顺序：先看能否确认是同一 profile（是 → 复用），再看是不是后台启动（是 → 拒绝），否则再启动一个。
 * 读不出 profile 一律当「不是同一 profile」：无法证明它属于本进程，就不能碰它。
 *
 * 后台启动经 Windows 的 `Start-Process` 创建新进程，不受已有实例的转发影响。
 * 所以端口被占时拒绝的是「占用者可能是人的浏览器」，不是「启动会失败」。
 */
export function decideReusePolicy(input: ReuseDecisionInput): ChromeReusePolicy {
  if (
    input.discoveredProfileDir !== undefined &&
    isSameProfileDir(input.expectedProfileDir, input.discoveredProfileDir)
  ) {
    return 'reuse'
  }
  return input.background ? 'reject' : 'launch'
}

/**
 * 拒绝对 `\\wsl.localhost\...` 启动 Chrome。
 *
 * 实测（2026-11-26，Chrome 158）：Profile 目录落在 9p 上时，LevelDB 打不开锁，
 * 日志报 `ChromeMethodBFE: 15::LockFile::1`。后果有三条：
 * Local Storage 写不进磁盘（登录态每次丢）、Cookies 库 0 字节、
 * 每次启动弹「打开您的个人资料时出了点问题」。
 *
 * 在启动前拦住，比让人对着一个「能连上但每次都要求重新登录」的浏览器排查便宜得多。
 */
export function assertLaunchableProfileDir(profileDir: string): void {
  const normalized = profileDir.toLowerCase()
  const uncPrefixes = ['\\\\wsl$\\', '\\\\wsl.localhost\\']
  if (uncPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new ConfigError(
      `Chrome 的 user-data-dir 不能落在 WSL 网络路径上：${profileDir}。\n` +
        'Chrome 在该路径上无法给 LevelDB 加锁，登录态写不进磁盘，每次启动都会弹「个人资料错误」。\n' +
        '请改用 Windows 本地路径，例如 C:\\Users\\<你>\\AppData\\Local\\deploydeck\\chrome-profile。\n' +
        '可用 DEPLOYDECK_CHROME_PROFILE_DIR 指定。',
    )
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
