import { join } from 'node:path'
import type { ConsoleChannel, ConsoleRuntimeContext } from '../console/ports.js'
import { jsString } from '../console/dom.js'
import { buildVerifiedSelectorExpression } from '../console/locate.js'
import {
  CONSOLE_INSTANCE_LIST_URL,
  INSTANCE_CELL_TEXT_DIVS,
  INSTANCE_LIST,
  INSTANCE_LIST_COLUMN,
  SSH_LOGIN_CELL,
} from '../console/selectors.js'
import { parseLocatedSelector } from '../console/power.js'
import { ConsoleParseError } from '../errors.js'
import { pollUntil } from '../util/poll.js'
import { systemClock } from '../util/clock.js'
import type { SshCredentials } from './ports.js'

/**
 * 从控制台 SSH 登录列取凭据。
 *
 * 判据（2026-11-25 真机实测，见 docs/refs/autodl/console-selectors.md 第 1.8 节）：
 * 登录指令与密码在 DOM 里**都是掩码**（`ssh******`、`*********`），明文不在页面文本里。
 * 明文只在点复制图标那一瞬间存在：控制台建一个无类名 `textarea`，写入明文并选中，
 * 再调 `document.execCommand('copy')`。
 *
 * 所以取凭据的路径是「装钩子 → 点复制图标 → 读钩子记下的值」。
 * 读剪贴板不在方案内：剪贴板里可能有上一次复制的旧内容，把它当密码等于猜。
 *
 * 密码只在内存里传：不写日志、不落盘、不进错误消息、不进截图文件名。
 */

/** SSH 登录列的截图文件名。每个控制台动作前后各一张，落进本步日志目录。 */
const BEFORE_SCREENSHOT_NAME = 'ssh-login-cell-before.png'
const AFTER_SCREENSHOT_NAME = 'ssh-login-cell-after.png'

/** 密码的合理长度上限。超过这个长度多半是读错了元素，不是真密码。 */
const PASSWORD_MAX_LENGTH = 128

/** 复制图标的序号。实测第 7 列有两个图标：第一个复制登录指令，第二个复制密码。 */
const COPY_ICON_ORDINAL = { command: 0, password: 1 } as const

/** 登录指令解析结果。 */
export interface SshLoginCommand {
  readonly host: string
  readonly port: number
  readonly user: string
}

/** SSH 登录列的原始快照。行没匹配到时 `rowIndex` 为 null。 */
export interface SshLoginCellSnapshot {
  readonly rowIndex: number | null
  /**
   * 匹配到的行选择器，已回验指回同一行。
   *
   * 行序号在页面上按真实 DOM 的同层同名位置算，不按 `.el-table__row` 计数：
   * 两者在有多张表或不同标签混排时会错位，错位会点错行。
   */
  readonly rowSelector: string | null
  readonly text: string
}

/**
 * 打开实例列表页，定位实例所在行的 SSH 登录列，读出凭据。
 *
 * 找不到行、列为空、找不到复制图标、钩子没拿到值，全部抛 `ConsoleParseError`。
 * 不猜、不重试：这些情况都要人看一眼控制台。
 */
export async function readSshCredentials(
  context: ConsoleRuntimeContext,
  instanceId: string,
): Promise<SshCredentials> {
  const channel = context.channel
  await channel.goto(CONSOLE_INSTANCE_LIST_URL)
  await channel.waitFor(INSTANCE_LIST.row, context.timeoutMs)
  await channel.screenshot(join(context.logDir, BEFORE_SCREENSHOT_NAME))

  const snapshot = await readSshLoginCell(channel, instanceId)
  if (snapshot.rowIndex === null) {
    throw new ConsoleParseError(
      `控制台实例列表里找不到实例 ${instanceId}。实例可能已被销毁，或列表尚未刷新。`,
    )
  }
  if (snapshot.rowSelector === null) {
    throw new ConsoleParseError(
      `定位实例 ${instanceId} 所在的表格行失败：行选择器没有指回同一行，页面结构可能已变。`,
    )
  }
  if (snapshot.text.trim().length === 0) {
    throw new ConsoleParseError(
      `实例 ${instanceId} 的 SSH 登录列为空。实例可能未运行，或控制台结构已变。`,
    )
  }

  await channel.evaluate<unknown>(buildInstallCopyHookScript())
  const commandText = await copySecret(context, snapshot.rowSelector, COPY_ICON_ORDINAL.command, '登录指令')
  const passwordText = await copySecret(context, snapshot.rowSelector, COPY_ICON_ORDINAL.password, '密码')

  const command = parseSshLoginCommand(commandText)
  assertPasswordLike(passwordText)

  await channel.screenshot(join(context.logDir, AFTER_SCREENSHOT_NAME))
  return { host: command.host, port: command.port, user: command.user, password: passwordText }
}

/** 点第 N 个复制图标，等钩子记下明文，读完立刻清空。 */
async function copySecret(
  context: ConsoleRuntimeContext,
  rowSelector: string,
  ordinal: number,
  label: string,
): Promise<string> {
  const channel = context.channel
  const clock = context.clock ?? systemClock
  const located = parseLocatedSelector(
    await channel.evaluate<unknown>(buildLocateCopyIconScript(rowSelector, ordinal)),
  )
  if (located === undefined) {
    throw new ConsoleParseError(
      `实例列表的 SSH 登录列里找不到「${label}」的复制图标。控制台结构可能已变。`,
    )
  }

  await channel.click(located)

  const outcome = await pollUntil<string>({
    description: `等待「${label}」被复制`,
    timeoutMs: context.timeoutMs,
    intervalMs: context.pollIntervalMs,
    now: () => clock.now(),
    sleep: (milliseconds: number) => clock.sleep(milliseconds),
    probe: async () => {
      const value = await channel.evaluate<unknown>(buildReadCopiedValueScript())
      return typeof value === 'string' && value.length > 0 ? value : undefined
    },
  })
  if (outcome.status === 'timeout') {
    throw new ConsoleParseError(
      `点「${label}」的复制图标后没有读到明文（已等 ${String(context.timeoutMs)}ms）。` +
        '控制台可能改了复制方式，请人工核对。',
    )
  }
  return outcome.value
}

/**
 * 密码形状校验。
 *
 * 判据：非空、单 token、不超长。含空白说明读到的不是密码本身；
 * 超长说明读错了元素。不按字符集否定：平台可能改密码规则。
 */
export function assertPasswordLike(password: string): void {
  if (password.length === 0) {
    throw new ConsoleParseError('取到的 SSH 密码是空字符串。')
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new ConsoleParseError(
      `取到的 SSH 密码长度 ${String(password.length)} 超过上限 ${String(PASSWORD_MAX_LENGTH)}，可能读错了元素。`,
    )
  }
  if (/\s/.test(password)) {
    throw new ConsoleParseError('取到的 SSH 密码含空白字符，可能读错了元素。')
  }
}

/**
 * 解析登录指令。
 *
 * 实测形状是 `ssh -p 12345 root@region-xx.autodl.com`。
 * 不带 `-p` 时端口取 22。其他形状一律抛错，不猜默认值。
 */
export function parseSshLoginCommand(text: string): SshLoginCommand {
  const tokens = text.trim().split(/\s+/)
  const sshIndex = tokens.findIndex(isSshCommandToken)
  if (sshIndex < 0) {
    throw new ConsoleParseError(
      `SSH 登录列里找不到登录指令（形如 ssh -p 12345 root@host）：${describeCommandFailure(text)}`,
    )
  }

  let port = 22
  let target: string | null = null
  for (let index = sshIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token === '-p') {
      const portText = tokens[index + 1] ?? ''
      port = parsePort(portText, text)
      index += 1
      continue
    }
    if (/^-p\d+$/.test(token)) {
      port = parsePort(token.slice(2), text)
      continue
    }
    if (token.startsWith('-')) {
      // 其他选项（-o、-L 等）与本次取凭据无关，跳过。它们的参数不含 @，也会被跳过。
      continue
    }
    if (token.includes('@')) {
      target = token
      break
    }
  }

  if (target === null) {
    throw new ConsoleParseError(
      `SSH 登录指令里找不到「用户@主机」：${describeCommandFailure(text)}`,
    )
  }

  const atIndex = target.lastIndexOf('@')
  const user = target.slice(0, atIndex)
  const host = target.slice(atIndex + 1)
  if (!/^[A-Za-z0-9._-]+$/.test(user)) {
    throw new ConsoleParseError(`SSH 登录指令里的用户名不合法：${JSON.stringify(user)}`)
  }
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new ConsoleParseError(`SSH 登录指令里的主机不合法：${JSON.stringify(host)}`)
  }
  return { host, port, user }
}

/**
 * 判断一个 token 是不是登录指令的开头。
 *
 * 单元格文本由多个子元素拼成，标签与指令之间可能没有空格（如「登录指令：ssh」）。
 * 因此允许 token 以 `ssh` 结尾，但要求它前面不是 ASCII 字母或数字。
 */
function isSshCommandToken(token: string): boolean {
  const sshIndex = token.lastIndexOf(SSH_LOGIN_CELL.loginCommandPrefix)
  const prefixLength = SSH_LOGIN_CELL.loginCommandPrefix.length
  if (sshIndex < 0 || sshIndex + prefixLength !== token.length) {
    return false
  }
  if (sshIndex === 0) {
    return true
  }
  return !/[A-Za-z0-9]/.test(token[sshIndex - 1] ?? '')
}

function parsePort(portText: string, commandText: string): number {
  if (!/^\d+$/.test(portText)) {
    throw new ConsoleParseError(
      `SSH 登录指令里的端口不是十进制整数：${describeCommandFailure(commandText)}`,
    )
  }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConsoleParseError(`SSH 登录指令里的端口越界：${port}。`)
  }
  return port
}

/**
 * 报错用的指令摘要。
 *
 * 只回显到 `@` 之前的部分：`@` 之后不可能是密码，但截断更保险，
 * 避免将来页面把密码放进同一段文本时被错误消息带出去。
 */
function describeCommandFailure(text: string): string {
  const trimmed = text.trim()
  const atIndex = trimmed.indexOf('@')
  const summary = atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed
  const clipped = summary.length > 80 ? `${summary.slice(0, 80)}…` : summary
  return JSON.stringify(clipped)
}

async function readSshLoginCell(
  channel: ConsoleChannel,
  instanceId: string,
): Promise<SshLoginCellSnapshot> {
  const raw: unknown = await channel.evaluate<unknown>(buildReadSshLoginCellScript(instanceId))
  return assertLoginCellSnapshot(raw)
}

/**
 * 页内读取脚本。
 *
 * 只定位行与取整列文本，不解析凭据：凭据在文本里是掩码，解析不出东西。
 * 实例行按「身份列里的叶子 div 文本等于实例 ID」定位，不依赖 div 序号。
 */
export function buildReadSshLoginCellScript(instanceId: string): string {
  return `(() => {
  const rowSelector = ${jsString(INSTANCE_LIST.row)}
  const cellSelector = ${jsString(INSTANCE_LIST.cell)}
  const identityTextDivsSelector = ${jsString(INSTANCE_CELL_TEXT_DIVS)}
  const sshColumnIndex = ${INSTANCE_LIST_COLUMN.sshLogin}
  const targetInstanceId = ${jsString(instanceId)}
  const rows = Array.from(document.querySelectorAll(rowSelector))
  let matchedRow = null
  let matchedRowIndex = -1
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]
    const identityCell = row.querySelector(cellSelector)
    if (identityCell === null) continue
    const identityTextDivs = Array.from(identityCell.querySelectorAll(identityTextDivsSelector))
    const instanceIdDiv = identityTextDivs.find(
      (div) => (div.textContent || '').trim() === targetInstanceId,
    )
    if (instanceIdDiv === undefined) continue
    matchedRow = row
    matchedRowIndex = rowIndex
    break
  }
  if (matchedRow === null) return { rowIndex: null, rowSelector: null, text: '' }
  // 行选择器按真实 DOM 的同层同名位置生成，并回验指回同一行。
  let sameTagIndex = 1
  for (
    let sibling = matchedRow.previousElementSibling;
    sibling !== null;
    sibling = sibling.previousElementSibling
  ) {
    if (sibling.localName === matchedRow.localName) sameTagIndex += 1
  }
  const scopedRowSelector = rowSelector + ':nth-of-type(' + String(sameTagIndex) + ')'
  const rowSelectorIsValid = document.querySelector(scopedRowSelector) === matchedRow
  const sshCell = matchedRow.querySelectorAll(cellSelector)[sshColumnIndex]
  return {
    rowIndex: matchedRowIndex,
    rowSelector: rowSelectorIsValid ? scopedRowSelector : null,
    text: sshCell === undefined ? '' : (sshCell.textContent || '').trim(),
  }
})()`
}

/**
 * 装复制钩子。
 *
 * 控制台点复制图标时建一个无类名 `textarea`、写入明文、选中，再调
 * `document.execCommand('copy')`。钩子在调用前读 `document.activeElement.value`，
 * 把明文留在页面上供随后读取。幂等：重复调用只清空上次的值。
 */
export function buildInstallCopyHookScript(): string {
  return `(() => {
  window.__deploydeckCopied = null
  if (window.__deploydeckCopyHookInstalled === true) return true
  window.__deploydeckCopyHookInstalled = true
  const original = document.execCommand
  document.execCommand = function (...args) {
    const active = document.activeElement
    if (
      args[0] === 'copy' &&
      active !== null &&
      (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')
    ) {
      window.__deploydeckCopied = active.value
    }
    return original.apply(this, args)
  }
  return true
})()`
}

/** 读一次钩子记下的值并立即清空。没有值时返回 null。 */
export function buildReadCopiedValueScript(): string {
  return `(() => {
  const value = window.__deploydeckCopied
  window.__deploydeckCopied = null
  return typeof value === 'string' ? value : null
})()`
}

/**
 * 定位第 N 个复制图标，返回已回验的结构选择器。
 *
 * 图标本身没有文字，只有 `iconfont icon-fuzhi` 两个类名，且同类元素在页面里很多，
 * 所以作用域限定在目标行的 SSH 登录列内，再按序号取。
 */
export function buildLocateCopyIconScript(rowSelector: string, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new RangeError(`复制图标序号必须是非负整数，当前值：${String(ordinal)}`)
  }
  return `(() => {
  const row = document.querySelector(${jsString(rowSelector)})
  if (row === null) return null
  const cell = row.querySelectorAll(${jsString(INSTANCE_LIST.cell)})[${String(INSTANCE_LIST_COLUMN.sshLogin)}]
  if (cell === undefined) return null
  const icons = Array.from(cell.querySelectorAll(${jsString(`.${SSH_LOGIN_CELL.copyIconClassName}`)}))
  const icon = icons[${String(ordinal)}]
  if (icon === undefined) return null
${buildVerifiedSelectorExpression()}
  return toVerifiedSelector(icon)
})()`
}

/** 校验页内求值的返回值。页面结构变化会返回别的形状，必须立即报错。 */
function assertLoginCellSnapshot(raw: unknown): SshLoginCellSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConsoleParseError('读取 SSH 登录列失败：页内求值没有返回对象。')
  }
  const record = raw as Record<string, unknown>
  const rowIndex = record['rowIndex']
  if (
    rowIndex !== null &&
    (typeof rowIndex !== 'number' || !Number.isInteger(rowIndex) || rowIndex < 0)
  ) {
    throw new ConsoleParseError('读取 SSH 登录列失败：rowIndex 不是非负整数或 null。')
  }
  const rowSelector = record['rowSelector']
  if (rowSelector !== null && typeof rowSelector !== 'string') {
    throw new ConsoleParseError('读取 SSH 登录列失败：rowSelector 不是字符串或 null。')
  }
  const text = record['text']
  if (typeof text !== 'string') {
    throw new ConsoleParseError('读取 SSH 登录列失败：text 不是字符串。')
  }
  return { rowIndex, rowSelector, text }
}
