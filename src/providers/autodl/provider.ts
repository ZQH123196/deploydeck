import { NotImplementedError } from '../../errors.js'
import type {
  AccessPoints,
  CreateRequest,
  ExecOptions,
  ExecResult,
  GpuSpec,
  Provider,
  ProviderCapabilities,
  ResourceSnapshot,
} from '../provider.js'

const CAPABILITIES: ProviderCapabilities = {
  create: true,
  powerCycle: true,
  // AutoDL 的 power_on 只接受 payload=gpu。API 不支持无卡模式开机。
  noGpuMode: false,
  timedShutdown: true,
  accessInfo: true,
  imageSnapshot: true,
  // AutoDL 的 Pro API 没有远程执行接口，必须走 SSH。
  execOverApi: false,
}

/**
 * AutoDL provider。
 *
 * 当前只有能力声明。API 接入尚未实现。
 * 端点映射见 docs/provider-contract.md 第 5 节。
 */
export class AutoDlProvider implements Provider {
  readonly id = 'autodl'
  readonly capabilities = CAPABILITIES

  listGpuSpecs(): Promise<readonly GpuSpec[]> {
    throw new NotImplementedError('autodl.listGpuSpecs：规格表读取尚未实现')
  }

  create(request: CreateRequest): Promise<string> {
    throw new NotImplementedError(`autodl.create（规格 ${request.gpuSpecId}）：API 调用尚未实现`)
  }

  describe(resourceId: string): Promise<ResourceSnapshot> {
    throw new NotImplementedError(`autodl.describe（容器 ${resourceId}）：API 调用尚未实现`)
  }

  exec(resourceId: string, command: string, options: ExecOptions): Promise<ExecResult> {
    throw new NotImplementedError(`autodl.exec（容器 ${resourceId}，命令 ${command}，超时 ${options.timeoutSeconds}s）：SSH 通道尚未实现`)
  }

  powerOff(resourceId: string): Promise<void> {
    throw new NotImplementedError(`autodl.powerOff（容器 ${resourceId}）：API 调用尚未实现`)
  }

  release(resourceId: string): Promise<void> {
    throw new NotImplementedError(`autodl.release（容器 ${resourceId}）：API 调用尚未实现`)
  }

  assertGone(resourceId: string): Promise<boolean> {
    throw new NotImplementedError(`autodl.assertGone（容器 ${resourceId}）：列表查询尚未实现`)
  }
}

/** 保留导出，供未来实现读取访问信息时使用。 */
export type { AccessPoints }
