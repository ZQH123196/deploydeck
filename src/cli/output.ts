/**
 * CLI 的输出边界。
 *
 * `--json` 模式下 stdout 只允许出现一个 JSON 对象；人读进度、引擎日志与错误一律走 stderr。
 * 命令实现不直接碰 `process.stdout`：测试注入内存流，输出才能断言。
 */

export interface OutputStream {
  /** 写入一段文本。由调用方负责换行。 */
  write(text: string): void
}

/** 写一行文本。 */
export function writeLine(stream: OutputStream, text = ''): void {
  stream.write(`${text}\n`)
}

/**
 * 写一个 JSON 对象。
 *
 * 只输出一个对象、一行写完：机器读者按整段解析 stdout，不会混进别的行。
 * 需要人读时用命令的人读模式，或把 stdout 交给 `jq`。
 */
export function writeJson(stream: OutputStream, value: unknown): void {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('要输出的值无法序列化为 JSON。')
  }
  stream.write(`${serialized}\n`)
}

/** 宽字符（中日韩文字与全角标点）在终端里占两列。 */
function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    width += isWideChar(code) ? 2 : 1
  }
  return width
}

function padCell(text: string, width: number): string {
  const gap = width - displayWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

/**
 * 把表头与行按列宽对齐后写出去。列数不一致即抛错：错位的表格比没有表格更难读。
 */
export function writeTable(
  stream: OutputStream,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  for (const row of rows) {
    if (row.length !== headers.length) {
      throw new RangeError(`表格列数不一致：表头 ${String(headers.length)} 列，某行 ${String(row.length)} 列。`)
    }
  }
  const widths = headers.map((header, index) => {
    let width = displayWidth(header)
    for (const row of rows) {
      width = Math.max(width, displayWidth(row[index] ?? ''))
    }
    return width
  })
  const renderRow = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => padCell(cell, widths[index] ?? 0))
      .join('  ')
      .trimEnd()

  writeLine(stream, renderRow(headers))
  for (const row of rows) {
    writeLine(stream, renderRow(row))
  }
}

/** 金额按两位小数展示，末位多余的 0 保留：账目要精确到分。 */
export function formatYuan(value: number): string {
  return value.toFixed(2)
}

/** 数字按普通十进制展示，避免 1e-7 这类科学计数法。 */
export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** 可空值的展示占位。 */
export function formatNullable(value: string | null | undefined): string {
  return value === null || value === undefined || value.length === 0 ? '-' : value
}
