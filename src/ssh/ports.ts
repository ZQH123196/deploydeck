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
