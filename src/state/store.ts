import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve as resolveAbsolute,
} from 'node:path'
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { z } from 'zod'
import {
  ConfigError,
  StateFileInvalidError,
  StateFileMissingError,
  StateLockTimeoutError,
} from '../errors.js'
import { beijingNowIso } from '../util/time.js'
import { assertPositiveInteger, isErrnoCode, isInsideOrEqual } from '../util/validate.js'
import type { StateStore } from './ports.js'

/** 锁文件相对状态目录的落点。锁是短生命周期产物，正常释放后即消失。 */
const LOCKS_DIRECTORY_NAME = 'locks'
const LOCK_FILE_SUFFIX = '.lock'
/** 临时文件的随机后缀。写完后改名覆盖目标文件。 */
const TEMPORARY_FILE_SUFFIX = '.tmp'

/** 锁文件里的持有者信息。只用于超时诊断，锁的有效性不依赖它。 */
const LockHolderSchema = z.object({
  pid: z.number().int().positive(),
  acquiredAt: z.string().min(1),
})

export interface StateStoreOptions {
  /** 状态目录。机器写。 */
  readonly stateDir: string
  /** 配置目录。人写，机器只读。 */
  readonly configDir: string
  /**
   * 取锁的总等待上限，毫秒。
   *
   * 必须显式给出：不同命令对锁竞争的容忍度不同（守护进程可等几十秒，CLI 不该让用户干等），
   * 猜一个默认值等于替调用方做决定。
   */
  readonly lockTimeoutMs: number
  /**
   * 取锁失败后的重试间隔，毫秒。
   *
   * 同样显式给出：它决定竞争时的轮询频率，属于并发参数，缺声明即拒绝构造。
   */
  readonly lockRetryIntervalMs: number
  /** 注入时钟。测试用。默认取真实时钟。 */
  readonly now?: () => number
  /** 注入等待。测试用。默认真实定时器。 */
  readonly sleep?: (milliseconds: number) => Promise<void>
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

/**
 * 创建状态存储。
 *
 * 并发约定：单次 `writeJson` / `appendJsonLine` 自身不会产生半个文件，
 * 多步读改写必须由调用方用 `withLock` 包住。哪些动作需要同一把锁由业务决定，
 * 存储层不替调用方猜锁名。
 */
export function createStateStore(options: StateStoreOptions): StateStore {
  const root = resolveAbsolute(requireNonEmpty(options.stateDir, 'stateDir'))
  const configRoot = resolveAbsolute(requireNonEmpty(options.configDir, 'configDir'))
  assertPositiveInteger(options.lockTimeoutMs, 'lockTimeoutMs')
  assertPositiveInteger(options.lockRetryIntervalMs, 'lockRetryIntervalMs')
  assertOutsideConfigDirectory(root, configRoot)

  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const lockTimeoutMs = options.lockTimeoutMs
  const lockRetryIntervalMs = options.lockRetryIntervalMs

  async function resolveStatePath(relativePath: string, createParents: boolean): Promise<string> {
    const absolutePath = resolveInsideRoot(root, relativePath)
    // 读也走这里：resolve 会创建父目录，本身就带写副作用；状态存储不碰配置目录。
    assertOutsideConfigDirectory(absolutePath, configRoot)
    if (createParents) {
      await mkdir(dirname(absolutePath), { recursive: true })
    }
    return absolutePath
  }

  async function readTextOrThrow(absolutePath: string, relativePath: string): Promise<string> {
    try {
      return await readFile(absolutePath, 'utf8')
    } catch (error: unknown) {
      if (isErrnoCode(error, 'ENOENT')) {
        throw new StateFileMissingError(relativePath, absolutePath)
      }
      throw error
    }
  }

  function resolveLockPath(name: string): string {
    assertLockName(name)
    const lockPath = join(root, LOCKS_DIRECTORY_NAME, `${name}${LOCK_FILE_SUFFIX}`)
    assertOutsideConfigDirectory(lockPath, configRoot)
    return lockPath
  }

  async function tryCreateLockFile(lockPath: string): Promise<boolean> {
    const holder = JSON.stringify({ pid: process.pid, acquiredAt: beijingNowIso() })
    try {
      // flag 'wx' = O_CREAT | O_EXCL：创建与占用是同一个原子动作，两个进程只有一个能成功。
      await writeFile(lockPath, `${holder}\n`, { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error: unknown) {
      if (isErrnoCode(error, 'EEXIST')) {
        return false
      }
      throw error
    }
  }

  async function releaseLock(lockPath: string): Promise<void> {
    try {
      await unlink(lockPath)
    } catch (error: unknown) {
      // 锁文件被人手工删掉时释放即已完成，不算失败。
      if (!isErrnoCode(error, 'ENOENT')) {
        throw error
      }
    }
  }

  async function describeLockHolder(lockPath: string): Promise<string> {
    try {
      const text = await readFile(lockPath, 'utf8')
      const holder = LockHolderSchema.safeParse(JSON.parse(text))
      if (holder.success) {
        return `持有者进程 ${holder.data.pid}，取得于 ${holder.data.acquiredAt}。`
      }
    } catch {
      // 诊断信息读不到不影响报错本身。
    }
    return '持有者信息不可读。'
  }

  async function acquireLock(lockPath: string, name: string): Promise<void> {
    const deadline = now() + lockTimeoutMs
    for (;;) {
      if (await tryCreateLockFile(lockPath)) {
        return
      }
      if (now() >= deadline) {
        const holder = await describeLockHolder(lockPath)
        throw new StateLockTimeoutError(
          `取锁超时：锁「${name}」被占用超过 ${lockTimeoutMs}ms（锁文件 ${lockPath}）。${holder}` +
            '若确认没有其他 deploydeck 进程在运行，删除该锁文件后重试。',
        )
      }
      await sleep(lockRetryIntervalMs)
    }
  }

  async function withLock<Result>(name: string, action: () => Promise<Result>): Promise<Result> {
    const lockPath = resolveLockPath(name)
    await mkdir(dirname(lockPath), { recursive: true })
    await acquireLock(lockPath, name)

    let result: Result
    try {
      result = await action()
    } catch (actionError: unknown) {
      try {
        await releaseLock(lockPath)
      } catch (releaseError: unknown) {
        // 两个失败都要留证：动作失败的原因不能被释放失败吞掉。
        throw new AggregateError([actionError, releaseError], `锁未能释放，且锁内动作失败：${name}`)
      }
      throw actionError
    }
    await releaseLock(lockPath)
    return result
  }

  async function writeJson(relativePath: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value, undefined, 2)
    if (serialized === undefined) {
      throw new TypeError(`值无法序列化为 JSON：${relativePath}`)
    }
    const absolutePath = await resolveStatePath(relativePath, true)
    await writeFileAtomically(absolutePath, `${serialized}\n`)
  }

  async function readJson<Value>(relativePath: string, schema: z.ZodType<Value>): Promise<Value> {
    const absolutePath = await resolveStatePath(relativePath, false)
    const text = await readTextOrThrow(absolutePath, relativePath)
    const parseErrors: ParseError[] = []
    // 读侧容忍人工注释：人可以为审查加注释，机器重写时再丢掉。
    const raw: unknown = parseJsonc(text, parseErrors, { allowTrailingComma: true })
    if (parseErrors.length > 0) {
      const details = parseErrors
        .map((parseError) => `偏移 ${parseError.offset}：${printParseErrorCode(parseError.error)}`)
        .join('；')
      throw new StateFileInvalidError(`状态文件不是合法 JSONC：${relativePath}（${details}）`)
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw new StateFileInvalidError(
        `状态文件不符合 schema：${relativePath}。${z.prettifyError(parsed.error)}`,
        { cause: parsed.error },
      )
    }
    return parsed.data
  }

  async function appendJsonLine(relativePath: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new TypeError(`值无法序列化为 JSON：${relativePath}`)
    }
    const absolutePath = await resolveStatePath(relativePath, true)
    // O_APPEND：写入位置由内核定位到文件末尾，并发追加不会互相覆盖。
    const handle = await open(absolutePath, 'a')
    try {
      await handle.writeFile(`${serialized}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async function readJsonLines<Value>(
    relativePath: string,
    schema: z.ZodType<Value>,
  ): Promise<readonly Value[]> {
    const absolutePath = await resolveStatePath(relativePath, false)
    const text = await readTextOrThrow(absolutePath, relativePath)
    const lines = text.split('\n')
    const values: Value[] = []
    for (let index = 0; index < lines.length; index += 1) {
      const line = (lines[index] ?? '').trim()
      if (line.length === 0) {
        continue
      }
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch (error: unknown) {
        throw new StateFileInvalidError(
          `状态文件第 ${index + 1} 行不是合法 JSON：${relativePath}`,
          { cause: error },
        )
      }
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        throw new StateFileInvalidError(
          `状态文件第 ${index + 1} 行不符合 schema：${relativePath}。${z.prettifyError(parsed.error)}`,
          { cause: parsed.error },
        )
      }
      values.push(parsed.data)
    }
    return values
  }

  return {
    root,
    resolve: (relativePath) => resolveStatePath(relativePath, true),
    writeJson,
    readJson,
    appendJsonLine,
    readJsonLines,
    withLock,
  }
}

function requireNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new ConfigError(`${name} 不能为空。`)
  }
  return value
}

/**
 * 状态目录不得落在配置目录内。
 *
 * 落在配置目录内意味着每一次状态写入都是写配置目录，而配置目录由人写、机器只读。
 */
function assertOutsideConfigDirectory(stateDir: string, configDir: string): void {
  if (isInsideOrEqual(configDir, stateDir)) {
    throw new ConfigError(
      `状态目录不能位于配置目录内：状态目录 ${stateDir}，配置目录 ${configDir}。` +
        '配置目录由人写，机器只读。',
    )
  }
}

/** 把相对路径解析成状态目录内的绝对路径。越界即抛错，不做猜测。 */
function resolveInsideRoot(root: string, relativePath: string): string {
  if (relativePath.length === 0) {
    throw new ConfigError('状态路径不能为空。')
  }
  if (relativePath.includes('\0')) {
    throw new ConfigError(`状态路径不能包含空字符：${JSON.stringify(relativePath)}`)
  }
  if (relativePath.includes('\\')) {
    throw new ConfigError(`状态路径一律用 / 分隔，不得使用反斜杠：${relativePath}`)
  }
  if (isAbsolute(relativePath)) {
    throw new ConfigError(`状态路径必须是相对路径，收到的却是绝对路径：${relativePath}`)
  }
  const segments = relativePath.split('/')
  if (segments.includes('..')) {
    throw new ConfigError(
      `状态路径不得包含 ..：${relativePath}。状态存储只接受状态目录内的相对路径。`,
    )
  }
  const normalized = normalize(relativePath)
  if (normalized === '.' || normalized === '') {
    throw new ConfigError(`状态路径必须指向文件或子目录，不能是状态目录本身：${relativePath}`)
  }
  const absolutePath = resolveAbsolute(root, normalized)
  if (!isInsideOrEqual(root, absolutePath)) {
    throw new ConfigError(`状态路径越出状态目录：${relativePath}（状态目录 ${root}）`)
  }
  return absolutePath
}

function assertLockName(name: string): void {
  if (name.length === 0) {
    throw new ConfigError('锁名不能为空。')
  }
  const isSingleSegment = !name.includes('/') && !name.includes('\\') && !name.includes('\0')
  if (!isSingleSegment || name === '.' || name === '..') {
    throw new ConfigError(
      `锁名必须是单段文件名，不能包含路径分隔符或 ..：${name}。需要按对象区分时用 plan-<id> 这类形状。`,
    )
  }
}

/**
 * 原子写：同目录临时文件 → fsync 文件 → 改名 → 尽力 fsync 目录。
 *
 * 判据是并发读不会读到半个文件：改名是原子的，读者要么看到旧文件，要么看到新文件。
 */
async function writeFileAtomically(absolutePath: string, content: string): Promise<void> {
  const directoryPath = dirname(absolutePath)
  const temporaryPath = join(
    directoryPath,
    `.${basename(absolutePath)}.${randomUUID()}${TEMPORARY_FILE_SUFFIX}`,
  )

  const handle = await open(temporaryPath, 'wx')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (error: unknown) {
    await handle.close()
    await rm(temporaryPath, { force: true })
    throw error
  }
  await handle.close()

  try {
    await rename(temporaryPath, absolutePath)
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true })
    throw error
  }
  await syncDirectory(directoryPath)
}

/**
 * 尽力 fsync 目录，让改名本身也落盘。
 *
 * 部分平台（Windows、部分文件系统）不支持对目录 fsync。失败不影响改名的原子性，
 * 只影响掉电后的持久性，所以这里不抛错。
 */
async function syncDirectory(directoryPath: string): Promise<void> {
  try {
    const handle = await open(directoryPath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // 见上：目录 fsync 是尽力而为。
  }
}
