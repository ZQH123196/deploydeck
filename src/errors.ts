/** 退出码。0 成功，1 业务失败，2 需要人工介入。 */
export type ExitCode = 0 | 1 | 2

export const EXIT_OK: ExitCode = 0
export const EXIT_BUSINESS_FAILURE: ExitCode = 1
export const EXIT_HUMAN_REQUIRED: ExitCode = 2

/** 所有 deploydeck 抛出错误的基类。携带稳定错误码与退出码。 */
export class DeploydeckError extends Error {
  readonly code: string
  readonly exitCode: ExitCode

  constructor(code: string, message: string, exitCode: ExitCode) {
    super(message)
    this.name = 'DeploydeckError'
    this.code = code
    this.exitCode = exitCode
  }
}

/** 配置非法。启动期一次报完，不猜默认值。 */
export class ConfigError extends DeploydeckError {
  constructor(message: string) {
    super('CONFIG_INVALID', message, EXIT_HUMAN_REQUIRED)
    this.name = 'ConfigError'
  }
}

/** 功能尚未实现。它不是成功，也不是普通失败。 */
export class NotImplementedError extends DeploydeckError {
  constructor(feature: string) {
    super('NOT_IMPLEMENTED', `[NOT IMPLEMENTED] ${feature}`, EXIT_HUMAN_REQUIRED)
    this.name = 'NotImplementedError'
  }
}

/** 需要人工介入。容器可能仍在计费。 */
export class HumanRequiredError extends DeploydeckError {
  constructor(message: string) {
    super('HUMAN_REQUIRED', message, EXIT_HUMAN_REQUIRED)
    this.name = 'HumanRequiredError'
  }
}
