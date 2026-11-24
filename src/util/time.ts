/** 全项目日历时间一律北京时间。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 生成带 +08:00 后缀的 ISO 时间串。写入侧承担偏移。 */
export function beijingIso(date: Date): string {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS)
  return shifted.toISOString().replace(/Z$/, '+08:00')
}

/** 当前时刻的北京时间 ISO 串。 */
export function beijingNowIso(): string {
  return beijingIso(new Date())
}
