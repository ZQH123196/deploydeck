import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConfigError } from '../errors.js'

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
 */
export function resolveChromeProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DEPLOYDECK_CHROME_PROFILE_DIR'] ?? ''
  return override.length > 0 ? override : join(resolveStateDir(env), 'chrome-profile')
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
