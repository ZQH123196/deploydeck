import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConsoleChannel } from '../../console/ports.js'
import { ConfigError } from '../../errors.js'
import {
  assertProviderOptions,
  createAutodlProvider,
  openAutodlProvider,
  type AutodlProviderOptions,
} from './runtime.js'

/**
 * provider 装配。
 *
 * 这里只验证纯装配与选项校验：`createAutodlProvider` 收的是假通道，不连浏览器、不连 SSH。
 * `openAutodlProvider` 会连真实 Chrome，所以只测它「选项非法时先崩，不去连浏览器」。
 */

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

/** 假通道。装配阶段不该调用它，任何调用都直接失败。 */
const unusedChannel: ConsoleChannel = {
  goto: async () => {
    throw new Error('装配阶段不应调用通道')
  },
  currentUrl: async () => {
    throw new Error('装配阶段不应调用通道')
  },
  evaluate: async () => {
    throw new Error('装配阶段不应调用通道')
  },
  click: async () => {
    throw new Error('装配阶段不应调用通道')
  },
  type: async () => {
    throw new Error('装配阶段不应调用通道')
  },
  waitFor: async () => {
    throw new Error('装配阶段不应调用通道')
  },
  waitForGone: async () => {
    throw new Error('装配阶段不应调用通道')
  },
  screenshot: async () => {
    throw new Error('装配阶段不应调用通道')
  },
  close: async () => {
    throw new Error('装配阶段不应调用通道')
  },
}

async function createTemporaryParent(): Promise<string> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'autodl-runtime-spec-'))
  temporaryParents.push(parent)
  return parent
}

function makeOptions(parent: string, overrides: Partial<AutodlProviderOptions> = {}): AutodlProviderOptions {
  const stateDir = join(parent, 'state')
  return {
    consoleUrl: 'https://www.autodl.com/console/instance/list',
    cdpPort: 9222,
    chromeProfileDir: join(parent, 'chrome-profile'),
    knownHostsPath: join(stateDir, 'ssh-known-hosts.txt'),
    logDir: join(stateDir, 'console'),
    stateDir,
    configDir: join(parent, 'config'),
    timeoutMs: 60_000,
    pollIntervalMs: 1_000,
    ...overrides,
  }
}

describe('createAutodlProvider', () => {
  it('把五组控制台端口与 SSH 装成一个 Provider，id 与能力声明按 AutoDL 实际', async () => {
    const parent = await createTemporaryParent()
    const provider = createAutodlProvider({
      channel: unusedChannel,
      logDir: join(parent, 'console'),
      timeoutMs: 60_000,
      pollIntervalMs: 1_000,
      knownHostsPath: join(parent, 'ssh-known-hosts.txt'),
    })

    expect(provider.id).toBe('autodl')
    expect(provider.capabilities).toEqual({
      create: true,
      powerCycle: true,
      noGpuMode: true,
      timedShutdown: true,
      accessInfo: true,
      imageSnapshot: false,
      clone: true,
    })
    for (const method of [
      'listInstances',
      'powerOn',
      'powerOff',
      'readCloneQuota',
      'clone',
      'readPriceQuote',
      'setTimedShutdown',
      'readBalance',
      'destroy',
      'waitUntilReady',
      'exec',
    ] as const) {
      expect(typeof provider[method]).toBe('function')
    }
  })
})

describe('openAutodlProvider 的选项校验', () => {
  it('CDP 端口越界时抛 ConfigError，不去连浏览器', async () => {
    const parent = await createTemporaryParent()

    await expect(
      openAutodlProvider(makeOptions(parent, { cdpPort: 70_000 })),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  it('控制台地址不是 http(s) 时抛 ConfigError', async () => {
    const parent = await createTemporaryParent()

    await expect(
      openAutodlProvider(makeOptions(parent, { consoleUrl: 'ftp://example.com/console' })),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  it('路径不是绝对路径时抛 ConfigError', async () => {
    const parent = await createTemporaryParent()

    await expect(
      openAutodlProvider(makeOptions(parent, { chromeProfileDir: 'relative/chrome-profile' })),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  it('Windows 盘符路径算绝对路径，不抛 ConfigError', async () => {
    // WSL 下 Chrome 的 user-data-dir 必须落 Windows 本地磁盘，取值天然是 `C:\...`。
    // 用 POSIX 的 isAbsolute 判它恒为假，会把唯一可用的取值判成非法，
    // 回退到状态目录又被 9p 检查拒绝 —— 两条路都走不通，控制台命令全部失败。
    //
    // 只测选项校验这层纯函数：`openAutodlProvider` 会连真实 Chrome，
    // 自动测试不得触发外部进程。
    const parent = await createTemporaryParent()

    expect(() =>
      assertProviderOptions(
        makeOptions(parent, {
          chromeProfileDir: 'C:\\Users\\example\\AppData\\Local\\deploydeck\\chrome-profile',
        }),
      ),
    ).not.toThrow()
  })

  it('Windows 盘符路径以后斜杠写也认，反斜杠与正斜杠等价', async () => {
    const parent = await createTemporaryParent()

    expect(() =>
      assertProviderOptions(
        makeOptions(parent, { chromeProfileDir: 'C:/Users/example/AppData/Local/deploydeck/chrome-profile' }),
      ),
    ).not.toThrow()
  })

  it('known-hosts 落在状态目录外时抛 ConfigError', async () => {
    const parent = await createTemporaryParent()

    await expect(
      openAutodlProvider(makeOptions(parent, { knownHostsPath: join(parent, 'known-hosts.txt') })),
    ).rejects.toBeInstanceOf(ConfigError)
  })

  it('状态目录落在配置目录内时抛 ConfigError', async () => {
    const parent = await createTemporaryParent()
    const configDir = join(parent, 'config')

    await expect(
      openAutodlProvider(
        makeOptions(parent, {
          configDir,
          stateDir: join(configDir, 'state'),
          knownHostsPath: join(configDir, 'state', 'ssh-known-hosts.txt'),
          logDir: join(configDir, 'state', 'console'),
        }),
      ),
    ).rejects.toBeInstanceOf(ConfigError)
  })
})
