/**
 * 真机耗费测试的授权闸门。
 *
 * 判据（AGENTS.md 测试规范 4.1 与 4.2）：耗费测试要花钱，必须与常规测试分开，
 * 并且必须由人显式授权。缺任何一个授权变量就拒绝运行——不猜默认值，
 * 也不允许「忘记关掉」的测试悄悄花掉配额与钱。
 *
 * 授权方式是三个环境变量同时给：
 *
 * ```text
 * DEPLOYDECK_E2E=1
 * DEPLOYDECK_E2E_SOURCE_INSTANCE=<要用作克隆源与开关机对象的实例 ID>
 * DEPLOYDECK_E2E_APPROVE_COST_YUAN=<本次批准的最大花费，元>
 * ```
 *
 * 第三个变量是审核动作本身：人必须先把钱数写下来，测试才跑。
 * 预计花费超过批准额度时立即拒绝，不做任何控制台动作。
 */

/** 一个用例的预计花费，用于向人报账与做授权校验。 */
export interface CostEstimateItem {
  readonly caseName: string
  readonly yuan: number
}

/**
 * 预计花费口径。
 *
 * 依据 2026-11-25 真机实测：vGPU-32GB 单价 1.58 元/时，按量计费。
 * - 开关机：开机到关机约 1-2 分钟。
 * - 定时关机：设 2 分钟后关，实际约 2-3 分钟。
 * - 克隆：实测从点「创建并开机」到源实例解锁约 7 分钟，另含改名与释放。
 * 取值只向上取整，宁可多批一点。
 */
export const COST_ESTIMATES: readonly CostEstimateItem[] = [
  { caseName: '开关机（含二次确认）', yuan: 0.05 },
  { caseName: '平台定时关机（2 分钟后自动关）', yuan: 0.08 },
  { caseName: '克隆 → 改名 → 释放（约 7 分钟）', yuan: 0.30 },
  // 无卡模式单价约 0.1 元/时，下面两项合计不超过 10 分钟，取 0.05 元。
  { caseName: '无卡模式开机 → 关机', yuan: 0.02 },
  { caseName: '无卡模式下的 SSH 与终端会话', yuan: 0.03 },
]

/** 本次真机测试的配置。全部来自环境变量，缺一个就抛错。 */
export interface E2eConfig {
  /** CDP 端口。默认 9222，是人工登录好的专用 Chrome。 */
  readonly cdpPort: number
  /** 用作开关机对象与克隆源的实例 ID。 */
  readonly sourceInstanceId: string
  /** 人批准的最大花费，元。 */
  readonly approvedCostYuan: number
  /** 克隆出来的实例名。改名用例要断言这个名字。 */
  readonly instanceName: string
  /** 克隆时用的算力规格优先级。 */
  readonly gpuPreference: readonly string[]
  /** 克隆完成的等待上限，分钟。实测约 7 分钟，给足余量。 */
  readonly cloneTimeoutMinutes: number
}

/** 预计总花费，元。 */
export function estimateTotalYuan(estimates: readonly CostEstimateItem[] = COST_ESTIMATES): number {
  const total = estimates.reduce((sum, item) => sum + item.yuan, 0)
  // 两位小数：金额口径统一到分。
  return Math.round(total * 100) / 100
}

/**
 * 读配置并过授权闸门。
 *
 * 失败信息必须写清「缺什么、怎么给、为什么需要」，让人一次就能补上。
 */
export function readE2eConfig(env: NodeJS.ProcessEnv = process.env): E2eConfig {
  const enabled = (env['DEPLOYDECK_E2E'] ?? '').trim()
  if (enabled !== '1') {
    throw new Error(
      '真机耗费测试未授权：需要 DEPLOYDECK_E2E=1。\n' +
        '这类测试会开关机、克隆与释放真实实例，产生真实费用，默认不跑。\n' +
        '授权步骤见 e2e/README.md。',
    )
  }

  const sourceInstanceId = (env['DEPLOYDECK_E2E_SOURCE_INSTANCE'] ?? '').trim()
  if (sourceInstanceId.length === 0) {
    throw new Error(
      '缺少 DEPLOYDECK_E2E_SOURCE_INSTANCE：要用哪一台实例做开关机与克隆源。\n' +
        '必须是已关机实例；测试会先校验状态，不满足就停下，不做任何动作。',
    )
  }

  const approvedRaw = (env['DEPLOYDECK_E2E_APPROVE_COST_YUAN'] ?? '').trim()
  if (approvedRaw.length === 0) {
    throw new Error(
      '缺少 DEPLOYDECK_E2E_APPROVE_COST_YUAN：本次批准的最大花费（单位：元，非负数字）。\n' +
        `本次预计花费 ${estimateTotalYuan().toFixed(2)} 元。\n` +
        '这个数字是审核动作本身：没有它就不跑，避免测试悄悄花掉配额与钱。',
    )
  }
  const approvedCostYuan = Number(approvedRaw)
  if (!Number.isFinite(approvedCostYuan) || approvedCostYuan < 0) {
    throw new Error(
      `DEPLOYDECK_E2E_APPROVE_COST_YUAN 必须是非负数字（元），当前值：${approvedRaw}。`,
    )
  }
  const estimated = estimateTotalYuan()
  if (approvedCostYuan < estimated) {
    throw new Error(
      `批准额度 ${approvedCostYuan.toFixed(2)} 元低于预计花费 ${estimated.toFixed(2)} 元，拒绝运行。\n` +
        '如果确实要跑，请把 DEPLOYDECK_E2E_APPROVE_COST_YUAN 提到不低于预计花费。',
    )
  }

  const portRaw = (env['DEPLOYDECK_E2E_CDP_PORT'] ?? '').trim()
  const cdpPort = portRaw.length === 0 ? 9222 : Number(portRaw)
  if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535) {
    throw new Error(`DEPLOYDECK_E2E_CDP_PORT 必须是 1-65535 的整数，当前值：${portRaw}。`)
  }

  const instanceName = (env['DEPLOYDECK_E2E_INSTANCE_NAME'] ?? '').trim() || 'deploydeck-e2e'
  const gpuPreferenceRaw = (env['DEPLOYDECK_E2E_GPU_PREFERENCE'] ?? '').trim() || 'v-32g-p'
  const gpuPreference = gpuPreferenceRaw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (gpuPreference.length === 0) {
    throw new Error('DEPLOYDECK_E2E_GPU_PREFERENCE 至少要给一个算力规格。')
  }

  const cloneTimeoutRaw = (env['DEPLOYDECK_E2E_CLONE_TIMEOUT_MINUTES'] ?? '').trim()
  const cloneTimeoutMinutes = cloneTimeoutRaw.length === 0 ? 45 : Number(cloneTimeoutRaw)
  if (!Number.isInteger(cloneTimeoutMinutes) || cloneTimeoutMinutes <= 0) {
    throw new Error(
      `DEPLOYDECK_E2E_CLONE_TIMEOUT_MINUTES 必须是正整数，当前值：${cloneTimeoutRaw}。`,
    )
  }

  return {
    cdpPort,
    sourceInstanceId,
    approvedCostYuan,
    instanceName,
    gpuPreference,
    cloneTimeoutMinutes,
  }
}

/** 打印授权与花费清单。真机测试开始前必须先看到它。 */
export function formatApprovalBanner(config: E2eConfig): string {
  const lines = [
    '===== 真机耗费测试（会产生真实费用）=====',
    `目标实例：${config.sourceInstanceId}`,
    `克隆产物名：${config.instanceName}`,
    `规格优先级：${config.gpuPreference.join('、')}`,
    `批准额度：${config.approvedCostYuan.toFixed(2)} 元`,
    `预计花费：${estimateTotalYuan().toFixed(2)} 元`,
    '将执行的真实动作：',
    ...COST_ESTIMATES.map((item) => `  - ${item.caseName}：约 ${item.yuan.toFixed(2)} 元`),
    '测试结束后会关机并释放它自己创建的实例；失败也会清理。',
    '=========================================',
  ]
  return lines.join('\n')
}
