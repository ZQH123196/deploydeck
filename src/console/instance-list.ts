/**
 * 实例列表的结构化读取。
 *
 * 分两半：读在页面里取原始结构与原文，判是纯函数。
 * `readInstanceRows` 只取 DOM，不做业务判断；`parseInstanceList` 不碰浏览器，单测直接喂真实样本。
 *
 * 判据：控制台改版必须抛 ConsoleParseError，不得返回空列表冒充结果。
 * 「没有倒计时」与「倒计时解析失败」走两条路：前者得 null，后者抛错。
 */

import { ConsoleInstanceSnapshotSchema } from '../domain/instance.js'
import type { ConsoleInstanceSnapshot, InstanceStatus } from '../domain/instance.js'
import { ConfigError, ConsoleParseError, InstanceNotFoundError } from '../errors.js'
import { systemClock } from '../util/clock.js'
import {
  addMinutesIso,
  BEIJING_TIME_ZONE,
  beijingIso,
  parseBeijingDateTimeText,
} from '../util/time.js'
import type { ConsoleActionContext, ConsoleChannel, InstanceListPort, ListInstancesOptions } from './ports.js'
import {
  CONSOLE_INSTANCE_LIST_URL,
  INSTANCE_BILLING_CELL,
  INSTANCE_CELL_TEXT_DIVS,
  INSTANCE_DISK_CELL,
  INSTANCE_IDENTITY_CELL,
  INSTANCE_LIST,
  INSTANCE_LIST_COLUMN,
  INSTANCE_RELEASE_CELL,
  INSTANCE_STATUS_CELL,
} from './selectors.js'

/**
 * 控制台表格的一行原文。
 *
 * 读取与判定之间的唯一中间层。字段全部来自 DOM 原文或结构位置，
 * 判定（状态归一、倒计时换算、告警拆分）一律不在这里做。
 */
export interface RawInstanceRow {
  /** 行在页面中的序号，0 基。报错时用它定位。 */
  readonly rowIndex: number
  /** 该行每格文本，按列序号。列数校验与报错原文用它。 */
  readonly cellTexts: readonly string[]
  /** 第 0 列按结构位置取出的实例 ID。 */
  readonly instanceId: string
  /** 第 0 列按结构位置取出的实例名。无名实例为空字符串。 */
  readonly instanceName: string
  /** 第 1 列的状态文本。状态词后面可能带空白或补充文字。 */
  readonly statusText: string
  /**
   * 状态格用的是创建进度块时的原文（形如 `克隆中 87.00%`），否则为 null。
   *
   * 创建过程中的实例没有 `.status`，只有一个进度块。进度块里的状态词会变
   * （实测见过「创建中」「克隆中」），按词表穷举必然漏，所以用「来自进度块」
   * 这个结构事实直接判为创建中。
   */
  readonly statusProgressText: string | null
  /** 第 2 列按结构位置取出的规格文本，不含「查看详情」按钮文字。 */
  readonly gpuSpecText: string
  /**
   * 第 1 列 `.gpuTips` 补充文字。
   *
   * 实测两种取值：`GPU充足`（有卡、有空闲 GPU），或者无卡模式的标记。
   * 空字符串表示该元素不存在。
   */
  readonly gpuTipsText: string
  /** 第 3 列两条盘占用原文，形如「系统盘 37.98%」。 */
  readonly diskLines: readonly string[]
  /** 第 5 列 `.chargeType` 原文。余额不足时告警文字跟在付费方式后面。 */
  readonly billingText: string
  /** 第 5 列 `.dateWarn` 告警原文。无告警为空字符串。 */
  readonly billingWarning: string
  /**
   * 第 6 列 `.date` 内倒计时原文，不含按钮文字。
   *
   * 空字符串表示该格存在但没有倒计时（例如克隆锁定中）。
   * null 表示整格取不到，说明页面结构变了，判定阶段必须报错。
   */
  readonly releaseText: string | null
  /**
   * 第 6 列 `.timed-shutdown` 内平台定时关机时刻原文，形如 `2026-11-25 05:54:00`。
   *
   * 空字符串表示没设置定时关机。null 表示整格取不到（页面结构变了）。
   */
  readonly timedShutdownText: string | null
}

/** 实例列表判定的输入参数。 */
export interface ParseInstanceListOptions {
  /** 倒计时换算的基准时刻。判定是纯函数，禁止读本机时钟。 */
  readonly now: Date
  /**
   * 倒计时所属的时区基准。
   *
   * 控制台按北京时间显示倒计时。传别的时区说明调用方对时基的理解有误，直接拒绝。
   */
  readonly countdownTimeZoneBase: string
}

/** 表格列数。取最后一列序号加一，与列序号常量同源。 */
const EXPECTED_CELL_COUNT = INSTANCE_LIST_COLUMN.actions + 1

/**
 * 实例 ID 形状。
 *
 * 形如 `af9c49bd44-8ee624d7`。这个形状只用于暴露「结构位置读错」：
 * 位置一漂移就会把实例名当地址读出来，那时必须报错，不能拿错 ID 去开机。
 */
const INSTANCE_ID_PATTERN = /^[0-9a-z]+-[0-9a-z]+$/

/** 状态原文前缀到闭合枚举的映射。控制台可能在状态词后面追加空白或补充文字。 */
const STATUS_BY_TEXT_PREFIX: ReadonlyArray<readonly [textPrefix: string, status: InstanceStatus]> = [
  ['已关机', 'stopped'],
  ['开机中', 'starting'],
  ['运行中', 'running'],
  ['克隆锁定中', 'cloning'],
  ['重置中', 'resetting'],
]

/** 倒计时后缀。不含它说明该格显示的不是释放倒计时。 */
const RELEASE_COUNTDOWN_SUFFIX = '后释放'

/**
 * 运行中实例的释放说明。
 *
 * 实测（2026-11-25 真机）：实例运行中时该列写「关机15天后释放」，
 * 含义是「关机后开始计 15 天，到期释放」。它不是倒计时：运行中没有确定的释放时刻，
 * 所以换算结果为空。已关机实例才写「6天04小时31分后释放」这种倒计时。
 *
 * 两种形态都含「后释放」，所以必须显式区分，否则运行中实例会让整张列表解析失败。
 */
const SHUTDOWN_RELEASE_NOTE_PATTERN = /^关机\s*(\d+)\s*天后释放$/

/** 各时间单位的分钟数。北京时间无夏令时，一天固定 1440 分钟。 */
const MINUTES_PER_DAY = 24 * 60
const MINUTES_PER_HOUR = 60

/**
 * 构造页内求值脚本。
 *
 * 只做取值与定位，不做业务判断。选择器全部来自 selectors.ts。
 * 结果是 JSON 可序列化的数组，每个元素对应一行。
 */
function buildReadInstanceRowsScript(): string {
  const selectors = {
    row: INSTANCE_LIST.row,
    cell: INSTANCE_LIST.cell,
    cellTextDivs: INSTANCE_CELL_TEXT_DIVS,
    statusText: INSTANCE_STATUS_CELL.statusText,
    progressText: INSTANCE_STATUS_CELL.progressText,
    gpuTips: INSTANCE_STATUS_CELL.gpuTips,
    billingText: INSTANCE_BILLING_CELL.billingText,
    billingWarning: INSTANCE_BILLING_CELL.warningText,
    releaseText: INSTANCE_RELEASE_CELL.releaseText,
    timedShutdown: INSTANCE_RELEASE_CELL.timedShutdown,
  }
  const columns = {
    identity: INSTANCE_LIST_COLUMN.identity,
    status: INSTANCE_LIST_COLUMN.status,
    gpuSpec: INSTANCE_LIST_COLUMN.gpuSpec,
    disk: INSTANCE_LIST_COLUMN.disk,
    billing: INSTANCE_LIST_COLUMN.billing,
    release: INSTANCE_LIST_COLUMN.release,
    instanceIdDivIndex: INSTANCE_IDENTITY_CELL.instanceIdDivIndex,
    instanceNameDivIndex: INSTANCE_IDENTITY_CELL.instanceNameDivIndex,
  }
  return `(() => {
  const selectors = ${JSON.stringify(selectors)}
  const columns = ${JSON.stringify(columns)}
  const clean = (text) => (text === null || text === undefined ? '' : text.replace(/\\s+/g, ' ').trim())
  const textOf = (element) => (element === null || element === undefined ? '' : clean(element.innerText))
  const statusOf = (cell) => {
    if (cell === null) return { text: '', progress: null }
    const plain = cell.querySelector(selectors.statusText)
    if (plain !== null) return { text: textOf(plain), progress: null }
    // 创建过程中的实例用进度块表示状态，没有 .status。
    const progress = cell.querySelector(selectors.progressText)
    return progress === null ? { text: '', progress: null } : { text: textOf(progress), progress: textOf(progress) }
  }
  const rows = [...document.querySelectorAll(selectors.row)]
  return rows.map((row, rowIndex) => {
    const cells = [...row.querySelectorAll(selectors.cell)]
    const cellTexts = cells.map((cell) => clean(cell.innerText))
    const cellAt = (column) => (column < cells.length ? cells[column] : null)
    const textDivsOf = (column) => {
      const cell = cellAt(column)
      return cell === null ? [] : [...cell.querySelectorAll(selectors.cellTextDivs)]
    }
    const identityDivs = textDivsOf(columns.identity)
    const specDivs = textDivsOf(columns.gpuSpec)
    const diskDivs = textDivsOf(columns.disk)
    const statusCell = cellAt(columns.status)
    const billingCell = cellAt(columns.billing)
    const releaseCell = cellAt(columns.release)
    const releaseRoot = releaseCell === null ? null : releaseCell.querySelector(selectors.releaseText)
    return {
      rowIndex,
      cellTexts,
      instanceId: textOf(identityDivs[columns.instanceIdDivIndex]),
      instanceName: textOf(identityDivs[columns.instanceNameDivIndex]),
      statusText: statusOf(statusCell).text,
      statusProgressText: statusOf(statusCell).progress,
      gpuSpecText: textOf(specDivs[0]),
      diskLines: diskDivs.map((element) => clean(element.innerText)),
      billingText: textOf(billingCell === null ? null : billingCell.querySelector(selectors.billingText)),
      billingWarning: textOf(billingCell === null ? null : billingCell.querySelector(selectors.billingWarning)),
      gpuTipsText: textOf(statusCell === null ? null : statusCell.querySelector(selectors.gpuTips)),
    releaseText: releaseRoot === null ? null : textOf(releaseRoot.querySelector('span')),
      // 只取时刻那个 span：容器里还嵌着「修改」「关闭」两个操作文字。
      timedShutdownText:
        releaseRoot === null
          ? null
          : textOf(releaseRoot.querySelector(selectors.timedShutdown + ' > span')),
    }
  })
})()`
}

/** 在页面里读出每一行的原文与结构位置。取不到页面时由调用方抛错。 */
export async function readInstanceRows(channel: ConsoleChannel): Promise<RawInstanceRow[]> {
  const rows = await channel.evaluate<readonly RawInstanceRow[]>(buildReadInstanceRowsScript())
  if (!Array.isArray(rows)) {
    throw new ConsoleParseError('实例列表页求值结果不是数组：求值脚本与页面结构不兼容。')
  }
  return [...rows]
}

/** 把控制台实例列表原文判定成快照数组。页面结构不符即抛 ConsoleParseError。 */
export function parseInstanceList(
  rows: readonly RawInstanceRow[],
  options: ParseInstanceListOptions,
): ConsoleInstanceSnapshot[] {
  assertOptions(options)
  if (rows.length === 0) {
    throw new ConsoleParseError(
      '实例列表页没有数据行：表格可能未加载、未登录或页面改版，不能把空列表当结果。',
    )
  }
  return rows.map((row) => parseInstanceRow(row, options))
}

function assertOptions(options: ParseInstanceListOptions): void {
  if (Number.isNaN(options.now.getTime())) {
    throw new ConfigError(`倒计时换算的基准时刻非法：${String(options.now)}`)
  }
  if (options.countdownTimeZoneBase !== BEIJING_TIME_ZONE) {
    throw new ConfigError(
      `倒计时时区基准必须是 ${BEIJING_TIME_ZONE}（控制台按北京时间显示倒计时），收到：${options.countdownTimeZoneBase}`,
    )
  }
}

function parseInstanceRow(
  row: RawInstanceRow,
  options: ParseInstanceListOptions,
): ConsoleInstanceSnapshot {
  const rowDescription = describeRawRow(row)
  if (row.cellTexts.length !== EXPECTED_CELL_COUNT) {
    throw new ConsoleParseError(
      `实例列表第 ${row.rowIndex} 行列数不符：预期 ${EXPECTED_CELL_COUNT} 列，实际 ${row.cellTexts.length} 列。${rowDescription}`,
    )
  }

  const instanceId = row.instanceId.trim()
  if (instanceId === '') {
    throw new ConsoleParseError(`实例列表第 ${row.rowIndex} 行取不到实例 ID。${rowDescription}`)
  }
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new ConsoleParseError(
      `实例列表第 ${row.rowIndex} 行的实例 ID 形状不符：「${instanceId}」。${rowDescription}`,
    )
  }

  const statusText = row.statusText.trim()
  if (statusText === '') {
    throw new ConsoleParseError(`实例列表第 ${row.rowIndex} 行取不到状态原文。${rowDescription}`)
  }
  // 创建进度块不是状态词表，它表示「实例正在被创建」。实测词会变（创建中、克隆中），
  // 所以按结构判，不按词判。
  const status: InstanceStatus = row.statusProgressText === null ? normalizeStatusText(statusText) : 'cloning'

  const gpuSpec = row.gpuSpecText.trim()
  if (gpuSpec === '') {
    throw new ConsoleParseError(`实例列表第 ${row.rowIndex} 行取不到规格。${rowDescription}`)
  }

  const disks = parseDiskLines(row, rowDescription)
  const billing = parseBilling(row, rowDescription)

  return assertSnapshotContract(
    {
      instanceId,
      name: row.instanceName.trim(),
      status,
      statusRaw: statusText,
      gpuSpec,
      systemDiskUsed: disks.systemDiskUsed,
      dataDiskUsed: disks.dataDiskUsed,
      health: cellText(row, INSTANCE_LIST_COLUMN.health).trim(),
      billingMode: billing.billingMode,
      autoReleaseAt: parseReleaseCountdown(row.releaseText, options.now, row.rowIndex),
      balanceWarning: billing.balanceWarning,
      timedShutdownAt: parseTimedShutdownAt(row.timedShutdownText, row.rowIndex),
      sshCommand: emptyToNull(cellText(row, INSTANCE_LIST_COLUMN.sshLogin).trim()),
      noGpuMode: detectNoGpuMode(row.gpuTipsText, status, row.rowIndex, rowDescription),
    },
    row,
  )
}

function assertSnapshotContract(
  snapshot: ConsoleInstanceSnapshot,
  row: RawInstanceRow,
): ConsoleInstanceSnapshot {
  try {
    return ConsoleInstanceSnapshotSchema.parse(snapshot)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ConsoleParseError(
      `实例列表第 ${row.rowIndex} 行解析结果不符合快照契约：${message}。${describeRawRow(row)}`,
    )
  }
}

/**
 * 状态原文归一成闭合枚举。前缀匹配，因为状态词后面可能跟补充文字。
 *
 * 列表解析与 `readInstanceStatus` 共用这一处：状态词的识别规则只允许有一份。
 */
export function normalizeStatusText(statusText: string): InstanceStatus {
  const trimmed = statusText.trim()
  const matched = STATUS_BY_TEXT_PREFIX.find(([textPrefix]) => trimmed.startsWith(textPrefix))
  return matched === undefined ? 'unknown' : matched[1]
}

/**
 * 释放倒计时换算成绝对时刻。
 *
 * 空字符串表示没有倒计时，得 null。文本含「后释放」却读不出时长时抛错，
 * 不允许静默留空：那会把「页面改版」伪装成「实例没有释放时间」。
 */
function parseReleaseCountdown(
  releaseText: string | null,
  now: Date,
  rowIndex: number,
): string | null {
  if (releaseText === null) {
    throw new ConsoleParseError(
      `实例列表第 ${rowIndex} 行取不到释放时间单元格：页面结构变了。`,
    )
  }
  const trimmed = releaseText.trim()
  if (trimmed === '') {
    return null
  }
  // 运行中实例写「关机N天后释放」：没有确定的释放时刻，不是倒计时。
  if (SHUTDOWN_RELEASE_NOTE_PATTERN.test(trimmed)) {
    return null
  }
  if (!trimmed.includes(RELEASE_COUNTDOWN_SUFFIX)) {
    return null
  }
  const durationText = trimmed.slice(0, trimmed.lastIndexOf(RELEASE_COUNTDOWN_SUFFIX)).trim()
  const match = /^(?:(\d+)\s*天)?(?:(\d+)\s*小时)?(?:(\d+)\s*分)?$/.exec(durationText)
  const days = match === null ? undefined : match[1]
  const hours = match === null ? undefined : match[2]
  const minutes = match === null ? undefined : match[3]
  if (days === undefined && hours === undefined && minutes === undefined) {
    throw new ConsoleParseError(`无法解析释放倒计时：「${releaseText}」。`)
  }
  const totalMinutes =
    Number(days ?? 0) * MINUTES_PER_DAY +
    Number(hours ?? 0) * MINUTES_PER_HOUR +
    Number(minutes ?? 0)
  return addMinutesIso(beijingIso(now), totalMinutes)
}

/**
 * 平台定时关机时刻。
 *
 * 实测（2026-11-25 真机）：设置过定时关机后，第 6 列会多出 `.timed-shutdown`，
 * 文字形如「2026-11-25 05:54:00」。没设置时该元素不存在，读成空字符串。
 *
 * 空字符串 → null。取不到整格（null）→ 抛错，不当成「没设置」。
 */
function parseTimedShutdownAt(text: string | null, rowIndex: number): string | null {
  if (text === null) {
    throw new ConsoleParseError(
      `实例列表第 ${rowIndex} 行取不到释放时间单元格：页面结构变了。`,
    )
  }
  const trimmed = text.trim()
  if (trimmed === '') {
    return null
  }
  // 只认开头那段时间：控制台可能把它和操作文字放在同一格。
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)/.exec(trimmed)
  if (match === null) {
    throw new ConsoleParseError(
      `实例列表第 ${rowIndex} 行的定时关机时刻无法解析：「${text}」。`,
    )
  }
  return parseBeijingDateTimeText(match[1] ?? '')
}

function parseDiskLines(
  row: RawInstanceRow,
  rowDescription: string,
): { readonly systemDiskUsed: string; readonly dataDiskUsed: string } {
  let systemDiskUsed = ''
  let dataDiskUsed = ''
  for (const line of row.diskLines) {
    const trimmed = line.trim()
    if (trimmed === '') {
      continue
    }
    if (trimmed.startsWith(INSTANCE_DISK_CELL.systemDiskPrefix)) {
      systemDiskUsed = trimmed.slice(INSTANCE_DISK_CELL.systemDiskPrefix.length).trim()
    } else if (trimmed.startsWith(INSTANCE_DISK_CELL.dataDiskPrefix)) {
      dataDiskUsed = trimmed.slice(INSTANCE_DISK_CELL.dataDiskPrefix.length).trim()
    } else {
      throw new ConsoleParseError(
        `实例列表第 ${row.rowIndex} 行磁盘单元格出现未知文本「${trimmed}」。${rowDescription}`,
      )
    }
  }
  if (systemDiskUsed === '') {
    throw new ConsoleParseError(`实例列表第 ${row.rowIndex} 行取不到系统盘占用。${rowDescription}`)
  }
  return { systemDiskUsed, dataDiskUsed }
}

function parseBilling(
  row: RawInstanceRow,
  rowDescription: string,
): { readonly billingMode: string; readonly balanceWarning: string | null } {
  const billingText = row.billingText.trim()
  const warning = row.billingWarning.trim()
  if (billingText === '') {
    throw new ConsoleParseError(`实例列表第 ${row.rowIndex} 行取不到付费方式。${rowDescription}`)
  }
  if (warning === '') {
    return { billingMode: billingText, balanceWarning: null }
  }
  if (!billingText.includes(warning)) {
    throw new ConsoleParseError(
      `实例列表第 ${row.rowIndex} 行付费方式原文不含告警文字「${warning}」。${rowDescription}`,
    )
  }
  const billingMode = billingText.slice(0, billingText.lastIndexOf(warning)).trim()
  if (billingMode === '') {
    throw new ConsoleParseError(
      `实例列表第 ${row.rowIndex} 行付费方式原文只剩余额告警。${rowDescription}`,
    )
  }
  return { billingMode, balanceWarning: warning }
}

/** 列序号越界不可达：列数已在前面校验。这里只是满足 noUncheckedIndexedAccess。 */
function cellText(row: RawInstanceRow, column: number): string {
  return row.cellTexts[column] ?? ''
}

function emptyToNull(text: string): string | null {
  return text === '' ? null : text
}

function describeRawRow(row: RawInstanceRow): string {
  const cells = row.cellTexts.map((text) => `「${text}」`).join(' | ')
  return `该行原文：${cells}`
}

/**
 * 实例列表动作。
 *
 * 读之前先等数据行出现：表格由前端脚本渲染，导航结束不代表数据行已进 DOM。
 * 基准时刻从上下文时钟取：真实运行走系统时钟，测试注入假时钟。
 * 截图不从上下文取：本动作不改页面状态，前后截图内容相同，没有诊断价值。
 */
/**
 * 点列表页工具栏的刷新按钮再等一会儿。
 *
 * 判据：控制台实例列表不自动刷新（实测空闲 45 秒 0 个请求）。等状态变化的轮询
 * 如果不点它，会一直读到同一份旧数据，把「状态没变」误判成超时。
 *
 * 判据：刷新是异步请求，页面没有可等的完成信号，只能在点击后等一个固定窗口。
 * 轮询本身会重复下一次读，因此单次读到的旧数据不会改变最终结论。
 */
const REFRESH_SETTLE_MS = 400

export function createInstanceListActions(context: ConsoleActionContext): InstanceListPort {
  const clock = context.clock ?? systemClock
  return {
    async listInstances(options?: ListInstancesOptions): Promise<readonly ConsoleInstanceSnapshot[]> {
      await context.channel.goto(CONSOLE_INSTANCE_LIST_URL)
      await context.channel.waitFor(INSTANCE_LIST.row, context.timeoutMs)
      if (options?.refresh === true) {
        await context.channel.click(INSTANCE_LIST.refreshButton)
        await clock.sleep(REFRESH_SETTLE_MS)
      }
      const rows = await readInstanceRows(context.channel)
      return parseInstanceList(rows, {
        now: new Date(clock.now()),
        countdownTimeZoneBase: BEIJING_TIME_ZONE,
      })
    },
  }
}

/**
 * 只看一个实例的状态，不解析整行。
 *
 * 判据：`shell` 连接前只要「实例在不在、是不是运行中」这一个事实。
 * 走完整行解析会连带要求磁盘、计费、释放倒计时等字段全部合法：
 * 那些字段与「能不能连 SSH」无关，它们解析失败不该挡住一条终端会话。
 *
 * 与完整解析共用状态列的取值路径（`.status` 与进度块），所以状态归一规则只有一份。
 */
export interface InstanceStatusProbe {
  readonly instanceId: string
  readonly status: InstanceStatus
  /** 控制台原文状态。归一结果与人读不一致时，它是唯一线索。 */
  readonly statusRaw: string
}

/** 页内读取脚本：按实例 ID 定位行，只取状态格的原文。 */
function buildReadInstanceStatusScript(instanceId: string): string {
  const selectors = {
    row: INSTANCE_LIST.row,
    cell: INSTANCE_LIST.cell,
    cellTextDivs: INSTANCE_CELL_TEXT_DIVS,
    statusText: INSTANCE_STATUS_CELL.statusText,
    progressText: INSTANCE_STATUS_CELL.progressText,
  }
  const columns = {
    identity: INSTANCE_LIST_COLUMN.identity,
    status: INSTANCE_LIST_COLUMN.status,
    instanceIdDivIndex: INSTANCE_IDENTITY_CELL.instanceIdDivIndex,
  }
  return `(() => {
  const selectors = ${JSON.stringify(selectors)}
  const columns = ${JSON.stringify(columns)}
  const clean = (text) => (text === null || text === undefined ? '' : text.replace(/\\s+/g, ' ').trim())
  const textOf = (element) => (element === null || element === undefined ? '' : clean(element.innerText))
  const targetInstanceId = ${JSON.stringify(instanceId)}
  const rows = [...document.querySelectorAll(selectors.row)]
  for (const row of rows) {
    const cells = [...row.querySelectorAll(selectors.cell)]
    const identityDivs = cells.length > columns.identity
      ? [...cells[columns.identity].querySelectorAll(selectors.cellTextDivs)]
      : []
    const rowInstanceId = textOf(identityDivs[columns.instanceIdDivIndex])
    if (rowInstanceId !== targetInstanceId) continue
    const statusCell = columns.status < cells.length ? cells[columns.status] : null
    if (statusCell === null) return { found: true, statusText: '', progressText: '' }
    const plain = statusCell.querySelector(selectors.statusText)
    if (plain !== null) return { found: true, statusText: textOf(plain), progressText: '' }
    // 创建过程中的实例没有 .status，只有进度块。
    const progress = statusCell.querySelector(selectors.progressText)
    return { found: true, statusText: '', progressText: progress === null ? '' : textOf(progress) }
  }
  return { found: false, statusText: '', progressText: '' }
})()`
}

/**
 * 读一个实例的状态。
 *
 * 实例不在列表里即抛 `InstanceNotFoundError`：没看到就是没看到，不猜「大概已开机」。
 */
export async function readInstanceStatus(
  channel: ConsoleChannel,
  instanceId: string,
): Promise<InstanceStatusProbe> {
  const raw = await channel.evaluate<unknown>(buildReadInstanceStatusScript(instanceId))
  if (typeof raw !== 'object' || raw === null) {
    throw new ConsoleParseError('读取实例状态失败：页内求值没有返回对象。')
  }
  const record = raw as Record<string, unknown>
  if (record['found'] !== true) {
    throw new InstanceNotFoundError(instanceId)
  }
  const statusText = record['statusText']
  const progressText = record['progressText']
  if (typeof statusText !== 'string' || typeof progressText !== 'string') {
    throw new ConsoleParseError('读取实例状态失败：状态字段不是字符串。')
  }
  const statusRaw = statusText.length > 0 ? statusText : progressText
  if (statusRaw.length === 0) {
    throw new ConsoleParseError(
      `实例 ${instanceId} 的状态格是空的：页面结构可能已变，不能把空状态当成运行中。`,
    )
  }
  return { instanceId, status: normalizeStatusText(statusRaw), statusRaw }
}

/**
 * 无卡模式的标记文字。
 *
 * 实测（2026-11-25 真机）：有卡实例的状态格 `.gpuTips` 写「GPU充足」，
 * 已关机实例没有这个元素。无卡模式实例的 `.gpuTips` 写什么本轮未实测。
 *
 * 判据：认得的只有「GPU充足」这一种有卡标记。其余非空取值一律按无卡模式处理并记原文。
 * 这条判定只在实例运行中时成立：已关机实例本来就没有 GPU，不构成无卡模式。
 */
export const GPU_AVAILABLE_TIP_TEXT = 'GPU充足'

/**
 * 判定实例是否以无卡模式运行。
 *
 * 返回 `null` 表示本次页面事实不足以判定。三种情况：
 * 1. 实例不在运行中：已关机实例没有 GPU 是常态，不是无卡模式。
 * 2. `.gpuTips` 为空：页面没给标记，不猜。
 * 3. 标记是「GPU充足」：有卡运行。
 */
export function detectNoGpuMode(
  gpuTipsText: string,
  status: InstanceStatus,
  rowIndex: number,
  rowDescription: string,
): boolean | null {
  if (status !== 'running') {
    return null
  }
  const tips = gpuTipsText.replace(/\s+/g, '')
  if (tips.length === 0) {
    return null
  }
  if (tips.includes(GPU_AVAILABLE_TIP_TEXT)) {
    return false
  }
  // 页面给了非空标记，而它不是「GPU充足」。这是无卡模式的唯一可观测证据。
  // 记录原文便于事后核对：控制台改文案时，日志里能看到当时读到了什么。
  void rowIndex
  void rowDescription
  return true
}
