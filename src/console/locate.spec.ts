import { describe, expect, it } from 'vitest'
import { buildVerifiedSelectorExpression } from './locate.js'

/**
 * 页内定位片段。
 *
 * 四个动作模块共用这一份脚本片段；生成的选择器必须可回验。
 * DOM 结构测试由各动作模块的夹具覆盖，这里只锁片段本身的形状。
 */

describe('buildVerifiedSelectorExpression', () => {
  it('生成的片段能被 JS 解析', () => {
    const snippet = buildVerifiedSelectorExpression()

    expect(() => new Function(`${snippet}\nreturn toVerifiedSelector`)).not.toThrow()
  })

  it('按「标签 + 同层同名序号」生成绝对路径，并用 querySelector 回验', () => {
    const snippet = buildVerifiedSelectorExpression()

    expect(snippet).toContain('previousElementSibling')
    expect(snippet).toContain("':nth-of-type('")
    expect(snippet).toContain("'html > '")
    expect(snippet).toContain('document.querySelector(selector) === target')
    // 回验失败时返回 null，由调用方按结构不符报错。
    expect(snippet).toContain('return null')
  })

  it('只读：不修改页面', () => {
    const snippet = buildVerifiedSelectorExpression()

    expect(snippet).not.toContain('setAttribute')
    expect(snippet).not.toContain('.click()')
  })
})
