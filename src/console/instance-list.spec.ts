import { describe, expect, it } from 'vitest'
import type { InstanceStatus } from '../domain/instance.js'
import { ConfigError, ConsoleParseError } from '../errors.js'
import type { ParseInstanceListOptions, RawInstanceRow } from './instance-list.js'
import { createInstanceListActions, parseInstanceList, readInstanceRows } from './instance-list.js'
import type { ConsoleChannel } from './ports.js'

/** 固定基准时刻。倒计时换算由调用方给时刻，判定不读时钟。 */
const NOW = new Date('2026-11-25T01:00:00+08:00')
const OPTIONS: ParseInstanceListOptions = {
  now: NOW,
  countdownTimeZoneBase: 'Asia/Shanghai',
}

/**
 * 真实样本：2026-11-25 从控制台实读的 5 行实例，逐格原文与结构取值。
 * 原始探针记录：.tmp/deploydeck-probe/02-list-rows-full.json（临时文件，不进版本库）。
 * 倒计时原文保留抓取时的读数；判定基准固定为 NOW，因此期望时刻可手算。
 */
const REAL_ROWS: readonly RawInstanceRow[] = [
  {
    rowIndex: 0,
    cellTexts: [
      '西北B区 / 722机 af9c49bd44-8ee624d7 app+asr',
      '已关机',
      'vGPU-32GB * 1卡 查看详情',
      '系统盘 37.98% 数据盘 57.93%',
      '正常',
      '按量计费',
      '6天11小时57分后释放 设置定时关机',
      '',
      '',
      '开机更多',
    ],
    instanceId: 'af9c49bd44-8ee624d7',
    instanceName: 'app+asr',
    statusText: '已关机',
    statusProgressText: null,
    gpuSpecText: 'vGPU-32GB * 1卡',
    diskLines: ['系统盘 37.98%', '数据盘 57.93%'],
    billingText: '按量计费',
    billingWarning: '',
    releaseText: '6天11小时57分后释放',
    timedShutdownText: '',
  },
  {
    rowIndex: 1,
    cellTexts: [
      '西北B区 / 071机 6a9f428e64-c7771049 app+asr',
      '已关机',
      'vGPU-32GB * 1卡 查看详情',
      '系统盘 35.81% 数据盘 55.97%',
      '正常',
      '按量计费',
      '5天05小时06分后释放 设置定时关机',
      '',
      '',
      '开机更多',
    ],
    instanceId: '6a9f428e64-c7771049',
    instanceName: 'app+asr',
    statusText: '已关机',
    statusProgressText: null,
    gpuSpecText: 'vGPU-32GB * 1卡',
    diskLines: ['系统盘 35.81%', '数据盘 55.97%'],
    billingText: '按量计费',
    billingWarning: '',
    releaseText: '5天05小时06分后释放',
    timedShutdownText: '',
  },
  {
    rowIndex: 2,
    cellTexts: [
      '西北B区 / 900机 9235478639-ca87bec6 tts',
      '已关机 GPU充足',
      'RTX PRO 6000 * 1卡 查看详情',
      '系统盘 80.74% 数据盘 80.00%',
      '正常',
      '按量计费',
      '6天09小时41分后释放 设置定时关机',
      '',
      '',
      '开机更多',
    ],
    instanceId: '9235478639-ca87bec6',
    instanceName: 'tts',
    statusText: '已关机',
    statusProgressText: null,
    gpuSpecText: 'RTX PRO 6000 * 1卡',
    diskLines: ['系统盘 80.74%', '数据盘 80.00%'],
    billingText: '按量计费',
    billingWarning: '',
    releaseText: '6天09小时41分后释放',
    timedShutdownText: '',
  },
  {
    rowIndex: 3,
    cellTexts: [
      '西北B区 / 255机 43474eae3d-4feb6a96 app+asr',
      '已关机',
      'vGPU-32GB * 1卡 查看详情',
      '系统盘 35.81% 数据盘 55.90%',
      '正常',
      '按量计费',
      '4天10小时46分后释放 设置定时关机',
      '',
      '',
      '开机更多',
    ],
    instanceId: '43474eae3d-4feb6a96',
    instanceName: 'app+asr',
    statusText: '已关机',
    statusProgressText: null,
    gpuSpecText: 'vGPU-32GB * 1卡',
    diskLines: ['系统盘 35.81%', '数据盘 55.90%'],
    billingText: '按量计费',
    billingWarning: '',
    releaseText: '4天10小时46分后释放',
    timedShutdownText: '',
  },
  {
    rowIndex: 4,
    cellTexts: [
      '西北B区 / D79机 b1hcx779z3-6abbac9b 设置名称',
      '克隆锁定中',
      'vGPU-48GB * 1卡 查看详情',
      '系统盘 3.79% 数据盘 68.16%',
      '正常',
      '按量计费 余额不足24小时',
      '设置定时关机',
      '',
      '',
      '关机更多',
    ],
    instanceId: 'b1hcx779z3-6abbac9b',
    instanceName: '',
    statusText: '克隆锁定中',
    statusProgressText: null,
    gpuSpecText: 'vGPU-48GB * 1卡',
    diskLines: ['系统盘 3.79%', '数据盘 68.16%'],
    billingText: '按量计费 余额不足24小时',
    billingWarning: '余额不足24小时',
    releaseText: '',
    timedShutdownText: '',
  },
]

function realRow(index: number): RawInstanceRow {
  const row = REAL_ROWS[index]
  if (row === undefined) {
    throw new Error(`真实样本缺少第 ${index} 行`)
  }
  return row
}

/** 造一行结构合法的原文，只改本用例关心的字段。 */
function makeRow(overrides: Partial<RawInstanceRow>): RawInstanceRow {
  return {
    rowIndex: 0,
    cellTexts: ['', '', '', '', '', '', '', '', '', ''],
    instanceId: 'af9c49bd44-8ee624d7',
    instanceName: 'app+asr',
    statusText: '已关机',
    statusProgressText: null,
    gpuSpecText: 'vGPU-32GB * 1卡',
    diskLines: ['系统盘 37.98%', '数据盘 57.93%'],
    billingText: '按量计费',
    billingWarning: '',
    releaseText: '6天11小时57分后释放',
    timedShutdownText: '',
    ...overrides,
  }
}

describe('真实样本解析', () => {
  it('5 台实例逐字段与人工读数一致', () => {
    const snapshots = parseInstanceList(REAL_ROWS, OPTIONS)

    expect(snapshots).toEqual([
      {
        instanceId: 'af9c49bd44-8ee624d7',
        name: 'app+asr',
        status: 'stopped',
        statusRaw: '已关机',
        gpuSpec: 'vGPU-32GB * 1卡',
        systemDiskUsed: '37.98%',
        dataDiskUsed: '57.93%',
        health: '正常',
        billingMode: '按量计费',
        autoReleaseAt: '2026-12-01T12:57:00.000+08:00',
        balanceWarning: null,
        timedShutdownAt: null,
        sshCommand: null,
      },
      {
        instanceId: '6a9f428e64-c7771049',
        name: 'app+asr',
        status: 'stopped',
        statusRaw: '已关机',
        gpuSpec: 'vGPU-32GB * 1卡',
        systemDiskUsed: '35.81%',
        dataDiskUsed: '55.97%',
        health: '正常',
        billingMode: '按量计费',
        autoReleaseAt: '2026-11-30T06:06:00.000+08:00',
        balanceWarning: null,
        timedShutdownAt: null,
        sshCommand: null,
      },
      {
        instanceId: '9235478639-ca87bec6',
        name: 'tts',
        status: 'stopped',
        statusRaw: '已关机',
        gpuSpec: 'RTX PRO 6000 * 1卡',
        systemDiskUsed: '80.74%',
        dataDiskUsed: '80.00%',
        health: '正常',
        billingMode: '按量计费',
        autoReleaseAt: '2026-12-01T10:41:00.000+08:00',
        balanceWarning: null,
        timedShutdownAt: null,
        sshCommand: null,
      },
      {
        instanceId: '43474eae3d-4feb6a96',
        name: 'app+asr',
        status: 'stopped',
        statusRaw: '已关机',
        gpuSpec: 'vGPU-32GB * 1卡',
        systemDiskUsed: '35.81%',
        dataDiskUsed: '55.90%',
        health: '正常',
        billingMode: '按量计费',
        autoReleaseAt: '2026-11-29T11:46:00.000+08:00',
        balanceWarning: null,
        timedShutdownAt: null,
        sshCommand: null,
      },
      {
        instanceId: 'b1hcx779z3-6abbac9b',
        name: '',
        status: 'cloning',
        statusRaw: '克隆锁定中',
        gpuSpec: 'vGPU-48GB * 1卡',
        systemDiskUsed: '3.79%',
        dataDiskUsed: '68.16%',
        health: '正常',
        billingMode: '按量计费',
        autoReleaseAt: null,
        balanceWarning: '余额不足24小时',
        timedShutdownAt: null,
        sshCommand: null,
      },
    ])
  })

  it('无名实例（「设置名称」按钮）解析出空名字', () => {
    const snapshots = parseInstanceList([realRow(4)], OPTIONS)

    expect(snapshots[0]?.name).toBe('')
  })
})

describe('状态归一', () => {
  it('创建进度块里的状态一律判为 cloning，不按词表穷举', () => {
    // 实测见过的两个词：创建中 0.00%、克隆中 87.00%。后续可能再变。
    for (const text of ['创建中 0.00%', '克隆中 87.00%']) {
      const snapshots = parseInstanceList(
        [makeRow({ statusText: text, statusProgressText: text })],
        OPTIONS,
      )

      expect(snapshots[0]?.status).toBe('cloning')
      expect(snapshots[0]?.statusRaw).toBe(text)
    }
  })

  const knownStatuses: ReadonlyArray<readonly [statusText: string, expected: InstanceStatus]> = [
    ['已关机', 'stopped'],
    ['开机中', 'starting'],
    ['运行中', 'running'],
    ['克隆锁定中', 'cloning'],
    ['重置中', 'resetting'],
  ]

  it.each(knownStatuses)('「%s」归一成 %s', (statusText, expected) => {
    const snapshots = parseInstanceList([makeRow({ statusText })], OPTIONS)

    expect(snapshots[0]?.status).toBe(expected)
    expect(snapshots[0]?.statusRaw).toBe(statusText)
  })

  it('状态词后面带补充文字时按前缀匹配，原文写进 statusRaw', () => {
    const snapshots = parseInstanceList([makeRow({ statusText: '已关机 GPU充足' })], OPTIONS)

    expect(snapshots[0]?.status).toBe('stopped')
    expect(snapshots[0]?.statusRaw).toBe('已关机 GPU充足')
  })

  it('未知状态落到 unknown，原文写进 statusRaw', () => {
    const snapshots = parseInstanceList([makeRow({ statusText: '维护中' })], OPTIONS)

    expect(snapshots[0]?.status).toBe('unknown')
    expect(snapshots[0]?.statusRaw).toBe('维护中')
  })
})

describe('释放倒计时', () => {
  it('带天、小时、分时换算成基准时刻加时长', () => {
    const snapshots = parseInstanceList([makeRow({ releaseText: '6天11小时57分后释放' })], OPTIONS)

    expect(snapshots[0]?.autoReleaseAt).toBe('2026-12-01T12:57:00.000+08:00')
  })

  it('只带小时、分时同样换算', () => {
    const snapshots = parseInstanceList([makeRow({ releaseText: '11小时57分后释放' })], OPTIONS)

    expect(snapshots[0]?.autoReleaseAt).toBe('2026-11-25T12:57:00.000+08:00')
  })

  it('没有倒计时时为空', () => {
    const snapshots = parseInstanceList([makeRow({ releaseText: '' })], OPTIONS)

    expect(snapshots[0]?.autoReleaseAt).toBeNull()
  })

  it('运行中实例的「关机N天后释放」不是倒计时，换算为空', () => {
    // 实测原文：实例运行中时该列写「关机15天后释放」，含义是关机后才开始计 15 天。
    const snapshots = parseInstanceList([makeRow({ releaseText: '关机15天后释放' })], OPTIONS)

    expect(snapshots[0]?.autoReleaseAt).toBeNull()
  })

  it('倒计时文本非法时抛错，错误信息含原始文本', () => {
    expect(() => parseInstanceList([makeRow({ releaseText: '稍后释放' })], OPTIONS)).toThrow(
      ConsoleParseError,
    )
    expect(() => parseInstanceList([makeRow({ releaseText: '稍后释放' })], OPTIONS)).toThrow(
      /稍后释放/,
    )
  })

  it('设置过定时关机时从列表读回时刻', () => {
    // 实测原文：格子里 .date 是主干说明，.timed-shutdown 是已设的关机时刻。
    const snapshots = parseInstanceList(
      [makeRow({ releaseText: '关机15天后释放', timedShutdownText: '2026-11-25 05:54:00 修改关闭' })],
      OPTIONS,
    )

    expect(snapshots[0]?.timedShutdownAt).toBe('2026-11-25T05:54:00.000+08:00')
  })

  it('定时关机时刻原文非法时抛错', () => {
    expect(() =>
      parseInstanceList([makeRow({ timedShutdownText: '稍后' })], OPTIONS),
    ).toThrow(/定时关机时刻无法解析/)
  })

  it('整格取不到（结构变化）时抛错，不与「没有倒计时」混为一谈', () => {
    expect(() => parseInstanceList([makeRow({ releaseText: null })], OPTIONS)).toThrow(
      /取不到释放时间单元格/,
    )
  })
})

describe('页面结构变化', () => {
  it('列数不足 10 列时抛错，错误信息含该行原始文本', () => {
    const row = makeRow({ cellTexts: ['西北B区 / 722机 af9c49bd44-8ee624d7 app+asr'] })

    expect(() => parseInstanceList([row], OPTIONS)).toThrow(ConsoleParseError)
    expect(() => parseInstanceList([row], OPTIONS)).toThrow(/西北B区/)
  })

  it('解析结果为空数组时抛错，不返回空列表冒充结果', () => {
    expect(() => parseInstanceList([], OPTIONS)).toThrow(/没有数据行/)
  })

  it('实例 ID 结构位置读错时抛错，不让名字冒充地址', () => {
    expect(() => parseInstanceList([makeRow({ instanceId: 'app+asr' })], OPTIONS)).toThrow(
      /实例 ID 形状不符/,
    )
  })
})

describe('读取参数校验', () => {
  it('倒计时时区基准不是北京时间时拒绝', () => {
    expect(() =>
      parseInstanceList([makeRow({})], { now: NOW, countdownTimeZoneBase: 'UTC' }),
    ).toThrow(ConfigError)
  })
})

describe('readInstanceRows', () => {
  it('返回页面求值结果', async () => {
    const channel = makeChannel(REAL_ROWS)

    await expect(readInstanceRows(channel)).resolves.toEqual(REAL_ROWS)
  })

  it('页面求值结果不是数组时抛错', async () => {
    const channel = makeChannel({ rows: [] })

    await expect(readInstanceRows(channel)).rejects.toThrow(ConsoleParseError)
  })
})

describe('createInstanceListActions', () => {
  it('先等数据行再读，用注入时钟作倒计时基准', async () => {
    const visited: string[] = []
    const channel = makeChannel(REAL_ROWS, (url) => visited.push(url))
    const actions = createInstanceListActions({
      channel,
      logDir: '.tmp/unused',
      timeoutMs: 1000,
      pollIntervalMs: 100,
      clock: {
        now: () => NOW.getTime(),
        sleep: async (): Promise<void> => undefined,
      },
    })

    const snapshots = await actions.listInstances()

    expect(visited).toEqual(['https://www.autodl.com/console/instance/list'])
    expect(snapshots.map((snapshot) => snapshot.instanceId)).toEqual(
      REAL_ROWS.map((row) => row.instanceId),
    )
    expect(snapshots[0]?.autoReleaseAt).toBe('2026-12-01T12:57:00.000+08:00')
  })

  it('要求刷新时先点刷新按钮，等一个刷新窗口再读', async () => {
    const clicked: string[] = []
    const slept: number[] = []
    const channel = makeChannel(REAL_ROWS, undefined, (selector) => clicked.push(selector))
    const actions = createInstanceListActions({
      channel,
      logDir: '.tmp/unused',
      timeoutMs: 1000,
      pollIntervalMs: 100,
      clock: {
        now: () => NOW.getTime(),
        sleep: async (milliseconds: number): Promise<void> => {
          slept.push(milliseconds)
        },
      },
    })

    await actions.listInstances({ refresh: true })

    expect(clicked).toEqual(['.refresh-btn'])
    expect(slept).toEqual([400])
  })

  it('不要求刷新时不碰页面，直接读', async () => {
    const clicked: string[] = []
    const channel = makeChannel(REAL_ROWS, undefined, (selector) => clicked.push(selector))
    const actions = createInstanceListActions({
      channel,
      logDir: '.tmp/unused',
      timeoutMs: 1000,
      pollIntervalMs: 100,
      clock: {
        now: () => NOW.getTime(),
        sleep: async (): Promise<void> => undefined,
      },
    })

    await actions.listInstances()

    expect(clicked).toEqual([])
  })
})

function makeChannel(
  evaluated: unknown,
  onGoto?: (url: string) => void,
  onClick?: (selector: string) => void,
): ConsoleChannel {
  const unsupported = async (): Promise<never> => {
    throw new Error('本用例不应走到这里')
  }
  return {
    goto: async (url: string): Promise<void> => {
      onGoto?.(url)
    },
    currentUrl: async () => 'https://www.autodl.com/console/instance/list',
    evaluate: async <Result,>(_script: string): Promise<Result> => evaluated as Result,
    click: async (selector: string): Promise<void> => {
      onClick?.(selector)
    },
    type: unsupported,
    waitFor: async (): Promise<void> => undefined,
    waitForGone: async (): Promise<void> => undefined,
    screenshot: unsupported,
    close: async (): Promise<void> => undefined,
  }
}
