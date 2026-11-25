import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CloneOutcome,
  CloneRequest,
  ListInstancesOptions,
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
 * CLI 命令面的验收用例（工单 12）。
 *
 * 外部依赖全部是假的：provider 用手写假对象，配置目录用仓库里的 `examples/`，
 * 状态目录用 `.tmp/` 下的真实临时目录，时钟用假时钟。不连浏览器、不连 SSH、不连真实控制台。
 * 每条用例对应工单验收里的一条要求，失败时看用例名就知道哪一条没满足。
 */

const START_ISO = '2026-01-01T00:00:00+08:00'
const INSTANCE_ID = 'af9c49bd44-8ee624d7'

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

interface FakeClock extends Clock {
  advanceMinutes(minutes: number): void
}

function createFakeClock(startIso: string): FakeClock {
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

function makeInstance(overrides: Partial<ConsoleInstanceSnapshot> = {}): ConsoleInstanceSnapshot {
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
    ...overrides,
  }
}

interface FakeProviderBehavior {
  /** 某条命令的退出码。默认 0。 */
  readonly exitCodeFor?: (command: string) => number
  /** 命令开始前调用。用例可以在这里推进假时钟，模拟耗时。 */
  readonly onExec?: (command: string, clock: FakeClock) => void
}

/**
 * 假 provider。默认行为模仿控制台：开机把状态改成 running，销毁把它从列表移除，
 * 单价 1 元/时、余额 100 元。用例只在需要反例时覆盖单项行为。
 */
class FakeProvider implements Provider {
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

  async powerOn(instanceId: string): Promise<PowerOnOutcome> {
    this.calls.push('powerOn')
    this.setStatus(instanceId, 'running', '运行中')
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
  ): void {
    this.snapshots = this.snapshots.map((snapshot) =>
      snapshot.instanceId === instanceId ? { ...snapshot, status, statusRaw } : snapshot,
    )
  }
}

interface FixtureOptions {
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

interface CliFixture {
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

async function createFixture(options: FixtureOptions = {}): Promise<CliFixture> {
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
function parseSingleJson(fixture: CliFixture): Record<string, unknown> {
  const lines = fixture.stdoutText().split('\n').filter((line) => line.length > 0)
  expect(lines).toHaveLength(1)
  const text = lines[0] ?? ''
  const parsed: unknown = JSON.parse(text)
  expect(typeof parsed).toBe('object')
  expect(Array.isArray(parsed)).toBe(false)
  return parsed as Record<string, unknown>
}

/** 先建一份计划，返回计划 id。 */
async function createPlan(fixture: CliFixture, extraArgs: readonly string[] = []): Promise<string> {
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
async function runOnce(
  fixture: CliFixture,
  planId: string,
  runId: string,
): Promise<Record<string, unknown>> {
  const code = await fixture.run(['run', '--plan', planId, '--json', '--run-id', runId])
  expect(code).toBe(0)
  return parseSingleJson(fixture)
}

describe('CLI：--json 输出', () => {
  it('status --json 的 stdout 只有一个可解析 JSON 对象，没有别的行', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['status', '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(Array.isArray(payload['plans'])).toBe(true)
  })

  it('全局位置的 --json 与命令内的 --json 等价', async () => {
    const fixture = await createFixture()

    expect(await fixture.run(['--json', 'status'])).toBe(0)
    const before = parseSingleJson(fixture)

    expect(await fixture.run(['status', '--json'])).toBe(0)
    const after = parseSingleJson(fixture)

    expect(after['plans']).toEqual(before['plans'])
  })
})

describe('CLI：退出码', () => {
  it('成功是 0', async () => {
    const fixture = await createFixture()
    expect(await fixture.run(['profile', 'list', '--json'])).toBe(0)
  })

  it('计划不存在是 1，并给出可读错误', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['plan', 'show', 'plan-missing', '--json'])

    expect(code).toBe(1)
    expect(fixture.stderrText()).toContain('计划不存在')
  })

  it('run 遇到未登录是 2，且不改动任何实例', async () => {
    // plan create 不需要控制台，可以先建好计划再让 run 撞未登录。
    const fixture = await createFixture({ loginRequired: true })
    const planId = await createPlan(fixture)

    const code = await fixture.run(['run', '--plan', planId, '--json'])

    expect(code).toBe(2)
    expect(fixture.stderrText()).toContain('登录')
    expect(fixture.provider.calls).toEqual([])
    expect((await fixture.readPlan(planId)).state).toBe('active')
  })

  it('teardown 未确认消失是 2，退出码来自 InstanceNotGoneError', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    await runOnce(fixture, planId, 'run-teardown-escalated')
    fixture.provider.destroyResult = { state: 'escalated', reason: '释放后实例仍在列表里' }

    const code = await fixture.run(['teardown', planId, '--json'])

    expect(code).toBe(2)
    expect(fixture.stderrText()).toContain('ESCALATED')
    expect((await fixture.readPlan(planId)).state).toBe('escalated')
  })
})

describe('CLI：plan create', () => {
  it('落盘可读回，打印的计划与状态目录一致', async () => {
    const fixture = await createFixture()

    const code = await fixture.run([
      'plan',
      'create',
      '--profile',
      'asyncproxy-dev',
      '--ttl',
      '30',
      '--budget',
      '3.5',
      '--json',
    ])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    const printed = payload['plan'] as Plan
    const stored = await fixture.readPlan(printed.id)

    expect(stored).toEqual(printed)
    expect(stored.profileId).toBe('asyncproxy-dev')
    expect(stored.budgetCapYuan).toBe(3.5)
    expect(stored.spentYuan).toBe(0)
    expect(stored.state).toBe('active')
    const timedShutdownAt = payload['timedShutdownAt'] as string
    expect(Date.parse(stored.expiresAt) - Date.parse(timedShutdownAt)).toBe(5 * 60_000)
    expect(payload['onDeployFailure']).toBe('keep-container')
  })

  it('计划选项非法时非 0 退出且不落盘', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['plan', 'create', '--profile', 'asyncproxy-dev', '--ttl', '0'])

    expect(code).not.toBe(0)
    expect(fixture.stderrText()).toContain('--ttl')
    expect(await fixture.listActivePlans()).toEqual([])
  })
})

describe('CLI：run', () => {
  it('成功时输出实例、单价与步骤，步骤含命令与日志路径', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    const runId = 'run-cli-fixed-0001'

    const payload = await runOnce(fixture, planId, runId)

    expect(payload['runId']).toBe(runId)
    expect(payload['planId']).toBe(planId)
    expect(payload['instanceId']).toBe(INSTANCE_ID)
    expect(payload['unitPriceYuanPerHour']).toBe(1)
    expect(payload['state']).toBe('succeeded')
    const steps = payload['steps'] as readonly Record<string, unknown>[]
    expect(steps.length).toBeGreaterThan(0)
    for (const step of steps) {
      expect(typeof step['stepId']).toBe('string')
      expect(typeof step['command']).toBe('string')
      expect(step['exitCode']).toBe(0)
      expect(String(step['logPath'])).toContain(
        join(fixture.stateDir, RUNS_DIRECTORY, runId, 'logs'),
      )
    }
    // 先定 run id 再开 provider：证据目录必须是本次 run 目录本身。
    expect(fixture.openedLogDirs).toEqual([join(fixture.stateDir, RUNS_DIRECTORY, runId)])
    // 计划绑定实例，下一次执行靠它命中「已绑定实例」。
    expect((await fixture.readPlan(planId)).instanceId).toBe(INSTANCE_ID)
  })

  it('--run-id 非法时抛配置错误，不触碰控制台', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture)

    const code = await fixture.run(['run', '--plan', planId, '--run-id', 'bad/id'])

    expect(code).toBe(2)
    expect(fixture.provider.calls).toEqual([])
  })

  it('--profile 在没有生效计划时失败，不偷偷创建计划', async () => {
    const fixture = await createFixture()

    const code = await fixture.run([
      'run',
      '--profile',
      'asyncproxy-dev',
      '--json',
      '--run-id',
      'run-profile-forbidden-0001',
    ])

    // 判据（spec 第 9.1 节）：没有生效计划时 run 一律拒绝创建或开机实例。
    expect(code).toBe(1)
    expect(fixture.stderrText()).toContain('plan create --profile asyncproxy-dev')
    expect(fixture.stderrText()).toContain('--create-plan')
    expect(fixture.provider.calls).toEqual([])
    expect(await fixture.listActivePlans()).toEqual([])
  })

  it('--profile --create-plan 在没有生效计划时新建一份，并把新计划 id 打进输出', async () => {
    const fixture = await createFixture()

    const code = await fixture.run([
      'run',
      '--profile',
      'asyncproxy-dev',
      '--create-plan',
      '--json',
      '--run-id',
      'run-profile-auto-0001',
    ])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(typeof payload['createdPlanId']).toBe('string')
    expect(payload['planId']).toBe(payload['createdPlanId'])
    const active = await fixture.listActivePlans()
    expect(active).toHaveLength(1)
    expect(active[0]?.id).toBe(payload['createdPlanId'])
  })

  it('--create-plan 不能与 --plan 一起用', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture)

    const code = await fixture.run(['run', '--plan', planId, '--create-plan'])

    expect(code).toBe(2)
    expect(fixture.stderrText()).toContain('--create-plan')
    expect(fixture.provider.calls).toEqual([])
  })

  it('--profile 有多份生效计划时报错并列出 id，不自己挑', async () => {
    const fixture = await createFixture()
    const first = await createPlan(fixture)
    const second = await createPlan(fixture)

    const code = await fixture.run(['run', '--profile', 'asyncproxy-dev', '--json'])

    expect(code).toBe(1)
    expect(fixture.stderrText()).toContain(first)
    expect(fixture.stderrText()).toContain(second)
    expect(fixture.provider.calls).toEqual([])
  })

  it('部署失败且 destroy-container 时写账本，并把金额记回计划 spentYuan', async () => {
    const fixture = await createFixture({
      providerFactory: (clock) =>
        new FakeProvider(clock, [makeInstance({ name: 'trans-prod' })], {
          exitCodeFor: (command) => (command.includes('deploy.sh') ? 1 : 0),
          // 部署脚本失败，且耗时 30 分钟：账本金额应当非零。
          onExec: (command, fakeClock) => {
            if (command.includes('deploy.sh')) {
              fakeClock.advanceMinutes(30)
            }
          },
        }),
    })
    const planCode = await fixture.run(['plan', 'create', '--profile', 'trans-prod', '--json'])
    expect(planCode).toBe(0)
    const planId = (parseSingleJson(fixture)['plan'] as Plan).id

    const code = await fixture.run([
      'run',
      '--plan',
      planId,
      '--commit',
      'abc123',
      '--json',
      '--run-id',
      'run-failure-ledger',
    ])

    expect(code).toBe(1)
    const plan = await fixture.readPlan(planId)
    expect(plan.spentYuan).toBeCloseTo(0.5, 10)
    const ledger = await fixture.readLedger()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.amountYuan).toBeCloseTo(0.5, 10)
  })
})

describe('CLI：status', () => {
  it('输出生效计划、实例状态、单价、累计花费与账本摘要', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    await runOnce(fixture, planId, 'run-status-0001')

    const code = await fixture.run(['status', '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    const plans = payload['plans'] as readonly Record<string, unknown>[]
    expect(plans).toHaveLength(1)
    expect(plans[0]?.['planId']).toBe(planId)
    expect(plans[0]?.['instanceId']).toBe(INSTANCE_ID)
    expect(plans[0]?.['instanceStatus']).toBe('running')
    expect(plans[0]?.['unitPriceYuanPerHour']).toBe(1)
    expect(plans[0]?.['spentYuan']).toBe(0)
    const ledger = payload['ledger'] as { entryCount: number; recentEntries: unknown[] }
    expect(ledger.entryCount).toBe(0)
    expect(ledger.recentEntries).toEqual([])
  })
})

describe('CLI：plan show', () => {
  it('不带 --balance 时输出明确写「余额未读取」，且不打开控制台', async () => {
    const fixture = await createFixture()
    await createPlan(fixture)

    const code = await fixture.run(['plan', 'show', '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(payload['balanceYuan']).toBeNull()
    expect(fixture.provider.calls).toEqual([])
  })

  it('带 --balance 时读取账户余额并输出', async () => {
    const fixture = await createFixture()
    await createPlan(fixture)

    const code = await fixture.run(['plan', 'show', '--json', '--balance'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(payload['balanceYuan']).toBe(100)
    expect(fixture.provider.calls).toContain('readBalance')
  })

  it('人读模式下未读取余额时明说，不显示 0', async () => {
    const fixture = await createFixture()
    await createPlan(fixture)

    const code = await fixture.run(['plan', 'show'])

    expect(code).toBe(0)
    expect(fixture.stdoutText()).toContain('账户余额：未读取')
    expect(fixture.stdoutText()).not.toContain('账户余额：0.00')
  })
})

describe('CLI：guard', () => {
  it('--once --json 输出一轮巡检报告', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['guard', '--once', '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(payload['activePlanCount']).toBe(0)
    expect(payload['closedPlanIds']).toEqual([])
    expect(payload['escalatedPlanIds']).toEqual([])
    expect(payload['balanceYuan']).toBe(100)
    expect(payload['degraded']).toBe(false)
  })

  it('过期计划在 --once 里被关闭', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    fixture.clock.advanceMinutes(61)

    const code = await fixture.run(['guard', '--once', '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(payload['expiredPlanIds']).toEqual([planId])
    expect(payload['closedPlanIds']).toEqual([planId])
    expect((await fixture.readPlan(planId)).state).toBe('closed')
  })

  it('没有配置余额告警阈值时启动期报错，退出码 2', async () => {
    const fixture = await createFixture({ balanceConfigMissing: true })

    const code = await fixture.run(['guard', '--once'])

    expect(code).toBe(2)
    expect(fixture.stderrText()).toContain('DEPLOYDECK_BALANCE_WARN_BELOW_YUAN')
  })

  it('--json 不带 --once 时报配置错误，不进入常驻循环', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['guard', '--json'])

    expect(code).toBe(2)
    expect(fixture.stderrText()).toContain('--once')
  })

  it('控制面不可用时降级为告警，退出码仍为 0', async () => {
    const fixture = await createFixture({ loginRequired: true })

    const code = await fixture.run(['guard', '--once', '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(payload['degraded']).toBe(true)
    expect(payload['balanceYuan']).toBeNull()
  })
})

describe('CLI：teardown', () => {
  it('确认消失后写一行账本、计划转 closed，金额记回 spentYuan', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    const summary = await runOnce(fixture, planId, 'run-teardown-gone')

    fixture.clock.advanceMinutes(30)
    const code = await fixture.run(['teardown', planId, '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(payload['state']).toBe('closed')
    expect(payload['instanceId']).toBe(INSTANCE_ID)
    expect(payload['budgetExhausted']).toBe(false)
    expect(payload['spentYuan']).toBeCloseTo(0.5, 10)
    const ledger = await fixture.readLedger()
    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.runId).toBe(summary['runId'])
    expect(ledger[0]?.amountYuan).toBeCloseTo(0.5, 10)
    const plan = await fixture.readPlan(planId)
    expect(plan.state).toBe('closed')
    expect(plan.spentYuan).toBeCloseTo(0.5, 10)
    // 销毁证据落在创建该实例的那次 run 目录里。
    expect(fixture.openedLogDirs.at(-1)).toBe(
      join(fixture.stateDir, RUNS_DIRECTORY, 'run-teardown-gone'),
    )
  })

  it('花费达到预算上限时输出标记预算已用尽', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture, ['--ttl', '60', '--budget', '1'])
    await runOnce(fixture, planId, 'run-budget-exhausted')

    fixture.clock.advanceMinutes(90)
    const code = await fixture.run(['teardown', planId, '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    expect(payload['spentYuan']).toBeCloseTo(1.5, 10)
    expect(payload['budgetExhausted']).toBe(true)
  })

  it('重复执行 teardown 不重复记账', async () => {
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    await runOnce(fixture, planId, 'run-teardown-twice')
    expect(await fixture.run(['teardown', planId, '--json'])).toBe(0)

    const code = await fixture.run(['teardown', planId, '--json'])

    expect(code).toBe(1)
    expect(await fixture.readLedger()).toHaveLength(1)
  })
})

describe('CLI：teardown 结算字段', () => {
  it.each([
    ['instanceAcquiredAt', '实例到手时刻'],
    ['gpuSpec', '实例规格'],
    ['unitPriceYuanPerHour', '观测到的单价'],
  ])('执行记录缺 %s 时抛人工错误，不销毁实例', async (field, label) => {
    // Arrange：先正常跑一次，再把执行记录里的结算字段抹成 null。
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    const summary = await runOnce(fixture, planId, 'run-teardown-field')
    const runs = createRunStore(fixture.createStateStore())
    const run = await runs.read(String(summary['runId']))
    await runs.save({ ...run, [field]: null })

    // Act
    const code = await fixture.run(['teardown', planId, '--json'])

    // Assert：账本只记已封口的金额，缺字段就交人工，不编数字、不销毁。
    expect(code).toBe(2)
    expect(fixture.stderrText()).toContain(field)
    expect(fixture.stderrText()).toContain('runs/run-teardown-field.jsonc')
    expect(fixture.provider.calls).not.toContain('destroy')
    expect((await fixture.readPlan(planId)).state).toBe('active')
    void label
  })

  it('账本文件丢失但计划已有 spentYuan 时拒绝结算，避免重复记账', async () => {
    // Arrange
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    await runOnce(fixture, planId, 'run-ledger-lost')
    const planStore = createPlanStore(fixture.createStateStore())
    const plan = await planStore.read(planId)
    // 计划上的金额说明至少结算过一次，但账本文件不存在。
    await planStore.save({ ...plan, spentYuan: 2.5 })

    // Act
    const code = await fixture.run(['teardown', planId, '--json'])

    // Assert
    expect(code).toBe(2)
    expect(fixture.stderrText()).toContain('ledger.jsonl')
    expect(fixture.stderrText()).toContain('重复记账')
    expect(fixture.provider.calls).not.toContain('destroy')
  })
})

describe('CLI：status 的账本状态', () => {
  it('账本文件不存在时 --json 明确输出 missing，不冒充空账本', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['status', '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    const ledger = payload['ledger'] as { status: string; entryCount: number }
    expect(ledger.status).toBe('missing')
    expect(ledger.entryCount).toBe(0)
  })
})

describe('CLI：profile list', () => {
  it('读真实 examples/profiles 能解析出 Profile', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['profile', 'list', '--json'])

    expect(code).toBe(0)
    const payload = parseSingleJson(fixture)
    const profiles = payload['profiles'] as readonly Profile[]
    const ids = profiles.map((profile) => profile.id)
    expect(ids).toContain('asyncproxy-dev')
    const asyncproxy = profiles.find((profile) => profile.id === 'asyncproxy-dev')
    expect(asyncproxy?.project).toBe('asyncproxy-server')
    expect(asyncproxy?.provider).toBe('autodl')
  })
})

describe('CLI：参数错误', () => {
  it('run 既没给 --plan 也没给 --profile 时非 0 退出，错误可读', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['run'])

    expect(code).not.toBe(0)
    expect(fixture.stderrText()).toContain('--plan')
    expect(fixture.stderrText()).toContain('--profile')
    expect(fixture.provider.calls).toEqual([])
  })

  it('plan create 缺必填 --profile 时由 commander 报错，退出码非 0', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['plan', 'create'])

    expect(code).not.toBe(0)
    expect(fixture.stderrText()).toContain('--profile')
    expect(fixture.stderrText()).toContain('--help')
  })
})
