import { describe, expect, it } from 'vitest'
import type { Profile } from '../domain/profile.js'
import type { Project } from '../domain/project.js'
import { ConfigError } from '../errors.js'
import {
  assertCommitSha,
  DEPLOY_SCRIPT_TIMEOUT_SECONDS,
  HEALTH_CHECK_TIMEOUT_SECONDS,
  normalizeCommitSha,
  planDeploySteps,
  START_SCRIPT_TIMEOUT_SECONDS,
  STEP_ID,
  SYNC_COMMIT_TIMEOUT_SECONDS,
} from './steps.js'

/**
 * 工单 10 的步骤生成规则。
 *
 * 纯函数：不起浏览器、不连 SSH、不碰状态目录。
 */

function makeProfile(overrides: Partial<Profile> = {}): Profile {
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
    ...overrides,
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'trans-app',
    repository: { url: 'git@example.com:trans/app.git', branch: 'main' },
    workdir: '/root/trans_app',
    healthCheck: 'curl -fsS http://127.0.0.1:6006/health',
    ...overrides,
  }
}

describe('planDeploySteps', () => {
  it('克隆路径只跑启动脚本，再跑健康检查', () => {
    const steps = planDeploySteps({
      mode: 'clone',
      profile: makeProfile(),
      project: makeProject(),
    })

    expect(steps.map((step) => step.stepId)).toEqual([STEP_ID.startScript, STEP_ID.healthCheck])
  })

  it('开机复用路径按「部署 → 启动 → 健康检查」排序', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile(),
      project: makeProject(),
    })

    expect(steps.map((step) => step.stepId)).toEqual([
      STEP_ID.deployScript,
      STEP_ID.startScript,
      STEP_ID.healthCheck,
    ])
  })

  it('脚本在项目 workdir 下用 bash 执行，路径带双引号', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile(),
      project: makeProject(),
    })

    expect(steps[0]?.command).toBe('cd "/root/trans_app" && bash "scripts/deploy.sh"')
    expect(steps[1]?.command).toBe('cd "/root/trans_app" && bash "scripts/start.sh"')
  })

  it('健康检查命令在项目 workdir 下执行', () => {
    const steps = planDeploySteps({
      mode: 'clone',
      profile: makeProfile(),
      project: makeProject(),
    })

    const healthCheck = steps[steps.length - 1]
    expect(healthCheck?.command).toBe(
      'cd "/root/trans_app" && curl -fsS http://127.0.0.1:6006/health',
    )
    expect(healthCheck?.kind).toBe('ssh')
  })

  it('三个步骤各自取显式超时常量', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile(),
      project: makeProject(),
    })

    expect(steps.map((step) => step.timeoutSeconds)).toEqual([
      DEPLOY_SCRIPT_TIMEOUT_SECONDS,
      START_SCRIPT_TIMEOUT_SECONDS,
      HEALTH_CHECK_TIMEOUT_SECONDS,
    ])
  })

  it('脚本路径含双引号时抛 ConfigError，不生成半条命令', () => {
    expect(() =>
      planDeploySteps({
        mode: 'reuse',
        profile: makeProfile({ deployScript: 'scripts/de"ploy.sh' }),
        project: makeProject(),
      }),
    ).toThrow(ConfigError)
  })

  it('workdir 含换行时抛 ConfigError', () => {
    expect(() =>
      planDeploySteps({
        mode: 'clone',
        profile: makeProfile(),
        project: makeProject({ workdir: '/root/trans\n_app' }),
      }),
    ).toThrow(ConfigError)
  })

  it('workdir 不是绝对路径时抛 ConfigError', () => {
    // 双引号里的 ~ 不会展开：相对路径与 ~ 路径会让 cd 落到不可预期的地方。
    expect(() =>
      planDeploySteps({
        mode: 'clone',
        profile: makeProfile(),
        project: makeProject({ workdir: '~/trans_app' }),
      }),
    ).toThrow(ConfigError)
  })
})

describe('sync-commit 步骤', () => {
  it('没给 commit 时没有该步骤', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile(),
      project: makeProject(),
    })

    expect(steps.map((step) => step.stepId)).not.toContain(STEP_ID.syncCommit)
  })

  it('开机复用路径给了 commit 时，sync-commit 是第一步', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile(),
      project: makeProject(),
      commitSha: 'abc1234',
    })

    expect(steps.map((step) => step.stepId)).toEqual([
      STEP_ID.syncCommit,
      STEP_ID.deployScript,
      STEP_ID.startScript,
      STEP_ID.healthCheck,
    ])
    expect(steps[0]?.kind).toBe('ssh')
    expect(steps[0]?.timeoutSeconds).toBe(SYNC_COMMIT_TIMEOUT_SECONDS)
  })

  it('克隆路径给了 commit 时，sync-commit 仍在第一步', () => {
    const steps = planDeploySteps({
      mode: 'clone',
      profile: makeProfile(),
      project: makeProject(),
      commitSha: 'deadbeef',
    })

    expect(steps.map((step) => step.stepId)).toEqual([
      STEP_ID.syncCommit,
      STEP_ID.startScript,
      STEP_ID.healthCheck,
    ])
  })

  it('仓库已在时先 fetch 再强制切 commit，并在同一条命令里回验 HEAD', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile(),
      project: makeProject(),
      commitSha: 'abc1234',
    })
    const command = steps[0]?.command ?? ''

    expect(command).toContain('if [ -d "/root/trans_app/.git" ]')
    expect(command).toContain('git fetch --all --prune')
    expect(command).toContain('git checkout --force "abc1234"')
    expect(command).toContain('test "$(git -C "/root/trans_app" rev-parse HEAD)" = "abc1234"')
  })

  it('仓库不在时按 repository.branch 克隆到 workdir，再切 commit', () => {
    const steps = planDeploySteps({
      mode: 'clone',
      profile: makeProfile(),
      project: makeProject({
        repository: { url: 'https://example.com/trans/app.git', branch: 'release' },
      }),
      commitSha: 'abc1234',
    })
    const command = steps[0]?.command ?? ''

    expect(command).toContain(
      'git clone --branch "release" "https://example.com/trans/app.git" "/root/trans_app"',
    )
    expect(command).toContain('git checkout --force "abc1234"')
  })

  it('workdir 末尾带 / 时拒绝，避免拼出 //.git', () => {
    expect(() =>
      planDeploySteps({
        mode: 'reuse',
        profile: makeProfile(),
        project: makeProject({ workdir: '/root/trans_app/' }),
        commitSha: 'abc1234',
      }),
    ).toThrow(ConfigError)
  })

  it('非十六进制 sha 抛 ConfigError，拒绝注入', () => {
    // Arrange：分号、空格、引号、$() 都是命令注入的形状。
    const invalid = ['abc; rm -rf /', 'abc 123', 'abc"def', '$(whoami)', '', '   ']

    // Act / Assert
    for (const sha of invalid) {
      expect(() =>
        planDeploySteps({
          mode: 'reuse',
          profile: makeProfile(),
          project: makeProject(),
          commitSha: sha,
        }),
      ).toThrow(ConfigError)
    }
  })

  it('assertCommitSha 接受 4-40 位十六进制', () => {
    expect(assertCommitSha('abcd')).toBe('abcd')
    expect(assertCommitSha('A'.repeat(40))).toBe('A'.repeat(40))
    expect(() => assertCommitSha('abc')).toThrow(ConfigError)
    expect(() => assertCommitSha('A'.repeat(41))).toThrow(ConfigError)
  })

  it('normalizeCommitSha 把空串当配置错误，不静默当没给', () => {
    expect(normalizeCommitSha(null)).toBeNull()
    expect(normalizeCommitSha('abc1234')).toBe('abc1234')
    expect(() => normalizeCommitSha('')).toThrow(ConfigError)
    expect(() => normalizeCommitSha('   ')).toThrow(ConfigError)
  })
})
