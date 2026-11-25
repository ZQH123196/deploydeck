import { describe, expect, it } from 'vitest'
import { createId } from './id.js'

describe('createId', () => {
  it('按北京时间的时间戳生成可排序 id', () => {
    const id = createId('plan', {
      now: () => new Date('2026-11-24T17:30:45Z'),
      randomSuffix: () => 'ab12',
    })
    expect(id).toBe('plan-20261125013045-ab12')
  })

  it('随机后缀不同则 id 不同', () => {
    const now = () => new Date('2026-11-24T17:30:45Z')
    const first = createId('run', { now, randomSuffix: () => '0001' })
    const second = createId('run', { now, randomSuffix: () => '0002' })
    expect(first).not.toBe(second)
  })

  it('空前缀是编程错误，直接抛错', () => {
    expect(() => createId('')).toThrow(RangeError)
  })
})
