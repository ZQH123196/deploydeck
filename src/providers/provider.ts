import type { ClonePort, InstanceListPort, PowerPort, PricePort, TeardownPort } from '../console/ports.js'
import type { SshPort } from '../ssh/ports.js'

/**
 * provider 能力声明。
 *
 * 上层只按能力询问，不按厂商名分支。能力为否时必须显式拒绝该路径，不得静默降级。
 * 判据见 docs/provider-contract.md。
 */
export interface ProviderCapabilities {
  /** 能创建全新实例。AutoDL 用克隆实现。 */
  create: boolean
  /** 实例可关机后再开机，数据保留。 */
  powerCycle: boolean
  /** 支持无卡降配开机。AutoDL 只能人工触发。 */
  noGpuMode: boolean
  /** 平台自带定时关机。 */
  timedShutdown: boolean
  /** 能查询 SSH 登录信息。 */
  accessInfo: boolean
  /** 能把实例保存成镜像。 */
  imageSnapshot: boolean
  /** 支持克隆实例。 */
  clone: boolean
}

/**
 * 部署 provider。它把控制面与数据面两组端口装成一个对象。
 *
 * L4 执行引擎只依赖这个接口。换云厂商时只换实现。
 */
export interface Provider extends InstanceListPort, PowerPort, ClonePort, PricePort, TeardownPort, SshPort {
  readonly id: string
  readonly capabilities: ProviderCapabilities
}
