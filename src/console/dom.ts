/**
 * 页内求值脚本的构造工具。
 *
 * 这些函数只拼字符串，不碰浏览器。单测断言转义正确，防止选择器或文字里
 * 出现引号时把脚本拼坏。
 */

/** 把字符串转成安全的 JS 字面量。 */
export function jsString(value: string): string {
  return JSON.stringify(value)
}

/**
 * 在给定作用域内按文本找按钮，返回它的视口中心点。
 *
 * 匹配规则是「文本包含」。控制台按钮文字带前后空格，用相等会匹配不到。
 * 作用域匹配不到、或作用域内没有该按钮时返回 null，由调用方决定报错方式。
 */
export function findButtonCenterScript(scopeSelector: string, buttonText: string): string {
  return `(() => {
  const scope = document.querySelector(${jsString(scopeSelector)})
  if (scope === null) return null
  const target = [...scope.querySelectorAll('button')].find((button) => (button.innerText || '').includes(${jsString(buttonText)}))
  if (target === undefined) return null
  const rect = target.getBoundingClientRect()
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
})()`
}

/**
 * 在给定作用域内按文本找元素（不只按钮），返回它的视口中心点。
 * 用于复选框标签、开关等非按钮控件。
 */
export function findElementCenterScript(scopeSelector: string, selector: string, text: string): string {
  return `(() => {
  const scope = document.querySelector(${jsString(scopeSelector)})
  if (scope === null) return null
  const target = [...scope.querySelectorAll(${jsString(selector)})].find((element) => (element.innerText || '').includes(${jsString(text)}))
  if (target === undefined) return null
  const rect = target.getBoundingClientRect()
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
})()`
}

/**
 * 找到「当前可见」的那个元素。
 *
 * 控制台把每个对话框、每个下拉弹层都留在 DOM 里，只靠 display 隐藏。
 * 可见判据用几何尺寸，因为标签在后台时动画不推进，class 会停在过渡态。
 */
export function findVisibleElementScript(selector: string): string {
  return `(() => {
  const target = [...document.querySelectorAll(${jsString(selector)})].find((element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  return target === undefined ? null : target
})()`
}
