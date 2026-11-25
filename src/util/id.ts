/**
 * 标识生成。计划与执行的 id 都经它，保证可排序、可读、可回查。
 *
 * 注入时钟与随机源，测试才能断言确定结果。
 */

export interface IdSource {
  readonly now?: () => Date
  readonly randomSuffix?: () => string
}

function defaultRandomSuffix(): string {
  return Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
}

/** 生成 `<前缀>-<年月日时分秒>-<四位随机>`。时间部分用北京时间。 */
export function createId(prefix: string, source: IdSource = {}): string {
  if (prefix.length === 0) {
    throw new RangeError('id 前缀不能为空')
  }
  const now = source.now?.() ?? new Date()
  const randomSuffix = source.randomSuffix ?? defaultRandomSuffix
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  const stamp = shifted.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${prefix}-${stamp}-${randomSuffix()}`
}
