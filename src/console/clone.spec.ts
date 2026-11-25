import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleInstanceSnapshot, InstanceStatus } from '../domain/instance.js'
import {
  CloneQuotaExhaustedError,
  CloneSourceUnavailableError,
  CloneTargetUnavailableError,
  CloneTimeoutError,
  ConsoleParseError,
  HumanRequiredError,
  InstanceNotFoundError,
} from '../errors.js'
import type { Logger } from '../logging/logger.js'
import type { Clock } from '../util/clock.js'
import {
  buildReadCloneDialogScript,
  buildReadCloneHostPageScript,
  buildReadCreateFailureNoticeScript,
  buildReadRenameInputValueScript,
  buildRenameBlurScript,
  createCloneActions,
  hostPageSnapshotSignature,
  hostRowMatchesGpuModel,
  parseCloneDialogProbe,
  parseCloneHostPageSnapshot,
  parseCloneQuota,
  parseFreeGpu,
  parseRenameInputValue,
  parseUnitPriceYuanPerHour,
  readCloneHostSourceId,
  readHostCpuCores,
} from './clone.js'
import type { ClonePort, ConsoleChannel, ConsoleRuntimeContext, ListInstancesOptions } from './ports.js'
import {
  CLONE_HOST_PAGE,
  CONSOLE_CLONE_HOST_URL_PREFIX,
  CONSOLE_INSTANCE_LIST_URL,
  INSTANCE_IDENTITY_CELL,
} from './selectors.js'

/**
 * 克隆实例的单测。
 *
 * 全部走假通道、假列表、假时钟：不连控制台，不点真实「创建并开机」。
 * 克隆会真的创建实例并计费，真机验证只能由人工发起。
 *
 * 假通道按求值脚本的内容分派，返回与真实页面同形的结构与可点击选择器；
 * 点击只改假状态。列表的 refresh 语义也照实测做：不刷新就看不到新实例。
 */

const SOURCE_INSTANCE_ID = 'src-0001'
const CREATED_INSTANCE_ID = 'clone-0001'

const ROW_SELECTOR = '[data-fake="row"]'
const MORE_SELECTOR = '[data-fake="more"]'
const MENU_ITEM_SELECTOR = '[data-fake="clone-menu-item"]'
const DIALOG_SELECTOR = '[data-fake="dialog"]'
const DIALOG_CLOSE_SELECTOR = '[data-fake="dialog-close"]'
const DIALOG_DATA_DISK_SELECTOR = '[data-fake="dialog-data-disk"]'
const DIALOG_SPARSE_SELECTOR = '[data-fake="dialog-sparse"]'
const DIALOG_CONTINUE_SELECTOR = '[data-fake="dialog-continue"]'
const BILLING_SELECTOR = '[data-fake="billing"]'
const CONFIRM_SELECTOR = '[data-fake="confirm"]'
const RENAME_BUTTON_SELECTOR = '[data-fake="rename-button"]'

/** 改名输入框的选择器：行选择器 + 选择器单一来源里的行内输入框。 */
function renameInputSelector(): string {
  return `${ROW_SELECTOR} ${INSTANCE_IDENTITY_CELL.renameInput}`
}

function regionSelector(regionText: string): string {
  return `[data-fake="region:${regionText}"]`
}

function gpuModelSelector(modelName: string): string {
  return `[data-fake="gpu-model:${modelName}"]`
}

function hostRowSelector(hostId: string): string {
  return `[data-fake="host-row:${hostId}"]`
}

const STATUS_RAW: Readonly<Record<InstanceStatus, string>> = {
  stopped: '已关机',
  starting: '开机中',
  running: '运行中',
  cloning: '克隆锁定中',
  resetting: '重置中',
  unknown: '未知状态',
}

interface FakeGpuModelConfig {
  readonly name: string
  readonly free: number
  readonly total: number
  readonly checked?: boolean
  readonly disabled?: boolean
}

interface FakeHostRowConfig {
  readonly hostId: string
  readonly modelName: string
  readonly freeGpu: number
  readonly totalGpu: number
  readonly priceYuanPerHour: number
}

interface FakeConsoleOptions {
  readonly sourceStatus?: InstanceStatus
  readonly omitSourceInstance?: boolean
  readonly extraInstanceIds?: readonly string[]
  readonly quota?: number
  readonly cloneDataDiskDefault?: boolean
  readonly dataDiskDisabled?: boolean
  readonly sparseFileDefault?: boolean
  readonly billingDefaultChecked?: boolean
  readonly gpuModels?: readonly FakeGpuModelConfig[]
  readonly hostRows?: readonly FakeHostRowConfig[]
  readonly regionTexts?: readonly string[]
  readonly createdStatuses?: readonly InstanceStatus[]
  readonly createdInstanceId?: string
  readonly extraCreatedInstanceIds?: readonly string[]
  readonly cloneHostSourceId?: string
  readonly platformNavigatesAfterConfirm?: boolean
  readonly confirmAlwaysDisabled?: boolean
  readonly createFailureNotice?: string
  /** 新实例创建时的名字。缺省为空串：实测克隆不复制实例名。 */
  readonly createdInstanceName?: string
  /** 打开改名输入框，但失焦后不提交。用来模拟改名没有生效。 */
  readonly renameIgnored?: boolean
}

const DEFAULT_GPU_MODELS: readonly FakeGpuModelConfig[] = [
  { name: 'RTX 4090', free: 5, total: 100, checked: true },
  { name: 'vGPU-32GB', free: 128, total: 2510 },
  { name: 'vGPU-48GB', free: 43, total: 960 },
  { name: 'RTX 5090', free: 20, total: 2064 },
]

const DEFAULT_HOST_ROWS: readonly FakeHostRowConfig[] = [
  { hostId: 'host-empty', modelName: 'vGPU-32GB', freeGpu: 0, totalGpu: 8, priceYuanPerHour: 1.58 },
  { hostId: 'host-a', modelName: 'vGPU-32GB', freeGpu: 1, totalGpu: 8, priceYuanPerHour: 1.58 },
  { hostId: 'host-b', modelName: 'vGPU-48GB', freeGpu: 2, totalGpu: 8, priceYuanPerHour: 2.1 },
  { hostId: 'host-c', modelName: 'RTX 5090', freeGpu: 1, totalGpu: 8, priceYuanPerHour: 3 },
  { hostId: 'host-d', modelName: 'RTX 4090', freeGpu: 1, totalGpu: 8, priceYuanPerHour: 1.88 },
]

const DEFAULT_REGION_TEXTS: readonly string[] = [
  '西北B区',
  '北京B区',
  '重庆A区',
  '内蒙B区',
  '北京A区',
  '佛山区',
]

function buildInstanceSnapshot(
  instanceId: string,
  status: InstanceStatus,
  name?: string,
): ConsoleInstanceSnapshot {
  return {
    instanceId,
    name: name ?? instanceId,
    status,
    statusRaw: STATUS_RAW[status],
    gpuSpec: 'vGPU-32GB * 1卡',
    systemDiskUsed: '系统盘 37.98%',
    dataDiskUsed: '',
    health: '正常',
    billingMode: '按量计费',
    autoReleaseAt: null,
    balanceWarning: null,
    timedShutdownAt: null,
    sshCommand: null,
  }
}

function readFakeClickTarget(selector: string): string | undefined {
  const match = /^\[data-fake="(.+)"\]$/.exec(selector)
  return match?.[1]
}

class FakeConsole implements ConsoleChannel {
  url = CONSOLE_INSTANCE_LIST_URL
  dialogOpen = false
  dropdownOpen = false
  quota: number
  dataDiskChecked: boolean
  dataDiskDisabled: boolean
  sparseFileEnabled: boolean
  billingChecked: boolean
  regionChecked = '西北B区'
  selectedHost: string | null = null
  selectedModel: string
  confirmed = false
  evaluateCount = 0
  /** 新实例在列表里的名字。实测克隆后为空串，改名提交后才变成目标名字。 */
  renamedName: string | null
  /** 改名输入框是否处于编辑态。点「设置名称」后为 true，失焦后为 false。 */
  renameEditing = false
  readonly typedTexts: string[] = []
  readonly clicks: string[] = []
  readonly screenshots: string[] = []
  readonly navigations: string[] = []
  readonly listCalls: { readonly refresh: boolean; readonly afterConfirm: boolean }[] = []
  private readonly sourceInstanceId = SOURCE_INSTANCE_ID
  private readonly omitSourceInstance: boolean
  private readonly extraInstanceIds: readonly string[]
  private readonly sourceStatus: InstanceStatus
  private readonly gpuModels: {
    name: string
    free: number
    total: number
    checked: boolean
    disabled: boolean
  }[]
  private readonly hostRows: readonly FakeHostRowConfig[]
  private readonly regionTexts: readonly string[]
  private readonly createdInstanceId: string
  private readonly extraCreatedInstanceIds: readonly string[]
  private readonly createdStatuses: readonly InstanceStatus[]
  private readonly cloneHostUrl: string
  private readonly platformNavigatesAfterConfirm: boolean
  private readonly confirmAlwaysDisabled: boolean
  private readonly createFailureNotice: string | undefined
  private readonly renameIgnored: boolean
  private renameDraftValue = ''
  private createdVisible = false
  private createdStatusIndex = 0
  private staleModelName: string
  private tableRefreshRemaining = 0

  constructor(options: FakeConsoleOptions = {}) {
    this.quota = options.quota ?? 10
    this.omitSourceInstance = options.omitSourceInstance ?? false
    this.extraInstanceIds = options.extraInstanceIds ?? []
    this.sourceStatus = options.sourceStatus ?? 'stopped'
    this.dataDiskChecked = options.cloneDataDiskDefault ?? false
    this.dataDiskDisabled = options.dataDiskDisabled ?? false
    this.sparseFileEnabled = options.sparseFileDefault ?? false
    this.billingChecked = options.billingDefaultChecked ?? true
    this.platformNavigatesAfterConfirm = options.platformNavigatesAfterConfirm ?? true
    this.confirmAlwaysDisabled = options.confirmAlwaysDisabled ?? false
    this.createFailureNotice = options.createFailureNotice
    this.renameIgnored = options.renameIgnored ?? false
    this.renamedName = options.createdInstanceName ?? null
    this.regionTexts = options.regionTexts ?? DEFAULT_REGION_TEXTS
    this.createdInstanceId = options.createdInstanceId ?? CREATED_INSTANCE_ID
    this.extraCreatedInstanceIds = options.extraCreatedInstanceIds ?? []
    this.createdStatuses = options.createdStatuses ?? ['cloning', 'cloning', 'cloning', 'running']
    this.gpuModels = (options.gpuModels ?? DEFAULT_GPU_MODELS).map((model) => ({
      name: model.name,
      free: model.free,
      total: model.total,
      checked: model.checked ?? false,
      disabled: model.disabled ?? false,
    }))
    this.hostRows = options.hostRows ?? DEFAULT_HOST_ROWS
    this.selectedModel =
      this.gpuModels.find((model) => model.checked)?.name ?? this.gpuModels[0]?.name ?? ''
    this.staleModelName = this.selectedModel
    const sourceFromUrl = options.cloneHostSourceId ?? SOURCE_INSTANCE_ID
    this.cloneHostUrl = `${CONSOLE_CLONE_HOST_URL_PREFIX}?region=west-B&id=${sourceFromUrl}&name=src-0001`
  }

  async listInstances(options?: ListInstancesOptions): Promise<readonly ConsoleInstanceSnapshot[]> {
    const refresh = options?.refresh === true
    this.listCalls.push({ refresh, afterConfirm: this.confirmed })
    const snapshots: ConsoleInstanceSnapshot[] = this.extraInstanceIds.map((instanceId) =>
      buildInstanceSnapshot(instanceId, 'running'),
    )
    if (!this.omitSourceInstance) {
      snapshots.push(buildInstanceSnapshot(this.sourceInstanceId, this.sourceStatus))
    }
    if (this.confirmed) {
      // 实测：实例列表不自动刷新。不点刷新就读不到新建实例，也看不到状态推进。
      if (refresh) {
        if (!this.createdVisible) {
          this.createdVisible = true
          this.createdStatusIndex = 0
        } else {
          this.createdStatusIndex = Math.min(
            this.createdStatusIndex + 1,
            this.createdStatuses.length - 1,
          )
        }
      }
      if (this.createdVisible) {
        const status = this.createdStatuses[this.createdStatusIndex] ?? 'cloning'
        snapshots.push(
          buildInstanceSnapshot(this.createdInstanceId, status, this.renamedName ?? ''),
        )
        for (const instanceId of this.extraCreatedInstanceIds) {
          snapshots.push(buildInstanceSnapshot(instanceId, 'cloning'))
        }
      }
    }
    return snapshots
  }

  async goto(url: string): Promise<void> {
    this.navigations.push(url)
    this.url = url
  }

  async currentUrl(): Promise<string> {
    return this.url
  }

  async evaluate<Result>(script: string): Promise<Result> {
    this.evaluateCount += 1
    // 改名：失焦脚本只做 blur；读 value 脚本按输入框是否出现返回 null 或字符串。
    if (script.includes('input.blur()')) {
      return this.blurRenameInput() as Result
    }
    if (script.includes('input.value')) {
      return this.renameInputValue() as Result
    }
    if (script.includes('.el-message--error')) {
      const notice = this.createFailureNotice
      return {
        notices: this.confirmed && notice !== undefined ? [notice] : [],
      } as Result
    }
    if (script.includes('.el-dialog__footer')) {
      return this.cloneDialogProbe() as Result
    }
    if (script.includes('.el-radio-group')) {
      return this.cloneHostPageSnapshot() as Result
    }
    if (script.includes('.el-dropdown__popper')) {
      return this.menuProbe() as Result
    }
    if (script.includes('querySelectorAll("button")')) {
      if (script.includes('"更多"')) {
        return MORE_SELECTOR as Result
      }
      if (script.includes(JSON.stringify(INSTANCE_IDENTITY_CELL.renameButtonText))) {
        return RENAME_BUTTON_SELECTOR as Result
      }
      throw new Error(`假通道不认识按钮定位脚本：${script.slice(0, 120)}`)
    }
    if (script.includes('.el-table__row')) {
      return ROW_SELECTOR as Result
    }
    throw new Error(`假通道不认识求值脚本：${script.slice(0, 120)}`)
  }

  async click(selector: string): Promise<void> {
    const target = readFakeClickTarget(selector)
    if (target === undefined) {
      throw new Error(`假通道不认识点击选择器：${selector}`)
    }
    this.clicks.push(selector)
    if (target === 'more') {
      // 下拉是开关语义：重复点会把刚打开的菜单关掉。
      this.dropdownOpen = !this.dropdownOpen
      return
    }
    if (target === 'clone-menu-item') {
      if (!this.dropdownOpen) {
        throw new Error('下拉没展开就点了「克隆实例新」')
      }
      this.dropdownOpen = false
      this.dialogOpen = true
      return
    }
    if (target === 'dialog-close') {
      this.dialogOpen = false
      return
    }
    if (target === 'dialog-data-disk') {
      if (this.dataDiskDisabled) {
        throw new Error('禁用的「数据盘」复选框不该被点击')
      }
      this.dataDiskChecked = !this.dataDiskChecked
      return
    }
    if (target === 'dialog-sparse') {
      this.sparseFileEnabled = !this.sparseFileEnabled
      return
    }
    if (target === 'dialog-continue') {
      if (!this.dialogOpen) {
        throw new Error('对话框没打开就点了「继续」')
      }
      this.dialogOpen = false
      this.url = this.cloneHostUrl
      return
    }
    if (target === 'billing') {
      this.billingChecked = true
      return
    }
    if (target.startsWith('region:')) {
      this.regionChecked = target.slice('region:'.length)
      return
    }
    if (target.startsWith('gpu-model:')) {
      this.selectModel(target.slice('gpu-model:'.length))
      return
    }
    if (target.startsWith('host-row:')) {
      this.selectedHost = target.slice('host-row:'.length)
      return
    }
    if (target === 'rename-button') {
      if (this.renamedName !== null) {
        throw new Error('实例已经有名字还点了「设置名称」')
      }
      this.renameEditing = true
      this.renameDraftValue = ''
      return
    }
    if (target === 'confirm') {
      this.confirmInstance()
      return
    }
    throw new Error(`假通道不认识点击目标：${target}`)
  }

  async type(selector: string, text: string): Promise<void> {
    if (!this.renameEditing) {
      throw new Error('改名输入框没出现就写了文字')
    }
    const expected = renameInputSelector()
    if (selector !== expected) {
      throw new Error(`写入了非改名输入框的选择器：${selector}`)
    }
    // 真实通道先点输入框取得焦点，再全选、退格、写入。假通道只记文本。
    this.typedTexts.push(text)
    this.renameDraftValue = text
  }

  async waitFor(): Promise<void> {
    throw new Error('克隆动作不该调用 waitFor：轮询一律走 pollUntil 与假时钟')
  }

  async waitForGone(): Promise<void> {
    throw new Error('克隆动作不该调用 waitForGone')
  }

  async screenshot(filePath: string): Promise<void> {
    this.screenshots.push(filePath)
  }

  async close(): Promise<void> {
    // 假通道没有连接要关。
  }

  private menuProbe(): unknown {
    if (!this.dropdownOpen) {
      return { kind: 'no-visible-popper' }
    }
    return {
      kind: 'located',
      selector: MENU_ITEM_SELECTOR,
      itemText: '克隆实例新',
      matchedBy: 'single-visible',
    }
  }

  private cloneDialogProbe(): unknown {
    if (!this.dialogOpen) {
      return { kind: 'absent' }
    }
    return {
      kind: 'dialog',
      selector: DIALOG_SELECTOR,
      title: '克隆实例',
      footerText: `今天剩余克隆次数：${String(this.quota)}次`,
      checkboxes: [
        { text: '系统盘', checked: true, disabled: true, toggleSelector: '[data-fake="dialog-system-disk"]' },
        {
          text: '数据盘',
          checked: this.dataDiskChecked,
          disabled: this.dataDiskDisabled,
          toggleSelector: DIALOG_DATA_DISK_SELECTOR,
        },
      ],
      sparseFileEnabled: this.sparseFileEnabled,
      sparseToggleSelector: DIALOG_SPARSE_SELECTOR,
      continueSelector: DIALOG_CONTINUE_SELECTOR,
      closeSelector: DIALOG_CLOSE_SELECTOR,
    }
  }

  private cloneHostPageSnapshot(): unknown {
    if (this.url !== this.cloneHostUrl) {
      return { radioGroups: [], checkboxes: [], rows: [], confirmButton: null }
    }
    const radioGroups = [
      {
        buttons: [
          { text: '按量计费', checked: this.billingChecked, selector: BILLING_SELECTOR },
          { text: '包日', checked: !this.billingChecked, selector: '[data-fake="billing-daily"]' },
          { text: '包周', checked: false, selector: '[data-fake="billing-weekly"]' },
          { text: '包月', checked: false, selector: '[data-fake="billing-monthly"]' },
        ],
      },
      {
        buttons: this.regionTexts.map((text) => ({
          text,
          checked: text === this.regionChecked,
          selector: regionSelector(text),
        })),
      },
      {
        buttons: ['V100专区', 'A800专区', '摩尔线程专区'].map((text) => ({
          text,
          checked: false,
          selector: `[data-fake="zone:${text}"]`,
        })),
      },
      {
        buttons: [
          { text: '1', checked: true, selector: '[data-fake="gpu-count:1"]' },
          { text: '2', checked: false, selector: '[data-fake="gpu-count:2"]' },
        ],
      },
    ]
    const checkboxes = [
      { text: '全部', checked: false, disabled: false, toggleSelector: '[data-fake="gpu-all"]' },
      ...this.gpuModels.map((model) => ({
        text: `${model.name} (${String(model.free)}/${String(model.total)})`,
        checked: model.checked,
        disabled: model.disabled,
        toggleSelector: gpuModelSelector(model.name),
      })),
    ]
    let tableModel = this.selectedModel
    if (this.tableRefreshRemaining > 0) {
      this.tableRefreshRemaining -= 1
      tableModel = this.staleModelName
    }
    const rows = this.hostRows
      .filter((row) => row.modelName === tableModel)
      .map((row) => ({
        cells: [
          row.hostId,
          `${row.hostId}机`,
          `${row.modelName} 32GB`,
          `${String(row.freeGpu)} / ${String(row.totalGpu)}`,
          'CPU：16核 内存：62GB',
          'Genuine',
          '数据盘：50GB 可扩容：0GB',
          '驱动：595.71.05 CUDA：13.2',
          `￥${row.priceYuanPerHour.toFixed(2)}/时 ￥${(row.priceYuanPerHour * 1.05).toFixed(2)}/时`,
        ],
        radioChecked: this.selectedHost === row.hostId,
        radioSelector: hostRowSelector(row.hostId),
      }))
    return {
      radioGroups,
      checkboxes,
      rows,
      confirmButton: {
        text: CLONE_HOST_PAGE.confirmButtonText,
        disabled: this.selectedHost === null || this.confirmAlwaysDisabled,
        selector: CONFIRM_SELECTOR,
      },
    }
  }

  private selectModel(name: string): void {
    this.staleModelName = this.selectedModel
    this.selectedModel = name
    for (const model of this.gpuModels) {
      model.checked = model.name === name
    }
    // 真实页面在新型号的表格刷新前还会短暂显示旧型号的行。给 4 次读数留出窗口。
    this.tableRefreshRemaining = 4
    this.selectedHost = null
  }

  private confirmInstance(): void {
    if (this.selectedHost === null) {
      throw new Error('没有选中主机就点了「创建并开机」')
    }
    this.confirmed = true
    if (this.platformNavigatesAfterConfirm) {
      this.url = CONSOLE_INSTANCE_LIST_URL
    }
  }

  /** 输入框只在编辑态存在。不在编辑态时返回 null，与真实页面「找不到输入框」同形。 */
  private renameInputValue(): unknown {
    return this.renameEditing ? this.renameDraftValue : null
  }

  /** 失焦提交。实测回车不提交；改名生效后列表里的 name 才变成新名字。 */
  private blurRenameInput(): unknown {
    if (!this.renameEditing) {
      return false
    }
    this.renameEditing = false
    if (!this.renameIgnored) {
      this.renamedName = this.renameDraftValue
    }
    return true
  }
}

function createManualClock(): Clock {
  let current = 0
  return {
    now: () => current,
    sleep: async (milliseconds) => {
      current += milliseconds
    },
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

async function createLogDirectory(): Promise<string> {
  const base = join(process.cwd(), '.tmp')
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, 'clone-spec-'))
  temporaryDirectories.push(directory)
  return directory
}

/** 静默 logger：用例不关心日志时不让 run 目录之外的输出混进测试输出。 */
function createSilentLogger(): Logger {
  const ignore = (): void => undefined
  return { info: ignore, warn: ignore, error: ignore }
}

interface Fixture {
  readonly console: FakeConsole
  readonly logDir: string
  readonly actions: ClonePort
}

async function createFixture(
  options: FakeConsoleOptions = {},
  logger: Logger = createSilentLogger(),
): Promise<Fixture> {
  const logDir = await createLogDirectory()
  const fake = new FakeConsole(options)
  const context: ConsoleRuntimeContext = {
    channel: fake,
    logDir,
    timeoutMs: 1000,
    pollIntervalMs: 100,
    clock: createManualClock(),
    instances: { listInstances: (listOptions) => fake.listInstances(listOptions) },
    logger,
  }
  return { console: fake, logDir, actions: createCloneActions(context) }
}

function buildCloneRequest(overrides: {
  readonly gpuPreference?: readonly string[]
  readonly regionPreference?: readonly string[]
  readonly cloneDataDisk?: boolean
}): Parameters<ClonePort['clone']>[0] {
  return {
    sourceInstanceId: SOURCE_INSTANCE_ID,
    gpuPreference: overrides.gpuPreference ?? ['v-32g-p'],
    regionPreference: overrides.regionPreference ?? [],
    cloneDataDisk: overrides.cloneDataDisk ?? true,
    instanceName: 'trans-dev',
  }
}

async function captureError(action: Promise<unknown>): Promise<unknown> {
  return action.then(
    () => undefined,
    (error: unknown) => error,
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readStepLog(logDir: string): Promise<string> {
  return readFile(join(logDir, 'clone-steps.jsonl'), 'utf8')
}

describe('readCloneQuota', () => {
  it('从对话框页脚读出剩余次数，并用右上角 × 关闭对话框', async () => {
    const fixture = await createFixture({ quota: 7 })

    const remaining = await fixture.actions.readCloneQuota(SOURCE_INSTANCE_ID)

    expect(remaining).toBe(7)
    expect(fixture.console.dialogOpen).toBe(false)
    expect(fixture.console.clicks).toContain(DIALOG_CLOSE_SELECTOR)
    expect(fixture.console.screenshots.some((path) => path.endsWith('clone-quota-01-open.png'))).toBe(true)
  })
})

describe('clone 前置校验', () => {
  it('配额为 0 时抛错，并提示改用开机复用路径', async () => {
    const fixture = await createFixture({ quota: 0 })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(CloneQuotaExhaustedError)
    expect(messageOf(error)).toContain('今日克隆次数已用尽，可改用开机复用路径')
    expect(fixture.console.dialogOpen).toBe(false)
    expect(fixture.console.confirmed).toBe(false)
    expect(fixture.console.clicks).not.toContain(CONFIRM_SELECTOR)
  })

  it('源实例不在列表里时抛错，且没有点任何按钮', async () => {
    const fixture = await createFixture({ omitSourceInstance: true })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(InstanceNotFoundError)
    expect(fixture.console.clicks).toEqual([])
    expect(fixture.console.screenshots).toEqual([])
  })

  it('源实例不是已关机时抛错，且没有点任何按钮', async () => {
    const fixture = await createFixture({ sourceStatus: 'running' })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(CloneSourceUnavailableError)
    expect(messageOf(error)).toContain('克隆前必须先关机')
    expect(fixture.console.clicks).toEqual([])
    expect(fixture.console.confirmed).toBe(false)
  })
})

describe('clone 正常路径', () => {
  it('设置选项、选地区与型号、选主机、创建并等到新实例', async () => {
    const fixture = await createFixture({
      extraInstanceIds: ['other-0001'],
      billingDefaultChecked: false,
    })

    const outcome = await fixture.actions.clone(
      buildCloneRequest({ gpuPreference: ['v-32g-p'], regionPreference: ['重庆A区'] }),
    )

    expect(outcome).toEqual({
      instanceId: CREATED_INSTANCE_ID,
      sourceInstanceId: SOURCE_INSTANCE_ID,
    })
    // 数据盘与稀疏优化都是显式设置的，不依赖平台默认值。
    expect(fixture.console.dataDiskChecked).toBe(true)
    expect(fixture.console.sparseFileEnabled).toBe(true)
    // 计费方式按实测显式点「按量计费」；地区按偏好改选；型号按映射表落到页面显示名。
    expect(fixture.console.clicks).toContain(BILLING_SELECTOR)
    expect(fixture.console.clicks).toContain(regionSelector('重庆A区'))
    expect(fixture.console.regionChecked).toBe('重庆A区')
    expect(fixture.console.clicks).toContain(gpuModelSelector('vGPU-32GB'))
    expect(fixture.console.selectedModel).toBe('vGPU-32GB')
    // 跳过空闲 GPU 为 0 的第一行，选到第一台可用主机。
    expect(fixture.console.clicks).toContain(hostRowSelector('host-a'))
    expect(fixture.console.selectedHost).toBe('host-a')
    expect(fixture.console.clicks).toContain(CONFIRM_SELECTOR)
    expect(fixture.console.confirmed).toBe(true)
    // 每步前后的截图落进 logDir。
    expect(fixture.console.screenshots.some((path) => path.endsWith('clone-08-host-selected.png'))).toBe(true)
    expect(fixture.console.screenshots.some((path) => path.endsWith('clone-09-confirm-clicked.png'))).toBe(true)
    // 创建后的列表轮询必须带 refresh：实测列表不自动刷新。
    const pollingCalls = fixture.console.listCalls.filter((call) => call.afterConfirm)
    expect(pollingCalls.length).toBeGreaterThan(0)
    expect(pollingCalls.every((call) => call.refresh)).toBe(true)
    // 单价没有 CloneOutcome 字段可放，落进步骤日志。
    const stepLog = await readStepLog(fixture.logDir)
    expect(stepLog).toContain('"unitPriceYuanPerHour":1.58')
    expect(stepLog).toContain('"hostId":"host-a"')
  })

  it('数据盘按 Profile 显式取消勾选', async () => {
    const fixture = await createFixture({ cloneDataDiskDefault: true })

    await fixture.actions.clone(buildCloneRequest({ cloneDataDisk: false }))

    expect(fixture.console.dataDiskChecked).toBe(false)
    expect(fixture.console.sparseFileEnabled).toBe(true)
  })

  it('第一个偏好型号可用数为 0 时选第二个，不跳档', async () => {
    const fixture = await createFixture({
      gpuModels: [
        { name: 'vGPU-48GB', free: 0, total: 960 },
        { name: 'vGPU-32GB', free: 128, total: 2510 },
        { name: 'RTX 4090', free: 5, total: 100, checked: true },
      ],
    })

    const outcome = await fixture.actions.clone(
      buildCloneRequest({ gpuPreference: ['v-48g', 'v-32g-p'] }),
    )

    expect(outcome.instanceId).toBe(CREATED_INSTANCE_ID)
    expect(fixture.console.selectedModel).toBe('vGPU-32GB')
  })

  it('多个偏好型号都可用时取最靠前的一个', async () => {
    const fixture = await createFixture()

    await fixture.actions.clone(buildCloneRequest({ gpuPreference: ['v-32g-p', 'v-48g'] }))

    expect(fixture.console.selectedModel).toBe('vGPU-32GB')
  })

  it('最终状态为已关机也算克隆完成', async () => {
    const fixture = await createFixture({ createdStatuses: ['cloning', 'stopped'] })

    const outcome = await fixture.actions.clone(buildCloneRequest({}))

    expect(outcome.instanceId).toBe(CREATED_INSTANCE_ID)
  })

  it('平台点击后没有自动跳回列表时，显式导航后仍能读到新实例', async () => {
    const fixture = await createFixture({ platformNavigatesAfterConfirm: false })

    const outcome = await fixture.actions.clone(buildCloneRequest({}))

    expect(outcome.instanceId).toBe(CREATED_INSTANCE_ID)
    expect(fixture.console.navigations).toContain(CONSOLE_INSTANCE_LIST_URL)
  })

  it('克隆结束后把新实例名字改成请求里的 instanceName', async () => {
    const fixture = await createFixture()

    const outcome = await fixture.actions.clone(buildCloneRequest({}))

    expect(outcome.instanceId).toBe(CREATED_INSTANCE_ID)
    expect(fixture.console.clicks).toContain(RENAME_BUTTON_SELECTOR)
    expect(fixture.console.typedTexts).toEqual(['trans-dev'])
    // 失焦才提交：blur 之后列表里的名字才变成目标名字。
    expect(fixture.console.renamedName).toBe('trans-dev')
    expect(fixture.console.renameEditing).toBe(false)
    expect(
      fixture.console.screenshots.some((path) => path.endsWith('clone-12-renamed.png')),
    ).toBe(true)
    const stepLog = await readStepLog(fixture.logDir)
    expect(stepLog).toContain('clone.renamed')
    expect(stepLog).toContain('"name":"trans-dev"')
  })

  it('新实例已经有正确名字时不点「设置名称」，直接返回', async () => {
    const fixture = await createFixture({ createdInstanceName: 'trans-dev' })

    const outcome = await fixture.actions.clone(buildCloneRequest({}))

    expect(outcome.instanceId).toBe(CREATED_INSTANCE_ID)
    expect(fixture.console.clicks).not.toContain(RENAME_BUTTON_SELECTOR)
    expect(fixture.console.typedTexts).toEqual([])
    expect(fixture.console.renamedName).toBe('trans-dev')
  })
})

describe('clone 失败路径', () => {
  it('克隆状态一直是克隆锁定中时抛 CloneTimeoutError，并带实例 ID 与已等时长', async () => {
    const fixture = await createFixture({ createdStatuses: ['cloning'] })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(CloneTimeoutError)
    const message = messageOf(error)
    expect(message).toContain(CREATED_INSTANCE_ID)
    expect(message).toMatch(/已等 \d+ 秒/)
    expect(message).toContain('克隆锁定中')
  })

  it('GPU 型号偏好一条都对不上时抛错，并列出页面可选型号', async () => {
    const fixture = await createFixture()

    const error = await captureError(
      fixture.actions.clone(buildCloneRequest({ gpuPreference: ['v-99g'] })),
    )

    expect(error).toBeInstanceOf(CloneTargetUnavailableError)
    const message = messageOf(error)
    expect(message).toContain('页面可选型号')
    expect(message).toContain('vGPU-32GB')
    expect(message).toContain('RTX 5090')
    expect(fixture.console.confirmed).toBe(false)
  })

  it('地区偏好一条都对不上时抛错，并列出页面可选地区', async () => {
    const fixture = await createFixture()

    const error = await captureError(
      fixture.actions.clone(buildCloneRequest({ regionPreference: ['火星区'] })),
    )

    expect(error).toBeInstanceOf(CloneTargetUnavailableError)
    expect(messageOf(error)).toContain('页面可选地区')
    expect(messageOf(error)).toContain('西北B区')
    expect(fixture.console.confirmed).toBe(false)
  })

  it('选主机页的源实例不是请求的实例时停止克隆，不点创建', async () => {
    const fixture = await createFixture({ cloneHostSourceId: 'other-9999' })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(HumanRequiredError)
    expect(messageOf(error)).toContain('other-9999')
    expect(fixture.console.clicks).not.toContain(CONFIRM_SELECTOR)
    expect(fixture.console.confirmed).toBe(false)
  })

  it('创建按钮不可用时抛错，不点创建', async () => {
    const fixture = await createFixture({ confirmAlwaysDisabled: true })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(HumanRequiredError)
    expect(messageOf(error)).toContain('按钮不可用')
    expect(fixture.console.confirmed).toBe(false)
  })

  it('数据盘复选框被平台禁用时抛错，不做半套设置', async () => {
    const fixture = await createFixture({ dataDiskDisabled: true, cloneDataDiskDefault: false })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(HumanRequiredError)
    expect(messageOf(error)).toContain('数据盘')
    expect(fixture.console.screenshots.some((path) => path.endsWith('clone-09-confirm-clicked.png'))).toBe(false)
  })

  it('点创建后平台给出错误提示时立即失败，不盲等超时', async () => {
    const fixture = await createFixture({ createFailureNotice: '余额不足' })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(HumanRequiredError)
    expect(messageOf(error)).toContain('余额不足')
  })

  it('禁用型号被跳过，不点不可选的型号', async () => {
    const fixture = await createFixture({
      gpuModels: [
        { name: 'vGPU-48GB', free: 43, total: 960, disabled: true },
        { name: 'vGPU-32GB', free: 128, total: 2510 },
        { name: 'RTX 4090', free: 5, total: 100, checked: true },
      ],
    })

    await fixture.actions.clone(buildCloneRequest({ gpuPreference: ['v-48g', 'v-32g-p'] }))

    expect(fixture.console.selectedModel).toBe('vGPU-32GB')
    expect(fixture.console.clicks).not.toContain(gpuModelSelector('vGPU-48GB'))
  })

  it('点创建后出现多台新实例时抛错，交给人核对', async () => {
    const fixture = await createFixture({ extraCreatedInstanceIds: ['clone-0002'] })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(HumanRequiredError)
    expect(messageOf(error)).toContain('无法判定哪一台是本次克隆')
  })

  it('改名提交后列表里的名字一直没变时抛错，并带实例 ID 与目标名字', async () => {
    const fixture = await createFixture({ renameIgnored: true })

    const error = await captureError(fixture.actions.clone(buildCloneRequest({})))

    expect(error).toBeInstanceOf(ConsoleParseError)
    const message = messageOf(error)
    expect(message).toContain(CREATED_INSTANCE_ID)
    expect(message).toContain('trans-dev')
  })
})

describe('页面读数解析', () => {
  it('从克隆对话框页脚解析剩余次数', () => {
    expect(parseCloneQuota('今天剩余克隆次数：10次')).toBe(10)
    expect(parseCloneQuota('今天剩余克隆次数：0次')).toBe(0)
    expect(() => parseCloneQuota('次数用完了')).toThrow(ConsoleParseError)
  })

  it('解析主机行的空闲 GPU 与单价', () => {
    expect(parseFreeGpu('1 / 8')).toEqual({ free: 1, total: 8 })
    expect(parseFreeGpu('8')).toBeUndefined()
    expect(parseUnitPriceYuanPerHour('￥1.58/时 ￥1.66/时')).toBe(1.58)
    expect(parseUnitPriceYuanPerHour('暂无报价')).toBeUndefined()
  })

  it('解析改名输入框读数：输入框不在页面上返回 undefined，非字符串抛错', () => {
    expect(parseRenameInputValue(null)).toBeUndefined()
    expect(parseRenameInputValue('')).toBe('')
    expect(parseRenameInputValue('trans-dev')).toBe('trans-dev')
    expect(() => parseRenameInputValue(0)).toThrow(ConsoleParseError)
  })

  it('型号名前缀互相包含时不误判（RTX 5090 与 RTX 5090 D）', () => {
    const row = {
      hostId: 'h',
      cells: ['RTX 5090 D 32GB'],
      freeGpu: 1,
      totalGpu: 8,
      unitPriceYuanPerHour: 2,
      radioChecked: false,
      radioSelector: '[data-fake="h"]',
    }
    expect(hostRowMatchesGpuModel(row, 'RTX 5090')).toBe(false)
    expect(hostRowMatchesGpuModel(row, 'RTX 5090 D')).toBe(true)
    expect(hostRowMatchesGpuModel({ ...row, cells: ['RTX 5090 32GB'] }, 'RTX 5090')).toBe(true)
  })

  it('从「每GPU分配」格读出 CPU 核数，读不出时返回 undefined', () => {
    const row = {
      hostId: 'nqn4gltvka',
      cells: ['nqn4gltvka', 'F83机', 'vGPU-32GB 32GB', '1 / 8', 'CPU：16核 内存：62GB'],
      freeGpu: 1,
      totalGpu: 8,
      unitPriceYuanPerHour: 1.58,
      radioChecked: false,
      radioSelector: null,
    }
    expect(readHostCpuCores(row)).toBe(16)
    expect(readHostCpuCores({ ...row, cells: ['nqn4gltvka'] })).toBeUndefined()
    expect(readHostCpuCores({ ...row, cells: ['nqn4gltvka', '', '', '', 'CPU：暂无 内存：62GB'] })).toBeUndefined()
  })

  it('从选主机页 URL 读源实例 ID（夹具取自实测 URL）', () => {
    const url =
      'https://www.autodl.com/cloneInstance?region=west-B&id=af9c49bd44-8ee624d7&name=app%2Basr' +
      '&copy_data_disk=&expand_size=0&gpu_name=vGPU-32GB'
    expect(readCloneHostSourceId(url)).toBe('af9c49bd44-8ee624d7')
    expect(readCloneHostSourceId('https://www.autodl.com/console/instance/list')).toBeUndefined()
  })

  it('按实测选主机页夹具解析出型号、主机行与单价', () => {
    // 夹具形状取自真实控制台捕获：单选组、型号复选框文字、表格行单元格。
    const raw = {
      radioGroups: [
        {
          buttons: [
            { text: '按量计费', checked: true, selector: '[data-fake="billing"]' },
            { text: '包日', checked: false, selector: '[data-fake="billing-daily"]' },
          ],
        },
        {
          buttons: [
            { text: '西北B区', checked: true, selector: regionSelector('西北B区') },
            { text: '北京B区', checked: false, selector: regionSelector('北京B区') },
          ],
        },
        {
          buttons: [{ text: 'V100专区', checked: false, selector: '[data-fake="zone"]' }],
        },
        {
          buttons: [{ text: '1', checked: true, selector: '[data-fake="gpu-count:1"]' }],
        },
      ],
      checkboxes: [
        { text: '全部', checked: false, disabled: false, toggleSelector: '[data-fake="gpu-all"]' },
        { text: 'vGPU-32GB (128/2510)', checked: true, disabled: false, toggleSelector: gpuModelSelector('vGPU-32GB') },
        { text: 'RTX 5090 (20/2064)', checked: false, disabled: false, toggleSelector: gpuModelSelector('RTX 5090') },
        { text: 'PRO 6000 Max-Q (0/8)', checked: false, disabled: false, toggleSelector: gpuModelSelector('PRO 6000 Max-Q') },
      ],
      rows: [
        {
          cells: [
            'nqn4gltvka',
            'F83机',
            'vGPU-32GB 32GB',
            '1 / 8',
            'CPU：16核 内存：62GB',
            'Genuine',
            '数据盘：50GB 可扩容：0GB',
            '驱动：595.91.07 CUDA：13.2',
            '￥1.58/时 ￥1.66/时',
          ],
          radioChecked: false,
          radioSelector: hostRowSelector('nqn4gltvka'),
        },
      ],
      confirmButton: {
        text: '创建并开机',
        disabled: false,
        selector: CONFIRM_SELECTOR,
      },
    }

    const snapshot = parseCloneHostPageSnapshot(raw)

    const model = snapshot.gpuModels.find((candidate) => candidate.name === 'vGPU-32GB')
    expect(model?.freeCount).toBe(128)
    expect(model?.totalCount).toBe(2510)
    const row = snapshot.hostRows[0]
    expect(row?.hostId).toBe('nqn4gltvka')
    expect(row?.freeGpu).toBe(1)
    expect(row?.unitPriceYuanPerHour).toBe(1.58)
    expect(row !== undefined && hostRowMatchesGpuModel(row, 'vGPU-32GB')).toBe(true)
    expect(snapshot.confirmButton?.text).toBe('创建并开机')
    // 指纹只随页面事实变化，用于判断地区切换后的刷新是否结束。
    expect(hostPageSnapshotSignature(snapshot)).toBe(hostPageSnapshotSignature(snapshot))
    expect(hostPageSnapshotSignature(snapshot)).not.toBe(
      hostPageSnapshotSignature({
        ...snapshot,
        gpuModels: snapshot.gpuModels.map((candidate) => ({
          ...candidate,
          freeCount: candidate.freeCount + 1,
        })),
      }),
    )
  })

  it('克隆对话框探测结果按 0 个、多个、正常三种情况分开', () => {
    expect(parseCloneDialogProbe({ kind: 'absent' })).toEqual({ kind: 'absent' })
    expect(parseCloneDialogProbe({ kind: 'ambiguous', count: 2 })).toEqual({
      kind: 'ambiguous',
      count: 2,
    })
    expect(() => parseCloneDialogProbe({ kind: '别的' })).toThrow(ConsoleParseError)

    const dialog = parseCloneDialogProbe({
      kind: 'dialog',
      selector: DIALOG_SELECTOR,
      title: '克隆实例',
      footerText: '今天剩余克隆次数：10次',
      checkboxes: [
        { text: '系统盘', checked: true, disabled: true, toggleSelector: '[data-fake="system-disk"]' },
        { text: '数据盘', checked: false, disabled: false, toggleSelector: DIALOG_DATA_DISK_SELECTOR },
      ],
      sparseFileEnabled: false,
      sparseToggleSelector: DIALOG_SPARSE_SELECTOR,
      continueSelector: DIALOG_CONTINUE_SELECTOR,
      closeSelector: DIALOG_CLOSE_SELECTOR,
    })
    expect(dialog.kind).toBe('dialog')
    if (dialog.kind !== 'dialog') {
      throw new Error('夹具应当解析成对话框')
    }
    expect(dialog.dialog.title).toBe('克隆实例')
    expect(dialog.dialog.checkboxes.map((checkbox) => checkbox.text)).toEqual(['系统盘', '数据盘'])
    expect(parseCloneQuota(dialog.dialog.footerText)).toBe(10)
  })
})

describe('页面求值脚本', () => {
  it('生成的页内脚本是合法 JavaScript', () => {
    const scripts = [
      buildReadCloneDialogScript(),
      buildReadCloneHostPageScript(),
      buildReadCreateFailureNoticeScript(),
    ]
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow()
    }
  })

  it('页内脚本只读：不写 DOM、不点元素', () => {
    for (const script of [buildReadCloneDialogScript(), buildReadCloneHostPageScript()]) {
      expect(script).toContain('querySelectorAll')
      expect(script).not.toContain('setAttribute')
      expect(script).not.toContain('.click()')
    }
  })

  it('改名脚本把选择器转义成安全的 JS 字面量，失焦脚本不按回车', () => {
    const selector = `${ROW_SELECTOR} input[data-note="x"]`
    const readScript = buildReadRenameInputValueScript(selector)
    const blurScript = buildRenameBlurScript(selector)

    for (const script of [readScript, blurScript]) {
      expect(script).toContain(JSON.stringify(selector))
      expect(() => new Function(script)).not.toThrow()
    }
    expect(readScript).toContain('input.value')
    expect(blurScript).toContain('input.blur()')
    // 实测回车不提交，失焦脚本不许出现键盘事件。
    expect(blurScript).not.toContain('Enter')
    expect(blurScript).not.toContain('keydown')
  })
})

describe('动作模块的运行日志出口', () => {
  it('装配方给了 logger 时同一条事件既进 logger 也进 run 目录的动作证据文件', async () => {
    // Arrange
    const events: string[] = []
    const logger: Logger = {
      info: (event) => {
        events.push(event)
      },
      warn: (event) => {
        events.push(event)
      },
      error: (event) => {
        events.push(event)
      },
    }
    const fixture = await createFixture({ quota: 7 }, logger)

    // Act
    await fixture.actions.readCloneQuota(SOURCE_INSTANCE_ID)

    // Assert：注入的 logger 收到事件；动作证据文件仍然写进 run 目录。
    expect(events).toContain('clone.quota.read')
    const stepLog = await readStepLog(fixture.logDir)
    expect(stepLog).toContain('clone.quota.read')
  })
})
