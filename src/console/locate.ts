/**
 * 控制台页面内的定位片段。
 *
 * 控制台 DOM 没有稳定类名可依靠，动作模块只能按「标签 + 同层同名序号」在运行时
 * 生成 CSS 路径选择器，并立刻回验：选择器必须指回同一个元素才返回。
 * 页面改版导致路径失效时返回 null，由判定层报错，不猜。
 *
 * 这段页内脚本原先在 power / release / clone / timed-shutdown 各写一份，
 * 副本之间只差个别变量名。统一收在这里，改判据只改一处。
 */

/**
 * 生成页内函数 `toVerifiedSelector(target)` 的脚本片段。
 *
 * 用法：把返回的字符串拼进页内 `(() => { ... })()` 脚本，再从 `document.documentElement`
 * 起生成绝对 CSS 路径。返回 null 表示生成失败（DOM 结构不符）。
 *
 * 判据：
 * 1. 路径按「标签 + 同层同名序号」逐级生成，不依赖控制台内部结构。
 * 2. 生成后用 `document.querySelector` 回查，必须指回同一元素。
 * 3. 回查不到时返回 null，调用方按结构不符报错，不重试、不猜别的选择器。
 */
export function buildVerifiedSelectorExpression(): string {
  return `  const toVerifiedSelector = (target) => {
    const parts = []
    let node = target
    while (node !== null && node !== document.documentElement) {
      const parent = node.parentElement
      if (parent === null) return null
      let index = 1
      for (let sibling = node.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
        if (sibling.localName === node.localName) index += 1
      }
      parts.unshift(node.localName + ':nth-of-type(' + String(index) + ')')
      node = parent
    }
    if (node !== document.documentElement) return null
    const selector = 'html > ' + parts.join(' > ')
    return document.querySelector(selector) === target ? selector : null
  }`
}
