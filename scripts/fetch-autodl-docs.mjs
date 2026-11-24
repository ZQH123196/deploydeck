// 抓取 AutoDL 官方文档快照到 docs/refs/autodl/。
//
// 用法：node scripts/fetch-autodl-docs.mjs
//
// 输出文件头部写入来源 URL 与抓取日期。
// 正文按 mkdocs 的 .md-content 区域提取，保留代码块与表格的可读形态。
// 官方页面改版后本脚本可能失效，失效时按页面结构重新调整提取逻辑。

import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'docs', 'refs', 'autodl')

const PAGES = [
  { url: 'https://www.autodl.com/docs/common_api/', file: 'common_api.md' },
  { url: 'https://www.autodl.com/docs/instance_pro_api/', file: 'instance_pro_api.md' },
]

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function extractMainContent(html) {
  const marker = html.indexOf('md-content__inner')
  if (marker < 0) throw new Error('页面里找不到 md-content__inner，结构可能已改版')
  // 从标记所在标签的结束尖括号之后开始，避免把 class 属性残留带进正文。
  const tagEnd = html.indexOf('>', marker)
  if (tagEnd < 0) throw new Error('页面结构异常：md-content__inner 标签未闭合')
  const body = html.slice(tagEnd + 1)
  const end = body.indexOf('</article>')
  return end < 0 ? body : body.slice(0, end)
}

function htmlToMarkdown(html) {
  let text = html
  // 代码块先取出，避免后续标签清理破坏内容。
  text = text.replace(/<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/g, (_m, code) => {
    return `\n\`\`\`\n${decodeEntities(code)}\n\`\`\`\n`
  })
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    return `\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/g, '').trim()}\n`
  })
  text = text.replace(/<\/t[dh]>/g, ' | ')
  text = text.replace(/<\/tr>/g, '\n')
  text = text.replace(/<li[^>]*>/g, '\n- ')
  text = text.replace(/<br\s*\/?>/g, '\n')
  text = text.replace(/<[^>]+>/g, '')
  // mkdocs 在每个标题后附加锚点符号，快照里去掉，避免污染正文。
  text = text.replace(/&para;/g, '').replace(/¶/g, '')
  text = decodeEntities(text)
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

const today = new Date().toISOString().slice(0, 10)

for (const page of PAGES) {
  const response = await fetch(page.url)
  if (!response.ok) {
    throw new Error(`抓取失败 ${page.url}：HTTP ${response.status}`)
  }
  const html = await response.text()
  const markdown = htmlToMarkdown(extractMainContent(html))
  const output = `来源 URL：${page.url}　抓取日期：${today}\n\n---\n\n${markdown}\n`
  await writeFile(join(OUT_DIR, page.file), output, 'utf8')
  console.log(`已写入 docs/refs/autodl/${page.file}`)
}
