import { describe, expect, it } from 'vitest'
import { decideCreate, decideRuntime, estimateRunCostYuan, usedRatio } from './budget.js'

describe('estimateRunCostYuan', () => {
  it('按单价与计划分钟数算出预计花费', () => {
    // Arrange
    const pricePerHourYuan = 3
    const ttlMinutes = 90

    // Act
    const cost = estimateRunCostYuan(pricePerHourYuan, ttlMinutes)

    // Assert
    expect(cost).toBe(4.5)
  })

  it('计划时长不为正时抛错', () => {
    // Arrange
    const ttlMinutes = 0

    // Act + Assert
    expect(() => estimateRunCostYuan(3, ttlMinutes)).toThrow(RangeError)
  })
})

describe('decideCreate', () => {
  it('预算充足时允许创建容器', () => {
    // Arrange
    const input = { spentYuan: 1, budgetCapYuan: 10, projectedCostYuan: 2 }

    // Act
    const decision = decideCreate(input)

    // Assert
    expect(decision).toBe('allow')
  })

  it('预计花费会顶穿上限时拒绝创建容器', () => {
    // Arrange
    const input = { spentYuan: 8, budgetCapYuan: 10, projectedCostYuan: 3 }

    // Act
    const decision = decideCreate(input)

    // Assert
    expect(decision).toBe('deny')
  })

  it('已用达到上限时拒绝创建容器', () => {
    // Arrange
    const input = { spentYuan: 10, budgetCapYuan: 10, projectedCostYuan: 0 }

    // Act
    const decision = decideCreate(input)

    // Assert
    expect(decision).toBe('deny')
  })

  it('已用达到告警线时允许创建但给出告警', () => {
    // Arrange
    const input = { spentYuan: 8.5, budgetCapYuan: 10, projectedCostYuan: 1 }

    // Act
    const decision = decideCreate(input)

    // Assert
    expect(decision).toBe('warn')
  })
})

describe('decideRuntime', () => {
  it('已用未达熔断线时继续运行', () => {
    // Arrange
    const input = { spentYuan: 5, budgetCapYuan: 10 }

    // Act
    const decision = decideRuntime(input)

    // Assert
    expect(decision).toBe('continue')
  })

  it('已用达到熔断线时立即熔断', () => {
    // Arrange
    const input = { spentYuan: 10, budgetCapYuan: 10 }

    // Act
    const decision = decideRuntime(input)

    // Assert
    expect(decision).toBe('trip')
  })
})

describe('usedRatio', () => {
  it('算出已用比例用于进度展示', () => {
    // Arrange
    const input = { spentYuan: 2.5, budgetCapYuan: 10 }

    // Act
    const ratio = usedRatio(input)

    // Assert
    expect(ratio).toBe(0.25)
  })
})
