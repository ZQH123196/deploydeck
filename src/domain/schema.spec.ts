import { describe, expect, it } from 'vitest'
import { PlanSchema } from './plan.js'
import { ProfileSchema } from './profile.js'

/**
 * 领域 schema 的必填判据。
 *
 * 判据（AGENTS.md 代码规范 · 启动期校验）：缺字段必须拒绝，不静默补默认值。
 * 缺字段的配置无法判断行为，补一个值等于凭空授权。
 */

function makeProfile(): Record<string, unknown> {
  return {
    id: 'trans-dev',
    project: 'trans-app',
    provider: 'autodl',
    instanceNamePattern: 'trans-dev',
    gpuPreference: ['v-48g'],
    regionPreference: [],
    cloneDataDisk: true,
    ttlMinutes: 60,
    budgetCapYuan: 6,
    onDeployFailure: 'keep-container',
    requirePinnedCommit: false,
    deployScript: 'scripts/deploy.sh',
    startScript: 'scripts/start.sh',
  }
}

function makePlan(): Record<string, unknown> {
  return {
    id: 'plan-20260101000000-0001',
    profileId: 'trans-dev',
    createdAt: '2026-01-01T00:00:00+08:00',
    expiresAt: '2026-01-01T01:00:00+08:00',
    budgetCapYuan: 6,
    spentYuan: 0,
    state: 'active',
    instanceId: null,
  }
}

describe('ProfileSchema', () => {
  it('完整配置通过', () => {
    expect(ProfileSchema.safeParse(makeProfile()).success).toBe(true)
  })

  it('缺 requirePinnedCommit 时拒绝，不补 false', () => {
    // 判据：spec 第 3.1 节与 docs/plan-and-budget.md 第 3 节都把它标为必填。
    const { requirePinnedCommit: _omitted, ...withoutField } = makeProfile()
    void _omitted

    const parsed = ProfileSchema.safeParse(withoutField)

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path).toEqual(['requirePinnedCommit'])
  })
})

describe('PlanSchema', () => {
  it('完整计划通过', () => {
    expect(PlanSchema.safeParse(makePlan()).success).toBe(true)
  })

  it.each([['state'], ['spentYuan'], ['instanceId']])(
    '缺 %s 时拒绝：残缺状态文件不能被默认值吞掉',
    (field) => {
      const partial = makePlan()
      delete partial[field]

      const parsed = PlanSchema.safeParse(partial)

      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues[0]?.path).toEqual([field])
    },
  )

  it('spentYuan 可以为 0，state 可以是 closed，instanceId 可以是 null', () => {
    const closed = { ...makePlan(), state: 'closed' }

    expect(PlanSchema.safeParse(closed).success).toBe(true)
  })
})
