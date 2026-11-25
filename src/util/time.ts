/** 全项目日历时间一律北京时间。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

/**
 * 北京时间的 IANA 名称。
 *
 * 需要显式声明时区基准的地方用它，不写裸字符串。
 * 控制台的倒计时与时间文本都按这个时区展示。
 */
export const BEIJING_TIME_ZONE = 'Asia/Shanghai'

/** 生成带 +08:00 后缀的 ISO 时间串。写入侧承担偏移。 */
export function beijingIso(date: Date): string {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS)
  return shifted.toISOString().replace(/Z$/, '+08:00')
}

/** 当前时刻的北京时间 ISO 串。 */
export function beijingNowIso(): string {
  return beijingIso(new Date())
}

/** 解析 ISO 时间串。带偏移或带 Z 都接受。非法即抛错，不猜。 */
export function parseIso(text: string): Date {
  const milli = Date.parse(text)
  if (Number.isNaN(milli)) {
    throw new RangeError(`无法解析时间串：${text}`)
  }
  return new Date(milli)
}

/** 时间串加减分钟，返回北京时间 ISO 串。 */
export function addMinutesIso(text: string, minutes: number): string {
  return beijingIso(new Date(parseIso(text).getTime() + minutes * MINUTE_MS))
}

/** 两个时刻之间的分钟数。后者晚于前者时为正。 */
export function minutesBetweenIso(fromText: string, toText: string): number {
  return (parseIso(toText).getTime() - parseIso(fromText).getTime()) / MINUTE_MS
}

/** 取分钟精度的北京时间文本，形如 `2026-11-25 01:30`。用于控制台输入框。 */
export function formatBeijingMinute(text: string): string {
  const iso = beijingIso(parseIso(text))
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/**
 * 解析控制台显示的时间文本为北京时间 ISO 串。
 *
 * 接受 `2026-11-25 01:30`、`2026-11-25 01:30:00` 两种形状。其他形状即抛错。
 */
export function parseBeijingDateTimeText(text: string): string {
  const trimmed = text.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed)
  if (match === null) {
    throw new RangeError(`无法解析控制台时间文本：${text}`)
  }
  const [, year, month, day, hour, minute, second] = match
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second ?? '00'}+08:00`
  return beijingIso(parseIso(iso))
}
