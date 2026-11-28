import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleInstanceSnapshot, InstanceStatus } from '../domain/instance.js'
import { ConsoleParseError } from '../errors.js'
import type { Logger } from '../logging/logger.js'
import type { Clock } from '../util/clock.js'
import type { ConsoleChannel, ConsoleRuntimeContext, InstanceListPort } from './ports.js'
import {
  buildLocateConfirmButtonScript,
  buildLocateVisibleMenuItemScript,
  computeLedgerAmount,
  createTeardownActions,
  parseConfirmDialogProbe,
  parseVisibleMenuItemProbe,
  TEARDOWN_LOG_FILE,
} from './release.js'
import { CONSOLE_INSTANCE_LIST_URL } from './selectors.js'

/**
 * 关机、释放与终态验证的单测。
 *
 * 全部走假通道、假列表、假时钟：不连控制台，不点真实「释放实例」。
 * 释放不可恢复，真机验证只能由人工发起。
 */

const ROW_SELECTOR = '[data-fake="row"]'
const POWER_OFF_SELECTOR = '[data-fake="power-off"]'
const MORE_SELECTOR = '[data-fake="more"]'
const MENU_ITEM_SELECTOR = '[data-fake="release-menu-item"]'
const CONFIRM_SELECTOR = '[data-fake="confirm-button"]'
const POWER_CONFIRM_SELECTOR = '[data-fake="power-confirm-button"]'

const LOCATED_MENU_ITEM_PROBE = {
  kind: 'located',
  selector: MENU_ITEM_SELECTOR,
  itemText: '释放实例',
  matchedBy: 'aria-hint',
}
const LOCATED_CONFIRM_PROBE = {
  kind: 'located',
  selector: CONFIRM_SELECTOR,
  source: 'message-box',
  title: '提示',
  buttonText: '确定',
}
const ABSENT_CONFIRM_PROBE = { kind: 'absent' }

type ProbeHandler = () => unknown

interface FakeChannelOptions {
  readonly menuProbe: ProbeHandler | undefined
  readonly confirmProbe: ProbeHandler | undefined
  /**
   * 关机二次确认框的探针。刚刚实测（2026-11-25）：点「关机」后会弹「确认关机吗？」，
   * 不点「确定」实例不会停。默认没有这个框，与历史用例一致。
   */
  readonly powerConfirmProbe?: ProbeHandler | undefined
}

const ABSENT_POWER_CONFIRM_PROBE = { kind: 'absent' }

/**
 * 假通道。`evaluate` 按脚本内容分派返回值：
 * 实例行定位、行内按钮定位、菜单项定位、确认弹窗定位各一套。
 */
class FakeConsoleChannel implements ConsoleChannel {
  readonly clicks: string[] = []
  readonly screenshots: string[] = []
  readonly navigations: string[] = []
  readonly evaluated: string[] = []
  private readonly menuProbe: ProbeHandler
  private readonly confirmProbe: ProbeHandler
  private readonly powerConfirmProbe: ProbeHandler

  constructor(options: FakeChannelOptions) {
    this.menuProbe = options.menuProbe ?? (() => LOCATED_MENU_ITEM_PROBE)
    this.confirmProbe = options.confirmProbe ?? (() => ABSENT_CONFIRM_PROBE)
    this.powerConfirmProbe = options.powerConfirmProbe ?? (() => ABSENT_POWER_CONFIRM_PROBE)
  }

  async goto(url: string): Promise<void> {
    this.navigations.push(url)
  }

  async currentUrl(): Promise<string> {
    return CONSOLE_INSTANCE_LIST_URL
  }

  async evaluate<Result>(script: string): Promise<Result> {
    this.evaluated.push(script)
    if (script.includes('.el-dropdown__popper')) {
      return this.menuProbe() as Result
    }
    // 关机二次确认框的脚本按问句前缀认，与释放确认框的定位脚本分开。
    if (script.includes('确认关机')) {
      return this.powerConfirmProbe() as Result
    }
    if (script.includes('.el-message-box')) {
      return this.confirmProbe() as Result
    }
    if (script.includes('querySelectorAll("button")')) {
      if (script.includes('"关机"')) {
        return POWER_OFF_SELECTOR as Result
      }
      if (script.includes('"更多"')) {
        return MORE_SELECTOR as Result
      }
      throw new Error(`假通道不认识的按钮定位脚本：${script}`)
    }
    return ROW_SELECTOR as Result
  }

  async click(selector: string): Promise<void> {
    this.clicks.push(selector)
  }

  async type(_selector: string, _text: string): Promise<void> {
    throw new Error('销毁链不向输入框写文字')
  }

  async waitFor(_selector: string, _timeoutMs: number): Promise<void> {
    void _selector
    void _timeoutMs
  }

  async waitForGone(_selector: string, _timeoutMs: number): Promise<void> {
    void _selector
    void _timeoutMs
  }

  async screenshot(filePath: string): Promise<void> {
    this.screenshots.push(filePath)
  }

  async close(): Promise<void> {
    void this
  }
}

/** 每次读列表返回下一个状态；最后一个状态重复，用来看超时路径。 */
class FakeInstanceList implements InstanceListPort {
  calls = 0
  private readonly states: readonly (readonly ConsoleInstanceSnapshot[])[]

  constructor(states: readonly (readonly ConsoleInstanceSnapshot[])[]) {
    this.states = states
  }

  async listInstances(): Promise<readonly ConsoleInstanceSnapshot[]> {
    const index = Math.min(this.calls, this.states.length - 1)
    this.calls += 1
    return this.states[index] ?? []
  }
}

/** 假时钟：sleep 直接推进刻度，测试不做真实等待。 */
function createFakeClock(): Clock {
  let current = 0
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds
    },
  }
}

function instance(instanceId: string, status: InstanceStatus, statusRaw: string): ConsoleInstanceSnapshot {
  return {
    instanceId,
    name: instanceId,
    status,
    statusRaw,
    gpuSpec: 'vGPU-32GB * 1卡',
    systemDiskUsed: '系统盘 10%',
    dataDiskUsed: '数据盘 10%',
    health: '正常',
    billingMode: '按量计费',
    autoReleaseAt: null,
    balanceWarning: null,
    timedShutdownAt: null,
    sshCommand: null,
    noGpuMode: null,
  }
}

interface Fixture {
  readonly actions: ReturnType<typeof createTeardownActions>
  readonly channel: FakeConsoleChannel
  readonly instances: FakeInstanceList
  readonly logDir: string
}

interface FixtureOptions {
  readonly lists: readonly (readonly ConsoleInstanceSnapshot[])[]
  readonly menuProbe?: ProbeHandler
  readonly confirmProbe?: ProbeHandler
  /** 关机二次确认框探针。不传表示控制台不弹这个框。 */
  readonly powerConfirmProbe?: ProbeHandler
}

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

/** 静默 logger：用例不关心日志时不让 run 目录之外的输出混进测试输出。 */
function createSilentLogger(): Logger {
  const ignore = (): void => undefined
  return { info: ignore, warn: ignore, error: ignore }
}

async function createFixture(
  options: FixtureOptions,
  logger: Logger = createSilentLogger(),
): Promise<Fixture> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'release-spec-'))
  temporaryParents.push(parent)
  const logDir = join(parent, 'logs')
  const channel = new FakeConsoleChannel({
    menuProbe: options.menuProbe,
    confirmProbe: options.confirmProbe,
    powerConfirmProbe: options.powerConfirmProbe,
  })
  const instances = new FakeInstanceList(options.lists)
  const context: ConsoleRuntimeContext = {
    channel,
    instances,
    logDir,
    timeoutMs: 1_000,
    pollIntervalMs: 100,
    clock: createFakeClock(),
    logger,
  }
  return { actions: createTeardownActions(context), channel, instances, logDir }
}

async function readLog(logDir: string): Promise<string> {
  return readFile(join(logDir, TEARDOWN_LOG_FILE), 'utf8')
}

describe('destroy 正常销毁链', () => {
  it('运行中实例：关机 → 释放 → 确认 → 列表消失，返回 gone', async () => {
    // Arrange：第一次读列表是运行中，关机轮询读到已关机，释放后列表为空。
    const fixture = await createFixture({
      lists: [
        [instance('inst-1', 'running', '运行中')],
        [instance('inst-1', 'stopped', '已关机')],
        [],
      ],
      confirmProbe: () => LOCATED_CONFIRM_PROBE,
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert：返回终态，且四个动作依次点过。
    expect(outcome).toEqual({ state: 'gone' })
    expect(fixture.channel.navigations).toContain(CONSOLE_INSTANCE_LIST_URL)
    expect(fixture.channel.clicks).toEqual([
      POWER_OFF_SELECTOR,
      MORE_SELECTOR,
      MENU_ITEM_SELECTOR,
      CONFIRM_SELECTOR,
    ])
  })

  it('点关机后弹二次确认框时先点确定，再等关机', async () => {
    // Arrange：真机上点「关机」会弹「确认关机吗？」，不点「确定」实例不会停。
    const fixture = await createFixture({
      lists: [
        [instance('inst-1', 'running', '运行中')],
        [instance('inst-1', 'stopped', '已关机')],
        [],
      ],
      confirmProbe: () => LOCATED_CONFIRM_PROBE,
      powerConfirmProbe: (() => {
        // 第一次读到确认框，点掉之后读到「没有框」。
        let calls = 0
        return () => {
          calls += 1
          return calls === 1
            ? {
                kind: 'located',
                selector: POWER_CONFIRM_SELECTOR,
                text: '确认关机吗？ 实例：inst-1 ... 是否继续关机？',
              }
            : { kind: 'absent' }
        }
      })(),
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert：顺序是「关机 → 确定 → 更多 → 释放菜单项 → 释放确认」。
    expect(outcome).toEqual({ state: 'gone' })
    expect(fixture.channel.clicks).toEqual([
      POWER_OFF_SELECTOR,
      POWER_CONFIRM_SELECTOR,
      MORE_SELECTOR,
      MENU_ITEM_SELECTOR,
      CONFIRM_SELECTOR,
    ])
  })

  it('全过程留前后截图与步骤日志', async () => {
    // Arrange
    const fixture = await createFixture({
      lists: [
        [instance('inst-1', 'running', '运行中')],
        [instance('inst-1', 'stopped', '已关机')],
        [],
      ],
      confirmProbe: () => LOCATED_CONFIRM_PROBE,
    })

    // Act
    await fixture.actions.destroy('inst-1')

    // Assert：终态前后各一张图，步骤日志逐条落盘。
    expect(fixture.channel.screenshots).toContain(join(fixture.logDir, 'teardown-01-list-before.png'))
    expect(fixture.channel.screenshots).toContain(join(fixture.logDir, 'teardown-06-gone.png'))
    const log = await readLog(fixture.logDir)
    expect(log).toContain('teardown.start')
    expect(log).toContain('teardown.release.click')
    expect(log).toContain('teardown.gone')
  })

  it('已关机实例：跳过关机，直接释放', async () => {
    // Arrange
    const fixture = await createFixture({
      lists: [[instance('inst-1', 'stopped', '已关机')], []],
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert
    expect(outcome).toEqual({ state: 'gone' })
    expect(fixture.channel.clicks).not.toContain(POWER_OFF_SELECTOR)
    expect(fixture.channel.clicks).toContain(MENU_ITEM_SELECTOR)
  })

  it('开机中的实例：也先点关机', async () => {
    // Arrange：边界状态，控制台此时可能尚未渲染「已关机」。
    const fixture = await createFixture({
      lists: [[instance('inst-1', 'starting', '开机中')], [instance('inst-1', 'stopped', '已关机')], []],
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert
    expect(outcome).toEqual({ state: 'gone' })
    expect(fixture.channel.clicks[0]).toBe(POWER_OFF_SELECTOR)
  })

  it('克隆锁定中的实例：不在可销毁状态，返回 escalated 且不点按钮', async () => {
    // Arrange
    const fixture = await createFixture({
      lists: [[instance('inst-1', 'cloning', '克隆锁定中')], [instance('inst-1', 'cloning', '克隆锁定中')]],
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert
    expect(outcome.state).toBe('escalated')
    if (outcome.state !== 'escalated') {
      throw new Error('应当返回 escalated')
    }
    expect(outcome.reason).toContain('克隆锁定中')
    expect(fixture.channel.clicks).toEqual([])
  })

  it('实例本来就不存在：直接返回 gone，不点任何按钮', async () => {
    // Arrange
    const fixture = await createFixture({ lists: [[]] })

    // Act
    const outcome = await fixture.actions.destroy('inst-absent')

    // Assert
    expect(outcome).toEqual({ state: 'gone' })
    expect(fixture.channel.clicks).toEqual([])
    expect(fixture.channel.evaluated).toEqual([])
  })
})

describe('destroy 超时与不重试', () => {
  it('释放后列表一直有该实例 ID：返回 escalated，reason 含实例 ID 与等待轮数', async () => {
    // Arrange：关机成功，释放后列表始终返回已关机实例。
    const fixture = await createFixture({
      lists: [
        [instance('inst-1', 'running', '运行中')],
        [instance('inst-1', 'stopped', '已关机')],
        [instance('inst-1', 'stopped', '已关机')],
      ],
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert：超时 1000ms、间隔 100ms，共探测 11 轮。
    expect(outcome.state).toBe('escalated')
    if (outcome.state !== 'escalated') {
      throw new Error('应当返回 escalated')
    }
    expect(outcome.reason).toContain('inst-1')
    expect(outcome.reason).toContain('11 轮')
  })

  it('关机后状态一直不到 stopped：返回 escalated', async () => {
    // Arrange：列表始终是运行中。
    const fixture = await createFixture({
      lists: [[instance('inst-1', 'running', '运行中')], [instance('inst-1', 'running', '运行中')]],
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert
    expect(outcome.state).toBe('escalated')
    if (outcome.state !== 'escalated') {
      throw new Error('应当返回 escalated')
    }
    expect(outcome.reason).toContain('未变为已关机')
    expect(outcome.reason).toContain('inst-1')
    expect(fixture.channel.clicks).toEqual([POWER_OFF_SELECTOR])
  })

  it('不自动重试：释放菜单项只被点一次', async () => {
    // Arrange：同上，终态验证会超时。
    const fixture = await createFixture({
      lists: [[instance('inst-1', 'stopped', '已关机')], [instance('inst-1', 'stopped', '已关机')]],
    })

    // Act
    await fixture.actions.destroy('inst-1')

    // Assert
    const releaseClicks = fixture.channel.clicks.filter((selector) => selector === MENU_ITEM_SELECTOR)
    expect(releaseClicks).toHaveLength(1)
  })
})

describe('二次确认弹窗', () => {
  it('弹窗出现时点确认按钮', async () => {
    // Arrange
    const fixture = await createFixture({
      lists: [[instance('inst-1', 'stopped', '已关机')], []],
      confirmProbe: () => LOCATED_CONFIRM_PROBE,
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert
    expect(outcome).toEqual({ state: 'gone' })
    expect(fixture.channel.clicks).toContain(CONFIRM_SELECTOR)
  })

  it('弹窗不出现时继续流程，并在日志里记下没等到', async () => {
    // Arrange
    const fixture = await createFixture({
      lists: [[instance('inst-1', 'stopped', '已关机')], []],
    })

    // Act
    const outcome = await fixture.actions.destroy('inst-1')

    // Assert：流程继续到 gone，且没有点确认按钮。
    expect(outcome).toEqual({ state: 'gone' })
    expect(fixture.channel.clicks).not.toContain(CONFIRM_SELECTOR)
    expect(await readLog(fixture.logDir)).toContain('teardown.release.confirm-absent')
  })
})

describe('页面脚本', () => {
  it('两段定位脚本都能被 JS 解析，且生成回验过的路径选择器', () => {
    // Arrange
    const scripts = [
      buildLocateVisibleMenuItemScript({ rowSelector: ROW_SELECTOR, itemText: '释放实例' }),
      buildLocateConfirmButtonScript(),
    ]

    // Act / Assert
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow()
      expect(script).toContain('html > ')
      expect(script).toContain('document.querySelector(selector) === target')
    }
    expect(scripts[0]).toContain('"释放实例"')
    expect(scripts[0]).toContain('data-fake')
    expect(scripts[0]).toContain('.el-dropdown__popper')
    expect(scripts[1]).toContain('.el-message-box')
  })
})

describe('探针结构解析', () => {
  it('页面返回结构非法时抛 ConsoleParseError，不猜', () => {
    expect(() => parseVisibleMenuItemProbe(null)).toThrow(ConsoleParseError)
    expect(() => parseConfirmDialogProbe({ kind: 'located', selector: '' })).toThrow(ConsoleParseError)
  })

  it('合法结构原样返回', () => {
    expect(parseConfirmDialogProbe({ kind: 'absent' })).toEqual({ kind: 'absent' })
    expect(parseVisibleMenuItemProbe(LOCATED_MENU_ITEM_PROBE)).toEqual(LOCATED_MENU_ITEM_PROBE)
  })
})

describe('computeLedgerAmount', () => {
  it('金额 = 单价 × 时长（小时）', () => {
    // Arrange：2.5 小时 × 1.58 元/时 = 3.95 元。
    const input = {
      unitPriceYuanPerHour: 1.58,
      startedAt: '2026-11-25T09:00:00+08:00',
      stoppedAt: '2026-11-25T11:30:00+08:00',
    }

    // Act
    const amount = computeLedgerAmount(input)

    // Assert
    expect(amount).toBeCloseTo(3.95, 10)
  })

  it('跨日的起止时刻按绝对时刻换算', () => {
    // Arrange：23:30 到次日 00:30 是 1 小时。
    const input = {
      unitPriceYuanPerHour: 1.58,
      startedAt: '2026-11-25T23:30:00+08:00',
      stoppedAt: '2026-11-26T00:30:00+08:00',
    }

    // Act
    const amount = computeLedgerAmount(input)

    // Assert
    expect(amount).toBeCloseTo(1.58, 10)
  })

  it('停止时刻早于开始时刻是编程错误，直接抛错', () => {
    expect(() =>
      computeLedgerAmount({
        unitPriceYuanPerHour: 1.58,
        startedAt: '2026-11-25T11:00:00+08:00',
        stoppedAt: '2026-11-25T09:00:00+08:00',
      }),
    ).toThrow(RangeError)
  })
})

describe('动作模块的运行日志出口', () => {
  it('装配方给了 logger 时运行日志走它，动作证据文件仍落在 run 目录', async () => {
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
    const fixture = await createFixture(
      {
        lists: [
          [instance('inst-1', 'running', '运行中')],
          [instance('inst-1', 'stopped', '已关机')],
          [],
        ],
        confirmProbe: () => LOCATED_CONFIRM_PROBE,
      },
      logger,
    )

    // Act
    await fixture.actions.destroy('inst-1')

    // Assert
    expect(events).toContain('teardown.start')
    expect(await readLog(fixture.logDir)).toContain('teardown.start')
  })
})
