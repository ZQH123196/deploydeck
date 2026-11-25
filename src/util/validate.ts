import { isAbsolute, relative, resolve } from 'node:path'
import { ConfigError } from '../errors.js'

/**
 * 共享的入参校验。这些判据原先在多个文件各写一份，改一处漏一处，
 * 统一收在这里：一个事实只有一个来源（AGENTS.md 代码规范）。
 */

/**
 * 路径落在目录内或等于该目录。
 *
 * 比较前先归一，避免 `a/../b` 这类写法绕过。
 * 用于「状态文件必须在状态目录内」「provider 证据必须在 run 目录内」这类装配自检。
 */
export function isInsideOrEqual(directory: string, candidate: string): boolean {
  const relativePath = relative(resolve(directory), resolve(candidate))
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

/**
 * 正整数参数校验。非法即抛 `ConfigError`。
 *
 * 并发、超时、轮询间隔这类参数必须显式声明；缺声明或写错即启动失败，不猜默认值。
 */
export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${label} 必须是正整数，当前值：${String(value)}。`)
  }
}

/**
 * 判断错误对象是否带某个 errno 码。
 *
 * 只用于把 ENOENT / EEXIST 这类文件系统状态翻译成显式状态，不用于错误分类
 * （错误分类用 `code` 字段协议，见 src/errors.ts）。
 */
export function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
