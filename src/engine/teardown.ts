/**
 * 销毁链的决策函数。纯函数，不做 IO。
 *
 * 销毁不是一次请求，而是一条链：关机 → 释放 → 验证消失。
 * 判据见 docs/provider-contract.md 第 4.2 节。
 */
import type { ResourcePhase } from '../providers/provider.js'

export interface TeardownObservation {
  phase: ResourcePhase
  /** assertGone 的结果。它才是终态判据。 */
  gone: boolean
  /** 关机请求是否已经发出。 */
  powerOffIssued: boolean
  /** 释放请求是否已经发出。 */
  releaseIssued: boolean
  /** 距离上一个动作已经等待的轮数。 */
  consecutiveWaits: number
}

export type TeardownAction =
  | { kind: 'power-off' }
  | { kind: 'release' }
  | { kind: 'wait'; reason: string }
  | { kind: 'done' }
  | { kind: 'escalate'; reason: string }

export interface TeardownLimits {
  /** 连续等待多少轮仍未消失就转人工。 */
  maxConsecutiveWaits: number
}

export const DEFAULT_TEARDOWN_LIMITS: TeardownLimits = {
  maxConsecutiveWaits: 30,
}

/** 决定销毁链的下一步动作。 */
export function decideTeardownAction(
  observation: TeardownObservation,
  limits: TeardownLimits = DEFAULT_TEARDOWN_LIMITS,
): TeardownAction {
  if (observation.gone) {
    return { kind: 'done' }
  }

  if (observation.phase === 'unknown') {
    return { kind: 'escalate', reason: '容器状态无法判定，不得当作已关闭' }
  }

  if (observation.consecutiveWaits >= limits.maxConsecutiveWaits) {
    return {
      kind: 'escalate',
      reason: `等待 ${observation.consecutiveWaits} 轮仍未确认容器消失`,
    }
  }

  const needsPowerOff = observation.phase === 'running' || observation.phase === 'provisioning'

  if (needsPowerOff) {
    if (!observation.powerOffIssued) {
      return { kind: 'power-off' }
    }
    return { kind: 'wait', reason: '关机处理中' }
  }

  if (!observation.releaseIssued) {
    return { kind: 'release' }
  }

  return { kind: 'wait', reason: '释放处理中' }
}
