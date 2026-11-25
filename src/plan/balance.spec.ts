import { describe, expect, it } from 'vitest'
import { decideBalance } from './balance.js'

describe('decideBalance', () => {
  it('余额足够时放行', () => {
    // Arrange
    const input = { balanceYuan: 100, projectedCostYuan: 10, warnBelowYuan: 20 }

    // Act
    const decision = decideBalance(input)

    // Assert
    expect(decision).toBe('ok')
  })

  it('余额低于告警线时告警', () => {
    // Arrange
    const input = { balanceYuan: 15, projectedCostYuan: 10, warnBelowYuan: 20 }

    // Act
    const decision = decideBalance(input)

    // Assert
    expect(decision).toBe('warn')
  })

  it('余额不足以覆盖预计花费时拒绝', () => {
    // Arrange
    const input = { balanceYuan: 5, projectedCostYuan: 10, warnBelowYuan: 20 }

    // Act
    const decision = decideBalance(input)

    // Assert
    expect(decision).toBe('deny')
  })

  it('余额正好等于预计花费时不算不足', () => {
    // Arrange
    const input = { balanceYuan: 10, projectedCostYuan: 10, warnBelowYuan: 0 }

    // Act
    const decision = decideBalance(input)

    // Assert
    expect(decision).toBe('ok')
  })

  it('余额正好等于告警线时不告警', () => {
    // Arrange
    const input = { balanceYuan: 20, projectedCostYuan: 10, warnBelowYuan: 20 }

    // Act
    const decision = decideBalance(input)

    // Assert
    expect(decision).toBe('ok')
  })

  it('余额为负（欠费）时拒绝任何正花费', () => {
    // Arrange
    const input = { balanceYuan: -1, projectedCostYuan: 0.1, warnBelowYuan: 20 }

    // Act
    const decision = decideBalance(input)

    // Assert
    expect(decision).toBe('deny')
  })

  it.each([
    ['余额不是有限数字', { balanceYuan: Number.NaN, projectedCostYuan: 10, warnBelowYuan: 20 }],
    ['余额是无穷大', { balanceYuan: Number.POSITIVE_INFINITY, projectedCostYuan: 10, warnBelowYuan: 20 }],
    ['预计花费为负', { balanceYuan: 100, projectedCostYuan: -1, warnBelowYuan: 20 }],
    ['告警线为负', { balanceYuan: 100, projectedCostYuan: 10, warnBelowYuan: -1 }],
    ['告警线不是有限数字', { balanceYuan: 100, projectedCostYuan: 10, warnBelowYuan: Number.NaN }],
  ])('非法入参抛 RangeError：%s', (_label, input) => {
    // Act + Assert
    expect(() => decideBalance(input)).toThrow(RangeError)
  })
})
