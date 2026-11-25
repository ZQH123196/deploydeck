import { describe, expect, it } from 'vitest'
import { pollUntil } from './poll.js'

/** 假时钟：now 由用例推进，sleep 直接推进 now。 */
function createFakeClock() {
  let current = 0
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds
    },
    advance: (milliseconds: number) => {
      current += milliseconds
    },
    get current() {
      return current
    },
  }
}

describe('pollUntil', () => {
  it('第一次探测即命中时不等待', async () => {
    const clock = createFakeClock()
    const outcome = await pollUntil({
      description: '测试',
      probe: async () => '命中',
      timeoutMs: 1000,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(outcome).toEqual({ status: 'matched', value: '命中' })
    expect(clock.current).toBe(0)
  })

  it('未命中时按间隔重试，直到命中', async () => {
    const clock = createFakeClock()
    let attempts = 0
    const outcome = await pollUntil({
      description: '测试',
      probe: async () => {
        attempts += 1
        return attempts === 3 ? '命中' : undefined
      },
      timeoutMs: 1000,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(outcome).toEqual({ status: 'matched', value: '命中' })
    expect(clock.current).toBe(200)
  })

  it('到达截止时刻仍未命中时返回超时', async () => {
    const clock = createFakeClock()
    const outcome = await pollUntil({
      description: '测试',
      probe: async () => undefined,
      timeoutMs: 250,
      intervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(outcome).toEqual({ status: 'timeout' })
    expect(clock.current).toBeGreaterThanOrEqual(250)
  })

  it('非正的超时是编程错误，直接抛错', async () => {
    const clock = createFakeClock()
    await expect(
      pollUntil({
        description: '测试',
        probe: async () => undefined,
        timeoutMs: 0,
        intervalMs: 100,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toThrow(RangeError)
  })
})
