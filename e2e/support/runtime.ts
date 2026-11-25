import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { openAutodlProvider } from '../../src/providers/autodl/runtime.js'
import { CONSOLE_INSTANCE_LIST_URL } from '../../src/console/selectors.js'
import type { Provider } from '../../src/providers/provider.js'

/**
 * 真机测试的运行时装配。
 *
 * 配置目录、状态目录、日志目录全部落在本仓 `.tmp/e2e/<时间戳>/` 下，
 * 与人工使用的 `~/.config/deploydeck`、`~/.local/state/deploydeck` 完全隔离：
 * 真机测试不该把测试计划、账本、截图混进人的状态目录。
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
  readonly workDir: E2eWorkDir
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
 * 打开真机 provider。
 *
 * 未登录时 `openAutodlProvider` 抛 `LoginRequiredError`（退出码 2），这里原样上抛：
 * 真机测试不做登录自动化，登录态由人提前在专用 Chrome 里准备好。
 */
export async function openE2eRuntime(workDir: E2eWorkDir, cdpPort: number): Promise<E2eRuntime> {
  const runtime = await openAutodlProvider({
    consoleUrl: CONSOLE_INSTANCE_LIST_URL,
    cdpPort,
    chromeProfileDir: join(workDir.stateDir, 'chrome-profile'),
    knownHostsPath: join(workDir.stateDir, 'ssh-known-hosts.txt'),
    logDir: workDir.logDir,
    stateDir: workDir.stateDir,
    configDir: workDir.configDir,
    timeoutMs: 120_000,
    pollIntervalMs: 2_000,
  })
  return {
    provider: runtime.provider,
    workDir,
    close: async () => {
      await runtime.close()
    },
  }
}
