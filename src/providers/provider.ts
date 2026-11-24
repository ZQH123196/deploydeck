/**
 * provider 能力契约。
 *
 * 上层只按能力询问，不按厂商名分支。新增一家厂商时只新增一个实现。
 * 判据见 docs/provider-contract.md。
 */

/** provider 声明自己支持哪些能力。为否时上层必须显式拒绝该路径。 */
export interface ProviderCapabilities {
  /** 能创建全新容器。 */
  create: boolean
  /** 容器可关机后再开机，数据保留。 */
  powerCycle: boolean
  /** 支持无卡降配开机。 */
  noGpuMode: boolean
  /** 平台自带定时关机。 */
  timedShutdown: boolean
  /** 能查询 SSH 与端口地址。 */
  accessInfo: boolean
  /** 能把容器保存成镜像。 */
  imageSnapshot: boolean
  /** 能通过 API 执行命令。为否时必须走 SSH。 */
  execOverApi: boolean
}

export interface GpuSpec {
  id: string
  label: string
  pricePerHourYuan: number
}

/** 容器阶段。`unknown` 不是安全状态，一律转人工。 */
export type ResourcePhase =
  | 'provisioning'
  | 'running'
  | 'stopped'
  | 'releasing'
  | 'gone'
  | 'unknown'

export interface SshAccess {
  host: string
  port: number
  user: string
  /** 凭据引用名。禁止把凭据明文写进这里。 */
  credentialRef: string
}

export interface AccessPoints {
  ssh?: SshAccess
  /** 端口号 → 公网地址。 */
  http?: Record<string, string>
}

export interface ResourceSnapshot {
  resourceId: string
  phase: ResourcePhase
  accessPoints: AccessPoints
  /** 当前每小时单价。预算核算的唯一来源。 */
  pricePerHourYuan: number
  /** 平台定时关机时刻。没有该能力时为 null。 */
  timedShutdownAt: string | null
}

export interface CreateRequest {
  gpuSpecId: string
  /** 地区偏好，按顺序尝试。空数组表示由 provider 决定。 */
  regionPreference: readonly string[]
  /** 容器备注名。部署器生成，带项目与计划标识。 */
  name: string
  /** 容器开机后自动执行的命令。 */
  startCommand?: string
}

export interface ExecOptions {
  timeoutSeconds: number
  cwd?: string
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface Provider {
  readonly id: string
  readonly capabilities: ProviderCapabilities

  listGpuSpecs(): Promise<readonly GpuSpec[]>
  create(request: CreateRequest): Promise<string>
  describe(resourceId: string): Promise<ResourceSnapshot>
  exec(resourceId: string, command: string, options: ExecOptions): Promise<ExecResult>
  powerOff(resourceId: string): Promise<void>
  release(resourceId: string): Promise<void>
  /**
   * 容器是否确实不存在。
   *
   * 必须查全量列表，不得复用 describe 的单条查询路径。
   * 销毁链的终态判据只认这个方法返回 true。
   */
  assertGone(resourceId: string): Promise<boolean>
}
