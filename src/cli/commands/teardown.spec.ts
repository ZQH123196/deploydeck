import { describe, expect, it } from 'vitest'
import type { LedgerEntry } from '../../state/ledger.js'
import {
  createFixture,
  createPlan,
  FakeProvider,
  INSTANCE_ID,
  makeInstance,
  parseSingleJson,
  runOnce,
  START_ISO,
} from '../spec-harness.js'

/**
 * `teardown` 的账本口径与计划状态验收。
 *
 * 外部依赖全是假的（假 provider、假时钟、`.tmp/` 下的真临时状态目录），
 * 不连浏览器、不连 SSH。失败时看用例名就知道哪条判据没满足。
 *
 * 两个来自审查的问题在这里锁死：
 * M1 停机成功已经写过账，再 teardown 不得用新钟点造第二行，也不得静默丢弃那段时长。
 * M2 「停机成功、等结算」与「停机失败、钱可能还在烧」必须是两个不同的计划状态。
 */

/** 让实例从列表消失，模拟「销毁链走完」。 */
function makeInstanceVanishing(fixture: { provider: FakeProvider }): void {
  fixture.provider.snapshots = []
}

describe('teardown：账本不重复记，也不丢时长', () => {
  it('停机成功已写账后 teardown：账本仍是一行，花费等于那一行，文案说清费用在哪一刻封口', async () => {
    // Arrange：部署脚本失败 → 失败收尾停机成功并写一行账（停机时刻 = T+30 分）。
    const fixture = await createFixture({
      providerFactory: (clock) =>
        new FakeProvider(clock, [makeInstance()], {
          exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
          onExec: (command, fakeClock) => {
            if (command.includes('curl')) {
              fakeClock.advanceMinutes(30)
            }
          },
        }),
    })
    const planId = await createPlan(fixture)
    await fixture.run(['run', '--plan', planId, '--json', '--run-id', 'run-m1-stop-ledger'])

    const beforeTeardown = await fixture.readLedger()
    expect(beforeTeardown).toHaveLength(1)
    const recordedEntry = beforeTeardown[0] as LedgerEntry
    expect(recordedEntry.amountYuan).toBeCloseTo(0.5, 10)

    // 停机之后又过了 120 分钟才有人执行 teardown。这段时间不算：实例已经关着。
    fixture.clock.advanceMinutes(120)

    // Act
    const code = await fixture.run(['teardown', planId, '--json'])

    // Assert：账本仍是一行，金额没被改写成「从停机到 teardown」的 2.5 元。
    expect(code).toBe(0)
    const afterTeardown = await fixture.readLedger()
    expect(afterTeardown).toHaveLength(1)
    expect(afterTeardown[0]).toEqual(recordedEntry)

    const payload = parseSingleJson(fixture)
    expect(payload['ledgerEntry']).toBeNull()
    expect(payload['settledBeforeThisRun']).toBe(true)
    // 计费终点必须写进输出：只说「未重复记账」答不出「钱停在几点」。
    expect(payload['accountedStoppedAt']).toBe(recordedEntry.stoppedAt)
    // 花费等于那一行的金额，不是 0，也不是 3 元。
    expect(payload['spentYuan']).toBeCloseTo(recordedEntry.amountYuan, 10)
    expect((await fixture.readPlan(planId)).spentYuan).toBeCloseTo(recordedEntry.amountYuan, 10)
  })

  it('teardown 的人读输出写明本次没有新增账本行，以及费用在哪一刻封口', async () => {
    // Arrange
    const fixture = await createFixture({
      providerFactory: (clock) =>
        new FakeProvider(clock, [makeInstance()], {
          exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
        }),
    })
    const planId = await createPlan(fixture)
    await fixture.run(['run', '--plan', planId, '--run-id', 'run-m1-human-text'])
    const recordedEntry = (await fixture.readLedger())[0] as LedgerEntry

    // Act
    const code = await fixture.run(['teardown', planId])
    const text = fixture.stdoutText()

    // Assert：判据是文案不能让人误以为这是一次幂等成功。
    expect(code).toBe(0)
    expect(text).toContain('本次没有新增账本行')
    expect(text).toContain(recordedEntry.stoppedAt)
    expect(text).not.toContain('未重复记账')
  })

  it('实例没有被写过账时 teardown 新增一行，金额按当天停机时刻算', async () => {
    // Arrange：执行成功（实例仍在运行），账本还是空的。
    // 实例必须还在列表里：不在列表且没有账本行时无从确定停机时刻，属另一条既有语义（交人工）。
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    await runOnce(fixture, planId, 'run-m1-no-entry')
    expect(await fixture.readLedger()).toEqual([])

    // Act
    const code = await fixture.run(['teardown', planId, '--json'])

    // Assert：这次才是「新增一行」。
    expect(code).toBe(0)
    const entries = await fixture.readLedger()
    expect(entries).toHaveLength(1)
    const payload = parseSingleJson(fixture)
    expect(payload['settledBeforeThisRun']).toBe(false)
    expect(payload['accountedStoppedAt']).toBeNull()
    // 停机时刻 = 本次 teardown 的时刻（实例一直在跑，没有更早的封口点）。
    expect(Date.parse((payload['ledgerEntry'] as LedgerEntry).stoppedAt)).toBe(Date.parse(START_ISO))
  })

  it('实例已不在列表且有账本行：直接关闭计划，不构造新账本行', async () => {
    // Arrange：失败停机写过账，之后实例已从列表消失（别人先销毁了）。
    const fixture = await createFixture({
      providerFactory: (clock) =>
        new FakeProvider(clock, [makeInstance()], {
          exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
        }),
    })
    const planId = await createPlan(fixture)
    await fixture.run(['run', '--plan', planId, '--run-id', 'run-m1-already-gone'])
    const recordedEntry = (await fixture.readLedger())[0] as LedgerEntry
    makeInstanceVanishing(fixture)

    // Act
    const code = await fixture.run(['teardown', planId, '--json'])

    // Assert：账本一行不变，且这一次没有调用销毁链（实例本来就不在）。
    expect(code).toBe(0)
    expect(await fixture.readLedger()).toEqual([recordedEntry])
    expect(fixture.provider.calls).not.toContain('destroy')
    const payload = parseSingleJson(fixture)
    expect(payload['state']).toBe('closed')
    expect(payload['spentYuan']).toBeCloseTo(recordedEntry.amountYuan, 10)
    expect(payload['accountedStoppedAt']).toBe(recordedEntry.stoppedAt)
  })

  it('重复执行 teardown 不会再写账：第二次报「已关闭」', async () => {
    // Arrange
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    await runOnce(fixture, planId, 'run-m1-twice')
    expect(await fixture.run(['teardown', planId])).toBe(0)
    const afterFirst = await fixture.readLedger()

    // Act
    const secondCode = await fixture.run(['teardown', planId])

    // Assert
    expect(secondCode).toBe(1)
    expect(await fixture.readLedger()).toEqual(afterFirst)
  })
})

describe('teardown：计划状态读得懂', () => {
  it('停机成功待结算的计划可以被 teardown 读取并关闭', async () => {
    // Arrange：失败停机成功 → 计划状态是 stopped-pending-settlement。
    const fixture = await createFixture({
      providerFactory: (clock) =>
        new FakeProvider(clock, [makeInstance()], {
          exitCodeFor: (command) => (command.includes('curl') ? 1 : 0),
        }),
    })
    const planId = await createPlan(fixture)
    await fixture.run(['run', '--plan', planId, '--run-id', 'run-m2-read'])
    expect((await fixture.readPlan(planId)).state).toBe('stopped-pending-settlement')

    // Act：teardown 不得把这种计划当成「已关闭」或「非法状态」拒掉。
    const code = await fixture.run(['teardown', planId, '--json'])

    // Assert
    expect(code).toBe(0)
    expect((await fixture.readPlan(planId)).state).toBe('closed')
    expect(parseSingleJson(fixture)['instanceId']).toBe(INSTANCE_ID)
  })

  it('销毁未确认消失时计划转 escalated，不写榜外账本行', async () => {
    // Arrange：执行成功但没写账，销毁链报未确认消失。
    const fixture = await createFixture()
    const planId = await createPlan(fixture)
    await runOnce(fixture, planId, 'run-m2-not-gone')
    fixture.provider.destroyResult = { state: 'escalated', reason: '释放后列表里还在' }

    // Act
    const code = await fixture.run(['teardown', planId])

    // Assert：实例可能还在跑 → escalated，退出码 2，账本不写。
    expect(code).toBe(2)
    expect((await fixture.readPlan(planId)).state).toBe('escalated')
    expect(await fixture.readLedger()).toEqual([])
    expect(fixture.stderrText()).toContain('ESCALATED')
  })
})
