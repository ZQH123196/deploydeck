/**
 * 数据面端口：SSH。
 *
 * AutoDL 只提供 root 加密码登录。Windows 与 Linux 走同一条代码路径。
 * 实现见 src/ssh/。
 */

/** 从控制台 SSH 登录列取得的凭据。密码禁止写入日志。 */
export interface SshCredentials {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
}

export interface SshExecOptions {
  /** 本步独立超时。超时即杀掉命令。 */
  readonly timeoutSeconds: number
  /** 完整输出的落盘路径。调用方负责给出。 */
  readonly logPath: string
  /**
   * 只注入本命令进程的环境变量。
   *
   * 判据：值不进 `command`。`command` 会被写进执行记录、逐字进日志、在报错消息里回显，
   * 值写在命令里就再也收不回来。实现方必须把值交给会话，不得拼进命令字符串。
   * 这是唯一允许出现取值的通道。
   *
   * 边界（已读 ssh2 1.17.0 源码核实）：协议层与库实现**都不保证失败可见**。
   * ssh2 的 `client.exec(command, {env}, cb)` 调 `reqEnv` 时没有传回调，
   * 于是 `want_reply` 置 0，服务端丢弃请求时客户端收不到任何错误。
   * 更关键的是 `reqEnv` 不进库里的 `todo` 队列，`reqExec` 紧随其后直接发出，
   * **即使补上回调也来不及阻止命令执行**。
   * 这不是库的缺陷，是协议层「服务端可以用 `AcceptEnv` 白名单丢弃」与库实现共同给出的
   * 既有边界。所以调用方不要指望靠这条通道判断注入成功：命令自己必须以环境变量在场为前置条件。
   */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * 执行一条命令的入口。
 *
 * `SshPort` 是本进程手上有实例凭据时的直接出口。`shell -- <command>` 经它执行，
 * 与 `run` 每一步用的是同一条数据面。
 */
export interface SshCommandPort {
  exec(instanceId: string, command: string, options: SshExecOptions): Promise<SshExecResult>
}

export interface SshExecResult {
  /** 命令退出码。超时被杀时为 null。 */
  readonly exitCode: number | null
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly durationMs: number
  readonly timedOut: boolean
}

export interface SshPort {
  /** 等待实例的 SSH 可登录。超时即抛错。 */
  waitUntilReady(instanceId: string, timeoutMs: number): Promise<void>
  /** 执行单条命令。每个 step 一次会话。 */
  exec(instanceId: string, command: string, options: SshExecOptions): Promise<SshExecResult>
}

/* ------------------------------------------------------------------ */
/* 交互式终端（PTY）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 终端窗口尺寸。
 *
 * 只收行列数。像素宽高是给图形终端的提示，SSH 服务端排版只认行列。
 */
export interface TerminalSize {
  readonly columns: number
  readonly rows: number
}

/**
 * 一次终端会话的输入输出。
 *
 * 它不是 `SshExecResult`：终端会话没有「一步结束」的边界，也没有逐步落盘。
 * 输入是流式的，输出按到达顺序回调，退出只有一个终态。
 */
export interface ShellSessionHandlers {
  /** 远端输出（含 stderr：PTY 下两路已合流）。 */
  onData(chunk: Buffer): void
  /** 窗口尺寸变化。实现方负责通知远端。 */
  onResize?(size: TerminalSize): void
}

/** 终端会话的终态。 */
export interface ShellSessionOutcome {
  /**
   * 远端 shell 的退出码。
   *
   * `null` 表示没拿到退出码：连接中途断开，或对端没发 exit-status。
   * 调用方不得把 `null` 当 0。
   */
  readonly exitCode: number | null
  /** 会话结束原因。`null` 表示正常收到退出码。 */
  readonly transportFailure: string | null
}

/** 一条已建立的交互式会话。 */
export interface InteractiveShellSession {
  /** 把本地键盘输入写给远端。 */
  write(data: Buffer): void
  /** 通知远端窗口尺寸。 */
  resize(size: TerminalSize): void
  /** 等会话结束。连接中断时同样 resolve，由 `transportFailure` 说明原因。 */
  wait(): Promise<ShellSessionOutcome>
  /** 关闭会话。重复调用必须安全。 */
  close(): Promise<void>
}

export interface OpenShellOptions {
  readonly size: TerminalSize
  /** 终端类型，写进 `$TERM`。默认 `xterm-256color`。 */
  readonly term: string
}

/**
 * 打开交互式 shell 的入口。
 *
 * 与 `SshPort` 分开：`SshPort` 的语义是「跑完一条命令拿退出码」，
 * 终端会话的语义是「保持连接，人敲键盘」。合并成一个接口会让两边都不好写。
 *
 * 连接前的前置校验（实例是否运行中、控制台是否登录）由调用方做，
 * 本入口只管「已经拿到凭据，建一条已认证的会话」。
 */
export interface SshShellPort {
  openShell(
    instanceId: string,
    handlers: ShellSessionHandlers,
    options: OpenShellOptions,
  ): Promise<InteractiveShellSession>
}
