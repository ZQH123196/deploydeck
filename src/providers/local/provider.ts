import { NotImplementedError } from '../../errors.js'
import type {
  CreateRequest,
  ExecOptions,
  ExecResult,
  GpuSpec,
  Provider,
  ProviderCapabilities,
  ResourceSnapshot,
} from '../provider.js'

const CAPABILITIES: ProviderCapabilities = {
  // 本机不创建容器。配“每次新建”的 Profile 时上层拒绝。
  create: false,
  powerCycle: false,
  noGpuMode: false,
  timedShutdown: false,
  accessInfo: false,
  imageSnapshot: false,
  execOverApi: true,
}

/**
 * local provider。用于本机调试。
 *
 * 它不创建容器，把它视为一个本地进程。
 * 当前只有能力声明。执行尚未实现。
 */
export class LocalProvider implements Provider {
  readonly id = 'local'
  readonly capabilities = CAPABILITIES

  listGpuSpecs(): Promise<readonly GpuSpec[]> {
    throw new NotImplementedError('local.listGpuSpecs：本机没有可租用的算力规格')
  }

  create(request: CreateRequest): Promise<string> {
    throw new NotImplementedError(`local.create（规格 ${request.gpuSpecId}）：本机不支持创建容器`)
  }

  describe(resourceId: string): Promise<ResourceSnapshot> {
    throw new NotImplementedError(`local.describe（容器 ${resourceId}）：尚未实现`)
  }

  exec(resourceId: string, command: string, options: ExecOptions): Promise<ExecResult> {
    throw new NotImplementedError(`local.exec（命令 ${command}，超时 ${options.timeoutSeconds}s）：尚未实现`)
  }

  powerOff(resourceId: string): Promise<void> {
    throw new NotImplementedError(`local.powerOff（容器 ${resourceId}）：本机没有关机动作`)
  }

  release(resourceId: string): Promise<void> {
    throw new NotImplementedError(`local.release（容器 ${resourceId}）：本机没有释放动作`)
  }

  assertGone(resourceId: string): Promise<boolean> {
    throw new NotImplementedError(`local.assertGone（容器 ${resourceId}）：本机没有容器可查`)
  }
}
