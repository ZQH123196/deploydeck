import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleInstanceSnapshot } from '../../domain/instance.js'
import {
  InstanceFormMismatchError,
  PowerOffFailedError,
  PowerOnFailedError,
} from '../../errors.js'
import type { Provider } from '../../providers/provider.js'
import { createStateStore } from '../../state/store.js'
import type { CliDependencies } from '../dependencies.js'
import type { OutputStream } from '../output.js'
import { runSwitchCommand, switchInstanceForm, type SwitchCommandOptions } from './switch.js'

/**
 * `switch` 命令的行为用例。
 *
 * 三条判据各有一条用例：
 * 1. 切换后实例仍在，`instanceId` 不变。
 * 2. 单价变化不触发漂移判定：命令不读单价、不写状态，账与单价缓存一字节不动。
 * 3. 任一步失败时停下并保留实例，不销毁。
 *
 * 另加：复验形态不一致时报错并写实测形态。
 *
 * 隔离：provider 是假对象；状态目录用本机临时目录，只用来验证「什么都没写」。
 */

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

async function createTemporaryParent(): Promise<string> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'switch-spec-'))
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

interface SwitchHarness {
  readonly deps: CliDependencies
  readonly stdout: ReturnType<typeof createOutput>
  readonly calls: string[]
  readonly stateDir: string
}

/**
 * 造一套假端口。
 *
 * `snapshots` 按调用次序被 `listInstances` 取用；最后一项会被重复。
 * 每个动作同时记进 `calls`，顺序断言直接看它。
 */
async function createHarness(input: {
  readonly snapshots: readonly (readonly ConsoleInstanceSnapshot[])[]
  readonly powerOnOutcome?: Awaited<ReturnType<Provider['powerOn']>>
  readonly failPowerOff?: Error
}): Promise<SwitchHarness> {
  const parent = await createTemporaryParent()
  const stateDir = join(parent, 'state')
  const store = createStateStore({
    stateDir,
    configDir: join(parent, 'config'),
    lockTimeoutMs: 2000,
    lockRetryIntervalMs: 2,
  })
  let listIndex = 0
  const calls: string[] = []
  const stdout = createOutput()

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
      const snapshots = input.snapshots[Math.min(listIndex, input.snapshots.length - 1)] ?? []
      listIndex += 1
      return snapshots
    },
    powerOff: async () => {
      calls.push('powerOff')
      if (input.failPowerOff !== undefined) {
        throw input.failPowerOff
      }
    },
    powerOn: async (_instanceId: string, mode: string) => {
      calls.push(`powerOn:${mode}`)
      return input.powerOnOutcome ?? { ok: true, instanceId: INSTANCE_ID }
    },
    destroy: async () => {
      calls.push('destroy')
      throw new Error('switch 命令不得调用销毁')
    },
    readCloneQuota: async () => {
      throw new Error('switch 命令不得读克隆配额')
    },
    clone: async () => {
      throw new Error('switch 命令不得克隆')
    },
    readPriceQuote: async () => {
      calls.push('readPriceQuote')
      throw new Error('switch 命令不得读单价')
    },
    setTimedShutdown: async () => {
      throw new Error('switch 命令不得设定时关机')
    },
    clearTimedShutdown: async () => {
      throw new Error('switch 命令不得清定时关机')
    },
    readBalance: async () => {
      throw new Error('switch 命令不得读余额')
    },
    waitUntilReady: async () => undefined,
    exec: async () => {
      throw new Error('switch 命令不得执行远端命令')
    },
  } as unknown as Provider

  const deps = {
    stateDir,
    clock: { now: () => Date.parse('2026-11-28T11:00:00+08:00'), sleep: async () => undefined },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    stdout: stdout.stream,
    stderr: createOutput().stream,
    openProvider: async () => ({ provider, close: async () => undefined }),
    // 与真实装配同形：开、调、关各一次。命令只拿 provider，不管会话生命周期。
    withProvider: async (_logDir: string, action: (target: typeof provider) => Promise<unknown>) =>
      await action(provider),
    commandEvidenceDir: async (command: string, instanceId: string) =>
      await store.resolve(`${command}/${instanceId}`),
    createStateStore: () => store,
  } as unknown as CliDependencies

  return { deps, stdout, calls, stateDir }
}

/** 列出状态目录下的全部相对路径。目录不存在时返回空。 */
async function listStateEntries(stateDir: string): Promise<string[]> {
  try {
    return (await readdir(stateDir, { recursive: true })).sort()
  } catch {
    return []
  }
}

function options(overrides: Partial<SwitchCommandOptions> = {}): SwitchCommandOptions {
  return { instanceId: INSTANCE_ID, targetMode: 'no-gpu', ...overrides }
}

describe('switch：顺序与形态复验', () => {
  it('按 关机 → 无卡开机 → 复验 的顺序执行，输出实测无卡', async () => {
    // Arrange
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: true })],
      ],
    })

    // Act
    await runSwitchCommand({ deps: harness.deps, json: true }, options({ targetMode: 'no-gpu' }))

    // Assert
    expect(harness.calls).toEqual([
      'listInstances',
      'powerOff',
      'listInstances',
      'powerOn:no-gpu',
      'listInstances',
      'listInstances',
    ])
    const payload = JSON.parse(harness.stdout.text()) as Record<string, unknown>
    expect(payload['targetMode']).toBe('no-gpu')
    expect(payload['observedNoGpuMode']).toBe(true)
  })

  it('已经是目标形态时不关机，直接返回', async () => {
    const harness = await createHarness({
      snapshots: [[createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: true })]],
    })

    await runSwitchCommand({ deps: harness.deps, json: false }, options({ targetMode: 'no-gpu' }))

    expect(harness.calls).toEqual(['listInstances', 'listInstances'])
  })

  it('复验形态与目标不一致时抛 InstanceFormMismatchError，消息里写实测形态', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        // 开出来的仍是有卡：控制台没按目标形态办。
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
      ],
    })

    const error = await runSwitchCommand(
      { deps: harness.deps, json: false },
      options({ targetMode: 'no-gpu' }),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(InstanceFormMismatchError)
    expect((error as Error).message).toContain('有卡')
    expect((error as Error).message).toContain('未销毁')
  })
})

describe('switch：判据 1（实例仍在，instanceId 不变）', () => {
  it('切换过程中不出现任何销毁动作，输出里的 instanceId 与输入相同', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
      ],
    })

    await runSwitchCommand({ deps: harness.deps, json: true }, options({ targetMode: 'gpu' }))

    expect(harness.calls).not.toContain('destroy')
    const payload = JSON.parse(harness.stdout.text()) as Record<string, unknown>
    expect(payload['instanceId']).toBe(INSTANCE_ID)
  })

  it('关机后实例仍显示运行中时中止，不继续开机', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
        // 控制台受理了关机，但列表还没反映出来：这时候开机等于在运行中的实例上强开。
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
      ],
    })

    const error = await runSwitchCommand(
      { deps: harness.deps, json: false },
      options({ targetMode: 'no-gpu' }),
    ).catch((caught: unknown) => caught)

    // 判据：关机后状态不对是运行期事实不符，报 `POWER_OFF_FAILED`，不是 `CONFIG_INVALID`。
    expect(error).toBeInstanceOf(PowerOffFailedError)
    expect((error as PowerOffFailedError).code).toBe('POWER_OFF_FAILED')
    expect((error as Error).message).toContain('不是已关机')
    expect(harness.calls.some((call) => call.startsWith('powerOn'))).toBe(false)
  })

  it('关机后实例不在列表里时中止，不继续开机', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
        // 关机后按同一 ID 读不到实例：切换「实例还在且 ID 没变」的前提失效。
        [createSnapshot({ instanceId: 'other-id', status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
      ],
    })

    await expect(
      runSwitchCommand({ deps: harness.deps, json: false }, options({ targetMode: 'no-gpu' })),
    ).rejects.toThrow(/找不到实例/)
    expect(harness.calls.some((call) => call.startsWith('powerOn'))).toBe(false)
  })
})

describe('switch：判据 2（单价变化不触发漂移判定）', () => {
  it('命令不读单价、不写状态文件：切换后状态目录里只有证据目录', async () => {
    // Arrange
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: true })],
      ],
    })
    const before = await listStateEntries(harness.stateDir)

    // Act
    await runSwitchCommand({ deps: harness.deps, json: false }, options({ targetMode: 'no-gpu' }))

    // Assert：单价端口一次都没被调用；状态目录里只有 switch 证据目录，
    // 没有新增计划、账本、单价缓存这类与钱相关的文件。
    expect(harness.calls).not.toContain('readPriceQuote')
    const after = await listStateEntries(harness.stateDir)
    expect(after).toEqual(['switch'])
    expect(before).toEqual([])
  })
})

describe('switch：判据 3（失败即停，保留实例，不销毁）', () => {
  it('关机失败时停下：不调用开机，不调用销毁', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
        [createSnapshot({ status: 'running', statusRaw: '运行中', noGpuMode: false })],
      ],
      failPowerOff: new Error('控制台拒绝关机'),
    })

    await expect(
      runSwitchCommand({ deps: harness.deps, json: false }, options({ targetMode: 'no-gpu' })),
    ).rejects.toThrow(/控制台拒绝关机/)
    expect(harness.calls.some((call) => call.startsWith('powerOn'))).toBe(false)
    expect(harness.calls).not.toContain('destroy')
  })

  it('开机步骤失败时停下：抛 PowerOnFailedError，不尝试别的形态，不销毁', async () => {
    const harness = await createHarness({
      snapshots: [
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
        [createSnapshot({ status: 'stopped', statusRaw: '已关机', noGpuMode: null })],
      ],
      powerOnOutcome: { ok: false, reason: 'no-gpu', detail: '当前无空闲 GPU' },
    })

    const error = await runSwitchCommand(
      { deps: harness.deps, json: false },
      options({ targetMode: 'gpu' }),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(PowerOnFailedError)
    expect(harness.calls.filter((call) => call.startsWith('powerOn'))).toEqual(['powerOn:gpu'])
    expect(harness.calls).not.toContain('destroy')
  })
})

describe('switchInstanceForm：纯编排', () => {
  it('实例不在列表里时抛错，一个动作都不发', async () => {
    const calls: string[] = []
    const error = await switchInstanceForm(
      {
        listInstances: async () => [],
        powerOff: async () => {
          calls.push('powerOff')
        },
        powerOn: async () => {
          calls.push('powerOn')
          return { ok: true, instanceId: INSTANCE_ID }
        },
      },
      options(),
    ).catch((caught: unknown) => caught)

    expect((error as Error).message).toContain('找不到实例')
    expect(calls).toEqual([])
  })
})
