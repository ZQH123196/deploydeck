import { describe, expect, it } from 'vitest'
import { findButtonCenterScript, findElementCenterScript, findVisibleElementScript, jsString } from './dom.js'

describe('jsString', () => {
  it('把含引号的文字转成安全字面量', () => {
    expect(jsString('他说"好"')).toBe('"他说\\"好\\""')
  })
})

describe('findButtonCenterScript', () => {
  it('把作用域与按钮文字都转义后拼进脚本', () => {
    const script = findButtonCenterScript('.el-dialog', '克"隆')
    expect(script).toContain('document.querySelector(".el-dialog")')
    expect(script).toContain('includes("克\\"隆")')
  })
})

describe('findElementCenterScript', () => {
  it('带上要查的子选择器', () => {
    const script = findElementCenterScript('.el-dialog', '.el-checkbox', '数据盘')
    expect(script).toContain('querySelectorAll(".el-checkbox")')
    expect(script).toContain('includes("数据盘")')
  })
})

describe('findVisibleElementScript', () => {
  it('按几何尺寸判定可见，不按 class 判定', () => {
    const script = findVisibleElementScript('.el-dialog')
    expect(script).toContain('getBoundingClientRect()')
    expect(script).toContain('rect.width > 0')
    expect(script).not.toContain('is-')
  })
})
