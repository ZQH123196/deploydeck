import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { afterEach, expect } from 'vitest'
import { join } from 'node:path'
import type {
  CloneOutcome,
  CloneRequest,
  ListInstancesOptions,
  PowerOnMode,
  PowerOnOutcome,
  PriceQuote,
  TeardownOutcome,
  TimedShutdownReceipt,
} from '../console/ports.js'
import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import type { Plan } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import type { Run } from '../domain/run.js'
import { loadProfiles } from '../config/loader.js'
import { loadProject } from '../config/project-loader.js'
import { createRunStore, RUNS_DIRECTORY } from '../engine/run-store.js'
import { ConfigError, LoginRequiredError, type ExitCode } from '../errors.js'
import type { Logger } from '../logging/logger.js'
import { createPlanStore } from '../plan/plan-store.js'
import type { Provider, ProviderCapabilities } from '../providers/provider.js'
import type { SshExecOptions, SshExecResult } from '../ssh/ports.js'
import { createLedgerStore, type LedgerStore } from '../state/ledger-store.js'
import type { LedgerEntry } from '../state/ledger.js'
import { createStateStore } from '../state/store.js'
import type { StateStore } from '../state/ports.js'
import type { Clock } from '../util/clock.js'
import {
  beijingIso,
  formatBeijingMinute,
  parseBeijingDateTimeText,
} from '../util/time.js'
import type { CliDependencies, ProviderSession } from './dependencies.js'
import { runCli } from './main.js'
import type { OutputStream } from './output.js'

/**
 * CLI 验收用例的假外部依赖。
 *
 * provider 是手写假对象，配置目录指向仓库里的 `examples/`，状态目录是 `.tmp/` 下的真实临时目录，
 * 时钟是假时钟。不连浏览器、不连 SSH、不连真实控制台。
 *
 * 放在单独文件里：`*.spec.ts` 被 import 时整份用例会被再跑一遍，
 * 多个命令用例共用这份装配时必须把它移出 spec 文件。
 */

export const START_ISO = '2026-01-01T00:00:00+08:00'
export const INSTANCE_ID = 'af9c49bd44-8ee624d7'

export interface FakeClock extends Clock {
  advanceMinutes(minutes: number): void
}

export function createFakeClock(startIso: string): FakeClock {
  let currentMillis = Date.parse(startIso)
  return {
    now: () => currentMillis,
    sleep: async (milliseconds) => {
      currentMillis += milliseconds
    },
    advanceMinutes: (minutes) => {
      currentMillis += minutes * 60_000
    },
  }
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  create: true,
  powerCycle: true,
  noGpuMode: false,
  timedShutdown: true,
  accessInfo: true,
  imageSnapshot: false,
  clone: true,
}

export function makeInstance(
  overrides: Partial<ConsoleInstanceSnapshot> = {},
): ConsoleInstanceSnapshot {
  return {
    instanceId: INSTANCE_ID,
    name: 'asyncproxy-dev',
    status: 'stopped',
    statusRaw: '已关机',
    gpuSpec: 'RTX 5090(32GB)',
    systemDiskUsed: '10 GB',
    dataDiskUsed: '0 GB',
    health: '正常',
    billingMode: '按量计费',
    autoReleaseAt: null,
    balanceWarning: null,
    timedShutdownAt: null,
    sshCommand: null,
    noGpuMode: null,
    ...overrides,
  }
}

export interface FakeProviderBehavior {
  /** 某条命令的退出码。默认 0。 */
  readonly exitCodeFor?: (command: string) => number
  /** 命令开始前调用。用例可以在这里推进假时钟，模拟耗时。 */
  readonly onExec?: (command: string, clock: FakeClock) => void
}

/**
 * 假 provider。默认行为模仿控制台：开机把状态改成 running，销毁把它从列表移除，
 * 单价 1 元/时、余额 100 元。用例只在需要反例时覆盖单项行为。
 */
export class FakeProvider implements Provider {
  readonly id = 'fake-autodl'
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES
  readonly calls: string[] = []
  snapshots: ConsoleInstanceSnapshot[]
  destroyResult: TeardownOutcome | null = null

  constructor(
    private readonly clock: FakeClock,
    instances: readonly ConsoleInstanceSnapshot[] = [makeInstance()],
    private readonly behavior: FakeProviderBehavior = {},
  ) {
    this.snapshots = [...instances]
  }

  async listInstances(options?: ListInstancesOptions): Promise<readonly ConsoleInstanceSnapshot[]> {
    this.calls.push('listInstances')
    void options
    return [...this.snapshots]
  }

  async powerOn(instanceId: string, mode: PowerOnMode): Promise<PowerOnOutcome> {
    this.calls.push('powerOn')
    // 无卡模式实例的状态列一样写「运行中」，差别在第 2 列的标记。
    // 单价缓存按开机形态分槽，status 命令要靠这个标记取对槽。
    this.setStatus(instanceId, 'running', '运行中', mode === 'no-gpu')
    return { ok: true, instanceId }
  }

  async powerOff(instanceId: string): Promise<void> {
    this.calls.push('powerOff')
    this.setStatus(instanceId, 'stopped', '已关机')
  }

  async readCloneQuota(): Promise<number> {
    this.calls.push('readCloneQuota')
    return 10
  }

  async clone(request: CloneRequest): Promise<CloneOutcome> {
    this.calls.push('clone')
    return { instanceId: 'cloned-instance', sourceInstanceId: request.sourceInstanceId }
  }

  async readPriceQuote(instanceId: string, ttlMinutes: number): Promise<PriceQuote> {
    this.calls.push('readPriceQuote')
    void instanceId
    return {
      serverTime: beijingIso(new Date(this.clock.now())),
      unitPriceYuanPerHour: 1,
      estimatedCostYuan: ttlMinutes / 60,
      ttlMinutes,
      balanceYuan: 100,
    }
  }

  async clearTimedShutdown(): Promise<void> {
    this.calls.push('clearTimedShutdown')
  }

  async setTimedShutdown(instanceId: string, shutdownAt: string): Promise<TimedShutdownReceipt> {
    this.calls.push('setTimedShutdown')
    void instanceId
    return {
      serverTime: beijingIso(new Date(this.clock.now())),
      // 控制台只到分钟精度，回执是归一后的时刻。
      shutdownAt: parseBeijingDateTimeText(formatBeijingMinute(shutdownAt)),
    }
  }

  async readBalance(): Promise<number> {
    this.calls.push('readBalance')
    return 100
  }

  async destroy(instanceId: string): Promise<TeardownOutcome> {
    this.calls.push('destroy')
    if (this.destroyResult !== null) {
      return this.destroyResult
    }
    this.snapshots = this.snapshots.filter((snapshot) => snapshot.instanceId !== instanceId)
    return { state: 'gone' }
  }

  async waitUntilReady(instanceId: string, timeoutMs: number): Promise<void> {
    this.calls.push('waitUntilReady')
    void instanceId
    void timeoutMs
  }

  async exec(
    instanceId: string,
    command: string,
    options: SshExecOptions,
  ): Promise<SshExecResult> {
    this.calls.push('exec')
    void instanceId
    this.behavior.onExec?.(command, this.clock)
    const stdout = `output of ${command}\n`
    // 模拟真实 SSH 端口：完整输出落盘，返回值只带尾部与字节数。
    await writeFile(options.logPath, stdout, 'utf8')
    const exitCode = this.behavior.exitCodeFor?.(command) ?? 0
    return {
      exitCode,
      stdoutTail: stdout,
      stderrTail: '',
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      stderrBytes: 0,
      durationMs: 1,
      timedOut: false,
    }
  }

  private setStatus(
    instanceId: string,
    status: ConsoleInstanceSnapshot['status'],
    statusRaw: string,
    noGpuMode: boolean | null = false,
  ): void {
    this.snapshots = this.snapshots.map((snapshot) =>
      snapshot.instanceId === instanceId
        ? { ...snapshot, status, statusRaw, noGpuMode }
        : snapshot,
    )
  }
}

export interface FixtureOptions {
  /** 按 fixture 的假时钟造 provider：用例要推进时钟时用这个入口，保证时间轴同源。 */
  readonly providerFactory?: (clock: FakeClock) => FakeProvider
  readonly provider?: FakeProvider
  readonly loginRequired?: boolean
  readonly configDir?: string
  readonly instanceName?: string
  /** 守护进程的余额告警阈值。默认 10 元。 */
  readonly balanceWarnBelowYuan?: number
  /** 模拟没有配置余额告警阈值：guard 启动期应报错。 */
  readonly balanceConfigMissing?: boolean
}

export interface CliFixture {
  readonly deps: CliDependencies
  readonly provider: FakeProvider
  readonly clock: FakeClock
  readonly stateDir: string
  readonly configDir: string
  /** 每次打开 provider 时收到的证据目录。 */
  readonly openedLogDirs: string[]
  readonly loginRequired: boolean
  run(argv: readonly string[]): Promise<ExitCode>
  stdoutText(): string
  stderrText(): string
  createStateStore(): StateStore
  readPlan(planId: string): Promise<Plan>
  listActivePlans(): Promise<readonly Plan[]>
  readLedger(): Promise<readonly LedgerEntry[]>
  readRun(runId: string): Promise<Run>
}

export async function createFixture(options: FixtureOptions = {}): Promise<CliFixture> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'cli-spec-'))
  temporaryParents.push(parent)
  const stateDir = join(parent, 'state')
  const configDir = options.configDir ?? join(process.cwd(), 'examples')
  const clock = createFakeClock(START_ISO)
  const provider =
    options.providerFactory?.(clock) ??
    options.provider ??
    new FakeProvider(clock, [
      makeInstance(options.instanceName === undefined ? {} : { name: options.instanceName }),
    ])
  const openedLogDirs: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const stdoutStream: OutputStream = {
    write: (text) => {
      stdout.push(text)
    },
  }
  const stderrStream: OutputStream = {
    write: (text) => {
      stderr.push(text)
    },
  }

  const stateStoreFactory = (): StateStore =>
    createStateStore({
      stateDir,
      configDir,
      lockTimeoutMs: 5_000,
      lockRetryIntervalMs: 5,
      now: () => clock.now(),
      sleep: (milliseconds) => clock.sleep(milliseconds),
    })
  const stateStore = stateStoreFactory()
  const planStore = createPlanStore(stateStore)
  const ledger: LedgerStore = createLedgerStore(stateStore)
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

  const deps: CliDependencies = {
    configDir,
    stateDir,
    consoleUrl: 'https://www.autodl.com/console/instance/list',
    clock,
    logger,
    stdout: stdoutStream,
    stderr: stderrStream,
    openProvider: async ({ logDir }): Promise<ProviderSession> => {
      openedLogDirs.push(logDir)
      // 真实实现先建通道再判登录态；未登录时不会交回任何端口。
      if (options.loginRequired === true) {
        throw new LoginRequiredError()
      }
      return { provider, close: async () => undefined }
    },
    openConsoleSession: async () => {
      throw new Error('测试不应打开真实控制台通道')
    },
    openShell: async () => {
      throw new Error('测试不应打开真实终端通道')
    },
    openCredentials: async () => {
      throw new Error('测试不应打开真实凭据通道')
    },
    openForward: async () => {
      throw new Error('测试不应打开真实端口转发')
    },
    withProvider: async (_logDir, action) => {
      // 与真实装配同形：开、调、关各一次。测试里 provider 已经是假对象。
      openedLogDirs.push(_logDir)
      if (options.loginRequired === true) {
        throw new LoginRequiredError()
      }
      return await action(provider)
    },
    commandEvidenceDir: async (command, instanceId) => {
      const store = stateStoreFactory()
      return await store.resolve(`${command}/${instanceId}`)
    },
    readProviderCapabilities: () => ({ id: 'autodl', capabilities: DEFAULT_CAPABILITIES }),
    createStateStore: stateStoreFactory,
    loadProfiles: async () => {
      const result = await loadProfiles(join(configDir, 'profiles'))
      return result.profiles
    },
    loadProject: async (projectId) => await loadProject(join(configDir, 'projects'), projectId),
    readBalanceWarnBelowYuan: () => {
      if (options.balanceConfigMissing === true) {
        throw new ConfigError(
          '缺少余额告警阈值：请配置环境变量 DEPLOYDECK_BALANCE_WARN_BELOW_YUAN（单位：元，非负数字）。',
        )
      }
      return options.balanceWarnBelowYuan ?? 10
    },
  }

  return {
    deps,
    provider,
    clock,
    stateDir,
    configDir,
    openedLogDirs,
    loginRequired: options.loginRequired === true,
    run: async (argv) => {
      // 每次调用模拟一次独立的进程：输出流从空开始。
      stdout.length = 0
      stderr.length = 0
      return await runCli(argv, deps)
    },
    stdoutText: () => stdout.join(''),
    stderrText: () => stderr.join(''),
    createStateStore: stateStoreFactory,
    readPlan: async (planId) => await planStore.read(planId),
    listActivePlans: async () => await planStore.listActive(new Date(clock.now())),
    readLedger: async () => {
      try {
        return await ledger.readAll()
      } catch {
        return []
      }
    },
    readRun: async (runId) => {
      const store = createRunStore(stateStoreFactory())
      return await store.read(runId)
    },
  }
}

/** 解析 stdout 的唯一 JSON 对象。顺带断言 stdout 里没有别的行。 */
export function parseSingleJson(fixture: CliFixture): Record<string, unknown> {
  const lines = fixture.stdoutText().split('\n').filter((line) => line.length > 0)
  expect(lines).toHaveLength(1)
  const text = lines[0] ?? ''
  const parsed: unknown = JSON.parse(text)
  expect(typeof parsed).toBe('object')
  expect(Array.isArray(parsed)).toBe(false)
  return parsed as Record<string, unknown>
}

/** 先建一份计划，返回计划 id。 */
export async function createPlan(fixture: CliFixture, extraArgs: readonly string[] = []): Promise<string> {
  const code = await fixture.run([
    'plan',
    'create',
    '--profile',
    'asyncproxy-dev',
    '--json',
    ...extraArgs,
  ])
  expect(code).toBe(0)
  const payload = parseSingleJson(fixture)
  const plan = payload['plan'] as Plan
  return plan.id
}

/** 跑一次成功执行，返回 RunSummary 的 JSON 载荷。 */
export async function runOnce(
  fixture: CliFixture,
  planId: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const code = await fixture.run(['run', '--plan', planId, '--json', '--run-id', runId])
  expect(code).toBe(0)
  return parseSingleJson(fixture)
}

export const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})
