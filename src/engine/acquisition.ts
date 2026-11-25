import type { ConsoleInstanceSnapshot } from '../domain/instance.js'
import type { Plan } from '../domain/plan.js'
import type { Profile } from '../domain/profile.js'
import {
  AmbiguousInstanceNameError,
  CloneSourceMissingError,
  HumanRequiredError,
} from '../errors.js'
import type { Provider } from '../providers/provider.js'

/**
 * 取实例的判定表（docs/plan-and-budget.md 第 3.4 节）。
 *
 * 四级：计划已绑定的实例 → 唯一的同名实例 → 多台同名就报错 → 按克隆源克隆。
 *
 * 判据：只读实例列表，不动任何资源。名不唯一、源缺失都在这里失败，
 * 调用方拿不到结论就不会去点开机的按钮。挑错机器的代价是部署到别人的环境上，
 * 所以任何「猜一台」的做法都不允许。
 */
export type AcquisitionDecision =
  /** 实例已在运行：直接复用，不开机。 */
  | { readonly kind: 'reuse-running'; readonly snapshot: ConsoleInstanceSnapshot }
  /** 实例已关机：尝试开机，开机成功才复用。 */
  | { readonly kind: 'power-on'; readonly snapshot: ConsoleInstanceSnapshot }
  /** 没有可复用的实例：以源实例为模板克隆。 */
  | { readonly kind: 'clone'; readonly source: ConsoleInstanceSnapshot }

export async function decideAcquisition(input: {
  readonly provider: Provider
  readonly profile: Profile
  readonly plan: Plan
}): Promise<AcquisitionDecision> {
  const { provider, profile, plan } = input
  // 控制台实例列表不自动刷新，读之前先让控制台取一次新数据。
  const snapshots = await provider.listInstances({ refresh: true })

  // 1. 计划已绑定的实例仍在列表里：用它。下一次执行靠它命中这一条。
  if (plan.instanceId !== null) {
    const bound = snapshots.find((snapshot) => snapshot.instanceId === plan.instanceId)
    if (bound !== undefined) {
      return decideFromInstance(bound)
    }
  }

  // 2. 按实例名找。名字不唯一时猜错就是部署到别人的机器上，所以报错。
  const sameName = snapshots.filter((snapshot) => snapshot.name === profile.instanceNamePattern)
  if (sameName.length > 1) {
    throw new AmbiguousInstanceNameError(
      profile.instanceNamePattern,
      sameName.map((snapshot) => snapshot.instanceId),
    )
  }
  const named = sameName[0]
  if (named !== undefined) {
    return decideFromInstance(named)
  }

  // 3. 没有同名实例：按部署配置里的克隆源克隆。
  return { kind: 'clone', source: requireCloneSource({ snapshots, profile }) }
}

/** 已有实例时按状态决定路径。不在可判定状态时交人工，不猜。 */
function decideFromInstance(snapshot: ConsoleInstanceSnapshot): AcquisitionDecision {
  if (snapshot.status === 'running') {
    return { kind: 'reuse-running', snapshot }
  }
  if (snapshot.status === 'stopped') {
    return { kind: 'power-on', snapshot }
  }
  // cloning / starting / resetting / unknown 都不是可判定状态：
  // unknown 不是安全状态，既不能当已关机，也不能当已消失。
  throw new HumanRequiredError(
    `实例 ${snapshot.instanceId}（${snapshot.name === '' ? '无名称' : snapshot.name}）的控制台状态是` +
      `「${snapshot.statusRaw}」，既不运行也不已关机，无法判定该开机复用还是克隆。` +
      '请等控制台状态稳定后重试，或人工确认后处理。未做任何动作。',
  )
}

/**
 * 解析克隆源实例。
 *
 * 只按名字或 ID 精确匹配，不做「取第一台已关机实例」这类猜测：克隆错机器等于把别人的环境抄一遍。
 * 不使用「像 ID 就按 ID 查」的形状启发式：实例名 `trans-dev` 与实例 ID 形状无法区分，
 * 所以两个字段都匹配，命中多台时一律报错。
 */
function requireCloneSource(input: {
  readonly snapshots: readonly ConsoleInstanceSnapshot[]
  readonly profile: Profile
}): ConsoleInstanceSnapshot {
  const { snapshots, profile } = input
  const sourceName = profile.cloneSourceInstanceName
  const stoppedCandidates = snapshots.filter((snapshot) => snapshot.status === 'stopped')
  const stoppedList =
    stoppedCandidates.length === 0
      ? '（列表里没有已关机的实例）'
      : stoppedCandidates
          .map(
            (snapshot) => `${snapshot.name === '' ? '无名称' : snapshot.name}（${snapshot.instanceId}）`,
          )
          .join('、')

  if (sourceName === undefined) {
    throw new CloneSourceMissingError(
      `控制台里没有名为「${profile.instanceNamePattern}」的实例，只能走克隆，` +
        '但部署配置没有写 cloneSourceInstanceName。' +
        '克隆需要一台已关机的源实例，请在部署配置里写 cloneSourceInstanceName（写名字或实例 ID）。' +
        `当前已关机的实例：${stoppedList}。`,
    )
  }

  // ID 与名字同时匹配：命中多台时报错，不替人挑。
  const matches = snapshots.filter(
    (snapshot) => snapshot.instanceId === sourceName || snapshot.name === sourceName,
  )
  if (matches.length === 0) {
    throw new CloneSourceMissingError(
      `部署配置 ${profile.id} 的 cloneSourceInstanceName 是「${sourceName}」，` +
        '但控制台实例列表里既没有这个 ID 也没有这个名称的实例。' +
        `当前已关机的实例：${stoppedList}。`,
    )
  }
  if (matches.length > 1) {
    throw new CloneSourceMissingError(
      `部署配置 ${profile.id} 的 cloneSourceInstanceName「${sourceName}」命中了 ` +
        `${String(matches.length)} 台实例：${matches.map((snapshot) => snapshot.instanceId).join('、')}。` +
        '无法判定用哪一台当克隆源，请改用实例 ID 指定。',
    )
  }
  const source = matches[0]
  if (source === undefined) {
    throw new CloneSourceMissingError(
      `部署配置 ${profile.id} 的克隆源「${sourceName}」解析结果为空，实例列表可能刚刷新。`,
    )
  }
  return source
}
