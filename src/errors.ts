import type { ConsoleInstanceSnapshot } from './domain/instance.js'

/** 退出码。0 成功，1 业务失败，2 需要人工介入。 */
export type ExitCode = 0 | 1 | 2

/**
 * 全部业务错误码。
 *
 * 错误分类靠这个显式字段，不靠类继承层级（AGENTS.md 代码规范 · 错误分类）。
 * 新增错误码时同时加进这个联合类型，各分支读 `code` 才受类型保护。
 */
export type DeploydeckErrorCode =
  | 'CONFIG_INVALID'
  | 'NOT_IMPLEMENTED'
  | 'HUMAN_REQUIRED'
  | 'LOGIN_REQUIRED'
  | 'CONSOLE_PARSE_FAILED'
  | 'CLONE_QUOTA_EXHAUSTED'
  | 'CLONE_TIMEOUT'
  | 'INSTANCE_NOT_GONE'
  | 'HOST_KEY_CHANGED'
  | 'PLAN_INVALID'
  | 'BUDGET_EXCEEDED'
  | 'INSTANCE_NAME_AMBIGUOUS'
  | 'CLONE_SOURCE_MISSING'
  | 'BALANCE_INSUFFICIENT'
  | 'HEALTH_CHECK_FAILED'
  | 'SSH_AUTH_FAILED'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_COMMAND_TIMEOUT'
  | 'BROWSER_CHANNEL_FAILED'
  | 'CHROME_LAUNCH_FAILED'
  | 'CHROME_BACKGROUND_LAUNCH_UNAVAILABLE'
  | 'STATE_FILE_MISSING'
  | 'STATE_FILE_INVALID'
  | 'STATE_LOCK_TIMEOUT'
  | 'CLONE_SOURCE_UNAVAILABLE'
  | 'CLONE_TARGET_UNAVAILABLE'
  | 'CLONE_RESULT_UNKNOWN'
  | 'INSTANCE_NOT_FOUND'
  | 'POWER_OFF_TIMEOUT'
  | 'INSTANCE_NOT_RUNNING'
  | 'PROBE_FAILED'
  | 'INTERACTIVE_TERMINAL_REQUIRED'
  | 'SHELL_FAILED'
  | 'POWER_ON_FAILED'
  | 'POWER_OFF_FAILED'
  | 'INSTANCE_FORM_MISMATCH'
  | 'TUNNEL_LOCAL_PORT_IN_USE'

export const EXIT_OK: ExitCode = 0
export const EXIT_BUSINESS_FAILURE: ExitCode = 1
export const EXIT_HUMAN_REQUIRED: ExitCode = 2

/** 所有 deploydeck 抛出错误的基类。携带稳定错误码与退出码。 */
export class DeploydeckError extends Error {
  readonly code: DeploydeckErrorCode
  readonly exitCode: ExitCode

  constructor(code: DeploydeckErrorCode, message: string, exitCode: ExitCode) {
    super(message)
    this.name = 'DeploydeckError'
    this.code = code
    this.exitCode = exitCode
  }
}

/**
 * 按显式 `code` 字段判断错误分类，并收窄成 `DeploydeckError`。
 *
 * 判据（AGENTS.md 代码规范 · 错误分类）：分类用字段，不用类继承层级。
 * 调用方因此不必 import 具体错误类，只按码分叉。
 */
export function isDeploydeckErrorWithCode<Code extends DeploydeckErrorCode>(
  error: unknown,
  ...codes: readonly Code[]
): error is DeploydeckError & { readonly code: Code } {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' && (codes as readonly string[]).includes(code)
}

/** 配置非法。启动期一次报完，不猜默认值。 */
export class ConfigError extends DeploydeckError {
  constructor(message: string) {
    super('CONFIG_INVALID', message, EXIT_HUMAN_REQUIRED)
    this.name = 'ConfigError'
  }
}

/** 功能尚未实现。它不是成功，也不是普通失败。 */
export class NotImplementedError extends DeploydeckError {
  constructor(feature: string) {
    super('NOT_IMPLEMENTED', `[NOT IMPLEMENTED] ${feature}`, EXIT_HUMAN_REQUIRED)
    this.name = 'NotImplementedError'
  }
}

/** 需要人工介入。实例可能仍在计费。 */
export class HumanRequiredError extends DeploydeckError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('HUMAN_REQUIRED', message, EXIT_HUMAN_REQUIRED)
    this.name = 'HumanRequiredError'
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/** 控制台未登录。停止全部动作，不改动任何实例。 */
export class LoginRequiredError extends DeploydeckError {
  constructor() {
    super('LOGIN_REQUIRED', '请在专用 Chrome 窗口重新登录 AutoDL 控制台，然后重试。', EXIT_HUMAN_REQUIRED)
    this.name = 'LoginRequiredError'
  }
}

/** 控制台页面结构与解析器不一致。页面改版必须报错，不得返回空结果。 */
export class ConsoleParseError extends DeploydeckError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('CONSOLE_PARSE_FAILED', message, EXIT_HUMAN_REQUIRED)
    this.name = 'ConsoleParseError'
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/** 当日克隆次数已用尽。 */
export class CloneQuotaExhaustedError extends DeploydeckError {
  constructor(remaining: number) {
    super(
      'CLONE_QUOTA_EXHAUSTED',
      `今日克隆次数已用尽，可改用开机复用路径（剩余 ${remaining} 次）。`,
      EXIT_HUMAN_REQUIRED,
    )
    this.name = 'CloneQuotaExhaustedError'
  }
}

/** 克隆超时，实例状态仍未离开「克隆锁定中」。 */
export class CloneTimeoutError extends DeploydeckError {
  constructor(message: string) {
    super('CLONE_TIMEOUT', message, EXIT_HUMAN_REQUIRED)
    this.name = 'CloneTimeoutError'
  }
}

/**
 * 克隆已经创建了实例，但没能走到「确认完成」那一步：实例状态未知。
 *
 * 判据：平台受理克隆后配额已扣、实例已存在。此时抛任何普通错误都会丢掉实例 ID，
 * 执行引擎就接管不了它，账也记不上。因此这种情况一律用本错误：
 * `instanceId` 必有值，`snapshot` 为 `null` 表示没读回列表，读回则带那一刻的实例快照。
 * 执行引擎读这两个字段把它绑定到计划上并记账。
 */
export class StrayInstanceError extends DeploydeckError {
  readonly instanceId: string
  readonly snapshot: ConsoleInstanceSnapshot | null

  constructor(
    cause: DeploydeckError,
    instance: { readonly instanceId: string; readonly snapshot: ConsoleInstanceSnapshot | null },
  ) {
    super(
      'CLONE_RESULT_UNKNOWN',
      `克隆已创建实例 ${instance.instanceId}，但结果未能确认：${cause.message}` +
        `（原因码 ${cause.code}）。配额已扣，实例状态未知。执行引擎会接管记账，` +
        '请到控制台核对实例状态。',
      EXIT_HUMAN_REQUIRED,
    )
    this.name = 'StrayInstanceError'
    this.instanceId = instance.instanceId
    this.snapshot = instance.snapshot
    this.cause = cause
  }
}

/** 实例未确认消失（ESCALATED）。钱可能还在烧。 */
export class InstanceNotGoneError extends DeploydeckError {
  constructor(message: string) {
    super('INSTANCE_NOT_GONE', `ESCALATED：${message}`, EXIT_HUMAN_REQUIRED)
    this.name = 'InstanceNotGoneError'
  }
}

/** 主机密钥指纹与首次记录不一致。可能是中间人，也可能是实例重建。 */
export class HostKeyChangedError extends DeploydeckError {
  constructor(message: string) {
    super('HOST_KEY_CHANGED', message, EXIT_HUMAN_REQUIRED)
    this.name = 'HostKeyChangedError'
  }
}

/** 没有生效的计划，或计划已过期。 */
export class PlanInvalidError extends DeploydeckError {
  constructor(message: string) {
    super('PLAN_INVALID', message, EXIT_BUSINESS_FAILURE)
    this.name = 'PlanInvalidError'
  }
}

/** 超出预算上限，或余额不足以支撑剩余时长。 */
export class BudgetExceededError extends DeploydeckError {
  constructor(message: string) {
    super('BUDGET_EXCEEDED', message, EXIT_BUSINESS_FAILURE)
    this.name = 'BudgetExceededError'
  }
}

/**
 * 列表里有多台同名实例，无法判定该用哪一台。
 *
 * 名字不唯一时猜错就是部署到别人的机器上，所以不猜：列出 ID 让人先清理。
 */
export class AmbiguousInstanceNameError extends DeploydeckError {
  constructor(instanceName: string, instanceIds: readonly string[]) {
    super(
      'INSTANCE_NAME_AMBIGUOUS',
      `控制台里有 ${String(instanceIds.length)} 台名为「${instanceName}」的实例：` +
        `${instanceIds.join('、')}。无法判定该用哪一台，请先清理重名实例后重试。未做任何动作。`,
      EXIT_BUSINESS_FAILURE,
    )
    this.name = 'AmbiguousInstanceNameError'
  }
}

/**
 * 走克隆路径但没有可用的源实例。
 *
 * 控制台的克隆以一台已关机实例为模板。没有模板就克隆不出东西，只能让人补配置或清理列表。
 * 消息里必须列出可用的已关机实例，但只列不选。
 */
export class CloneSourceMissingError extends DeploydeckError {
  constructor(message: string) {
    super('CLONE_SOURCE_MISSING', message, EXIT_BUSINESS_FAILURE)
    this.name = 'CloneSourceMissingError'
  }
}

/**
 * 账户余额不足以支撑本次预计花费。
 *
 * 它与 `BudgetExceededError` 回答两个不同的问题：那个管「本计划还能花多少」，
 * 这个管「账户里还有没有钱」。两者都是业务失败。
 */
export class BalanceInsufficientError extends DeploydeckError {
  constructor(message: string) {
    super('BALANCE_INSUFFICIENT', message, EXIT_BUSINESS_FAILURE)
    this.name = 'BalanceInsufficientError'
  }
}

/**
 * 探测未通过：SSH 连不上、命令没返回，或命令退出码非 0。
 *
 * 判据：探测只回答「这台机器能不能连上并执行一条命令」。`true` 恒真，
 * 所以失败原因只有链路与传输两类。退出码 1：链路恢复后重试即可，不用人排查配置。
 */
export class ProbeFailedError extends DeploydeckError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('PROBE_FAILED', message, EXIT_BUSINESS_FAILURE)
    this.name = 'ProbeFailedError'
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/**
 * 健康检查未通过。
 *
 * 已无消费者：`run` 不再做健康检查，探测改用固定命令并报 `PROBE_FAILED`。
 * 错误码保留，不删：码表是稳定接口，删码会让读历史日志的人找不到对应含义。
 */
export class HealthCheckFailedError extends DeploydeckError {
  constructor(message: string) {
    super('HEALTH_CHECK_FAILED', message, EXIT_BUSINESS_FAILURE)
    this.name = 'HealthCheckFailedError'
  }
}

/** SSH 认证失败或连接失败。消息中禁止出现密码。 */
export class SshError extends DeploydeckError {
  constructor(code: 'SSH_AUTH_FAILED' | 'SSH_CONNECT_FAILED' | 'SSH_COMMAND_TIMEOUT', message: string) {
    super(code, message, EXIT_BUSINESS_FAILURE)
    this.name = 'SshError'
  }
}

/**
 * 浏览器通道不可用。
 *
 * 覆盖：连不上 CDP、请求超时、连接断开后重连仍失败、CDP 协议返回错误。
 * 它属于业务失败：换一次操作可能就好了，不需要人介入。
 */
export class BrowserChannelError extends DeploydeckError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('BROWSER_CHANNEL_FAILED', message, EXIT_BUSINESS_FAILURE)
    this.name = 'BrowserChannelError'
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/**
 * 专用 Chrome 没起来，或 CDP 端口在超时内没就绪。
 *
 * 属于需要人介入：机器上缺 Chrome、路径配错、窗口被别的实例占住，
 * 这些都不是重试能修的。
 */
export class ChromeLaunchError extends DeploydeckError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('CHROME_LAUNCH_FAILED', message, EXIT_HUMAN_REQUIRED)
    this.name = 'ChromeLaunchError'
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/**
 * 要求后台启动 Chrome，但当前平台没有这种启动方式。
 *
 * 判据：后台启动只覆盖 WSL 调 Windows Chrome 这一条路径。其余平台直接拒绝，
 * 不当事后再重试能修的问题，所以退出码是「需要人工介入」。
 */
export class ChromeBackgroundLaunchUnavailableError extends DeploydeckError {
  constructor(message: string) {
    super('CHROME_BACKGROUND_LAUNCH_UNAVAILABLE', message, EXIT_HUMAN_REQUIRED)
    this.name = 'ChromeBackgroundLaunchUnavailableError'
  }
}

/**
 * 状态文件不存在。
 *
 * 读状态时缺失即报错，不返回空值：空值会让「账本为空」与「账本文件丢了」看起来一样。
 */
export class StateFileMissingError extends DeploydeckError {
  constructor(relativePath: string, absolutePath: string) {
    super('STATE_FILE_MISSING', `状态文件不存在：${relativePath}（${absolutePath}）。`, EXIT_BUSINESS_FAILURE)
    this.name = 'StateFileMissingError'
  }
}

/**
 * 状态文件内容非法：JSONC 解析失败，或读回的数据不符合 schema。
 *
 * 状态文件损坏时机器无法判断哪一部分可信，必须交给人检查。
 */
export class StateFileInvalidError extends DeploydeckError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('STATE_FILE_INVALID', message, EXIT_HUMAN_REQUIRED)
    this.name = 'StateFileInvalidError'
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/**
 * 取锁超时。锁被其他进程持有超过上限。
 *
 * 持续超时通常意味着上一个进程崩溃后留下锁文件，需要人确认后删除。
 */
export class StateLockTimeoutError extends DeploydeckError {
  constructor(message: string) {
    super('STATE_LOCK_TIMEOUT', message, EXIT_HUMAN_REQUIRED)
    this.name = 'StateLockTimeoutError'
  }
}

/** 克隆前置条件不满足：源实例没有关机等状态问题。 */
export class CloneSourceUnavailableError extends DeploydeckError {
  constructor(message: string) {
    super('CLONE_SOURCE_UNAVAILABLE', message, EXIT_HUMAN_REQUIRED)
    this.name = 'CloneSourceUnavailableError'
  }
}

/** 克隆目标不可用：偏好与页面可选值对不上，或所选型号没有可用主机。 */
export class CloneTargetUnavailableError extends DeploydeckError {
  constructor(message: string) {
    super('CLONE_TARGET_UNAVAILABLE', message, EXIT_HUMAN_REQUIRED)
    this.name = 'CloneTargetUnavailableError'
  }
}

/**
 * 控制台实例列表里找不到目标实例。
 *
 * 绑定实例被删除，或列表还没加载完，都会走到这里。它不是「大概已开机」：
 * 没有列表事实就不动作，由调用方决定后续。退出码按业务失败处理。
 */
export class InstanceNotFoundError extends DeploydeckError {
  constructor(instanceId: string) {
    super('INSTANCE_NOT_FOUND', `控制台实例列表中找不到实例 ${instanceId}。`, EXIT_BUSINESS_FAILURE)
    this.name = 'InstanceNotFoundError'
  }
}

/**
 * 关机超时，实例状态仍未变为「已关机」。
 *
 * 实例可能仍在计费，所以退出码是「需要人工介入」，不是普通失败。
 * 判据见 docs/provider-contract.md 第 4.2 节。
 */
export class PowerOffTimeoutError extends DeploydeckError {
  constructor(instanceId: string, timeoutMs: number, lastStatusRaw: string) {
    super(
      'POWER_OFF_TIMEOUT',
      `实例 ${instanceId} 在 ${String(Math.round(timeoutMs / 1000))} 秒内未关机` +
        `（最后状态：${lastStatusRaw}）。实例可能仍在计费，请在控制台确认。`,
      EXIT_HUMAN_REQUIRED,
    )
    this.name = 'PowerOffTimeoutError'
  }
}

/**
 * 目标实例不在运行中，SSH 连不上。
 *
 * 判据（docs/specs/deploydeck-phase3-shell.md 第 3 节）：终端只连运行中的实例。
 * 已关机的实例没有 SSH 服务，连它只会拿到一个晦涩的连接超时。
 *
 * 退出码 1，不是 2：这是实例当前状态，不是配置错误。等实例运行后重试即可。
 */
export class InstanceNotRunningError extends DeploydeckError {
  constructor(instanceId: string, statusRaw: string) {
    super(
      'INSTANCE_NOT_RUNNING',
      `实例 ${instanceId} 当前状态是「${statusRaw}」，不在运行中，无法建立 SSH 连接。` +
        '开机后再执行本命令。未打开任何 SSH 连接。',
      EXIT_BUSINESS_FAILURE,
    )
    this.name = 'InstanceNotRunningError'
  }
}

/**
 * 需要交互式终端，但当前进程没有终端。
 *
 * 判据：`shell` 与 `shell run` 要转发 stdin 与窗口尺寸，没有 tty 就转发不了。
 * 这不是可以自动降级的场景：静默退化成非交互会让需要确认的命令假装执行成功。
 */
export class InteractiveTerminalRequiredError extends DeploydeckError {
  constructor() {
    super(
      'INTERACTIVE_TERMINAL_REQUIRED',
      '当前进程没有交互式终端（stdin 不是 tty），无法转发键盘输入与窗口尺寸。' +
        '请在真正的终端里运行本命令。不带参数的 `shell run` 与本错误无关。',
      EXIT_HUMAN_REQUIRED,
    )
    this.name = 'InteractiveTerminalRequiredError'
  }
}

/**
 * SSH shell 会话失败：通道建立失败、会话中途断开、或命令超时。
 *
 * 它不是 `SSH_COMMAND_TIMEOUT`：那条属于非交互的 `exec`，判据是「命令被杀」。
 * 本错误面前，远端 shell 是否已执行过命令未知，所以退出码是「需要人工」。
 */
export class ShellFailedError extends DeploydeckError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('SHELL_FAILED', message, EXIT_HUMAN_REQUIRED)
    this.name = 'ShellFailedError'
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

/**
 * 开机失败：控制台报无可用 GPU，或等到超时仍未进入运行中。
 *
 * 判据（docs/plan-and-budget.md 第 3.1 节）：开机形态由部署配置或命令行显式给出，
 * 引擎不自行降级到无卡模式。所以开机失败必须报错，不能静默换一种形态开。
 *
 * 退出码 1：换一个时刻重试或改目标形态就能继续，不是需要人排查配置的错误。
 */
export class PowerOnFailedError extends DeploydeckError {
  constructor(
    instanceId: string,
    mode: 'gpu' | 'no-gpu',
    reason: 'no-gpu' | 'timeout',
    detail: string,
    lastStatusRaw: string,
  ) {
    super(
      'POWER_ON_FAILED',
      `实例 ${instanceId} 按${mode === 'no-gpu' ? '无卡' : '有卡'}模式开机失败` +
        `（原因：${reason}，最后状态：${lastStatusRaw}）：${detail}` +
        '未做任何降级：目标形态是显式给出的，换形态请重新执行命令并指定。',
      EXIT_BUSINESS_FAILURE,
    )
    this.name = 'PowerOnFailedError'
  }
}

/**
 * 切换形态后复验不一致：实测形态与目标形态不同。
 *
 * 判据（`ConsoleInstanceSnapshot.noGpuMode`）：true 表示无卡，false 表示有卡，
 * null 表示页面没给出可判定的信息。null 同样算不一致：没有事实支撑的「大概对」不能算成功。
 *
 * 退出码 2：实例已经开起来了但形态不对，说明控制台行为与预期不符，需要人确认。
 */
export class InstanceFormMismatchError extends DeploydeckError {
  constructor(input: {
    readonly instanceId: string
    readonly targetMode: 'gpu' | 'no-gpu'
    readonly observedNoGpuMode: boolean | null
    readonly statusRaw: string
  }) {
    const observed =
      input.observedNoGpuMode === null ? '未给出可判定的形态' : input.observedNoGpuMode ? '无卡' : '有卡'
    super(
      'INSTANCE_FORM_MISMATCH',
      `切换后复验不一致：目标是${input.targetMode === 'no-gpu' ? '无卡' : '有卡'}，` +
        `实测形态是${observed}（实例 ${input.instanceId}，状态「${input.statusRaw}」）。` +
        '实例已保留，未销毁。请在控制台确认形态与计费口径。',
      EXIT_HUMAN_REQUIRED,
    )
    this.name = 'InstanceFormMismatchError'
  }
}

/**
 * 本地端口已被占用，端口转发起不来。
 *
 * 判据：端口被占用是确定性失败。重试解决不了，等下去也不会变；静默失败更糟，
 * 使用方会以为转发已经建好。所以立即报错。
 *
 * 退出码 1：换一个本地端口即可继续。
 */
export class TunnelLocalPortInUseError extends DeploydeckError {
  constructor(localPort: number, remote: string) {
    super(
      'TUNNEL_LOCAL_PORT_IN_USE',
      `本地端口 ${String(localPort)} 已被占用，无法建立到 ${remote} 的端口转发。` +
        '换一个本地端口重试。未建立任何转发，也未重试。',
      EXIT_BUSINESS_FAILURE,
    )
    this.name = 'TunnelLocalPortInUseError'
  }
}

/**
 * 关机失败：动作返回后实例状态不是已关机。
 *
 * 判据（与 `PowerOnFailedError` 分开）：两条路径的结论不同，读日志的人必须一眼分开。
 * 开机失败沿用 `POWER_ON_FAILED`，措辞是「开机失败」；关机失败用 `POWER_OFF_FAILED`，
 * 措辞是「关机失败」。共用一个码时，「关机后仍是运行中」会被读成「开机失败」。
 *
 * 与 `PowerOffTimeoutError` 的区别：那条是等关机超时，这条是动作返回后的终态不符。
 * 退出码 1：实例可能仍在计费，但重试一次关机就能继续，不需要人排查配置。
 */
export class PowerOffFailedError extends DeploydeckError {
  constructor(
    instanceId: string,
    detail: string,
    lastStatusRaw: string,
  ) {
    super(
      'POWER_OFF_FAILED',
      `实例 ${instanceId} 关机失败（最后状态：${lastStatusRaw}）：${detail}` +
        '实例可能仍在计费，请到控制台确认，或重试一次关机。未做任何降级动作。',
      EXIT_BUSINESS_FAILURE,
    )
    this.name = 'PowerOffFailedError'
  }
}
