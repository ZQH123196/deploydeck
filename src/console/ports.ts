import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import type { Logger } from '../logging/logger.js'
import type { Clock } from '../util/clock.js'

/**
 * 控制面端口。
 *
 * 上层只依赖这些接口，不依赖 CDP 与浏览器。实现见 src/console/。
 * 每个动作产出两类东西：结构化结果，以及落进 Run 目录的截图。
 */

/** 浏览器通道。所有控制台动作都经它。 */
export interface ConsoleChannel {
  /** 打开页面。已在该页时不重复导航。 */
  goto(url: string): Promise<void>
  /** 当前页面 URL。 */
  currentUrl(): Promise<string>
  /** 在页面里求值。返回值必须可被 JSON 序列化。 */
  evaluate<Result>(script: string): Promise<Result>
  /**
   * 点击匹配元素。
   *
   * 必须走 CDP `Input.dispatchMouseEvent`。实测 JS `.click()` 对 Element Plus 按钮无效。
   * 选择器匹配不到元素即抛错，不做静默等待。
   */
  click(selector: string): Promise<void>
  /** 向输入框写入文本。先清空再写。 */
  type(selector: string, text: string): Promise<void>
  /** 等待选择器出现。超时即抛错。 */
  waitFor(selector: string, timeoutMs: number): Promise<void>
  /** 等待选择器消失。超时即抛错。 */
  waitForGone(selector: string, timeoutMs: number): Promise<void>
  /** 截图落盘。目录不存在时先创建。 */
  screenshot(filePath: string): Promise<void>
  /** 关闭连接。不关闭浏览器本身。 */
  close(): Promise<void>
}

/**
 * 控制台动作的公共上下文。
 *
 * 每个动作工厂都收它，保证所有动作在同一套超时与落盘目录下运行。
 */
export interface ConsoleActionContext {
  readonly channel: ConsoleChannel
  /** 本步日志目录。动作前后的截图落在这里。 */
  readonly logDir: string
  /** 单次动作的默认超时。 */
  readonly timeoutMs: number
  /** 等状态变化时的轮询间隔。 */
  readonly pollIntervalMs: number
  /**
   * 时钟与等待。测试注入假时钟。
   * 不传时用系统时钟；真实运行路径必须走系统时钟，测试必须显式注入。
   */
  readonly clock?: Clock
  /**
   * 部署器自身的运行日志。
   *
   * 判据（docs/plan-and-budget.md 第 8 节）：部署器自身日志落 run 目录。
   * 装配方传本次 run 的日志器；动作模块自建各自的动作证据文件（JSONL 落 `logDir`），
   * 运行日志走这里。不传时落回 stderr，只在测试或独立调用时发生。
   */
  readonly logger?: Logger
}

/** 读列表时的选项。 */
export interface ListInstancesOptions {
  /**
   * 先让控制台刷新数据再读。
   *
   * 判据：控制台实例列表不自动刷新。实测页面空闲 45 秒内发出 0 个请求，
   * 列表页工具栏的 `.refresh-btn` 是唯一刷新入口。
   * 等状态变化的轮询必须带它，否则会一直读到同一份旧数据。
   */
  readonly refresh?: boolean
}

/** 读实例列表。 */
export interface InstanceListPort {
  listInstances(options?: ListInstancesOptions): Promise<readonly ConsoleInstanceSnapshot[]>
}

/**
 * 需要「先定位到某一行」的动作收这个上下文：它多一个读列表能力。
 *
 * 靠列表定位实例的动作（开机、克隆、定时关机、销毁、SSH 取密码）都收它，
 * 这样它们不直接依赖列表模块，只依赖端口。
 */
export interface ConsoleRuntimeContext extends ConsoleActionContext {
  readonly instances: InstanceListPort
}

/** 开机结果。开机失败的定义见 spec 第 4.1 节。 */
export type PowerOnOutcome =
  | { readonly ok: true; readonly instanceId: string }
  | { readonly ok: false; readonly reason: 'no-gpu' | 'timeout'; readonly detail: string }

/**
 * 开机形态。
 *
 * 判据（spec 第 4.1 节与第 7.2 节）：
 * - `gpu`：租用算力开机。主机没有空闲 GPU 时开不了机，会返回 `no-gpu`。
 * - `no-gpu`：无卡模式开机。不占 GPU，始终能开机，单价低。
 *   它只允许由部署配置显式指定，引擎不得自行降级到这条路径。
 */
export type PowerOnMode = 'gpu' | 'no-gpu'

export interface PowerPort {
  /** 按给定形态开机并等待到 `running`。`no-gpu` 形态不会返回 `no-gpu` 失败。 */
  powerOn(instanceId: string, mode: PowerOnMode): Promise<PowerOnOutcome>
  /** 关机并等待到 `stopped`。 */
  powerOff(instanceId: string): Promise<void>
}

/** 克隆请求。规格与地区优先级来自 Profile。 */
export interface CloneRequest {
  readonly sourceInstanceId: string
  readonly gpuPreference: readonly string[]
  readonly regionPreference: readonly string[]
  /** 是否一起拷贝数据盘。系统盘固定拷贝。 */
  readonly cloneDataDisk: boolean
  /** 新实例名称。取 Profile 的 instanceNamePattern。 */
  readonly instanceName: string
}

export interface CloneOutcome {
  readonly instanceId: string
  readonly sourceInstanceId: string
}

export interface ClonePort {
  /**
   * 当日剩余克隆次数。
   *
   * 次数显示在「克隆实例」对话框里，所以必须先给一台源实例。
   * 为 0 时调用方不得尝试克隆。
   */
  readCloneQuota(sourceInstanceId: string): Promise<number>
  /** 克隆并等待完成。超时抛 CloneTimeoutError。 */
  clone(request: CloneRequest): Promise<CloneOutcome>
}

/**
 * 单价与余额。
 *
 * 单价只能从控制台的定时关机对话框反推，见 spec 第 7.5 节。
 * 时间一律以对话框显示的服务器时间为准。
 */
export interface PriceQuote {
  /** 控制台显示的服务器时间，北京时间 ISO。 */
  readonly serverTime: string
  /** 反推的每小时单价，单位元。 */
  readonly unitPriceYuanPerHour: number
  /** 对话框显示的预计消费，单位元。 */
  readonly estimatedCostYuan: number
  /** 本次填入的时长，单位分钟。 */
  readonly ttlMinutes: number
  /** 账户余额，单位元。 */
  readonly balanceYuan: number
}

/** 平台定时关机的回执。 */
export interface TimedShutdownReceipt {
  /** 控制台显示的服务器时间。 */
  readonly serverTime: string
  /** 已设置的关机时刻，北京时间 ISO。 */
  readonly shutdownAt: string
}

export interface PricePort {
  /** 在定时关机对话框里填入时长，读预计消费与余额，反推单价。不改变实例状态。 */
  readPriceQuote(instanceId: string, ttlMinutes: number): Promise<PriceQuote>
  /** 设置平台定时关机。 */
  setTimedShutdown(instanceId: string, shutdownAt: string): Promise<TimedShutdownReceipt>
  /**
   * 取消平台定时关机。
   *
   * 平台在定时关机触发后**不自动清除**那条记录，列表会一直显示已过去的时刻。
   * 清除入口是列表第 6 列的「关闭」按钮 + 「取消定时关机」确认框。
   * 没有记录时什么都不做（幂等）。
   */
  clearTimedShutdown(instanceId: string): Promise<void>
  /** 读账户余额。 */
  readBalance(): Promise<number>
}

/** 销毁链结果。终态判据是实例从列表消失。 */
export type TeardownOutcome =
  | { readonly state: 'gone' }
  | { readonly state: 'escalated'; readonly reason: string }

export interface TeardownPort {
  /** 关机、释放、验证消失。任一环超时返回 escalated，不重试。 */
  destroy(instanceId: string): Promise<TeardownOutcome>
}
