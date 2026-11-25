import { describe, expect, it } from 'vitest'
import type { ConsoleChannel, ConsoleRuntimeContext } from '../console/ports.js'
import { ConsoleParseError } from '../errors.js'
import type { Clock } from '../util/clock.js'
import {
  assertPasswordLike,
  buildInstallCopyHookScript,
  buildLocateCopyIconScript,
  buildReadCopiedValueScript,
  buildReadSshLoginCellScript,
  parseSshLoginCommand,
  readSshCredentials,
} from './credentials.js'

/**
 * SSH 凭据读取的单测。
 *
 * 真机事实（2026-11-25）：登录指令与密码在 DOM 里都是掩码，明文只在点复制图标时
 * 由页面临时 `textarea` 承载。所以这里的假通道模拟「点图标 → 钩子拿到明文」这条链路，
 * 不模拟任何明文出现在文本里的情况。
 */

const INSTANCE_ID = '6a9f428e64-c7771049'
const ROW_SELECTOR = '.el-table__row:nth-of-type(2)'
const COMMAND_SELECTOR = 'html > body:nth-of-type(1) > div:nth-of-type(1) > svg:nth-of-type(1)'
const PASSWORD_SELECTOR = 'html > body:nth-of-type(1) > div:nth-of-type(1) > svg:nth-of-type(2)'

const CELL_TEXT = '登录指令 ssh****** 密码 *********'

/** 假时钟：sleep 直接推进 now，不真实等待。 */
function createFakeClock(): Clock {
  let current = 0
  return {
    now: () => current,
    sleep: async (milliseconds: number) => {
      current += milliseconds
    },
  }
}

interface FakeChannelOptions {
  /** 行是否找到。null 表示找不到。 */
  readonly rowSelector?: string | null
  readonly text?: string
  /** 两个复制图标是否都定位得到。 */
  readonly icons?: { readonly command: string | null; readonly password: string | null }
  /** 点图标后钩子返回的值。null 表示钩子一直没值。 */
  readonly copied?: { readonly command: string | null; readonly password: string | null }
}

interface FakeChannel {
  readonly channel: ConsoleChannel
  readonly clicks: string[]
  readonly scripts: string[]
  readonly screenshots: string[]
}

function createFakeChannel(options: FakeChannelOptions = {}): FakeChannel {
  const clicks: string[] = []
  const scripts: string[] = []
  const screenshots: string[] = []
  const rowSelector = options.rowSelector === undefined ? ROW_SELECTOR : options.rowSelector
  const icons = options.icons ?? { command: COMMAND_SELECTOR, password: PASSWORD_SELECTOR }
  const copied = options.copied ?? {
    command: 'ssh -p 11541 root@connect.west-b.autodl.com',
    password: 'SglGexample',
  }
  let lastIcon: 'command' | 'password' | null = null

  const readCellScript = buildReadSshLoginCellScript(INSTANCE_ID)
  const installHookScript = buildInstallCopyHookScript()
  const readCopiedScript = buildReadCopiedValueScript()
  const locateCommandIconScript = buildLocateCopyIconScript(ROW_SELECTOR, 0)
  const locatePasswordIconScript = buildLocateCopyIconScript(ROW_SELECTOR, 1)

  const channel: ConsoleChannel = {
    goto: async () => {},
    currentUrl: async () => 'https://www.autodl.com/console/instance/list',
    evaluate: async <Result>(script: string): Promise<Result> => {
      scripts.push(script)
      if (script === readCellScript) {
        return {
          rowIndex: rowSelector === null ? null : 1,
          rowSelector,
          text: options.text === undefined ? CELL_TEXT : options.text,
        } as unknown as Result
      }
      if (script === installHookScript) {
        return true as unknown as Result
      }
      if (script === readCopiedScript) {
        const value = lastIcon === null ? null : copied[lastIcon]
        return value as unknown as Result
      }
      if (script === locateCommandIconScript) {
        return icons.command as unknown as Result
      }
      if (script === locatePasswordIconScript) {
        return icons.password as unknown as Result
      }
      throw new Error(`假通道不认识求值脚本：${script.slice(0, 120)}`)
    },
    click: async (selector: string) => {
      clicks.push(selector)
      if (selector === COMMAND_SELECTOR) {
        lastIcon = 'command'
      } else if (selector === PASSWORD_SELECTOR) {
        lastIcon = 'password'
      }
    },
    type: async () => {},
    waitFor: async () => {},
    waitForGone: async () => {},
    screenshot: async (filePath: string) => {
      screenshots.push(filePath)
    },
    close: async () => {},
  }

  return { channel, clicks, scripts, screenshots }
}

function createContext(channel: ConsoleChannel): ConsoleRuntimeContext {
  return {
    channel,
    instances: {
      listInstances: async () => [],
    },
    logDir: 'run-log',
    timeoutMs: 3_000,
    pollIntervalMs: 1_000,
    clock: createFakeClock(),
  }
}

describe('parseSshLoginCommand', () => {
  it('带 -p 的实测形状解析出 host、port、user', () => {
    expect(parseSshLoginCommand('ssh -p 11541 root@connect.west-b.autodl.com')).toEqual({
      host: 'connect.west-b.autodl.com',
      port: 11541,
      user: 'root',
    })
  })

  it('不带 -p 时端口取 22', () => {
    expect(parseSshLoginCommand('ssh root@1.2.3.4').port).toBe(22)
  })

  it('紧凑写法 -p11541 也能解析', () => {
    expect(parseSshLoginCommand('ssh -p11541 root@host.example.com').port).toBe(11541)
  })

  it('标签与指令粘连时仍能找到指令', () => {
    // 单元格文本由多个子元素拼成，标签与指令之间可能没有空格。
    expect(parseSshLoginCommand('登录指令ssh -p 22 root@host').port).toBe(22)
  })

  it('端口不是整数时抛错', () => {
    expect(() => parseSshLoginCommand('ssh -p abc root@host')).toThrow(ConsoleParseError)
  })

  it('端口越界时抛错', () => {
    expect(() => parseSshLoginCommand('ssh -p 70000 root@host')).toThrow(/越界/)
  })

  it('找不到「用户@主机」时抛错', () => {
    expect(() => parseSshLoginCommand('ssh -p 22')).toThrow(/用户@主机/)
  })

  it('不是 ssh 指令时抛错，错误信息不回显 @ 之后的内容', () => {
    const error = (() => {
      try {
        parseSshLoginCommand('curl http://x@y')
        return null
      } catch (caught: unknown) {
        return caught instanceof Error ? caught.message : String(caught)
      }
    })()
    expect(error).not.toBeNull()
    expect(error).not.toContain('@y')
  })
})

describe('assertPasswordLike', () => {
  it('正常密码通过', () => {
    expect(() => assertPasswordLike('SglGexample')).not.toThrow()
  })

  it('空密码抛错', () => {
    expect(() => assertPasswordLike('')).toThrow(/空字符串/)
  })

  it('超长抛错', () => {
    expect(() => assertPasswordLike('a'.repeat(129))).toThrow(/超过上限/)
  })

  it('含空白抛错', () => {
    expect(() => assertPasswordLike('has space')).toThrow(/空白/)
  })
})

describe('页内脚本', () => {
  it('复制钩子脚本幂等且记录 execCommand 的 textarea 值', () => {
    const script = buildInstallCopyHookScript()

    expect(script).toContain('document.execCommand = function')
    expect(script).toContain('window.__deploydeckCopyHookInstalled === true')
    expect(script).toContain('active.tagName === \'TEXTAREA\'')
  })

  it('读复制结果脚本读一次就清空', () => {
    const script = buildReadCopiedValueScript()

    expect(script).toContain('window.__deploydeckCopied = null')
    expect(script).toContain('typeof value === \'string\'')
  })

  it('复制图标定位脚本按序号取，且作用域限定在 SSH 登录列', () => {
    const script = buildLocateCopyIconScript(ROW_SELECTOR, 1)

    expect(script).toContain(ROW_SELECTOR)
    expect(script).toContain('icon-fuzhi')
    expect(script).toContain('icons[1]')
  })

  it('复制图标序号非法时抛错', () => {
    expect(() => buildLocateCopyIconScript(ROW_SELECTOR, -1)).toThrow(RangeError)
    expect(() => buildLocateCopyIconScript(ROW_SELECTOR, 1.5)).toThrow(RangeError)
  })
})

describe('readSshCredentials', () => {
  it('点两个复制图标取到凭据，返回 host、port、user、password', async () => {
    const fake = createFakeChannel()

    const credentials = await readSshCredentials(createContext(fake.channel), INSTANCE_ID)

    expect(credentials).toEqual({
      host: 'connect.west-b.autodl.com',
      port: 11541,
      user: 'root',
      password: 'SglGexample',
    })
    expect(fake.clicks).toEqual([COMMAND_SELECTOR, PASSWORD_SELECTOR])
    expect(fake.screenshots).toEqual([
      'run-log/ssh-login-cell-before.png',
      'run-log/ssh-login-cell-after.png',
    ])
  })

  it('先装复制钩子，再点图标', async () => {
    const fake = createFakeChannel()

    await readSshCredentials(createContext(fake.channel), INSTANCE_ID)

    const hookIndex = fake.scripts.indexOf(buildInstallCopyHookScript())
    expect(hookIndex).toBeGreaterThanOrEqual(0)
  })

  it('实例不在列表里时抛错，错误信息含实例 ID，不点任何图标', async () => {
    const fake = createFakeChannel({ rowSelector: null })

    await expect(readSshCredentials(createContext(fake.channel), INSTANCE_ID)).rejects.toThrow(
      INSTANCE_ID,
    )
    expect(fake.clicks).toEqual([])
  })

  it('SSH 登录列为空时抛错，提示实例可能未运行', async () => {
    const fake = createFakeChannel({ text: '' })

    await expect(readSshCredentials(createContext(fake.channel), INSTANCE_ID)).rejects.toThrow(
      /未运行/,
    )
    expect(fake.clicks).toEqual([])
  })

  it('找不到复制图标时抛错', async () => {
    const fake = createFakeChannel({ icons: { command: null, password: PASSWORD_SELECTOR } })

    await expect(readSshCredentials(createContext(fake.channel), INSTANCE_ID)).rejects.toThrow(
      /复制图标/,
    )
    expect(fake.clicks).toEqual([])
  })

  it('点复制图标后钩子一直没有值时超时抛错', async () => {
    const fake = createFakeChannel({ copied: { command: null, password: null } })

    await expect(readSshCredentials(createContext(fake.channel), INSTANCE_ID)).rejects.toThrow(
      /复制方式/,
    )
  })

  it('复制到的密码含空白时抛错，不把它当密码用', async () => {
    const fake = createFakeChannel({
      copied: { command: 'ssh -p 11541 root@host', password: 'not a password' },
    })

    await expect(readSshCredentials(createContext(fake.channel), INSTANCE_ID)).rejects.toThrow(
      /空白/,
    )
  })
})
