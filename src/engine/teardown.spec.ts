import { describe, expect, it } from 'vitest'
import { decideTeardownAction, type TeardownObservation } from './teardown.js'

function observation(overrides: Partial<TeardownObservation>): TeardownObservation {
  return {
    phase: 'running',
    gone: false,
    powerOffIssued: false,
    releaseIssued: false,
    consecutiveWaits: 0,
    ...overrides,
  }
}

describe('decideTeardownAction', () => {
  it('容器已消失时结束销毁链', () => {
    // Arrange
    const obs = observation({ phase: 'gone', gone: true, powerOffIssued: true, releaseIssued: true })

    // Act
    const action = decideTeardownAction(obs)

    // Assert
    expect(action.kind).toBe('done')
  })

  it('运行中的容器先执行关机', () => {
    // Arrange
    const obs = observation({ phase: 'running' })

    // Act
    const action = decideTeardownAction(obs)

    // Assert
    expect(action.kind).toBe('power-off')
  })

  it('关机已发出时继续等待，不重复发请求', () => {
    // Arrange
    const obs = observation({ phase: 'running', powerOffIssued: true })

    // Act
    const action = decideTeardownAction(obs)

    // Assert
    expect(action.kind).toBe('wait')
  })

  it('容器已停止时执行释放', () => {
    // Arrange
    const obs = observation({ phase: 'stopped', powerOffIssued: true })

    // Act
    const action = decideTeardownAction(obs)

    // Assert
    expect(action.kind).toBe('release')
  })

  it('释放已发出但容器仍在时继续等待', () => {
    // Arrange
    const obs = observation({ phase: 'releasing', powerOffIssued: true, releaseIssued: true })

    // Act
    const action = decideTeardownAction(obs)

    // Assert
    expect(action.kind).toBe('wait')
  })

  it('容器状态无法判定时转人工，不当成已关闭', () => {
    // Arrange
    const obs = observation({ phase: 'unknown', powerOffIssued: true, releaseIssued: true })

    // Act
    const action = decideTeardownAction(obs)

    // Assert
    expect(action.kind).toBe('escalate')
  })

  it('等待轮数超过上限时转人工', () => {
    // Arrange
    const obs = observation({ phase: 'releasing', powerOffIssued: true, releaseIssued: true, consecutiveWaits: 30 })

    // Act
    const action = decideTeardownAction(obs, { maxConsecutiveWaits: 30 })

    // Assert
    expect(action.kind).toBe('escalate')
  })
})
