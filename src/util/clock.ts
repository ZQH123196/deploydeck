/**
 * 时钟。轮询与超时都必须经过它，测试才能用假时钟，不做真实等待。
 */
export interface Clock {
  now(): number
  sleep(milliseconds: number): Promise<void>
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    }),
}
