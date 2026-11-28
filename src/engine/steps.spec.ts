import { describe, expect, it } from 'vitest'
import { PROBE_COMMAND, PROBE_TIMEOUT_SECONDS } from './steps.js'

/**
 * 引擎内置远端命令的判据。
 *
 * 纯常量：不起浏览器、不连 SSH、不碰状态目录。
 */

describe('探测命令', () => {
  it('恒真、无输出、不依赖任何目录或配置', () => {
    // 判据：`probe` 只回答「SSH 能不能连上并执行一条命令」。命令里有路径、
    // 变量或重定向，判的就是别的东西了。
    expect(PROBE_COMMAND).toBe('true')
    expect(PROBE_COMMAND).not.toContain('/')
    expect(PROBE_COMMAND).not.toContain('$')
    expect(PROBE_COMMAND).not.toContain('"')
    expect(PROBE_COMMAND).not.toContain("'")
    expect(PROBE_COMMAND).not.toContain('>')
    expect(PROBE_COMMAND).not.toContain(';')
    expect(PROBE_COMMAND).not.toContain('&&')
  })

  it('超时是 30 秒：恒真命令 30 秒未返回即链路坏了', () => {
    expect(PROBE_TIMEOUT_SECONDS).toBe(30)
  })
})
