import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { PlanSchema } from './plan.js'
import { ProfileSchema } from './profile.js'
import { ProjectSchema } from './project.js'
import { StepResultSchema } from './run.js'

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
  }
}

function makeProject(): Record<string, unknown> {
  return {
    id: 'trans-app',
    workdir: '/root/trans_app',
    healthCheck: 'curl -fsS http://127.0.0.1:6006/health',
  }
}

function makeStepResult(): Record<string, unknown> {
  return {
    stepId: 'health-check',
    kind: 'ssh',
    command: 'cd "/root/trans_app" && curl -fsS http://127.0.0.1:6006/health',
    exitCode: 0,
    startedAt: '2026-01-01T00:00:00+08:00',
    finishedAt: '2026-01-01T00:00:01+08:00',
    stdoutTail: '',
    stderrTail: '',
    logPath: '/state/runs/run-1/logs/health-check.log',
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

  it.each([['id'], ['project'], ['instanceNamePattern'], ['gpuPreference'], ['ttlMinutes'], ['budgetCapYuan']])(
    '缺 %s 时拒绝：必填字段不补默认值',
    (field) => {
      const partial = makeProfile()
      delete partial[field]

      const parsed = ProfileSchema.safeParse(partial)

      expect(parsed.success).toBe(false)
      expect(parsed.error?.issues[0]?.path).toEqual([field])
    },
  )

  it.each([
    ['deployScript', 'scripts/deploy.sh'],
    ['startScript', 'scripts/start.sh'],
    ['bootstrapScript', 'scripts/bootstrap.sh'],
    ['bootstrapEnv', { TOKEN: 'x' }],
    ['env', { DB_PASSWORD: 'x' }],
    ['requirePinnedCommit', true],
  ])('已删除的字段 %s 不进解析结果', (field, value) => {
    // 判据：schema 是 strip 型，多余的键不报错，所以只能断言结果里没有它。
    // 有人把字段加回 schema 时，这条断言会变红。
    const parsed = ProfileSchema.safeParse({ ...makeProfile(), [field]: value })

    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty(field)
  })
})

describe('ProjectSchema', () => {
  it('完整清单通过', () => {
    expect(ProjectSchema.safeParse(makeProject()).success).toBe(true)
  })

  it.each([['id'], ['workdir'], ['healthCheck']])('缺 %s 时拒绝', (field) => {
    const partial = makeProject()
    delete partial[field]

    const parsed = ProjectSchema.safeParse(partial)

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path).toEqual([field])
  })

  it.each([
    ['repository', { url: 'git@example.com:trans/app.git', branch: 'main' }],
    ['dataDiskPath', '/root/autodl-tmp'],
  ])('已删除的字段 %s 不进解析结果', (field, value) => {
    const parsed = ProjectSchema.safeParse({ ...makeProject(), [field]: value })

    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty(field)
  })

  it('解析结果只有 id、workdir 与 healthCheck', () => {
    expect(Object.keys(ProjectSchema.parse(makeProject())).sort()).toEqual([
      'healthCheck',
      'id',
      'workdir',
    ])
  })
})

describe('StepResultSchema', () => {
  it('完整步骤结果通过', () => {
    expect(StepResultSchema.safeParse(makeStepResult()).success).toBe(true)
  })

  it('没有 skipped 字段：步骤结果不表达「跳过」', () => {
    // 判据：跳过只有一个来源，且该来源已删除。schema 是 strip 型，只能断言结果里没有它。
    const parsed = StepResultSchema.safeParse({ ...makeStepResult(), skipped: true })

    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty('skipped')
  })

  it('解析结果只有 stepId、kind、command、exitCode、时间、输出、日志与截图', () => {
    expect(Object.keys(StepResultSchema.parse(makeStepResult())).sort()).toEqual(
      [
        'command',
        'exitCode',
        'finishedAt',
        'kind',
        'logPath',
        'screenshotPaths',
        'startedAt',
        'stderrBytes',
        'stderrTail',
        'stdoutBytes',
        'stdoutTail',
        'stepId',
      ].sort(),
    )
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

describe('examples/ 下的配置能通过 schema', () => {
  const root = join(process.cwd(), 'examples')

  async function readJsoncDirectory(dir: string): Promise<Record<string, unknown>[]> {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonc')).sort()
    const values: Record<string, unknown>[] = []
    for (const name of names) {
      const text = await readFile(join(dir, name), 'utf8')
      const errors: ParseError[] = []
      const value = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown>
      expect(errors).toEqual([])
      values.push(value)
    }
    return values
  }

  it('每个示例部署配置都能通过 ProfileSchema', async () => {
    const profiles = await readJsoncDirectory(join(root, 'profiles'))

    expect(profiles.length).toBeGreaterThan(0)
    for (const profile of profiles) {
      const parsed = ProfileSchema.safeParse(profile)
      expect(parsed.error?.issues ?? []).toEqual([])
    }
  })

  it('每个示例项目清单都能通过 ProjectSchema', async () => {
    const projects = await readJsoncDirectory(join(root, 'projects'))

    expect(projects.length).toBeGreaterThan(0)
    for (const project of projects) {
      const parsed = ProjectSchema.safeParse(project)
      expect(parsed.error?.issues ?? []).toEqual([])
    }
  })
})
