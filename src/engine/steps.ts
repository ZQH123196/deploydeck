import { dirname } from 'node:path'
import type { Profile } from '../domain/profile.js'
import type { Project } from '../domain/project.js'
import type { RunMode, StepKind } from '../domain/run.js'
import { ConfigError } from '../errors.js'

/**
 * 部署步骤的生成规则（纯函数，不碰时钟、不发请求）。
 *
 * 判据见 docs/specs/deploydeck-phase2.md 第 5 节：
 * 克隆出来的实例环境已就绪，只跑启动脚本；开机复用的实例代码可能过期，先跑部署脚本。
 * 最后一步永远是健康检查。步骤不由人写在 Project 清单里：清单只声明健康检查命令，
 * 两个脚本的开关在 Profile。
 *
 * 给了 commit 时最前面多一步 `sync-commit`：把实例里的仓库切到指定 commit 并回验。
 * 判据见 docs/specs/deploydeck-phase2.md 第 3.4 节与 docs/plan-and-budget.md 第 3.2 节。
 */

/** 引擎生成的一步。`stepId` 同时是日志文件名，见 `stepLogFilePath`。 */
export interface PlannedStep {
  readonly stepId: string
  readonly kind: StepKind
  readonly command: string
  readonly timeoutSeconds: number
}

/**
 * 部署脚本超时，秒。
 *
 * 经验值：实例上要切 commit、装依赖、构建前端产物，分钟级起步。
 * 它不是实测结论：真实项目的部署耗时必须实测后再调，见报告「未实测项」。
 */
export const DEPLOY_SCRIPT_TIMEOUT_SECONDS = 1800

/**
 * 启动脚本超时，秒。
 *
 * 经验值：拉起常驻进程并等它监听端口，通常远小于部署。
 * 同样不是实测结论。
 */
export const START_SCRIPT_TIMEOUT_SECONDS = 600

/**
 * 健康检查超时，秒。
 *
 * 经验值：一次 HTTP 探活正常在 1 秒内返回，120 秒是留给「启动脚本返回了但端口还没监听」的抖动窗口。
 * 同样不是实测结论。
 */
export const HEALTH_CHECK_TIMEOUT_SECONDS = 120

/**
 * 切 commit 的超时，秒。
 *
 * 首次要克隆整个仓库，耗时与仓库体积相关。取与部署脚本相同的上限：
 * 它是「拉代码 + 切版本」，比部署轻，但不该比部署先超时。
 */
export const SYNC_COMMIT_TIMEOUT_SECONDS = DEPLOY_SCRIPT_TIMEOUT_SECONDS

/**
 * 步骤 id。
 *
 * 落盘的文件名与 Run 记录里的 `stepId` 都是它，必须稳定：改它等于让历史 Run 的日志路径失配。
 * 它同时是单段文件名，不含路径分隔符。
 */
export const STEP_ID = {
  syncCommit: 'sync-commit',
  deployScript: 'deploy-script',
  startScript: 'start-script',
  healthCheck: 'health-check',
} as const

/**
 * commit sha 的合法形状：4-40 位十六进制。
 *
 * 只接受十六进制，拒绝一切注入：sha 会被拼进 SSH 命令，`;`、空格、引号、
 * 换行都会改变命令语义。git 允许最短 4 位缩写，最长 40 位完整 sha。
 */
const COMMIT_SHA_PATTERN = /^[0-9a-fA-F]{4,40}$/

/**
 * 校验 commit sha。非法即抛 `ConfigError`，不「尽力转义」。
 *
 * 启动期校验：执行引擎在碰任何资源之前调它，配置写错不该走到实例上才崩。
 */
export function assertCommitSha(value: string): string {
  if (!COMMIT_SHA_PATTERN.test(value)) {
    throw new ConfigError(
      `commit sha 只接受 4-40 位十六进制字符，当前值：${JSON.stringify(value)}。` +
        '它会被拼进实例内的 git 命令，非十六进制内容一律拒绝。',
    )
  }
  return value
}

/**
 * 把 request 里的 commit 归一成「要么是合法 sha，要么是 null」。
 *
 * 空串与纯空白不是「没给」：那说明调用方传了空值，静默当成没给会掩盖配置错误。
 */
export function normalizeCommitSha(value: string | null): string | null {
  if (value === null) {
    return null
  }
  if (value.trim().length === 0) {
    throw new ConfigError('commit sha 不能为空字符串：不锁定 commit 时不要传该参数。')
  }
  return assertCommitSha(value)
}

/**
 * 按获取方式生成要执行的步骤。
 *
 * 判据：`clone` 只跑启动脚本；`reuse` 先跑部署脚本再跑启动脚本；最后一步是健康检查。
 * 给了 commit 时 `sync-commit` 永远是第一步：代码版本必须先定下来，再执行任何脚本。
 *
 * 路径与 commit 在生成期校验：命令里用双引号包着，含双引号或换行的取值无法安全执行，直接拒绝。
 */
export function planDeploySteps(input: {
  readonly mode: RunMode
  readonly profile: Profile
  readonly project: Project
  /** 部署的代码版本。`null` 表示不锁定 commit。 */
  readonly commitSha?: string | null
}): readonly PlannedStep[] {
  const { mode, profile, project } = input
  const workdir = assertShellSafePath(project.workdir, '项目清单的 workdir')
  if (!workdir.startsWith('/')) {
    throw new ConfigError(
      `项目清单的 workdir 必须是绝对路径，当前值：${workdir}。` +
        '命令用双引号包住路径执行，引号里的 ~ 不会展开，相对路径会落在 SSH 登录用户的随意目录里。',
    )
  }
  if (workdir.length > 1 && workdir.endsWith('/')) {
    throw new ConfigError(`项目清单的 workdir 不能以 / 结尾，当前值：${workdir}。`)
  }

  const deployScript = assertShellSafePath(profile.deployScript, `部署配置 ${profile.id} 的 deployScript`)
  const startScript = assertShellSafePath(profile.startScript, `部署配置 ${profile.id} 的 startScript`)
  const healthCheck = project.healthCheck.trim()
  if (healthCheck.length === 0) {
    throw new ConfigError('项目清单的 healthCheck 不能为空。')
  }

  const startStep: PlannedStep = {
    stepId: STEP_ID.startScript,
    kind: 'ssh',
    command: scriptCommand(workdir, startScript),
    timeoutSeconds: START_SCRIPT_TIMEOUT_SECONDS,
  }
  const healthCheckStep: PlannedStep = {
    stepId: STEP_ID.healthCheck,
    kind: 'ssh',
    command: workdirCommand(workdir, healthCheck),
    timeoutSeconds: HEALTH_CHECK_TIMEOUT_SECONDS,
  }

  const commitSha = input.commitSha ?? null
  const steps: PlannedStep[] =
    mode === 'clone'
      ? [startStep, healthCheckStep]
      : [
          {
            stepId: STEP_ID.deployScript,
            kind: 'ssh',
            command: scriptCommand(workdir, deployScript),
            timeoutSeconds: DEPLOY_SCRIPT_TIMEOUT_SECONDS,
          },
          startStep,
          healthCheckStep,
        ]

  if (commitSha === null) {
    return steps
  }
  assertCommitSha(commitSha)
  return [buildSyncCommitStep({ workdir, repository: project.repository, commitSha }), ...steps]
}

/**
 * 切 commit 的一步。
 *
 * 一条命令里做完三件事，任一件失败即整步失败：
 * 1. 仓库在 → `git fetch --all --prune` 后强制切到 sha；仓库不在 → 先按分支克隆到 workdir。
 * 2. `git checkout --force <sha>`：丢弃实例上的本地改动，保证跑的就是这个版本。
 * 3. 回验 `git rev-parse HEAD` 等于 sha。`checkout` 成功不等于工作区在该 commit
 *    （钩子、别名、并发进程都可能改动它），回验才是判据。
 */
function buildSyncCommitStep(input: {
  readonly workdir: string
  readonly repository: Project['repository']
  readonly commitSha: string
}): PlannedStep {
  const { workdir, commitSha } = input
  const url = assertShellSafePath(input.repository.url, '项目清单的 repository.url')
  const branch = assertShellSafePath(input.repository.branch, '项目清单的 repository.branch')
  const sha = quote(commitSha)
  const quotedWorkdir = quote(workdir)
  const cloneCommand =
    `mkdir -p ${quote(dirname(workdir))} && git clone --branch ${quote(branch)} ` +
    `${quote(url)} ${quotedWorkdir} && cd ${quotedWorkdir} && git checkout --force ${sha}`
  const command =
    `if [ -d ${quote(`${workdir}/.git`)} ]; then ` +
    `cd ${quotedWorkdir} && git fetch --all --prune && git checkout --force ${sha}; ` +
    `else ${cloneCommand}; fi && ` +
    `test "$(git -C ${quotedWorkdir} rev-parse HEAD)" = ${sha}`
  return {
    stepId: STEP_ID.syncCommit,
    kind: 'ssh',
    command,
    timeoutSeconds: SYNC_COMMIT_TIMEOUT_SECONDS,
  }
}

/** 脚本命令：在项目目录里用 bash 跑仓库内的脚本。 */
function scriptCommand(workdir: string, scriptPath: string): string {
  return `cd ${quote(workdir)} && bash ${quote(scriptPath)}`
}

/** 健康检查命令：同样在项目目录里跑，检查脚本通常按相对路径找本项目的文件。 */
function workdirCommand(workdir: string, command: string): string {
  return `cd ${quote(workdir)} && ${command}`
}

function quote(text: string): string {
  return `"${text}"`
}

/**
 * 路径要拼进 shell 命令，取值必须先校验。
 *
 * 含双引号的路径无法用双引号安全包住；含换行的路径会把一条命令拆成两条。
 * 这两类都不允许「尽力转义」：配置写错了应当在生成步骤时就崩，而不是到实例上执行一半。
 */
function assertShellSafePath(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new ConfigError(`${label}不能为空。`)
  }
  if (value.includes('"')) {
    throw new ConfigError(`${label}不能包含双引号：${JSON.stringify(value)}。命令里的路径用双引号包裹。`)
  }
  if (/[\r\n\0]/.test(value)) {
    throw new ConfigError(`${label}不能包含换行或空字符：${JSON.stringify(value)}。`)
  }
  return value
}
