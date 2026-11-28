import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ConfigError } from '../errors.js'

const execFileAsync = promisify(execFile)

/**
 * 配置读取的唯一入口。
 *
 * 判据（AGENTS.md 代码规范）：配置读取只有一个入口，禁止在别处直接读环境变量。
 * 需要新增配置项时先在这里加一个 `resolve*` 函数，再由装配方注入给使用者。
 */

/** 控制面 CDP 端口的默认值。取自 spec 第 6.1 节。 */
const DEFAULT_CDP_PORT = 9222

/**
 * 进程环境变量快照。
 *
 * 装配方需要一份可复用的 env 时从这里取：`process.env` 的读取只允许发生在本文件内。
 */
export function readProcessEnv(): NodeJS.ProcessEnv {
  return process.env
}

/** 配置目录。存放 profiles。 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DEPLOYDECK_CONFIG_DIR'] ?? ''
  return override.length > 0 ? override : join(homedir(), '.config', 'deploydeck')
}

/** 状态目录。存放计划、运行记录、账本、日志。 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DEPLOYDECK_STATE_DIR'] ?? ''
  return override.length > 0 ? override : join(homedir(), '.local', 'state', 'deploydeck')
}

export function resolveProfilesDir(configDir: string): string {
  return join(configDir, 'profiles')
}

/** 项目清单目录。存放 projects。人写，机器只读。 */
export function resolveProjectsDir(configDir: string): string {
  return join(configDir, 'projects')
}

/**
 * SSH 主机密钥指纹文件。落在状态目录，由 SSH 通道读写。
 *
 * 不放配置目录：配置目录由人写、机器只读。
 * 格式与手工删行的做法见 docs/state-layout.md 与 src/ssh/known-hosts.ts。
 */
export function resolveKnownHostsPath(stateDir: string): string {
  return join(stateDir, 'ssh-known-hosts.txt')
}

/**
 * 控制面 CDP 端口。
 *
 * 端口非法即抛错：端口被别的程序占住与端口配错，表现都是连不上，
 * 猜一个默认值只会让人查错方向。
 */
export function resolveCdpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['DEPLOYDECK_CDP_PORT'] ?? ''
  if (raw.length === 0) {
    return DEFAULT_CDP_PORT
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`DEPLOYDECK_CDP_PORT 必须是整数端口号，当前值：${raw}`)
  }
  const port = Number(raw)
  if (port < 1 || port > 65535) {
    throw new ConfigError(`DEPLOYDECK_CDP_PORT 超出 1-65535 范围，当前值：${raw}`)
  }
  return port
}

/**
 * 专用 Chrome 的 user-data-dir。
 *
 * 必须与日常浏览的 profile 分开：控制台登录态保存在这里，日常 profile 的扩展与设置不应干扰控制面。
 *
 * 默认落状态目录，不落配置目录：机器会往这个目录写文件（登录态、缓存、锁），
 * 而配置目录由人写、机器只读。见 docs/state-layout.md 第 6 节。
 *
 * 该函数只负责「部署方自己的状态目录在哪」。WSL 调 Windows Chrome 时，
 * 这个路径不能直接交给 Chrome：见 `resolveChromeProfileDirForChrome`。
 */
export function resolveChromeProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DEPLOYDECK_CHROME_PROFILE_DIR'] ?? ''
  return override.length > 0 ? override : join(resolveStateDir(env), 'chrome-profile')
}

/**
 * 传给 Chrome 的 `--user-data-dir`。纯函数：外部给定的 Windows 根目录由调用方探测后传入。
 *
 * 跨 WSL 边界时必须落 Windows 本地磁盘，不能落 `\\wsl.localhost\...`。
 * 实测（2026-11-26）：Chrome 在 9p 上无法完成 LevelDB 的 LockFile 加锁，
 * Local Storage、Cookies 等库全部 0 字节，登录态写不进磁盘，且每次启动弹「个人资料错误」。
 * AutoDL 的登录态就是 Local Storage 里的 `token` 与 `user` 键，落不了盘等于每次都要重新登录。
 *
 * 判据：显式覆盖值原样使用；WSL 下拿到 Windows 根目录时落 Windows 本地目录；其余情况用状态目录。
 */
export function resolveChromeProfileDirForChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  windowsRoot: string | undefined = readWindowsProfileRoot(env),
): string {
  const override = env['DEPLOYDECK_CHROME_PROFILE_DIR'] ?? ''
  if (override.length > 0) {
    return override
  }
  if (platform === 'linux' && windowsRoot !== undefined) {
    return `${windowsRoot}\\deploydeck\\${MAIN_CHROME_PROFILE_LEAF}`
  }
  return join(resolveStateDir(env), MAIN_CHROME_PROFILE_LEAF)
}

/**
 * 主 profile 的叶子目录名。
 *
 * 缺省取值由它派生；显式覆盖 `DEPLOYDECK_CHROME_PROFILE_DIR` 时不看它。
 */
const MAIN_CHROME_PROFILE_LEAF = 'chrome-profile'

/**
 * 真机测试进程的开关。
 *
 * 只认 `DEPLOYDECK_E2E=1`：该变量同时是 `e2e/support/gate.ts` 的授权开关。
 * 用它回答「这个进程是不是 e2e 测试进程」，不另写一份字面量。
 */
export function isE2eProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['DEPLOYDECK_E2E'] ?? '').trim() === '1'
}

/**
 * 真机测试 profile 副本的 Windows 落点。
 *
 * 判据：副本必须落 Windows 本地磁盘。Chrome 在 `\\wsl.localhost\\...` 上无法给 LevelDB 加锁，
 * 登录态写不进磁盘（见 `assertLaunchableProfileDir`），副本放 WSL 文件系统就等于每次都要重新登录。
 *
 * 跑完即删，所以放 Windows 临时目录：`%LOCALAPPDATA%\Temp\deploydeck-e2e\<运行标识>`。
 * 找不到 Windows 临时目录时返回 undefined，由调用方决定拒绝运行。
 */
export function resolveWindowsTempChromeProfileDir(
  windowsRoot: string | undefined,
  runStamp: string,
): string | undefined {
  if (windowsRoot === undefined || windowsRoot.trim().length === 0) {
    return undefined
  }
  return `${windowsRoot}\\Temp\\deploydeck-e2e\\${runStamp}\\chrome-profile`
}

/**
 * 后台启动开关。默认 false，即窗口像人平时一样出现在桌面上。
 *
 * 真机测试必须置 true：测试跑起来时人可能正在用同一个 Chrome 窗口做别的事，
 * 不能把测试的窗口抢到前台。
 */
export function resolveChromeBackgroundLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env['DEPLOYDECK_CHROME_LAUNCH_BACKGROUND'] ?? '').trim()
  if (raw.length === 0) {
    return false
  }
  if (raw !== '1' && raw !== '0') {
    throw new ConfigError(`DEPLOYDECK_CHROME_LAUNCH_BACKGROUND 只接受 1 或 0，当前值：${raw}`)
  }
  return raw === '1'
}

/**
 * 从 WSL 向 Windows 询问 profile 根目录，取值是 `%LOCALAPPDATA%`。
 *
 * WSL 默认不把 Windows 环境变量注入 Linux 进程，`process.env.LOCALAPPDATA` 恒为空。
 * 只能主动问一次 `cmd.exe`。问不到返回 undefined，由调用方回退状态目录。
 *
 * 不落 `%TEMP%`：临时目录会被系统清理，登录态随之丢失。
 */
export async function probeWindowsProfileRoot(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const override = (env['DEPLOYDECK_WINDOWS_PROFILE_ROOT'] ?? '').trim()
  if (override.length > 0) {
    return override
  }
  try {
    const { stdout } = await execFileAsync('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'], {
      timeout: 5_000,
    })
    const value = stdout.replace(/\r/g, '').trim()
    return value.length > 0 && value.includes('\\') ? value : undefined
  } catch {
    // 探测失败是「拿不到 Windows 目录」这一事实，不是异常：由调用方回退到状态目录。
    return undefined
  }
}

/** 读 Windows 侧 profile 根目录。优先显式覆盖，其次进程环境里的 `%LOCALAPPDATA%`。 */
function readWindowsProfileRoot(env: NodeJS.ProcessEnv): string | undefined {
  const override = (env['DEPLOYDECK_WINDOWS_PROFILE_ROOT'] ?? '').trim()
  if (override.length > 0) {
    return override
  }
  const localAppData = (env['LOCALAPPDATA'] ?? '').trim()
  if (localAppData.length > 0) {
    return localAppData
  }
  return undefined
}

/**
 * 专用 Chrome 可执行文件的覆盖值。
 *
 * 空串表示没有覆盖，由 `src/console/chrome.ts` 按平台候选表查找。
 * 这里只取值，不校验文件存在：存在性检查需要文件系统，属 chrome.ts 的职责。
 */
export function resolveChromeExecutableOverride(env: NodeJS.ProcessEnv = process.env): string {
  return env['DEPLOYDECK_CHROME_EXECUTABLE'] ?? ''
}

/**
 * WSL 分发名。WSL 会注入该变量，缺失时为空串。
 *
 * WSL 判定还需要看内核版本串，那部分留在 `src/console/chrome.ts`：
 * 它不是配置，是运行环境事实。
 */
export function resolveWslDistroName(env: NodeJS.ProcessEnv = process.env): string {
  return env['WSL_DISTRO_NAME'] ?? ''
}

/**
 * 守护进程的余额告警阈值，单位元。
 *
 * 不设默认值：工程里没有任何来源规定「余额低于多少该告警」。猜一个数会让告警线
 * 看起来像经过论证的结论。没有配置时直接抛 `ConfigError`，由人显式给出。
 * 只有 `deploydeck guard` 需要它，其他命令不读。
 */
export function resolveBalanceWarnBelowYuan(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['DEPLOYDECK_BALANCE_WARN_BELOW_YUAN'] ?? ''
  if (raw.trim().length === 0) {
    throw new ConfigError(
      '缺少余额告警阈值：请配置环境变量 DEPLOYDECK_BALANCE_WARN_BELOW_YUAN（单位：元，非负数字）。' +
        '守护进程需要它判断何时告警，不猜默认值。',
    )
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(
      `DEPLOYDECK_BALANCE_WARN_BELOW_YUAN 必须是非负数字（单位：元），当前值：${raw}`,
    )
  }
  return value
}

/**
 * 从本机环境读出 Profile 声明的变量取值。
 *
 * 判据（AGENTS.md 代码规范 · 唯一来源）：环境变量只在 `src/config/paths.ts` 读，
 * Profile 里的 `env` / `bootstrapEnv` 只写变量名，值在这里一次性解析。
 *
 * 缺变量即抛 `ConfigError`，一次报完全部缺失项：
 * 落空会让远端脚本读到空串，表现为认证失败这类与配置无关的报错，人查不到根因。
 * 空串同样算缺失：`export K=` 与没配 `K` 在脚本里无从区分，不把它当「有值」。
 *
 * 返回的键是 Profile 里的键（即本机变量名），值只允许进远端进程环境，
 * 不得进命令字符串、执行记录或日志。
 */
export function resolveDeclaredEnv(
  declared: Readonly<Record<string, string>>,
  description: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const missing: string[] = []
  const resolved: Record<string, string> = {}
  for (const name of Object.keys(declared)) {
    const value = env[name]
    if (value === undefined || value.length === 0) {
      missing.push(name)
      continue
    }
    resolved[name] = value
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `${description} 声明的环境变量在本机不存在（或为空）：${missing.join('、')}。` +
        '这些取值只从本机环境读取，不会从配置文件读。' +
        '先在本机设置它们，或从配置里删掉对应的声明。',
    )
  }
  return resolved
}
