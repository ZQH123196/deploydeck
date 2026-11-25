import type { z } from 'zod'

/**
 * 状态存储端口。
 *
 * 配置目录由人写、机器只读；状态目录由机器写。两者不混。
 * 判据见 spec 第 11 节：原子写 + 锁文件 + 账本只追加。
 */
export interface StateStore {
  /** 状态目录绝对路径。 */
  readonly root: string

  /**
   * 相对路径 → 绝对路径。父目录不存在时创建。
   *
   * 路径必须落在状态目录内。越界即抛错。
   */
  resolve(relativePath: string): Promise<string>

  /** 原子写 JSON。先写临时文件再改名。 */
  writeJson(relativePath: string, value: unknown): Promise<void>

  /** 读 JSON 并按 schema 校验。文件不存在即抛错。 */
  readJson<Value>(relativePath: string, schema: z.ZodType<Value>): Promise<Value>

  /** 追加一行 JSONL。只追加，不重写。 */
  appendJsonLine(relativePath: string, value: unknown): Promise<void>

  /** 读全部 JSONL 行。文件不存在即抛错。 */
  readJsonLines<Value>(relativePath: string, schema: z.ZodType<Value>): Promise<readonly Value[]>

  /**
   * 独占锁。拿不到即等待，等到超时抛错。
   *
   * CLI 与守护进程会同时写状态目录，所有写动作必须在锁内完成。
   */
  withLock<Result>(name: string, action: () => Promise<Result>): Promise<Result>
}
