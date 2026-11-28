import { describe, expect, it } from 'vitest'
import { assertE2eBrowserPlatform } from '../../e2e/support/runtime.js'

/**
 * 真机测试的平台判据。
 *
 * 它必须在任何浏览器动作之前给出确定答案：判不准就拒绝，不降级成前台启动（那会抢人的前台）。
 * 本文件只验证判据，不启动任何进程。
 */
describe('真机测试的平台判据', () => {
  it('WSL 里放行', () => {
    expect(() => assertE2eBrowserPlatform('linux', { WSL_DISTRO_NAME: 'Ubuntu-24.04' })).not.toThrow()
  })

  it('原生 Linux 拒绝：拿不到 Windows Chrome', () => {
    expect(() => assertE2eBrowserPlatform('linux', {})).toThrow(/只在 WSL 下支持/)
  })

  it('Windows 与 macOS 拒绝', () => {
    expect(() => assertE2eBrowserPlatform('win32', { WSL_DISTRO_NAME: 'x' })).toThrow(/只在 WSL 下支持/)
    expect(() => assertE2eBrowserPlatform('darwin', {})).toThrow(/只在 WSL 下支持/)
  })
})
