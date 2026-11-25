import { describe, expect, it } from 'vitest'
import {
  addMinutesIso,
  beijingIso,
  formatBeijingMinute,
  minutesBetweenIso,
  parseBeijingDateTimeText,
  parseIso,
} from './time.js'

describe('beijingIso', () => {
  it('把 UTC 时刻写成带 +08:00 的北京时间', () => {
    const iso = beijingIso(new Date('2026-11-24T17:30:00Z'))
    expect(iso).toBe('2026-11-25T01:30:00.000+08:00')
  })
})

describe('parseIso', () => {
  it('拒绝无法解析的时间串', () => {
    expect(() => parseIso('明天下午')).toThrow(RangeError)
  })
})

describe('addMinutesIso', () => {
  it('跨日时进位到次日', () => {
    expect(addMinutesIso('2026-11-25T23:30:00+08:00', 45)).toBe('2026-11-26T00:15:00.000+08:00')
  })
})

describe('minutesBetweenIso', () => {
  it('返回带符号的分钟差', () => {
    expect(minutesBetweenIso('2026-11-25T10:00:00+08:00', '2026-11-25T12:30:00+08:00')).toBe(150)
  })
})

describe('formatBeijingMinute', () => {
  it('输出到分钟精度', () => {
    expect(formatBeijingMinute('2026-11-25T01:30:45+08:00')).toBe('2026-11-25 01:30')
  })
})

describe('parseBeijingDateTimeText', () => {
  it('解析不带秒的控制台时间文本', () => {
    expect(parseBeijingDateTimeText('2026-11-25 01:30')).toBe('2026-11-25T01:30:00.000+08:00')
  })

  it('解析带秒的控制台时间文本', () => {
    expect(parseBeijingDateTimeText('2026-11-25 01:30:45')).toBe('2026-11-25T01:30:45.000+08:00')
  })

  it('拒绝其它形状', () => {
    expect(() => parseBeijingDateTimeText('2026/11/25 01:30')).toThrow(RangeError)
  })
})
