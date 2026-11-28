import type { Project } from '../domain/project.js'
import type { StepKind } from '../domain/run.js'
import { ConfigError } from '../errors.js'

/**
 * 部署步骤的生成规则（纯函数，不碰时钟、不发请求）。
 *
 * 判据见 docs/specs/deploydeck-phase2.md 第 5 节：引擎只执行健康检查一步，
 * 它不随获取方式变化。健康检查命令在项目 workdir 里执行。
 */

/** 引擎生成的一步。`stepId` 同时是日志文件名，见 `stepLogFilePath`。 */
export interface PlannedStep {
  readonly stepId: string
  readonly kind: StepKind
  /** 写进执行记录与日志的命令文本。 */
  readonly command: string
  readonly timeoutSeconds: number
}

/**
 * 健康检查超时，秒。
 *
 * 经验值：一次 HTTP 探活正常在 1 秒内返回，120 秒是留给「实例刚到、服务还没起」的抖动窗口。
 * 同样不是实测结论。
 */
export const HEALTH_CHECK_TIMEOUT_SECONDS = 120

/**
 * 步骤 id。
 *
 * 落盘的文件名与 Run 记录里的 `stepId` 都是它，必须稳定：改它等于让历史 Run 的日志路径失配。
 * 它同时是单段文件名，不含路径分隔符。
 */
export const STEP_ID = {
  healthCheck: 'health-check',
} as const

/**
 * 生成要执行的步骤：只有一步健康检查。
 *
 * 判据：引擎只做验证连通性的动作，不跑使用者的任何命令。查看方式不受限制。`run` 成功
 * 只保证「实例已获取、已连通、健康检查通过」，不保证业务服务可用。
 *
 * workdir 在生成期校验：命令里用双引号包着，含双引号或换行的取值无法安全执行，直接拒绝。
 */
export function planDeploySteps(input: {
  readonly project: Project
}): readonly PlannedStep[] {
  const workdir = assertAbsoluteWorkdir(input.project.workdir)
  const healthCheck = input.project.healthCheck.trim()
  if (healthCheck.length === 0) {
    throw new ConfigError('项目清单的 healthCheck 不能为空。')
  }

  return [
    {
      stepId: STEP_ID.healthCheck,
      kind: 'ssh',
      command: `cd ${quote(workdir)} && ${healthCheck}`,
      timeoutSeconds: HEALTH_CHECK_TIMEOUT_SECONDS,
    },
  ]
}

/**
 * workdir 必须是绝对路径且不以 `/` 结尾。
 *
 * 判据：同一个 workdir 值只允许一种写法。双引号里的 `~` 不会展开，相对路径会落到
 * SSH 登录用户的当前目录；末尾带 `/` 时同一个目录有两种写法，命令文本与报错文案会对不上。
 */
function assertAbsoluteWorkdir(value: string): string {
  const workdir = assertShellSafePath(value, '项目清单的 workdir')
  if (!workdir.startsWith('/')) {
    throw new ConfigError(
      `项目清单的 workdir 必须是绝对路径，当前值：${workdir}。` +
        '命令用双引号包住路径执行，引号里的 ~ 不会展开，相对路径会落在 SSH 登录用户的随意目录里。',
    )
  }
  if (workdir.length > 1 && workdir.endsWith('/')) {
    throw new ConfigError(`项目清单的 workdir 不能以 / 结尾，当前值：${workdir}。`)
  }
  return workdir
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
