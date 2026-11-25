import { describe, expect, it } from 'vitest'
import { ConfigError } from '../errors.js'
import {
  resolveBalanceWarnBelowYuan,
  resolveChromeExecutableOverride,
  resolveChromeProfileDir,
  resolveCdpPort,
  resolveConfigDir,
  resolveStateDir,
  resolveWslDistroName,
} from './paths.js'

/**
 * 配置读取唯一入口的判据。
 *
 * 这些函数是所有环境变量的唯一读取点：改默认值、加校验只改这里。
 */

describe('目录默认值', () => {
  it('配置目录默认 ~/.config/deploydeck，环境变量可覆盖', () => {
    expect(resolveConfigDir({})).toContain(joinTail('.config', 'deploydeck'))
    expect(resolveConfigDir({ DEPLOYDECK_CONFIG_DIR: '/custom/config' })).toBe('/custom/config')
  })

  it('状态目录默认 ~/.local/state/deploydeck，环境变量可覆盖', () => {
    expect(resolveStateDir({})).toContain(joinTail('.local', 'state', 'deploydeck'))
    expect(resolveStateDir({ DEPLOYDECK_STATE_DIR: '/custom/state' })).toBe('/custom/state')
  })
})

describe('专用 Chrome 的 user-data-dir', () => {
  it('默认落状态目录，不落配置目录', () => {
    // 判据：配置目录由人写、机器只读，而 Chrome 会往 user-data-dir 写登录态。
    const dir = resolveChromeProfileDir({
      DEPLOYDECK_CONFIG_DIR: '/custom/config',
      DEPLOYDECK_STATE_DIR: '/custom/state',
    })

    expect(dir).toBe('/custom/state/chrome-profile')
    expect(dir.startsWith('/custom/config')).toBe(false)
  })

  it('显式覆盖优先', () => {
    expect(
      resolveChromeProfileDir({
        DEPLOYDECK_STATE_DIR: '/custom/state',
        DEPLOYDECK_CHROME_PROFILE_DIR: '/custom/profile',
      }),
    ).toBe('/custom/profile')
  })
})

describe('专用 Chrome 环境变量', () => {
  it('可执行文件覆盖值来自配置入口，没配时为空串', () => {
    expect(resolveChromeExecutableOverride({})).toBe('')
    expect(
      resolveChromeExecutableOverride({ DEPLOYDECK_CHROME_EXECUTABLE: '/opt/chrome' }),
    ).toBe('/opt/chrome')
  })

  it('WSL 分发名来自配置入口，没配时为空串', () => {
    expect(resolveWslDistroName({})).toBe('')
    expect(resolveWslDistroName({ WSL_DISTRO_NAME: 'Ubuntu-24.04' })).toBe('Ubuntu-24.04')
  })
})

describe('余额告警阈值', () => {
  it('没有配置时启动期报错，并说清要配哪个变量', () => {
    let caught: unknown
    try {
      resolveBalanceWarnBelowYuan({})
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigError)
    if (!(caught instanceof ConfigError)) {
      throw new Error('期望抛出 ConfigError')
    }
    expect(caught.message).toContain('DEPLOYDECK_BALANCE_WARN_BELOW_YUAN')
    expect(caught.exitCode).toBe(2)
  })

  it('合法值原样返回，0 也合法（只在欠费时告警）', () => {
    expect(resolveBalanceWarnBelowYuan({ DEPLOYDECK_BALANCE_WARN_BELOW_YUAN: '20' })).toBe(20)
    expect(resolveBalanceWarnBelowYuan({ DEPLOYDECK_BALANCE_WARN_BELOW_YUAN: '0' })).toBe(0)
    expect(resolveBalanceWarnBelowYuan({ DEPLOYDECK_BALANCE_WARN_BELOW_YUAN: '1.5' })).toBe(1.5)
  })

  it.each([['-1'], ['abc'], ['NaN'], ['Infinity'], [' ']])(
    '非法值 %s 报 ConfigError，不猜默认值',
    (raw) => {
      expect(() => resolveBalanceWarnBelowYuan({ DEPLOYDECK_BALANCE_WARN_BELOW_YUAN: raw })).toThrow(
        ConfigError,
      )
    },
  )
})

describe('CDP 端口', () => {
  it('默认 9222，非法值报 ConfigError', () => {
    expect(resolveCdpPort({})).toBe(9222)
    expect(resolveCdpPort({ DEPLOYDECK_CDP_PORT: '9333' })).toBe(9333)
    expect(() => resolveCdpPort({ DEPLOYDECK_CDP_PORT: '0' })).toThrow(ConfigError)
    expect(() => resolveCdpPort({ DEPLOYDECK_CDP_PORT: 'abc' })).toThrow(ConfigError)
  })
})

/** 跨平台断言路径尾巴：只关心相对结构，不关心分隔符与主目录。 */
function joinTail(...segments: readonly string[]): string {
  return segments.join('/')
}
