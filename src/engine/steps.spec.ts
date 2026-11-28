import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { Profile } from '../domain/profile.js'
import { ProfileSchema } from '../domain/profile.js'
import type { Project } from '../domain/project.js'
import { ConfigError, REMOTE_ENV_NOT_INJECTED_EXIT_CODE } from '../errors.js'
import {
  assertCommitSha,
  BOOTSTRAP_TIMEOUT_SECONDS,
  buildDataDiskUsageCommand,
  buildEnvPresenceCheck,
  DATA_DISK_READY_TIMEOUT_SECONDS,
  DATA_DISK_SAMPLE_INTERVAL_SECONDS,
  DATA_DISK_STABLE_SAMPLE_COUNT,
  DEPLOY_SCRIPT_TIMEOUT_SECONDS,
  HEALTH_CHECK_TIMEOUT_SECONDS,
  normalizeCommitSha,
  planDeploySteps,
  scriptCommandWithEnvCheck,
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
    powerOnMode: 'gpu',
    cloneDataDisk: true,
    ttlMinutes: 60,
    budgetCapYuan: 6,
    onDeployFailure: 'keep-container',
    requirePinnedCommit: false,
    deployScript: 'scripts/deploy.sh',
    startScript: 'scripts/start.sh',
    env: {},
    bootstrapEnv: {},
    ...overrides,
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'trans-app',
    repository: { url: 'git@example.com:trans/app.git', branch: 'main' },
    workdir: '/root/trans_app',
    healthCheck: 'curl -fsS http://127.0.0.1:6006/health',
    dataDiskPath: '/root/autodl-tmp',
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

    // 克隆路径多一步数据盘就绪：状态离开克隆锁定中不等于数据盘拷完。
    expect(steps.map((step) => step.stepId)).toEqual([
      STEP_ID.dataDiskReady,
      STEP_ID.startScript,
      STEP_ID.healthCheck,
    ])
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
      STEP_ID.dataDiskReady,
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

describe('引导脚本步骤', () => {
  it('有引导脚本时排在启动脚本之前，两条路径都是', () => {
    for (const mode of ['clone', 'reuse'] as const) {
      const steps = planDeploySteps({
        mode,
        profile: makeProfile({ bootstrapScript: 'scripts/bootstrap.sh' }),
        project: makeProject(),
      })

      const ids = steps.map((step) => step.stepId)
      expect(ids).toContain(STEP_ID.bootstrapScript)
      expect(ids.indexOf(STEP_ID.bootstrapScript)).toBeLessThan(ids.indexOf(STEP_ID.startScript))
    }
  })

  it('没有引导脚本时不生成引导步骤', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile(),
      project: makeProject(),
    })

    expect(steps.map((step) => step.stepId)).not.toContain(STEP_ID.bootstrapScript)
  })

  it('引导步骤用独立超时，不受启动脚本 600 秒上限影响', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile({ bootstrapScript: 'scripts/bootstrap.sh' }),
      project: makeProject(),
    })

    const bootstrap = steps.find((step) => step.stepId === STEP_ID.bootstrapScript)
    const start = steps.find((step) => step.stepId === STEP_ID.startScript)
    expect(bootstrap?.timeoutSeconds).toBe(BOOTSTRAP_TIMEOUT_SECONDS)
    expect(BOOTSTRAP_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(7200)
    expect(start?.timeoutSeconds).toBe(START_SCRIPT_TIMEOUT_SECONDS)
    expect(START_SCRIPT_TIMEOUT_SECONDS).toBe(600)
  })

  it('引导步骤的命令只含脚本路径与变量名，不含任何取值或说明文字', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile({
        bootstrapScript: 'scripts/bootstrap.sh',
        bootstrapEnv: { HF_TOKEN: '模型站 token', MIRROR: '镜像站' },
      }),
      project: makeProject(),
    })

    const bootstrap = steps.find((step) => step.stepId === STEP_ID.bootstrapScript)
    expect(bootstrap?.command).toContain('for v in HF_TOKEN MIRROR;')
    expect(bootstrap?.command).toContain(' && cd "/root/trans_app" && bash "scripts/bootstrap.sh"')
    expect(bootstrap?.envNames).toEqual(['HF_TOKEN', 'MIRROR'])
    expect(bootstrap?.command).not.toContain('模型站')
    expect(bootstrap?.command).not.toContain('镜像站')
  })
})

describe('环境变量只以名字进步骤', () => {
  it('部署脚本与启动脚本带 Profile.env 的变量名，健康检查不带', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile({ env: { DB_PASSWORD: '数据库口令' } }),
      project: makeProject(),
    })

    const deploy = steps.find((step) => step.stepId === STEP_ID.deployScript)
    const start = steps.find((step) => step.stepId === STEP_ID.startScript)
    const health = steps.find((step) => step.stepId === STEP_ID.healthCheck)
    expect(deploy?.envNames).toEqual(['DB_PASSWORD'])
    expect(start?.envNames).toEqual(['DB_PASSWORD'])
    expect(health?.envNames).toBeUndefined()
  })

  it('命令文本里只有变量名，Profile 的说明文字一律不拼进命令', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile({ env: { DB_PASSWORD: '这个说明不该出现在命令里' } }),
      project: makeProject(),
    })

    for (const step of steps) {
      // 说明文字是给人读的，不是取值来源，任何一条命令里都不该出现。
      expect(step.command).not.toContain('这个说明不该出现在命令里')
      expect(step.command).not.toContain('export')
    }
    // 变量名只出现在自检前缀里，不是取值。
    expect(steps[0]?.command).toContain('DB_PASSWORD')
  })

  it('引导环境与脚本环境分开：bootstrapEnv 只出现在引导步骤上', () => {
    const steps = planDeploySteps({
      mode: 'reuse',
      profile: makeProfile({
        bootstrapScript: 'scripts/bootstrap.sh',
        env: { APP_TOKEN: '应用用' },
        bootstrapEnv: { HF_TOKEN: '模型下载用' },
      }),
      project: makeProject(),
    })

    const bootstrap = steps.find((step) => step.stepId === STEP_ID.bootstrapScript)
    const start = steps.find((step) => step.stepId === STEP_ID.startScript)
    expect(bootstrap?.envNames).toEqual(['HF_TOKEN'])
    expect(start?.envNames).toEqual(['APP_TOKEN'])
  })
})

describe('数据盘就绪步骤', () => {
  it('克隆路径上排在启动脚本之前', () => {
    const steps = planDeploySteps({ mode: 'clone', profile: makeProfile(), project: makeProject() })

    const ids = steps.map((step) => step.stepId)
    expect(ids.indexOf(STEP_ID.dataDiskReady)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(STEP_ID.dataDiskReady)).toBeLessThan(ids.indexOf(STEP_ID.startScript))
  })

  it('cloneDataDisk=false 时没有这一步：数据盘没跟着克隆，不存在「盘还在拷」', () => {
    // 判据：没克隆数据盘时实例上不存在这个状态，这一步会空等一个永远不会准备好的盘。
    // 目录总是存在，没克隆时只是空的——「空盘」与「盘在拷」是两个状态。
    const steps = planDeploySteps({
      mode: 'clone',
      profile: makeProfile({ cloneDataDisk: false }),
      project: makeProject(),
    })

    expect(steps.map((step) => step.stepId)).toEqual([STEP_ID.startScript, STEP_ID.healthCheck])
  })

  it('cloneDataDisk 缺省为 true 时要加这一步', () => {
    // 判据：ProfileSchema 的缺省值是 true，老配置不写它时也必须有门控为真的结果。
    const steps = planDeploySteps({ mode: 'clone', profile: makeProfile(), project: makeProject() })

    expect(steps.map((step) => step.stepId)).toContain(STEP_ID.dataDiskReady)
  })

  it('开机复用路径没有这一步：实例的数据盘不重新拷', () => {
    const steps = planDeploySteps({ mode: 'reuse', profile: makeProfile(), project: makeProject() })

    expect(steps.map((step) => step.stepId)).not.toContain(STEP_ID.dataDiskReady)
  })

  it('采样命令读数据盘已用字节数，并用连续两次相同作为结束条件', () => {
    const steps = planDeploySteps({ mode: 'clone', profile: makeProfile(), project: makeProject() })

    const step = steps.find((candidate) => candidate.stepId === STEP_ID.dataDiskReady)
    expect(step?.kind).toBe('ssh')
    expect(step?.timeoutSeconds).toBe(DATA_DISK_READY_TIMEOUT_SECONDS)
    expect(step?.command).toContain('df -B1')
    expect(step?.command).toContain('"/root/autodl-tmp"')
    expect(step?.command).toContain(`"$stable" -lt ${String(DATA_DISK_STABLE_SAMPLE_COUNT)}`)
    expect(step?.command).toContain(`sleep ${String(DATA_DISK_SAMPLE_INTERVAL_SECONDS)}`)
    // 读不到数字必须以非 0 退出：读不到不等于拷完。
    expect(step?.command).toContain('exit 1')
  })

  it('数据盘路径来自项目清单，不是写死的', () => {
    const steps = planDeploySteps({
      mode: 'clone',
      profile: makeProfile(),
      project: makeProject({ dataDiskPath: '/mnt/tmpdata' }),
    })

    const step = steps.find((candidate) => candidate.stepId === STEP_ID.dataDiskReady)
    expect(step?.command).toContain('"/mnt/tmpdata"')
    expect(step?.command).not.toContain('/root/autodl-tmp')
  })

  it('数据盘路径含双引号时拒绝，不生成半条命令', () => {
    expect(() =>
      planDeploySteps({
        mode: 'clone',
        profile: makeProfile(),
        project: makeProject({ dataDiskPath: '/mnt/"x' }),
      }),
    ).toThrow(ConfigError)
  })

  it('采样命令本身单独可取，排除内存文件系统', () => {
    const command = buildDataDiskUsageCommand('/root/autodl-tmp')

    expect(command).toContain('-x tmpfs')
    expect(command).toContain('-x devtmpfs')
    expect(command).toContain('--output=used')
  })
})

describe('ProfileSchema：env 与引导字段', () => {
  const base = {
    id: 'trans-dev',
    project: 'trans-app',
    instanceNamePattern: 'trans-dev',
    gpuPreference: ['v-48g'],
    ttlMinutes: 60,
    budgetCapYuan: 6,
    requirePinnedCommit: false,
    deployScript: 'scripts/deploy.sh',
    startScript: 'scripts/start.sh',
  }

  it('不写 env 与引导字段时取空表，老配置不用改', () => {
    const parsed = ProfileSchema.parse(base)

    expect(parsed.env).toEqual({})
    expect(parsed.bootstrapEnv).toEqual({})
    expect(parsed.bootstrapScript).toBeUndefined()
  })

  it('环境变量名非法时拒绝：名字会被当作变量名下发，不是任意文本', () => {
    for (const name of ['1BAD', 'BAD-NAME', 'BAD NAME', 'BAD=1', '$HOME']) {
      expect(ProfileSchema.safeParse({ ...base, env: { [name]: 'x' } }).success).toBe(false)
    }
  })

  it('给 bootstrapEnv 却没给 bootstrapScript 时拒绝', () => {
    const parsed = ProfileSchema.safeParse({ ...base, bootstrapEnv: { TOKEN: 'x' } })

    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.path).toEqual(['bootstrapEnv'])
  })

  it('给 bootstrapScript 时可以带 bootstrapEnv', () => {
    const parsed = ProfileSchema.safeParse({
      ...base,
      bootstrapScript: 'scripts/bootstrap.sh',
      bootstrapEnv: { TOKEN: '模型站 token' },
    })

    expect(parsed.success).toBe(true)
  })
})

describe('环境变量自检片段', () => {
  it('没有变量时不生成自检，命令与旧形态一致', () => {
    expect(buildEnvPresenceCheck([])).toBe('')
    expect(scriptCommandWithEnvCheck('/root/trans_app', 'scripts/start.sh', [])).toBe(
      'cd "/root/trans_app" && bash "scripts/start.sh"',
    )
  })

  it('只有一个变量时用一条 test，判的是非空而不是仅已设置', () => {
    const check = buildEnvPresenceCheck(['HF_TOKEN'])

    // 判据：空值等于没注入。`VAR=` 算已设置，所以还要再判一次非空。
    // 期望值用拼接写：这段本身含三层引号嵌套，直接写成字面量极易与实现同步写错。
    const dollar = String.fromCharCode(36)
    const quote = String.fromCharCode(34)
    expect(check).toBe(
      `test -n ${quote}${dollar}{HF_TOKEN+x}${quote} && [ -n ${quote}${dollar}{HF_TOKEN}${quote} ] ` +
        `|| exit ${String(REMOTE_ENV_NOT_INJECTED_EXIT_CODE)}`,
    )
    expect(check).not.toContain('eval')
  })

  it('多个变量时用一条循环覆盖全部变量名，不拼成一串 test', () => {
    // 判据：AcceptEnv 是白名单，可能只接受一部分，所以「第一个成功」推不出「全部成功」。
    const check = buildEnvPresenceCheck(['A_TOKEN', 'B_TOKEN', 'C_TOKEN'])

    // 一份名单全部列出：逐个都要在场。
    expect(check).toContain('for v in A_TOKEN B_TOKEN C_TOKEN; do')
    // 只一条出口：长度与变量个数无关。
    expect(check.split('exit').length - 1).toBe(1)
    expect(check).toContain('eval')
    // 判据是「非空」：只判是否被设置会让 `VAR=` 通过。
    expect(check).toContain('[ -n ')
  })

  it('变量名非法时拒绝，不把它拼进远端命令', () => {
    for (const name of ['BAD;rm -rf /', 'A B', 'A$(id)', '']) {
      expect(() => buildEnvPresenceCheck([name])).toThrow(ConfigError)
    }
  })

  it('带变量的脚本命令先自检再执行脚本', () => {
    const command = scriptCommandWithEnvCheck('/root/trans_app', 'scripts/start.sh', ['APP_TOKEN'])

    expect(command.startsWith('test -n ')).toBe(true)
    expect(command).toContain(' && cd "/root/trans_app" && bash "scripts/start.sh"')
  })

  it('生成的命令是合法 bash，且自检片段能被 bash 正确解析', () => {
    for (const names of [[], ['A'], ['A', 'B'], ['A', 'B', 'C']] as const) {
      const command = scriptCommandWithEnvCheck('/tmp', 'x.sh', names)
      expect(() => new Function(`return ${JSON.stringify(command)}`)).not.toThrow()
      // 语法检查交给 bash 本身：-n 只解析不执行。
      expect(() => spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' })).not.toThrow()
      const parsed = spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8' })
      expect(parsed.status).toBe(0)
    }
  })

  it('变量真的没送到远端时，自检以 78 退出（真跑 bash，不起网络）', () => {
    // 在子 bash 里清掉这两个变量，验证自检确实能拦住。
    for (const command of [
      buildEnvPresenceCheck(['DEFINITELY_NOT_SET_A']),
      buildEnvPresenceCheck(['DEFINITELY_NOT_SET_A', 'DEFINITELY_NOT_SET_B']),
    ]) {
      const result = spawnSync('bash', ['-c', `unset DEFINITELY_NOT_SET_A DEFINITELY_NOT_SET_B; ${command}`], {
        encoding: 'utf8',
      })
      expect(result.status).toBe(REMOTE_ENV_NOT_INJECTED_EXIT_CODE)
    }
  })

  it('两个变量只到齐一个时自检仍以 78 退出：白名单可能只放过一部分', () => {
    const command = buildEnvPresenceCheck(['PRESENT_VAR', 'ABSENT_VAR'])

    const result = spawnSync('bash', ['-c', `unset ABSENT_VAR; PRESENT_VAR=x; ${command}`], {
      encoding: 'utf8',
    })

    expect(result.status).toBe(REMOTE_ENV_NOT_INJECTED_EXIT_CODE)
  })

  it('变量全部到齐时自检通过；空值仍算没注入', () => {
    for (const command of [
      buildEnvPresenceCheck(['ONLY_VAR']),
      buildEnvPresenceCheck(['VAR_A', 'VAR_B']),
    ]) {
      const passed = spawnSync(
        'bash',
        ['-c', `ONLY_VAR=x VAR_A=x VAR_B=x; ${command}`],
        { encoding: 'utf8' },
      )
      expect(passed.status).toBe(0)

      const emptyValue = spawnSync(
        'bash',
        ['-c', `ONLY_VAR= VAR_A= VAR_B=; ${command}`],
        { encoding: 'utf8' },
      )
      expect(emptyValue.status).toBe(REMOTE_ENV_NOT_INJECTED_EXIT_CODE)
    }
  })
})
