import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openAutodlProvider } from '../../src/providers/autodl/runtime.js'
import { CONSOLE_INSTANCE_LIST_URL } from '../../src/console/selectors.js'
import { closeChrome } from '../../src/console/chrome.js'
import {
  probeWindowsProfileRoot,
  resolveChromeProfileDirForChrome,
  resolveWindowsTempChromeProfileDir,
} from '../../src/config/paths.js'
import type { Provider } from '../../src/providers/provider.js'
import type { SshShellPort } from '../../src/ssh/ports.js'
import {
  copyChromeProfile,
  removeProfileCopy,
  toWslAccessiblePath,
  type ProfileCopyResult,
} from './profile-copy.js'

/**
 * 真机测试的运行时装配。
 *
 * 配置目录、状态目录、日志目录全部落在本仓 `.tmp/e2e/<时间戳>/` 下，
 * 与人工使用的 `~/.config/deploydeck`、`~/.local/state/deploydeck` 完全隔离：
 * 真机测试不该把测试计划、账本、截图混进人的状态目录。
 *
 * 浏览器：用主 profile 的副本（登录态与主 profile 一致），副本落在本次运行的临时目录，
 * 后台最小化启动。人的 Chrome 进程与窗口全程不被触碰。
 */

/** 真机测试的工作目录。每次运行一个时间戳子目录，便于事后回查。 */
export interface E2eWorkDir {
  readonly root: string
  readonly configDir: string
  readonly stateDir: string
  readonly logDir: string
}

export interface E2eRuntime {
  readonly provider: Provider
  /** 交互式终端端口。只有终端用例用它。 */
  readonly shell: SshShellPort
  readonly workDir: E2eWorkDir
  /** 本次使用的 profile 副本信息。报告里要能看出用了哪份数据。 */
  readonly profileCopy: ProfileCopyResult
  /** 本次使用的 CDP 端口。收尾关闭浏览器时用它定位。 */
  readonly cdpPort: number
  /** 本次是否由测试自己启动了浏览器。只有这种情况收尾才会关掉它。 */
  readonly browserLaunchedByTest: boolean
  close(): Promise<void>
}

/** 建立本次运行的工作目录。不清理同名旧目录：现场要能回查。 */
export async function createE2eWorkDir(
  cdpPort: number,
  now: Date = new Date(),
  baseDir: string = join(process.cwd(), '.tmp', 'e2e'),
): Promise<E2eWorkDir> {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const root = join(baseDir, stamp)
  const configDir = join(root, 'config')
  const stateDir = join(root, 'state')
  const logDir = join(root, 'logs')
  await mkdir(configDir, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await mkdir(logDir, { recursive: true })
  void cdpPort
  return { root, configDir, stateDir, logDir }
}

/**
 * 本次运行里 profile 副本的落点。
 *
 * 返回两种表示：`chromeProfileDir` 是交给 Chrome 的 Windows 路径，
 * `localDir` 是本进程用来复制、删除的路径（WSL 里是 `/mnt/c/...`）。
 */
export interface E2eProfileCopyLocation {
  readonly chromeProfileDir: string
  readonly localDir: string
}

/**
 * 副本落在 Windows 临时目录，不在工作目录下。
 *
 * 工作目录在本仓 `.tmp/`（WSL 文件系统），Chrome 在 `\\wsl.localhost` 上给 LevelDB 加不了锁，
 * 登录态写不进磁盘。所以副本必须落 Windows 本地磁盘。跑完即删，不长期占空间。
 */
export function resolveE2eProfileCopyLocation(
  windowsRoot: string | undefined,
  runStamp: string,
): E2eProfileCopyLocation {
  const chromeProfileDir = resolveWindowsTempChromeProfileDir(windowsRoot, runStamp)
  if (chromeProfileDir === undefined) {
    throw new Error(
      '无法确定 Windows 临时目录（%LOCALAPPDATA%），真机测试的 profile 副本无处安放。\n' +
        'Chrome 的 user-data-dir 不能落 WSL 文件系统：那里的 LevelDB 加锁失败，登录态写不进磁盘。\n' +
        '可用 DEPLOYDECK_WINDOWS_PROFILE_ROOT 指定 Windows 本地目录。未启动任何浏览器。',
    )
  }
  return { chromeProfileDir, localDir: toWslAccessiblePath(chromeProfileDir) }
}

/**
 * 真机测试的平台判据：只支持 WSL 调 Windows Chrome。
 *
 * 判据用 `WSL_DISTRO_NAME` 与发行版名，不看 `/proc`：这个检查发生在任何浏览器动作之前，
 * 要求给出确定答案。判不准时拒绝运行，不降级成前台启动。
 */
export function assertE2eBrowserPlatform(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  const distroName = (env['WSL_DISTRO_NAME'] ?? '').trim()
  if (platform !== 'linux' || distroName.length === 0) {
    throw new Error(
      `真机测试要求后台启动 Windows Chrome，只在 WSL 下支持（当前平台：${platform}，` +
        `WSL_DISTRO_NAME：${distroName.length === 0 ? '未设置' : distroName}）。\n` +
        '未启动任何浏览器。请在 WSL 里运行，或先实现该平台的后台启动方式。',
    )
  }
}

/**
 * 准备本次运行用的 profile 副本：把主 profile 复制到工作目录下。
 *
 * 为什么必须是副本：Chrome 同一个 user-data-dir 只跑一个实例，再启动的进程会把参数转发给
 * 已有实例。共用主目录就等于操作人正在用的浏览器，这正是要避免的。
 * 复制是单向的：测试产出只留在副本里，不回写主 profile。
 */
export async function prepareE2eProfileCopy(
  workDir: E2eWorkDir,
): Promise<ProfileCopyResult> {
  const windowsRoot = await probeWindowsProfileRoot()
  const mainProfileDir = resolveChromeProfileDirForChrome(process.env, process.platform, windowsRoot)
  const location = resolveE2eProfileCopyLocation(windowsRoot, runStampOf(workDir))
  const result = await copyChromeProfile(mainProfileDir, location.localDir)
  // 复制模块只在结果里报本机路径；Chrome 需要的是 Windows 形式，统一到这里给出。
  return { ...result, destinationDir: location.chromeProfileDir }
}

/** 从工作目录名反推运行标识：两者同一次运行，标识必须一致。 */
function runStampOf(workDir: E2eWorkDir): string {
  const stamp = workDir.root.split(/[\\/]/).pop()
  if (stamp === undefined || stamp.length === 0) {
    throw new Error(`无法从工作目录取运行标识：${workDir.root}`)
  }
  return stamp
}

/**
 * 打开真机 provider。
 *
 * 未登录时 `openAutodlProvider` 抛 `LoginRequiredError`（退出码 2），这里原样上抛：
 * 真机测试不做登录自动化，登录态来自主 profile 的副本。
 *
 * 浏览器两条硬约束（都在这里钉死，不看环境变量）：
 *
 * 1. 用主 profile 的副本。共用主 profile 会被转发到人正在用的实例。
 * 2. 后台启动。窗口最小化、不抢前台，不打断人正在做的事。
 */
export async function openE2eRuntime(workDir: E2eWorkDir, cdpPort: number): Promise<E2eRuntime> {
  // 平台判据在装配期钉死：后台启动只覆盖 WSL 调 Windows Chrome。
  // 交给运行时探测的话，探测失败时后台标记仍为真，却用前台方式启动，会抢人的前台。
  assertE2eBrowserPlatform(process.platform, process.env)
  const profileCopy = await prepareE2eProfileCopy(workDir)
  const runtime = await openAutodlProvider({
    consoleUrl: CONSOLE_INSTANCE_LIST_URL,
    cdpPort,
    chromeProfileDir: profileCopy.destinationDir,
    backgroundLaunch: true,
    wsl: true,
    knownHostsPath: join(workDir.stateDir, 'ssh-known-hosts.txt'),
    logDir: workDir.logDir,
    stateDir: workDir.stateDir,
    configDir: workDir.configDir,
    timeoutMs: 120_000,
    pollIntervalMs: 2_000,
  })
  return {
    provider: runtime.provider,
    shell: runtime.shell,
    workDir,
    profileCopy,
    cdpPort,
    // 复用已有实例时它不是本次建的，收尾不能关：可能是别人正在用的浏览器。
    browserLaunchedByTest: runtime.session.chrome.launched,
    close: async () => {
      await runtime.close()
    },
  }
}

/**
 * 收尾：断开通道，再删掉 profile 副本。
 *
 * 副本里是登录态，只应留在本次运行的现场目录里，不该被下一次运行复用
 * （复用会带着上一次的浏览器状态，起点不一致）。删失败只报告，不吞掉。
 */
export async function closeE2eRuntime(runtime: E2eRuntime): Promise<string | undefined> {
  // 先关浏览器再删副本：Chrome 退出前占着 profile 里的锁文件，删除会因 EACCES 失败。
  const browserError = runtime.browserLaunchedByTest
    ? await closeChrome(`http://127.0.0.1:${String(runtime.cdpPort)}`)
    : undefined
  await runtime.close()
  if (browserError !== undefined) {
    return `关闭浏览器失败：${browserError}。profile 副本可能删不掉。`
  }
  try {
    await removeProfileCopy(toWslAccessiblePath(runtime.profileCopy.destinationDir))
    return undefined
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}
