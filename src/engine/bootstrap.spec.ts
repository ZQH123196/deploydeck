import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { resolveDeclaredEnv } from '../config/paths.js'
import { ConfigError } from '../errors.js'
import { createStateStore } from '../state/store.js'
import {
  bootstrapRecordPath,
  readBootstrapState,
  writeBootstrapRecord,
  BOOTSTRAP_DIRECTORY,
  type BootstrapIdentity,
} from './bootstrap.js'

/**
 * 一次性引导记录的用例。
 *
 * 判据（工单 B3）：引导只在实例首次就绪时跑一次，重启不重跑。
 * 「跑过没有」是落盘事实，不是进程内存状态。
 *
 * 用 `.tmp/` 下的真实临时状态目录：状态存储本身是薄封装，这里验证的是落点与判定，
 * 不连数据库、不出网。
 */

const temporaryDirectories: string[] = []

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

async function createFixture(): Promise<{
  readonly root: string
  readonly createStore: () => ReturnType<typeof createStateStore>
}> {
  const base = join(process.cwd(), '.tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'bootstrap-spec-'))
  temporaryDirectories.push(root)
  return {
    root,
    createStore: () =>
      createStateStore({
        stateDir: root,
        configDir: join(root, 'config'),
        lockTimeoutMs: 5_000,
        lockRetryIntervalMs: 5,
      }),
  }
}

function makeIdentity(overrides: Partial<BootstrapIdentity> = {}): BootstrapIdentity {
  return {
    instanceId: 'af9c49bd44-8ee624d7',
    profileId: 'trans-dev',
    projectId: 'trans-app',
    script: 'scripts/bootstrap.sh',
    ...overrides,
  }
}

describe('引导记录落点', () => {
  it('落在 bootstrap/<instanceId>.jsonc', () => {
    expect(bootstrapRecordPath('af9c49bd44-8ee624d7')).toBe(
      `${BOOTSTRAP_DIRECTORY}/af9c49bd44-8ee624d7.jsonc`,
    )
  })

  it('实例 ID 含路径分隔符时拒绝，不写到状态目录之外', () => {
    expect(() => bootstrapRecordPath('../../etc/passwd')).toThrow(ConfigError)
    expect(() => bootstrapRecordPath('a/b')).toThrow(ConfigError)
  })
})

describe('引导是否跑过的判定', () => {
  it('没有记录时判为没跑过', async () => {
    const fixture = await createFixture()
    const store = fixture.createStore()

    const state = await readBootstrapState(store, makeIdentity())

    expect(state).toEqual({ kind: 'not-run', reason: 'no-record' })
  })

  it('记录存在且身份一致时判为已跑过', async () => {
    const fixture = await createFixture()
    const store = fixture.createStore()
    await writeBootstrapRecord(store, {
      ...makeIdentity(),
      finishedAt: '2026-01-01T00:00:00+08:00',
      exitCode: 0,
    })

    const state = await readBootstrapState(store, makeIdentity())

    expect(state.kind).toBe('done')
  })

  it('换了部署配置时判为没跑过：老记录不能当这个配置已经装好了', async () => {
    const fixture = await createFixture()
    const store = fixture.createStore()
    await writeBootstrapRecord(store, {
      ...makeIdentity(),
      finishedAt: '2026-01-01T00:00:00+08:00',
      exitCode: 0,
    })

    const state = await readBootstrapState(store, makeIdentity({ profileId: 'other-profile' }))

    expect(state).toEqual({ kind: 'not-run', reason: 'identity-mismatch' })
  })

  it('换了引导脚本时判为没跑过', async () => {
    const fixture = await createFixture()
    const store = fixture.createStore()
    await writeBootstrapRecord(store, {
      ...makeIdentity(),
      finishedAt: '2026-01-01T00:00:00+08:00',
      exitCode: 0,
    })

    const state = await readBootstrapState(store, makeIdentity({ script: 'scripts/v2.sh' }))

    expect(state).toEqual({ kind: 'not-run', reason: 'identity-mismatch' })
  })

  it('退出码不为 0 的记录写不进去：失败的引导必须能重跑', async () => {
    const fixture = await createFixture()
    const store = fixture.createStore()

    await expect(
      writeBootstrapRecord(store, {
        ...makeIdentity(),
        finishedAt: '2026-01-01T00:00:00+08:00',
        exitCode: 1,
      }),
    ).rejects.toBeInstanceOf(ConfigError)

    expect(await readBootstrapState(store, makeIdentity())).toEqual({
      kind: 'not-run',
      reason: 'no-record',
    })
  })
})

describe('读取本机环境变量', () => {
  it('按声明的变量名取值', () => {
    const resolved = resolveDeclaredEnv({ MY_TOKEN: 'ignored' }, '测试配置', {
      MY_TOKEN: 's3cret-value',
    })

    expect(resolved).toEqual({ MY_TOKEN: 's3cret-value' })
  })

  it('本机缺变量时抛错，并列出全部缺失项，不静默落空', () => {
    const error = (() => {
      try {
        resolveDeclaredEnv(
          { PRESENT: 'p', MISSING_A: 'a', MISSING_B: 'b' },
          '部署配置 trans-dev 的 env',
          { PRESENT: 'v' },
        )
        return undefined
      } catch (caught: unknown) {
        return caught
      }
    })()

    expect(error).toBeInstanceOf(ConfigError)
    const message = (error as Error).message
    expect(message).toContain('MISSING_A')
    expect(message).toContain('MISSING_B')
    expect(message).not.toContain('PRESENT')
    // 定义里写的「用途说明」不是取值来源。
    expect(message).not.toContain('p')
  })

  it('本机变量是空串时算缺失，不把空串当有值', () => {
    expect(() => resolveDeclaredEnv({ EMPTY: 'x' }, '测试配置', { EMPTY: '' })).toThrow(ConfigError)
  })

  it('没有声明任何变量时返回空对象', () => {
    expect(resolveDeclaredEnv({}, '测试配置', {})).toEqual({})
  })
})
