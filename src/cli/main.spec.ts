import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Plan } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import { createRunStore, RUNS_DIRECTORY } from '../engine/run-store.js'
import { ConfigError, LoginRequiredError } from '../errors.js'
import { createPlanStore } from '../plan/plan-store.js'
import type { ProviderSession } from './dependencies.js'
import type { OutputStream } from './output.js'
import {
  createFixture,
  createPlan,
  FakeProvider,
  INSTANCE_ID,
  makeInstance,
  parseSingleJson,
  runOnce,
  temporaryParents,
  type CliFixture,
  type FakeClock,
} from './spec-harness.js'

/**
 * CLI 命令面的验收用例（工单 12）。
 *
 * 外部依赖全部是假的：provider 用手写假对象，配置目录用仓库里的 `examples/`，
 * 状态目录用 `.tmp/` 下的真实临时目录，时钟用假时钟。不连浏览器、不连 SSH、不连真实控制台。
 * 每条用例对应工单验收里的一条要求，失败时看用例名就知道哪一条没满足。
 */

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

  it('业务错误在 stderr 行首打出稳定错误码，机器读者按码分叉', async () => {
    // 判据（docs/OPERATIONS.md 第 7.3 节）：退出码只有三个值，区分不了具体失败原因。
    const fixture = await createFixture()

    await fixture.run(['plan', 'show', 'plan-missing', '--json'])

    expect(fixture.stderrText().split('\n')[0]).toMatch(/^\[PLAN_INVALID\] /)
  })

  it('未登录的 stderr 行首是 LOGIN_REQUIRED，退出码 2', async () => {
    const fixture = await createFixture({ loginRequired: true })
    const planId = await createPlan(fixture)

    expect(await fixture.run(['run', '--plan', planId, '--json'])).toBe(2)

    expect(fixture.stderrText().split('\n')[0]).toMatch(/^\[LOGIN_REQUIRED\] /)
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
          exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
          // 部署脚本失败，且耗时 30 分钟：账本金额应当非零。
          onExec: (command, fakeClock) => {
            if (command.includes('curl')) {
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

describe('CLI：power / switch / creds / tunnel 的参数面', () => {
  it('help 里列出四个子命令，命名与 C 组导出的常量一致', async () => {
    const fixture = await createFixture()

    await fixture.run(['--help'])

    const help = fixture.stdoutText()
    expect(help).toMatch(/^\s+power /m)
    expect(help).toMatch(/^\s+switch /m)
    expect(help).toMatch(/^\s+creds /m)
    expect(help).toMatch(/^\s+tunnel /m)
    // 命名照 C 组：不是 credentials、不是 port-forward。
    expect(help).not.toMatch(/credentials\s+<instanceId>/)
  })

  it('power 只给一个 --on/--off 都不给时报参数错误，不碰任何实例', async () => {
    const fixture = await createFixture()

    const code = await fixture.run(['power', INSTANCE_ID])

    expect(code).not.toBe(0)
    expect(fixture.provider.calls).toEqual([])
  })
})

describe('CLI：creds 的人读模式不许把密码写进文件', () => {
  it('不重定向时人读模式拒接（stdout 在测试进程里不是终端），退出码 2', async () => {
    // 判据：`process.stdout.isTTY` 在 vitest 下恒为 undefined，正好是「被重定向」的形状。
    // 命令必须在这条形状上拒绝，而不是把密码写出去。
    const fixture = await createFixture()

    const code = await fixture.run(['creds', INSTANCE_ID])

    expect(code).toBe(2)
    expect(fixture.stdoutText()).toBe('')
    expect(fixture.stderrText()).toContain('HUMAN_REQUIRED')
    expect(fixture.stderrText()).toContain('--json')
  })

  it('--json 不受 tty 限制：过了前置校验，走到打开凭据通道', async () => {
    // 判据：两条路径的分界只有 `--json`。这里装配层没有真实控制台，
    // 所以期望的是「打开了凭据通道」这类错误，而不是 tty 拒绝。
    const fixture = await createFixture()

    const code = await fixture.run(['creds', INSTANCE_ID, '--json'])

    expect(code).not.toBe(0)
    expect(fixture.stderrText()).not.toContain('不是终端')
  })
})
