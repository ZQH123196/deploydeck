import { describe, expect, it } from 'vitest'
import type { Project } from '../domain/project.js'
import { ConfigError } from '../errors.js'
import { HEALTH_CHECK_TIMEOUT_SECONDS, planDeploySteps, STEP_ID } from './steps.js'

/**
 * 步骤生成规则。
 *
 * 纯函数：不起浏览器、不连 SSH、不碰状态目录。
 */

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'trans-app',
    workdir: '/root/trans_app',
    healthCheck: 'curl -fsS http://127.0.0.1:6006/health',
    ...overrides,
  }
}

describe('planDeploySteps', () => {
  it('只有一步：健康检查', () => {
    const steps = planDeploySteps({ project: makeProject() })

    expect(steps.map((step) => step.stepId)).toEqual([STEP_ID.healthCheck])
  })

  it('步骤序列与获取方式无关：入参只有项目清单', () => {
    // 判据：获取方式（克隆 / 开机复用）不改步骤序列，所以函数不接受它。
    // 传入多余键时函数不得改变输出；其中 `mode` 若被重新引入并把脚本步骤带回来，本条会变红。
    const withMode = { project: makeProject(), mode: 'reuse' as const }

    expect(planDeploySteps(withMode).map((step) => step.stepId)).toEqual([STEP_ID.healthCheck])
  })

  it('健康检查在项目 workdir 下执行，取显式超时常量', () => {
    const [step] = planDeploySteps({ project: makeProject() })

    expect(step?.command).toBe('cd "/root/trans_app" && curl -fsS http://127.0.0.1:6006/health')
    expect(step?.kind).toBe('ssh')
    expect(step?.timeoutSeconds).toBe(HEALTH_CHECK_TIMEOUT_SECONDS)
  })

  it('步骤只有 id、类型、命令与超时四个字段，命令里没有任何脚本路径', () => {
    // 判据：远端命令只有健康检查这一条，不来自配置文本，也没有写死的脚本路径。
    const [step] = planDeploySteps({ project: makeProject() })

    expect(Object.keys(step ?? {}).sort()).toEqual(['command', 'kind', 'stepId', 'timeoutSeconds'])
    expect(step?.command).not.toContain('bash')
    expect(step?.command).not.toContain('.sh')
    expect(step?.command).not.toContain('export')
    expect(step?.command).not.toContain('$')
  })

  it('healthCheck 只有空白时抛 ConfigError', () => {
    expect(() => planDeploySteps({ project: makeProject({ healthCheck: '   ' }) })).toThrow(
      ConfigError,
    )
  })

  it('workdir 含双引号时抛 ConfigError，不生成半条命令', () => {
    expect(() => planDeploySteps({ project: makeProject({ workdir: '/root/"x' }) })).toThrow(
      ConfigError,
    )
  })

  it('workdir 含换行时抛 ConfigError', () => {
    expect(() =>
      planDeploySteps({ project: makeProject({ workdir: '/root/trans\n_app' }) }),
    ).toThrow(ConfigError)
  })

  it('workdir 不是绝对路径时抛 ConfigError', () => {
    // 双引号里的 ~ 不会展开：相对路径与 ~ 路径会让 cd 落到不可预期的地方。
    expect(() => planDeploySteps({ project: makeProject({ workdir: '~/trans_app' }) })).toThrow(
      ConfigError,
    )
  })

  it('workdir 末尾带 / 时拒绝', () => {
    expect(() =>
      planDeploySteps({ project: makeProject({ workdir: '/root/trans_app/' }) }),
    ).toThrow(ConfigError)
  })
})

describe('步骤清单：不再有任何脚本步骤', () => {
  /**
   * 按「使用者可能写错」的形状调它：多传的键不属于入参类型，所以断言能编译。
   * 这些键若被重新接受并把脚本步骤带回来，下面的断言会变红。
   */
  const planWithWiderInput = planDeploySteps as unknown as (input: Record<string, unknown>) => readonly {
    readonly stepId: string
  }[]

  it('引擎不跑使用者的命令：唯一生成的步骤是健康检查', () => {
    // 判据（ADR-0047）：deploydeck 不提供任何自动运行的业务脚本。命令清单里出现别的
    // 步骤号，就说明有一步在做「验证连通性」以外的动作。
    const stepIds: readonly string[] = planDeploySteps({ project: makeProject() }).map(
      (step) => step.stepId,
    )

    expect(stepIds).toEqual(['health-check'])
  })

  it('获取方式不参与步骤生成：入参里没有 mode', () => {
    // 判据：克隆与开机复用只差「怎么拿到实例」，拿到之后要做的事完全相同。
    // 入参重新接受 mode 并把脚本步骤带回来时，这两条会一起变红。
    for (const mode of ['clone', 'reuse'] as const) {
      const stepIds = planWithWiderInput({ project: makeProject(), mode }).map(
        (step) => step.stepId,
      )

      expect(stepIds).toEqual(['health-check'])
    }
  })
})
