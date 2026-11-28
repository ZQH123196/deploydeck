import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError } from '../../errors.js'
import type { CredentialsPort } from '../../ssh/credentials.js'
import type { SshCredentials } from '../../ssh/ports.js'
import { createStateStore } from '../../state/store.js'
import type { CliDependencies } from '../dependencies.js'
import type { OutputStream } from '../output.js'
import {
  formatCredsHumanReadable,
  runCredsCommand,
  toCredsCommandResult,
} from './creds.js'

/**
 * `creds` 命令的行为用例。
 *
 * 判据：
 * - `--json` 输出恰好 host / port / user / password 四个键。
 * - 密码只出现在 stdout。日志与状态目录里都不出现。
 * - 不加 `--json` 时按人读格式打印，密码照样打出来。
 *
 * 隔离：凭据端口是假对象，不连浏览器。状态目录用本机临时目录，
 * 只用来验证「命令没有写任何东西」和「密码没有落盘」。
 */

const INSTANCE_ID = 'af9c49bd44-8ee624d7'
const PASSWORD = 'zq7Kp2mNxR4t'

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

async function createTemporaryParent(): Promise<string> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'creds-spec-'))
  temporaryParents.push(parent)
  return parent
}

function createOutput(): { stream: OutputStream; text: () => string } {
  const parts: string[] = []
  return {
    stream: { write: (chunk: string) => parts.push(chunk) },
    text: () => parts.join(''),
  }
}

const CREDENTIALS: SshCredentials = {
  host: 'region-44.autodl.com',
  port: 23456,
  user: 'root',
  password: PASSWORD,
}

interface CredsHarness {
  readonly deps: CliDependencies
  readonly stdout: ReturnType<typeof createOutput>
  readonly logLines: string[]
  readonly stateDir: string
  readonly closed: { count: number }
  /** 凭据端口收到的证据目录。 */
  readonly logDirs: string[]
}

async function createHarness(input: {
  readonly credentials?: SshCredentials
  readonly failure?: Error
}): Promise<CredsHarness> {
  const parent = await createTemporaryParent()
  const stateDir = join(parent, 'state')
  const store = createStateStore({
    stateDir,
    configDir: join(parent, 'config'),
    lockTimeoutMs: 2000,
    lockRetryIntervalMs: 2,
  })
  const stdout = createOutput()
  const logLines: string[] = []
  const closed = { count: 0 }
  const logDirs: string[] = []

  const port: CredentialsPort = {
    readCredentials: async () => {
      if (input.failure !== undefined) {
        throw input.failure
      }
      return input.credentials ?? CREDENTIALS
    },
    close: async () => {
      closed.count += 1
    },
  }

  const deps = {
    stateDir,
    clock: { now: () => Date.parse('2026-11-28T11:00:00+08:00'), sleep: async () => undefined },
    logger: {
      info: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
      warn: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
      error: (event: string, fields?: Record<string, unknown>) => {
        logLines.push(JSON.stringify({ event, ...fields }))
      },
    },
    stdout: stdout.stream,
    stderr: createOutput().stream,
    // 与真实装配同形：路径解析走 `commandEvidenceDir`，命令不自己拼。
    commandEvidenceDir: async (command: string, instanceId: string) =>
      await store.resolve(`${command}/${instanceId}`),
    createStateStore: () => store,
  } as unknown as CliDependencies

  return {
    deps,
    stdout,
    logLines,
    stateDir,
    closed,
    logDirs,
    // 端口对象在下面 openCredentials 里被使用，这里不再暴露。
  }
}

/** 读出状态目录下全部文件的文本。目录不存在时返回空。 */
async function readStateFiles(stateDir: string): Promise<string[]> {
  let relativePaths: string[]
  try {
    relativePaths = await readdir(stateDir, { recursive: true })
  } catch {
    return []
  }
  const texts: string[] = []
  for (const relativePath of relativePaths) {
    const absolutePath = join(stateDir, relativePath)
    const info = await stat(absolutePath)
    if (!info.isFile()) {
      continue
    }
    texts.push(await readFile(absolutePath, 'utf8'))
  }
  return texts
}

describe('creds：--json 输出', () => {
  it('stdout 只有一个对象，含 host / port / user / password 四个键', async () => {
    // Arrange
    const harness = await createHarness({})
    const port: CredentialsPort = {
      readCredentials: async () => CREDENTIALS,
      close: async () => undefined,
    }

    // Act
    await runCredsCommand({ deps: harness.deps, json: true }, { instanceId: INSTANCE_ID }, async () => port)

    // Assert
    const lines = harness.stdout.text().split('\n').filter((line) => line.length > 0)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      host: 'region-44.autodl.com',
      port: 23456,
      user: 'root',
      password: PASSWORD,
    })
  })

  it('取凭据失败时关闭凭据通道，错误原样上抛', async () => {
    const harness = await createHarness({})
    let closed = 0
    const port: CredentialsPort = {
      readCredentials: async () => {
        throw new Error('控制台结构已变')
      },
      close: async () => {
        closed += 1
      },
    }

    await expect(
      runCredsCommand({ deps: harness.deps, json: true }, { instanceId: INSTANCE_ID }, async () => port),
    ).rejects.toThrow(/控制台结构已变/)
    expect(closed).toBe(1)
  })

  it('instanceId 为空时抛 ConfigError，不打开凭据通道', async () => {
    const harness = await createHarness({})
    let opened = false

    await expect(
      runCredsCommand({ deps: harness.deps, json: true }, { instanceId: '  ' }, async () => {
        opened = true
        throw new Error('不应打开凭据通道')
      }),
    ).rejects.toBeInstanceOf(ConfigError)
    expect(opened).toBe(false)
  })
})

describe('creds：密码不外泄', () => {
  it('密码不出现在日志与状态目录里，只出现在 stdout', async () => {
    // Arrange
    const harness = await createHarness({})
    const port: CredentialsPort = {
      readCredentials: async () => CREDENTIALS,
      close: async () => undefined,
    }

    // Act
    await runCredsCommand({ deps: harness.deps, json: false }, { instanceId: INSTANCE_ID }, async () => port)

    // Assert：三处互相独立地不出现密码。
    expect(harness.stdout.text()).toContain(PASSWORD)
    expect(harness.logLines.join('\n')).not.toContain(PASSWORD)
    const stateTexts = await readStateFiles(harness.stateDir)
    expect(stateTexts.join('\n')).not.toContain(PASSWORD)
  })
})

describe('creds：人读格式', () => {
  it('不加 --json 时按四行字段打印，密码照样打出来', async () => {
    const harness = await createHarness({})
    const port: CredentialsPort = {
      readCredentials: async () => CREDENTIALS,
      close: async () => undefined,
    }

    await runCredsCommand({ deps: harness.deps, json: false }, { instanceId: INSTANCE_ID }, async () => port)

    expect(harness.stdout.text().split('\n').filter((line) => line.length > 0)).toEqual([
      'host: region-44.autodl.com',
      'port: 23456',
      'user: root',
      `password: ${PASSWORD}`,
    ])
  })

  it('纯函数：字段集合与 SshCredentials 一致，不改写任何值', () => {
    const result = toCredsCommandResult(CREDENTIALS)
    expect(result).toEqual(CREDENTIALS)
    expect(formatCredsHumanReadable(result)[3]).toBe(`password: ${PASSWORD}`)
  })
})
