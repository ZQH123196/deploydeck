import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigError } from '../../src/errors.js'

/**
 * 真机测试的 Chrome profile 副本。
 *
 * 判据（用户需求）：e2e 用同一个 profile 的数据（登录态等），但要新起一个后台 Chrome，
 * 不碰人正在用的那个浏览器。
 *
 * Chrome 在同一个 user-data-dir 内只跑一个实例：再启动的进程会把参数转发给已有实例。
 * 所以要真正新起进程，只能换目录。用同一份数据、换目录 = 复制一份。
 *
 * 复制方向永远是「主 profile → 副本」，一次单向。测试绝不写主 profile：
 * 同步回去会把测试产生的浏览器状态混进人日常使用的登录态与会话里。
 */

/**
 * profile 顶层需要复制的条目：登录态与浏览器身份都在这里。
 *
 * `Local State` 里有加密用的密钥与账号信息，缺它 Cookies 解不开；
 * `First Run` 让新目录不必走首次运行流程。
 */
const KEPT_TOP_LEVEL: ReadonlySet<string> = new Set(['Local State', 'First Run'])

/**
 * `Default/` 下需要复制的条目。
 *
 * 判据：只取登录态直接依赖的库。AutoDL 的 token 在 `Local Storage` 里，
 * 会话在 `Cookies`，偏好与账号表单决定控制台能否直接进入。
 *
 * 刻意不取 `Web Applications`（已安装网页应用的图标等，实测 98 个文件 / 950 KB）
 * 与 `Storage`（各站点存储的其余分支，实测 50 个文件 / 1.7 MB）：两者都不影响 AutoDL 登录态，
 * 拿去只是拖慢每次运行。
 */
const KEPT_DEFAULT: ReadonlySet<string> = new Set([
  'Local Storage',
  'Session Storage',
  'Cookies',
  'Cookies-journal',
  'Login Data',
  'Login Data-journal',
  'Preferences',
  'Secure Preferences',
  'Web Data',
  'Web Data-journal',
])

/**
 * 白名单内部仍要跳过的目录名。
 *
 * 这几项挂在 `Local Storage`、`Storage` 之下，是缓存与旁路数据，与登录态无关。
 */
const SKIPPED_NESTED: ReadonlySet<string> = new Set(['Cache', 'Code Cache', 'Crashpad'])

/** Windows 上文件被占用时会短暂抛出这些码，重试一次即可。 */
const RETRYABLE_COPY_ERRORS: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES'])

/**
 * 把 Windows 路径翻译成 WSL 可访问的 `/mnt/<盘符>/...`。
 *
 * 判据：Node 在 WSL 里用 `fs` 打不开 `C:\...`（实测 `ENOENT`），只能走 `/mnt/c/...`。
 * 源目录来自配置，取值是 Windows 形式；副本目录是 WSL 本地路径，不受影响。
 */
export function toWslAccessiblePath(windowsPath: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(windowsPath)
  if (drive === null) {
    return windowsPath
  }
  const rest = windowsPath.slice(drive[0].length).replaceAll('\\', '/')
  return `/mnt/${(drive[1] ?? '').toLowerCase()}/${rest}`
}

export interface ProfileCopyResult {
  /** 副本目录。 */
  readonly destinationDir: string
  /** 复制的顶层条目数，用于日志与人工核对。 */
  readonly copiedEntries: number
  /** 跳过的顶层条目名。 */
  readonly skippedEntries: readonly string[]
}

/**
 * 把主 profile 复制到 `destinationDir`。
 *
 * 目标目录必须已经不存在或为空：存在非空目录时直接报错，不覆盖、不合并。
 * 合并会留下上一次运行的状态（例如上次的「Chrome 未正常退出」标记），让每次运行的起点不一致。
 */
export async function copyChromeProfile(
  sourceDirConfigValue: string,
  destinationDir: string,
): Promise<ProfileCopyResult> {
  // 配置给的是 Chrome 自己用的路径（Windows 形式），本机 fs 要的是能打开的路径。
  const sourceDir = toWslAccessiblePath(sourceDirConfigValue)
  if (fsNormalize(sourceDir) === fsNormalize(destinationDir)) {
    throw new ConfigError(
      `profile 副本目录不能与主 profile 相同：${sourceDir}。` +
        '测试若共用同一个目录，新起的 Chrome 会被转发到人正在用的那个实例。',
    )
  }

  const sourceStat = await stat(sourceDir).catch(() => undefined)
  if (sourceStat === undefined || !sourceStat.isDirectory()) {
    throw new ConfigError(
      `主 profile 目录不存在：${sourceDir}。\n` +
        '先运行一次 deploydeck（或 deploydeck 的任意需要浏览器的命令）让它创建主 profile，并完成登录。',
    )
  }

  await assertEmptyOrAbsent(destinationDir)
  await mkdir(destinationDir, { recursive: true })

  const entries = await readdir(sourceDir, { withFileTypes: true })
  const skipped: string[] = []
  let copied = 0
  for (const entry of entries) {
    if (!KEPT_TOP_LEVEL.has(entry.name)) {
      skipped.push(entry.name)
      continue
    }
    await copyEntry(join(sourceDir, entry.name), join(destinationDir, entry.name), entry.isDirectory())
    copied += 1
  }

  const defaultDir = join(sourceDir, 'Default')
  const defaultEntries = await readdir(defaultDir, { withFileTypes: true }).catch(() => undefined)
  if (defaultEntries === undefined) {
    // 没有 Default 就没有登录态：与其复制一份空的，不如让人先登录一次。
    throw new ConfigError(
      `主 profile 里没有 Default 目录：${defaultDir}。\n` +
        '它不存在说明这个 profile 从没登录过。先用 deploydeck 的任意需要浏览器的命令登录一次。',
    )
  }
  await mkdir(join(destinationDir, 'Default'), { recursive: true })
  for (const entry of defaultEntries) {
    if (!KEPT_DEFAULT.has(entry.name)) {
      continue
    }
    await copyEntry(
      join(defaultDir, entry.name),
      join(destinationDir, 'Default', entry.name),
      entry.isDirectory(),
    )
    copied += 1
  }

  return { destinationDir, copiedEntries: copied, skippedEntries: skipped }
}

/**
 * 复制一个条目：文件直接拷贝，目录递归并按 `SKIPPED_NESTED` 过滤。
 *
 * 为什么不用 `fs.cp` 递归整棵目录：`fs.cp` 会连 Cache、模型文件一起搬。
 * 实测整份 profile 250 MB、复制 7 到 12 秒；只取登录态必要文件约 300 KB、200 毫秒。
 */
async function copyEntry(sourcePath: string, destinationPath: string, isDirectory: boolean): Promise<void> {
  if (!isDirectory) {
    await copyFileWithRetry(sourcePath, destinationPath)
    return
  }
  await mkdir(destinationPath, { recursive: true })
  const children = await readdir(sourcePath, { withFileTypes: true })
  for (const child of children) {
    if (SKIPPED_NESTED.has(child.name)) {
      continue
    }
    await copyEntry(
      join(sourcePath, child.name),
      join(destinationPath, child.name),
      child.isDirectory(),
    )
  }
}

/** 拷贝单个文件。Windows 上浏览器可能正握着句柄，短暂 `EBUSY` 时重试一次。 */
async function copyFileWithRetry(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await cp(sourcePath, destinationPath)
  } catch (error: unknown) {
    const code = error instanceof Error ? (error as { code?: unknown }).code : undefined
    if (typeof code !== 'string' || !RETRYABLE_COPY_ERRORS.has(code)) {
      throw error
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
    await cp(sourcePath, destinationPath)
  }
}

/** 目标目录不存在、或存在但为空时放行；存在非空内容时报错。 */
async function assertEmptyOrAbsent(destinationDir: string): Promise<void> {
  const existing = await readdir(destinationDir).catch(() => undefined)
  if (existing === undefined) {
    return
  }
  if (existing.length > 0) {
    throw new ConfigError(
      `profile 副本目录已存在且非空：${destinationDir}。\n` +
        '不覆盖、不合并：合并会把上一次运行留下的浏览器状态混进本次。请换一个目录，或先清掉它。',
    )
  }
}

/** 删掉一个目录树。只用于删除本次运行自己创建的副本目录。 */
export async function removeProfileCopy(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** 本机路径统一成可比较形式：去掉尾部分隔符，不解析符号链接。 */
function fsNormalize(path: string): string {
  return path.trim().replace(/\/+$/, '')
}
