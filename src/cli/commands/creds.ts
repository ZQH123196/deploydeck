import { join } from 'node:path'
import { ConfigError } from '../../errors.js'
import type { CredentialsPort } from '../../ssh/credentials.js'
import type { SshCredentials } from '../../ssh/ports.js'
import { writeJson, writeLine } from '../output.js'
import type { CommandContext } from './shared.js'

/**
 * `creds <instanceId>`：打印一台实例的 SSH 登录信息。
 *
 * 它存在的理由只有一个：密码在控制台页面上是掩码，人只能靠本命令拿到明文。
 *
 * 判据：
 * - 密码只写 stdout。不落盘、不进日志、不进错误消息、不进截图文件名。
 * - 凭据来源只经 `CredentialsPort`。控制台定位、复制钩子、密码形状校验只有一份实现，
 *   命令不另写一套，也不读剪贴板。
 * - 只读：除了凭据动作自己的两张截图（落证据目录）之外不写任何文件，不改实例状态，不建计划。
 * - 人读模式下密码照样打出来。这不是缺陷，是这条命令存在的理由。
 */

/** 凭据证据目录名。它落在状态目录 runs 根下，与其它命令的现场目录并列。 */
export const CREDS_EVIDENCE_DIRECTORY = 'creds'

export interface CredsCommandOptions {
  /** 目标实例 ID。 */
  readonly instanceId: string
}

/**
 * `creds --json` 的输出形状。
 *
 * 键名直接取 `SshCredentials` 的字段名，不另起一套：同一份事实只允许一个名字。
 */
export interface CredsCommandResult {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
}

/**
 * 把端口给出的凭据收成输出形状。
 *
 * 纯函数，只做字段收口：不改写、不兜底、不补默认值。缺字段的凭据在端口层就已失败。
 */
export function toCredsCommandResult(credentials: SshCredentials): CredsCommandResult {
  return {
    host: credentials.host,
    port: credentials.port,
    user: credentials.user,
    password: credentials.password,
  }
}

/**
 * 把输出形状排成人读文本。
 *
 * 纯函数：它的输出会被写进 stdout，测试直接断言返回值即可，
 * 不必经过流。密码是最后一行，便于复制。
 */
export function formatCredsHumanReadable(result: CredsCommandResult): readonly string[] {
  return [
    `host: ${result.host}`,
    `port: ${String(result.port)}`,
    `user: ${result.user}`,
    `password: ${result.password}`,
  ]
}

/**
 * `creds` 命令实现。
 *
 * `openCredentials` 由调用方给出：装配浏览器通道属于 `dependencies.ts`，
 * 不在本文件的职责范围。命令只决定「取什么、写到哪里」。
 */
export async function runCredsCommand(
  context: CommandContext,
  options: CredsCommandOptions,
  openCredentials: (options: { readonly logDir: string }) => Promise<CredentialsPort>,
): Promise<void> {
  if (options.instanceId.trim().length === 0) {
    throw new ConfigError('instanceId 不能为空。')
  }

  // 证据目录口径：不带 run 的命令一律 <stateDir>/<命令名>/<instanceId>。
  // 路径解析的单一入口是 `commandEvidenceDir`，命令不自己拼。
  const logDir = await context.deps.commandEvidenceDir(
    CREDS_EVIDENCE_DIRECTORY,
    options.instanceId,
  )
  const port = await openCredentials({ logDir })
  try {
    const credentials = await port.readCredentials(options.instanceId)
    // 日志只记实例与目标主机端口。密码与用户名之外的凭据字段一律不进来：
    // 日志会被发给人、会被贴进工单，一次写出去就收不回来。
    context.deps.logger.info('creds.read', {
      instanceId: options.instanceId,
      host: credentials.host,
      port: credentials.port,
    })
    const result = toCredsCommandResult(credentials)
    if (context.json) {
      writeJson(context.deps.stdout, result)
      return
    }
    for (const line of formatCredsHumanReadable(result)) {
      writeLine(context.deps.stdout, line)
    }
  } finally {
    await port.close()
  }
}
