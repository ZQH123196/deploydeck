/**
 * 轮询。控制台与实例状态都不是即时的，所有「等到某个状态」的动作都经它。
 *
 * 本函数不抛超时错误：超时是调用方要裁决的业务事实（退出码 1 还是 2），
 * 由调用方按自己的语义抛出。测试必须注入假时钟，禁止真实等待。
 */

export type PollOutcome<Result> =
  | { readonly status: 'matched'; readonly value: Result }
  | { readonly status: 'timeout' }

export interface PollOptions<Result> {
  /** 人类可读的动作描述。失败时进日志。 */
  readonly description: string
  /** 探测一次。返回 undefined 表示还没到目标状态。 */
  readonly probe: () => Promise<Result | undefined>
  readonly timeoutMs: number
  readonly intervalMs: number
  /** 注入时钟。默认使用真实时钟。 */
  readonly now?: () => number
  /** 注入等待。默认使用真实定时器。 */
  readonly sleep?: (milliseconds: number) => Promise<void>
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

export async function pollUntil<Result>(options: PollOptions<Result>): Promise<PollOutcome<Result>> {
  const { description, probe, timeoutMs, intervalMs } = options
  if (timeoutMs <= 0) {
    throw new RangeError(`轮询超时必须为正：${description}（${timeoutMs}ms）`)
  }
  if (intervalMs <= 0) {
    throw new RangeError(`轮询间隔必须为正：${description}（${intervalMs}ms）`)
  }

  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const deadline = now() + timeoutMs

  for (;;) {
    const value = await probe()
    if (value !== undefined) {
      return { status: 'matched', value }
    }
    if (now() >= deadline) {
      return { status: 'timeout' }
    }
    await sleep(intervalMs)
  }
}
