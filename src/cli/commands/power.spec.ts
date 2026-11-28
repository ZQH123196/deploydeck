import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleInstanceSnapshot } from '../../domain/instance.js'
import type { Plan } from '../../domain/plan.js'
import type { Profile } from '../../domain/profile.js'
import { ConfigError, PowerOffFailedError, PowerOnFailedError } from '../../errors.js'
import type { PowerOnMode } from '../../console/ports.js'
import type { Provider } from '../../providers/provider.js'
import { createPlanStore } from '../../plan/plan-store.js'
import { createStateStore } from '../../state/store.js'
import type { CliDependencies } from '../dependencies.js'
import type { OutputStream } from '../output.js'
import {
  matchesTargetPowerOnMode,
  resolvePowerOnModeOverride,
  runPowerCommand,
  type PowerCommandOptions,
} from './power.js'

/**
 * `power` 命令的行为用例。
 *
 * 判据：
 * - `off` 只关机：不走销毁路径，不改计划状态，不写账本。
 * - `on` 的目标形态取自部署配置；显式覆盖优先于配置。
 * - 开机失败即报错，不降级到另一种形态。
 * - 不读单价：命令装配里没有单价入口，读不到也就不会参与任何判定。
 *
 * 隔离：provider 是假对象，不连浏览器、不连 SSH。状态目录用本机临时目录，
 * 因为 `off` 要从计划里读出目标形态，计划是真实落盘的文件。
 */

const INSTANCE_ID = 'af9c49bd44-8ee624d7'
const PROFILE_ID = 'dev'

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

async function createTemporaryParent(): Promise<string> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'power-spec-'))
  temporaryParents.push(parent)
  return parent
}

function createOutput(): { stream: OutputStream; text: () => string } {
  const parts: string[] = []
  return {
    stream: { write: (chunk: string) => parts.push(chunk) },
    text: () => parts.join(''),
  }
}

function createSnapshot(overrides: Partial<ConsoleInstanceSnapshot> = {}): ConsoleInstanceSnapshot {
  return {
    instanceId: INSTANCE_ID,
    name: 'deck-dev',
    status: 'running',
    statusRaw: '运行中',
    gpuSpec: 'RTX 4090(24GB)',
    systemDiskUsed: '20GB',
    dataDiskUsed: '0GB',
    health: '正常',
    billingMode: '按量计费',
    autoReleaseAt: null,
    balanceWarning: null,
    timedShutdownAt: null,
    sshCommand: 'ssh -p 12345 root@region-x.autodl.com',
    noGpuMode: false,
    ...overrides,
  }
}

function createProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: PROFILE_ID,
    project: 'demo',
    provider: 'autodl',
    instanceNamePattern: 'deck-dev',
    gpuPreference: ['RTX 4090'],
    regionPreference: [],
    powerOnMode: 'no-gpu',
    cloneDataDisk: true,
    ttlMinutes: 60,
    budgetCapYuan: 20,
    onDeployFailure: 'keep-container',
    ...overrides,
  }
}

function createPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    profileId: PROFILE_ID,
    createdAt: '2026-11-28T10:00:00+08:00',
    expiresAt: '2026-11-28T12:00:00+08:00',
    budgetCapYuan: 20,
    spentYuan: 0,
    state: 'active',
    instanceId: INSTANCE_ID,
    ...overrides,
  }
}

interface FakeHarness {
  readonly deps: CliDependencies
  readonly stdout: ReturnType<typeof createOutput>
  readonly logLines: string[]
  readonly calls: string[]
  /** 状态目录绝对路径。用于断言本命令写了什么。 */
  readonly stateDir: string
}

async function createHarness(input: {
  /** 每次 `listInstances` 依次返回的列表。用完后重复最后一个。 */
  readonly snapshots: readonly (readonly ConsoleInstanceSnapshot[])[]
  readonly powerOnOutcome?: Awaited<ReturnType<Provider['powerOn']>>
  readonly plans?: readonly Plan[]
  readonly profiles?: readonly Profile[]
}): Promise<FakeHarness> {
  const parent = await createTemporaryParent()
  const stateDir = join(parent, 'state')
  const configDir = join(parent, 'config')
  const store = createStateStore({
    stateDir,
    configDir,
    lockTimeoutMs: 2000,
    lockRetryIntervalMs: 2,
  })
  for (const plan of input.plans ?? []) {
    await createPlanStore(store).create(plan)
  }

  const stdout = createOutput()
  const stderr = createOutput()
  const logLines: string[] = []
  const calls: string[] = []
  let listIndex = 0

  const provider = {
    id: 'autodl',
    capabilities: {
      create: true,
      powerCycle: true,
      noGpuMode: true,
      timedShutdown: true,
      accessInfo: true,
      imageSnapshot: false,
      clone: true,
    },
    listInstances: async () => {
      calls.push('listInstances')
      const snapshots =
        input.snapshots[Math.min(listIndex, input.snapshots.length - 1)] ?? []
      listIndex += 1
      return snapshots
    },
    powerOn: async (_instanceId: string, mode: PowerOnMode) => {
      calls.push(`powerOn:${mode}`)
      return input.powerOnOutcome ?? { ok: true, instanceId: INSTANCE_ID }
    },
    powerOff: async () => {
      calls.push('powerOff')
    },
    destroy: async () => {
      calls.push('destroy')
      throw new Error('power 命令不得调用销毁')
    },
    readCloneQuota: async () => {
      throw new Error('power 命令不得读克隆配额')
    },
    clone: async () => {
      throw new Error('power 命令不得克隆')
    },
    readPriceQuote: async () => {
      calls.push('readPriceQuote')
      throw new Error('power 命令不得读单价')
    },
    setTimedShutdown: async () => {
      calls.push('setTimedShutdown')
      throw new Error('power 命令不得设定时关机')
    },
    clearTimedShutdown: async () => {
      throw new Error('power 命令不得清定时关机')
    },
    readBalance: async () => {
      throw new Error('power 命令不得读余额')
    },
    waitUntilReady: async () => undefined,
    exec: async () => {
      throw new Error('power 命令不得执行远端命令')
    },
  } as unknown as Provider

  const deps = {
    stateDir,
    clock: { now: () => Date.parse('2026-11-28T11:00:00+08:00'), sleep: async () => undefined },
    logger: {
      info: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
      warn: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
      error: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
    openProvider: async () => ({ provider, close: async () => undefined }),
    // 与真实装配同形：开、调、关各一次。命令只拿 provider，不管会话生命周期。
    withProvider: async (_logDir: string, action: (target: typeof provider) => Promise<unknown>) =>
      await action(provider),
    commandEvidenceDir: async (command: string, instanceId: string) =>
      await store.resolve(`${command}/${instanceId}`),
    loadProfiles: async () => input.profiles ?? [createProfile()],
    createStateStore: () => store,
  } as unknown as CliDependencies

  return { deps, stdout, logLines, calls, stateDir }
}

function options(overrides: Partial<PowerCommandOptions> = {}): PowerCommandOptions {
  return {
    instanceId: INSTANCE_ID,
    action: 'off',
    profileId: null,
    modeOverride: null,
    ...overrides,
  }
}

describe('power：off 只关机', () => {
  it('关机成功即报终态已关机，不调用销毁，不写账本，计划一字节不变', async () => {
    // Arrange
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'running', statusRaw: '运行中' })],
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
      ],
      plans: [createPlan()],
    })
    const planPath = join(harness.stateDir, 'plans', 'plan-1.jsonc')
    const planBefore = await readFile(planPath, 'utf8')

    // Act
    await runPowerCommand({ deps: harness.deps, json: true }, options({ action: 'off' }))

    // Assert：只走 powerOff，从不走 destroy / 单价。
    expect(harness.calls).toEqual(['listInstances', 'powerOff', 'listInstances'])
    // 计划文件一字未改；状态目录里没有账本文件。
    expect(await readFile(planPath, 'utf8')).toBe(planBefore)
    expect(await readdir(harness.stateDir)).not.toContain('ledger.jsonl')
    const payload = JSON.parse(harness.stdout.text()) as Record<string, unknown>
    expect(payload).toEqual({
      instanceId: INSTANCE_ID,
      action: 'off',
      powerOnMode: 'no-gpu',
      status: 'stopped',
      statusRaw: '已关机',
    })
  })

  it('动作返回后状态不是已关机即抛 PowerOffFailedError（不是「开机失败」）', async () => {
    // Arrange
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'running', statusRaw: '运行中' })],
        [createSnapshot({ status: 'running', statusRaw: '运行中' })],
      ],
      plans: [createPlan()],
    })

    // Act
    const error = await runPowerCommand(
      { deps: harness.deps, json: false },
      options({ action: 'off' }),
    ).catch((caught: unknown) => caught)

    // Assert：两条路径的码必须分开，日志按码分叉。
    expect(error).toBeInstanceOf(PowerOffFailedError)
    expect((error as PowerOffFailedError).code).toBe('POWER_OFF_FAILED')
    expect((error as Error).message).toContain('关机失败')
    expect((error as Error).message).not.toContain('开机失败')
  })

  it('开机返回后状态不是运行中时抛 PowerOnFailedError（不是「关机失败」）', async () => {
    // Arrange：形态对得上，但动作返回后列表还没到运行中。
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
      ],
      plans: [createPlan()],
      profiles: [createProfile({ powerOnMode: 'gpu' })],
    })

    // Act
    const error = await runPowerCommand(
      { deps: harness.deps, json: false },
      options({ action: 'on' }),
    ).catch((caught: unknown) => caught)

    // Assert
    expect(error).toBeInstanceOf(PowerOnFailedError)
    expect((error as PowerOnFailedError).code).toBe('POWER_ON_FAILED')
    expect((error as Error).message).toContain('不是运行中')
  })
})

describe('power：on 的目标形态', () => {
  it('没给覆盖时按部署配置的 powerOnMode 开机', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: true })],
      ],
      plans: [createPlan()],
      profiles: [createProfile({ powerOnMode: 'no-gpu' })],
    })

    await runPowerCommand({ deps: harness.deps, json: false }, options({ action: 'on' }))

    expect(harness.calls).toContain('powerOn:no-gpu')
  })

  it('--gpu 覆盖部署配置的无卡形态', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
      ],
      plans: [createPlan()],
      profiles: [createProfile({ powerOnMode: 'no-gpu' })],
    })

    await runPowerCommand(
      { deps: harness.deps, json: false },
      options({ action: 'on', modeOverride: 'gpu' }),
    )

    expect(harness.calls).toContain('powerOn:gpu')
  })

  it('--gpu 与 --no-gpu 同时给即抛 ConfigError，不猜哪个优先', () => {
    expect(() => resolvePowerOnModeOverride({ gpu: true, noGpu: true })).toThrow(ConfigError)
  })

  it('实例没有绑定计划且没给形态时抛 ConfigError，一个端口都不碰', async () => {
    const harness = await createHarness({
      snapshots: [[createSnapshot({ status: 'stopped', statusRaw: '已关机' })]],
      plans: [],
    })

    await expect(
      runPowerCommand({ deps: harness.deps, json: false }, options({ action: 'on' })),
    ).rejects.toBeInstanceOf(ConfigError)
    expect(harness.calls).toEqual([])
  })
})

describe('power：开机失败', () => {
  it('控制台报无可用 GPU 时抛 PowerOnFailedError，不降级到无卡模式', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
      ],
      powerOnOutcome: { ok: false, reason: 'no-gpu', detail: '当前无空闲 GPU' },
      plans: [createPlan()],
      profiles: [createProfile({ powerOnMode: 'gpu' })],
    })

    const error = await runPowerCommand(
      { deps: harness.deps, json: false },
      options({ action: 'on' }),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(PowerOnFailedError)
    expect((error as Error).message).toContain('当前无空闲 GPU')
    // 判据证据：没有第二次 powerOn 尝试，也没有 powerOff。
    expect(harness.calls.filter((call) => call.startsWith('powerOn'))).toEqual(['powerOn:gpu'])
  })
})

describe('power：形态判定', () => {
  it('noGpuMode 为 null 时不算与目标一致', () => {
    expect(matchesTargetPowerOnMode('no-gpu', null)).toBe(false)
    expect(matchesTargetPowerOnMode('gpu', null)).toBe(false)
  })

  it('noGpuMode 为 true 表示无卡', () => {
    expect(matchesTargetPowerOnMode('no-gpu', true)).toBe(true)
    expect(matchesTargetPowerOnMode('gpu', true)).toBe(false)
  })
})
