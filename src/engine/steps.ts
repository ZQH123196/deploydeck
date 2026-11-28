import { dirname } from 'node:path'
import { isEnvVarName, type Profile } from '../domain/profile.js'
import type { Project } from '../domain/project.js'
import type { RunMode, StepKind } from '../domain/run.js'
import { ConfigError, REMOTE_ENV_NOT_INJECTED_EXIT_CODE } from '../errors.js'

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
  /**
   * 写进执行记录与日志的命令文本。
   *
   * 判据：它**只含命令模板，不含环境变量的值**。需要注入环境变量的步骤把值放在 `envNames` 里，
   * 由执行层从本机读出后经数据面单独下发。命令文本会被写进 Run 记录、逐字进日志、
   * 在失败消息里回显，值写进来就再也收不回去。
   */
  readonly command: string
  readonly timeoutSeconds: number
  /**
   * 本步要注入的环境变量名。取值由执行层从本机环境读出，只进远端进程环境。
   *
   * 判据：这里只有名字，没有值。没有注入需求的步骤不写这个字段。
   */
  readonly envNames?: readonly string[]
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
 * 一次性引导脚本的超时，秒。
 *
 * 判据：一次完整安装加模型下载以小时计。实测把装环境与下载模型塞进 `startScript`
 * 会被 600 秒上限截断，所以它单独占一步、单独给上限。
 * 取值下限 7200 秒（2 小时）；再长的安装应当改为预置镜像，而不是继续调大它。
 */
export const BOOTSTRAP_TIMEOUT_SECONDS = 7200

/**
 * 克隆出来的实例等数据盘就绪的上限，秒。
 *
 * 实测（2026-11-25）：状态离开「克隆锁定中」时数据盘占用仍在推进（3.38% → 36.27% → 55.84%），
 * 拷贝还要约 6 分钟。取与克隆创建同量级的上限。
 */
export const DATA_DISK_READY_TIMEOUT_SECONDS = 900

/**
 * 两次数据盘采样之间的等待，秒。
 *
 * 判据：判据是「连续两次采样不变」，采样间隔必须大于控制台占用数字的刷新粒度，
 * 否则同一份未刷新的数字会被读两次，把还在拷贝的盘判成就绪。
 */
export const DATA_DISK_SAMPLE_INTERVAL_SECONDS = 30

/**
 * 连续多少次采样相同才算稳定。固定为 2：判据就是「连续两次不变」。
 */
export const DATA_DISK_STABLE_SAMPLE_COUNT = 2

/**
 * 步骤 id。
 *
 * 落盘的文件名与 Run 记录里的 `stepId` 都是它，必须稳定：改它等于让历史 Run 的日志路径失配。
 * 它同时是单段文件名，不含路径分隔符。
 */
export const STEP_ID = {
  syncCommit: 'sync-commit',
  bootstrapScript: 'bootstrap-script',
  dataDiskReady: 'data-disk-ready',
  deployScript: 'deploy-script',
  startScript: 'start-script',
  healthCheck: 'health-check',
} as const

/**
 * 数据盘就绪判据的采样命令。
 *
 * 判据取数据盘已用字节数。用 `df -B1` 取字节而不是 `df -h` 的百分比：百分比是四舍五入后的整数，
 * 拷最后一段时可能连续多次读到同一个整数，「连续两次不变」会在没拷完时就成立。
 * 字节数以 4 KiB 块为单位变化，拷贝只要还在写盘就会推动它。
 *
 * `-x tmpfs -x devtmpfs` 排除内存文件系统。数字读不出时命令以非 0 退出，
 * 由执行层判本步失败：读不到不等于拷完。
 */
export function buildDataDiskUsageCommand(devicePath: string): string {
  const target = quote(assertShellSafePath(devicePath, '数据盘路径'))
  return (
    `df -B1 -x tmpfs -x devtmpfs --output=used ${target} 2>/dev/null | tail -n +2 | ` +
    "awk '{ sum += $1 } END { if (NR == 0) exit 1; print sum }'"
  )
}

/**
 * 数据盘就绪的一步：连续两次采样相同才算拷完。
 *
 * 为什么放在步骤层而不是克隆动作里：控制面只说「实例可用了」，数据面自己判断盘好了没有。
 * 克隆动作拿不到 SSH，也不该为这件事去拿数据面。
 *
 * 采样循环在远端一条命令里完成，本地只读一次退出码：断线重连不会让计数从头开始。
 */
export function buildDataDiskReadyStep(input: { readonly devicePath: string }): PlannedStep {
  const sample = buildDataDiskUsageCommand(input.devicePath)
  const required = String(DATA_DISK_STABLE_SAMPLE_COUNT)
  const command =
    `prev=""; stable=0; while [ "$stable" -lt ${required} ]; do ` +
    `cur=$(${sample}) || exit 1; ` +
    'if [ -n "$prev" ] && [ "$cur" = "$prev" ]; then stable=$((stable + 1)); else stable=0; fi; ' +
    `prev="$cur"; ` +
    `if [ "$stable" -lt ${required} ]; then sleep ${String(DATA_DISK_SAMPLE_INTERVAL_SECONDS)}; fi; ` +
    'done'
  return {
    stepId: STEP_ID.dataDiskReady,
    kind: 'ssh',
    command,
    timeoutSeconds: DATA_DISK_READY_TIMEOUT_SECONDS,
  }
}

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
 * 前置步骤的顺序（同一份判据下逐条）：
 * 1. 有引导脚本时，`bootstrap-script` 排在 `startScript` 之前：启动脚本会读引导装好的
 *    环境与模型。它只管「跑不跑」，跑没跑过由执行层按引导记录判定。
 * 2. `clone` 路径上，`data-disk-ready` 排在 `startScript` 之前：控制台状态说实例可用时
 *    数据盘拷完是另一件事实，启动脚本要读盘上的东西。
 * 3. 前置步骤都在 `sync-commit` 之后：先定代码版本，再动环境。
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

  const preStartSteps: PlannedStep[] = []
  // 引导步骤的两条判据：
  // 1. 跑不跑由引导记录决定（`src/engine/bootstrap.ts`）。已跑过时执行层仍要在这步留一条
  //    「跳过」记录：步骤列表里少了这一步，运维会以为配置写错了。
  // 2. 引导失败后实例不会消失。执行引擎把「实例到手后的失败」统一落 `stray`，
  //    `destroy-container` 策略下也不再销毁，人可以进容器看现场；记录没写，
  //    修好后重跑 `run` 会重新执行引导，现场日志留在上一轮的 `runs/<runId>/logs/` 下。
  if (profile.bootstrapScript !== undefined) {
    const bootstrapScript = assertShellSafePath(
      profile.bootstrapScript,
      `部署配置 ${profile.id} 的 bootstrapScript`,
    )
    preStartSteps.push({
      stepId: STEP_ID.bootstrapScript,
      kind: 'ssh',
      command: scriptCommandWithEnvCheck(workdir, bootstrapScript, Object.keys(profile.bootstrapEnv)),
      timeoutSeconds: BOOTSTRAP_TIMEOUT_SECONDS,
      envNames: Object.keys(profile.bootstrapEnv),
    })
  }
  // 门控判据：只有数据盘跟着克隆时才有「盘还在拷」这个状态。
  // `cloneDataDisk === false` 时实例上不存在这个状态，这一步会空等一个永远不会准备好的盘。
  // 目录总是存在，没克隆时只是空的：「空盘」与「盘在拷」是两个状态。
  if (mode === 'clone' && profile.cloneDataDisk) {
    preStartSteps.push(buildDataDiskReadyStep({ devicePath: project.dataDiskPath }))
  }

  const startStep: PlannedStep = {
    stepId: STEP_ID.startScript,
    kind: 'ssh',
    command: scriptCommandWithEnvCheck(workdir, startScript, Object.keys(profile.env)),
    timeoutSeconds: START_SCRIPT_TIMEOUT_SECONDS,
    envNames: Object.keys(profile.env),
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
      ? [...preStartSteps, startStep, healthCheckStep]
      : [
          {
            stepId: STEP_ID.deployScript,
            kind: 'ssh',
            command: scriptCommandWithEnvCheck(workdir, deployScript, Object.keys(profile.env)),
            timeoutSeconds: DEPLOY_SCRIPT_TIMEOUT_SECONDS,
            envNames: Object.keys(profile.env),
          },
          ...preStartSteps,
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

/**
 * 环境变量没注入时的远端退出码。
 *
 * 单一来源在 `src/errors.ts`：那里写了判据与「它不是 deploydeck 进程退出码」这条边界。
 */
const ENV_NOT_INJECTED_EXIT_CODE = REMOTE_ENV_NOT_INJECTED_EXIT_CODE

/**
 * 脚本命令：在项目目录里用 bash 跑仓库内的脚本。
 *
 * 带环境变量时在开头插一句自检。原因见 `SshExecOptions.env` 的注释：
 * SSH 的 `env` 请求在服务端被静默丢弃时，数据面拿不到任何失败信号，
 * 唯一可靠的判据是「命令自己能不能读到这些变量」。
 *
 * 判据：空值等于没注入。`test -n "${VAR+x}"` 判的是「变量是否被设置」，
 * 所以 `VAR=`（设置了但值为空）能通过它；再叠一层 `-n` 才是本仓要的语义。
 * 空值与没设置按同一种失败处理：脚本读到空串后报的错（通常是认证失败）
 * 与配置无关，人查不到根因。
 *
 * 变量名已经过 `ProfileSchema` 的 regex 校验，不含 `$`、空白、引号，`eval` 因此安全。
 */
export function scriptCommandWithEnvCheck(
  workdir: string,
  scriptPath: string,
  envNames: readonly string[],
): string {
  const envCheck = buildEnvPresenceCheck(envNames)
  const script = `cd ${quote(workdir)} && bash ${quote(scriptPath)}`
  return envCheck === '' ? script : `${envCheck} && ${script}`
}

/**
 * 生成「这些环境变量都必须在场」的自检片段。
 *
 * 判据：ssh2 逐个变量发 `env` 请求，服务端的 `AcceptEnv` 是白名单，
 * 白名单里没有的会被丢弃、有的会被接受。所以「第一个成功了」推不出「全部成功」，
 * 自检必须覆盖全部变量名。
 *
 * 变量多于一个时用一条循环，长度与变量个数无关；只有一个时用一条 `test`。
 */
export function buildEnvPresenceCheck(envNames: readonly string[]): string {
  if (envNames.length === 0) {
    return ''
  }
  for (const name of envNames) {
    if (!isEnvVarName(name)) {
      throw new ConfigError(
        `环境变量名非法：${JSON.stringify(name)}。它会被拼进远端自检命令，` +
          '只允许字母、数字与下划线，且不能以数字开头。',
      )
    }
  }
  const exitCode = String(ENV_NOT_INJECTED_EXIT_CODE)
  // 判据：空值等于没注入。`${VAR+x}` 只判「是否被设置」，`VAR=` 也能通过；
  // 再叠一个 `[ -n "${VAR}" ]` 才是本仓要的语义。
  if (envNames.length === 1) {
    const name = String(envNames[0])
    return (
      `test -n "${'$'}{${name}+x}" && [ -n "${'$'}{${name}}" ] || exit ${exitCode}`
    )
  }
  // eval 的参数用双引号包住，所以内层有三处必须转义：
  // `$` 不写成 `\$`，外层 shell 会先按自己的参数展开，命令直接 bad substitution；
  // 内层引号不写成 `\"`，会被外层提前闭合，`test` 变成四个词。
  // 变量名过不了 `"` 与 `$` 那一关（`ProfileSchema` 的 regex），内层不再需要别的转义。
  // 判据同单变量形态：先判「是否被设置」，再判「值非空」——空值等于没注入。
  // 改写这段后必须跑 `steps.spec.ts` 里那几条真跑 bash 的用例：转义写错时命令往往仍能跑通，
  // 只是判据失效，读代码发现不了。
  const names = envNames.join(' ')
  // 反斜杠与引号都用 charCode 拼：这段模板要产出三层引号嵌套，
  // 手写转义只要露出一层，命令仍能跑通但判据失效。
  const bs = String.fromCharCode(92)
  const q = String.fromCharCode(34)
  const set = `${bs}${q}${bs}$` + '{' + '$' + `v+x}${bs}${q}`
  const nonEmpty = `${bs}${q}${bs}$` + '{' + '$' + `v}${bs}${q}`
  const check = `test -n ${set} && [ -n ${nonEmpty} ]`
  return `for v in ${names}; do eval ${q}${check}${q} || exit ${exitCode}; done`
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
