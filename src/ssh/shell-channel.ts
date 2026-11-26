import { hostname } from 'node:os'
import { readInstanceStatus } from '../console/instance-list.js'
import type { ConsoleRuntimeContext } from '../console/ports.js'
import { InstanceNotRunningError, ShellFailedError } from '../errors.js'
import { assertPositiveInteger } from '../util/validate.js'
import { readSshCredentials } from './credentials.js'
import { createKnownHosts } from './known-hosts.js'
import type {
  InteractiveShellSession,
  OpenShellOptions,
  ShellSessionHandlers,
  SshCredentials,
  ShellSessionOutcome,
  SshShellPort,
  TerminalSize,
} from './ports.js'
import { connectShellWithSsh2 } from './ssh-channel.js'

/**
 * 交互式终端通道。
 *
 * 与 `channel.ts` 的分工：
 * - `channel.ts` 负责「跑一条命令，拿退出码，落盘」。它不转发键盘输入。
 * - 本文件负责「开一个 shell，人敲键盘」。它不落盘、不判退出码含义。
 *
 * 两条通道共用凭据读取、主机密钥指纹校验与连接适配层，不各写一套。
 *
 * 判据（docs/specs/deploydeck-phase3-shell.md 第 3 节）：
 * 1. 连接前只检查「实例在列表里且运行中」。已关机或创建中的实例没有可连的 SSH 服务。
 * 2. 连接前不做计划校验、不读单价、不设定时关机。终端不是部署动作，它不改实例生命周期。
 * 3. 主机密钥指纹照样校验，规则与 `exec` 完全一致。
 * 4. 密码只用一次，不落盘、不进日志、不进错误消息。
 */

/** 终端类型默认值。远端按它决定颜色与按键转义序列。 */
export const DEFAULT_TERM = 'xterm-256color'

/** 建立连接的默认超时，毫秒。一次握手远小于它。 */
export const DEFAULT_SHELL_CONNECT_TIMEOUT_MS = 15_000

/**
 * 拿不到本地终端尺寸时的兜底值。
 *
 * 它不是配置默认值：值来自真实终端。没有 tty 时用这个尺寸，
 * 因为调用方已经显式声明了「不要交互」。
 */
export const FALLBACK_TERMINAL_SIZE: TerminalSize = { columns: 80, rows: 24 }

export interface ShellChannelOptions {
  readonly context: ConsoleRuntimeContext
  /** known-hosts 文件绝对路径。由装配方给出。 */
  readonly knownHostsPath: string
  readonly connectTimeoutMs: number
  /** 终端类型。默认 `DEFAULT_TERM`。 */
  readonly term?: string
}

/**
 * 单测替换点。
 *
 * 生产装配只用 `createShellPort`：它把适配层固定成 `ssh2`。
 */
export interface ShellChannelOverrides {
  readonly connector: (
    request: {
      readonly instanceId: string
      readonly host: string
      readonly port: number
      readonly user: string
      readonly password: string
      readonly timeoutMs: number
      readonly verifyHostKey: (fingerprint: string) => Promise<void>
    },
    handlers: ShellSessionHandlers,
    options: OpenShellOptions,
  ) => Promise<InteractiveShellSession>
  /** 替换凭据来源。默认从控制台 SSH 登录列读。 */
  readonly readCredentials?: (instanceId: string) => Promise<SshCredentials>
  /** 替换实例状态来源。默认读控制台实例列表。 */
  readonly readStatus?: (
    instanceId: string,
  ) => Promise<{ readonly status: string; readonly statusRaw: string }>
}

/**
 * 创建交互式终端通道。
 *
 * 配置在这里一次校验完：指纹文件必须是绝对路径，连接超时必须为正整数。
 */
export function createShellPort(options: ShellChannelOptions): SshShellPort {
  return createShellPortWithOverrides(options, { connector: connectShellWithSsh2 })
}

export function createShellPortWithOverrides(
  options: ShellChannelOptions,
  overrides: ShellChannelOverrides,
): SshShellPort {
  assertPositiveInteger(options.connectTimeoutMs, 'connectTimeoutMs')
  assertPositiveInteger(options.context.pollIntervalMs, 'context.pollIntervalMs')
  assertPositiveInteger(options.context.timeoutMs, 'context.timeoutMs')

  const context = options.context
  const term = options.term ?? DEFAULT_TERM
  const knownHosts = createKnownHosts({ filePath: options.knownHostsPath })

  const readCredentials =
    overrides.readCredentials ??
    (async (instanceId: string) => await readSshCredentials(context, instanceId))
  const readStatus =
    overrides.readStatus ??
    (async (instanceId: string) => {
      const probe = await readInstanceStatus(context.channel, instanceId)
      return { status: probe.status, statusRaw: probe.statusRaw }
    })

  return {
    async openShell(
      instanceId: string,
      handlers: ShellSessionHandlers,
      shellOptions: OpenShellOptions,
    ): Promise<InteractiveShellSession> {
      const status = await readStatus(instanceId)
      if (status.status !== 'running') {
        throw new InstanceNotRunningError(instanceId, status.statusRaw)
      }

      const credentials = await readCredentials(instanceId)
      const session = await overrides.connector(
        {
          instanceId,
          host: credentials.host,
          port: credentials.port,
          user: credentials.user,
          password: credentials.password,
          timeoutMs: options.connectTimeoutMs,
          verifyHostKey: async (fingerprint: string) => {
            await knownHosts.verify({
              instanceId,
              host: credentials.host,
              port: credentials.port,
              fingerprint,
            })
          },
        },
        handlers,
        { size: shellOptions.size, term: shellOptions.term },
      )

      return session
    },
  }
}

/**
 * 从一个流对象读终端尺寸。
 *
 * 判据：只有真实 tty 才有 `columns` 与 `rows`。拿不到就返回兜底值，
 * 由调用方决定「没有 tty 是否可接受」。
 */
export interface TerminalSizeSource {
  readonly columns?: number | undefined
  readonly rows?: number | undefined
  readonly isTTY?: boolean | undefined
}

export function readTerminalSize(stream: TerminalSizeSource): TerminalSize {
  const columns = stream.columns
  const rows = stream.rows
  if (
    typeof columns === 'number' &&
    typeof rows === 'number' &&
    Number.isInteger(columns) &&
    Number.isInteger(rows) &&
    columns > 0 &&
    rows > 0
  ) {
    return { columns, rows }
  }
  return FALLBACK_TERMINAL_SIZE
}

/**
 * 终端会话的欢迎行。人一眼看清连到了哪台机。
 *
 * 只写实例 ID。SSH 目标主机与用户名属于凭据的一部分推导结果，
 * 不进欢迎行：终端可能被截屏、被录屏。
 */
export function formatShellBanner(input: { readonly instanceId: string }): string {
  return (
    `已连接实例 ${input.instanceId}（本机 ${hostname()}）。` +
    '输入 exit 或按 Ctrl-D 断开。窗口尺寸会跟随本地终端变化。'
  )
}

/** 把会话终态转成命令结论。没拿到退出码即会话失败，不当成 0。 */
export function requireShellExitCode(outcome: ShellSessionOutcome): number {
  if (outcome.exitCode === null) {
    throw new ShellFailedError(
      '终端会话没有拿到远端退出码' +
        (outcome.transportFailure === null ? '：连接在你离开前断开。' : `：${outcome.transportFailure}。`) +
        '远端命令是否执行完成未知，请人工核对实例状态。',
    )
  }
  return outcome.exitCode
}
