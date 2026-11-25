import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ConfigError,
  StateFileInvalidError,
  StateFileMissingError,
  StateLockTimeoutError,
} from '../errors.js'
import type { StateStore } from './ports.js'
import { createStateStore } from './store.js'
import type { StateStoreOptions } from './store.js'

type OptionOverrides = Partial<
  Pick<StateStoreOptions, 'lockTimeoutMs' | 'lockRetryIntervalMs' | 'now' | 'sleep'>
>

interface StoreFixture {
  readonly parent: string
  readonly stateDir: string
  readonly configDir: string
  readonly store: StateStore
}

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
  const parent = await mkdtemp(join(baseDirectory, 'state-store-spec-'))
  temporaryParents.push(parent)
  return parent
}

function buildOptions(
  stateDir: string,
  configDir: string,
  overrides: OptionOverrides = {},
): StateStoreOptions {
  return {
    stateDir,
    configDir,
    lockTimeoutMs: overrides.lockTimeoutMs ?? 2000,
    lockRetryIntervalMs: overrides.lockRetryIntervalMs ?? 2,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
  }
}

async function createFixture(overrides: OptionOverrides = {}): Promise<StoreFixture> {
  const parent = await createTemporaryParent()
  const stateDir = join(parent, 'state')
  const configDir = join(parent, 'config')
  const store = createStateStore(buildOptions(stateDir, configDir, overrides))
  return { parent, stateDir, configDir, store }
}

describe('原子写', () => {
  it('并发读写时，读者读到的永远是完整文件', async () => {
    const fixture = await createFixture()
    const schema = z.object({ sequence: z.number().int().nonnegative(), payload: z.string() })
    const payload = 'x'.repeat(64 * 1024)
    await fixture.store.writeJson('state.jsonc', { sequence: 0, payload })

    let writing = true
    const writer = (async () => {
      try {
        for (let sequence = 1; sequence <= 30; sequence += 1) {
          await fixture.store.writeJson('state.jsonc', { sequence, payload })
        }
      } finally {
        writing = false
      }
    })()

    const seenSequences: number[] = []
    while (writing) {
      const value = await fixture.store.readJson('state.jsonc', schema)
      // 读到半个文件时 JSON.parse 或 schema 校验会先失败，payload 也会不完整。
      expect(value.payload).toBe(payload)
      seenSequences.push(value.sequence)
    }
    await writer

    expect(seenSequences.length).toBeGreaterThan(0)
    const finalValue = await fixture.store.readJson('state.jsonc', schema)
    expect(finalValue.sequence).toBe(30)
    // 临时文件不残留：同目录下只剩目标文件。
    expect((await readdir(fixture.stateDir)).sort()).toEqual(['state.jsonc'])
  })
})

describe('锁', () => {
  it('同一名字的锁串行化，第二个进入者等第一个释放', async () => {
    const fixture = await createFixture()
    const events: string[] = []

    let notifyFirstEntered: () => void = () => {}
    const firstEntered = new Promise<void>((resolve) => {
      notifyFirstEntered = resolve
    })
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = fixture.store.withLock('serialize', async () => {
      events.push('第一个进入')
      notifyFirstEntered()
      await firstGate
      events.push('第一个退出')
    })
    await firstEntered

    let sleepCalls = 0
    let notifySecondWaiting: () => void = () => {}
    const secondWaiting = new Promise<void>((resolve) => {
      notifySecondWaiting = resolve
    })
    // 第二个存储实例指向同一目录：锁必须跨实例生效，不能是进程内状态。
    const secondStore = createStateStore(
      buildOptions(fixture.stateDir, fixture.configDir, {
        lockTimeoutMs: 5000,
        sleep: async () => {
          sleepCalls += 1
          if (sleepCalls === 1) {
            notifySecondWaiting()
          }
        },
      }),
    )

    const second = secondStore.withLock('serialize', async () => {
      events.push('第二个进入')
    })
    await secondWaiting

    expect(events).toEqual(['第一个进入'])
    releaseFirst()
    await Promise.all([first, second])

    expect(events).toEqual(['第一个进入', '第一个退出', '第二个进入'])
    expect(await readdir(join(fixture.stateDir, 'locks'))).toEqual([])
  })

  it('持锁不放时，第二个调用等到超时后抛错', async () => {
    let clock = 0
    const fixture = await createFixture({
      lockTimeoutMs: 50,
      lockRetryIntervalMs: 10,
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds
      },
    })

    let notifyFirstEntered: () => void = () => {}
    const firstEntered = new Promise<void>((resolve) => {
      notifyFirstEntered = resolve
    })
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = fixture.store.withLock('stuck', async () => {
      notifyFirstEntered()
      await firstGate
    })
    await firstEntered

    let caught: unknown
    try {
      await fixture.store.withLock('stuck', async () => '不会执行')
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StateLockTimeoutError)
    if (!(caught instanceof StateLockTimeoutError)) {
      throw new Error('期望抛出 StateLockTimeoutError')
    }
    expect(caught.code).toBe('STATE_LOCK_TIMEOUT')
    expect(caught.exitCode).toBe(2)
    expect(caught.message).toContain('stuck')
    expect(caught.message).toContain('50ms')

    releaseFirst()
    await first
    expect(await readdir(join(fixture.stateDir, 'locks'))).toEqual([])
  })

  it('锁内动作抛错时仍然释放锁', async () => {
    const fixture = await createFixture()

    await expect(
      fixture.store.withLock('release-on-error', async () => {
        throw new Error('步骤失败')
      }),
    ).rejects.toThrow('步骤失败')

    await expect(
      fixture.store.withLock('release-on-error', async () => '第二次拿到锁'),
    ).resolves.toBe('第二次拿到锁')
  })

  it('锁名含路径分隔符时拒绝', async () => {
    const fixture = await createFixture()
    await expect(fixture.store.withLock('plan/1', async () => undefined)).rejects.toThrow(ConfigError)
  })
})

describe('路径', () => {
  it.each(['../escape.jsonc', 'nested/../../escape.jsonc', '..'])('拒绝越界路径 %s', async (relativePath) => {
    const fixture = await createFixture()

    await expect(fixture.store.resolve(relativePath)).rejects.toThrow(ConfigError)
    await expect(fixture.store.writeJson(relativePath, {})).rejects.toThrow(ConfigError)
    // 状态目录与配置目录都没被创建，写动作在解析阶段就被拦下。
    expect(await readdir(fixture.parent)).toEqual([])
  })

  it.each(['/etc/passwd', join(process.cwd(), 'escape.jsonc')])(
    '拒绝绝对路径 %s',
    async (absolutePath) => {
      const fixture = await createFixture()
      await expect(fixture.store.resolve(absolutePath)).rejects.toThrow(ConfigError)
    },
  )

  it.each(['', '.'])('拒绝不能指向文件的路径 %s', async (relativePath) => {
    const fixture = await createFixture()
    await expect(fixture.store.resolve(relativePath)).rejects.toThrow(ConfigError)
  })

  it('resolve 创建父目录并返回状态目录内的绝对路径', async () => {
    const fixture = await createFixture()

    const resolved = await fixture.store.resolve('runs/run-1/logs/step.log')

    expect(resolved).toBe(join(fixture.stateDir, 'runs', 'run-1', 'logs', 'step.log'))
    expect((await stat(join(fixture.stateDir, 'runs', 'run-1', 'logs'))).isDirectory()).toBe(true)
  })
})

describe('配置目录保护', () => {
  it('写入配置目录内的路径被拒，错误说明配置目录由人写', async () => {
    const parent = await createTemporaryParent()
    const stateDir = join(parent, 'state')
    // 配置目录嵌在状态目录内：只有这种布局才能用不含 .. 的相对路径命中配置目录。
    const configDir = join(stateDir, 'config')
    const store = createStateStore(buildOptions(stateDir, configDir))

    let caught: unknown
    try {
      await store.writeJson('config/profiles/deploydeck.jsonc', { id: 'deploydeck' })
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigError)
    if (!(caught instanceof ConfigError)) {
      throw new Error('期望抛出 ConfigError')
    }
    expect(caught.message).toContain('配置目录由人写，机器只读')
    expect(caught.message).toContain(configDir)
    await expect(stat(join(configDir, 'profiles', 'deploydeck.jsonc'))).rejects.toThrow()
  })

  it('状态目录落在配置目录内时拒绝构造', async () => {
    const parent = await createTemporaryParent()
    const configDir = join(parent, 'config')
    const stateDir = join(configDir, 'state')

    let caught: unknown
    try {
      createStateStore(buildOptions(stateDir, configDir))
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ConfigError)
    if (!(caught instanceof ConfigError)) {
      throw new Error('期望抛出 ConfigError')
    }
    expect(caught.message).toContain('状态目录不能位于配置目录内')
  })
})

describe('读取', () => {
  it('读取不存在的状态文件时报错，不返回空值', async () => {
    const fixture = await createFixture()

    await expect(fixture.store.readJson('missing.jsonc', z.object({}))).rejects.toThrow(
      StateFileMissingError,
    )
    await expect(fixture.store.readJsonLines('missing.jsonl', z.object({}))).rejects.toThrow(
      StateFileMissingError,
    )
  })

  it('文件不是合法 JSONC 时报错', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.stateDir, { recursive: true })
    await writeFile(join(fixture.stateDir, 'broken.jsonc'), '{ 半截', 'utf8')

    await expect(fixture.store.readJson('broken.jsonc', z.object({}))).rejects.toThrow(
      StateFileInvalidError,
    )
  })

  it('内容不符合 schema 时报错并指出文件', async () => {
    const fixture = await createFixture()
    await fixture.store.writeJson('wrong.jsonc', { count: '不是数字' })
    const schema = z.object({ count: z.number() })

    let caught: unknown
    try {
      await fixture.store.readJson('wrong.jsonc', schema)
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StateFileInvalidError)
    if (!(caught instanceof StateFileInvalidError)) {
      throw new Error('期望抛出 StateFileInvalidError')
    }
    expect(caught.message).toContain('wrong.jsonc')
  })

  it('读取时容忍人工注释，机器重写后注释消失', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.stateDir, { recursive: true })
    const filePath = join(fixture.stateDir, 'plan.jsonc')
    await writeFile(
      filePath,
      '{\n  // 人工注释：本轮按八折预算\n  "budgetCapYuan": 10\n}\n',
      'utf8',
    )
    const schema = z.object({ budgetCapYuan: z.number() })

    expect(await fixture.store.readJson('plan.jsonc', schema)).toEqual({ budgetCapYuan: 10 })

    await fixture.store.writeJson('plan.jsonc', { budgetCapYuan: 10 })
    expect(await readFile(filePath, 'utf8')).not.toContain('人工注释')
  })
})

describe('JSONL', () => {
  it('追加后可按 schema 读回全部行', async () => {
    const fixture = await createFixture()
    const schema = z.object({ name: z.string(), count: z.number() })

    await fixture.store.appendJsonLine('events.jsonl', { name: '甲', count: 1 })
    await fixture.store.appendJsonLine('events.jsonl', { name: '乙', count: 2 })

    expect(await fixture.store.readJsonLines('events.jsonl', schema)).toEqual([
      { name: '甲', count: 1 },
      { name: '乙', count: 2 },
    ])
  })

  it('某行内容非法时报出行号', async () => {
    const fixture = await createFixture()
    await mkdir(fixture.stateDir, { recursive: true })
    await writeFile(join(fixture.stateDir, 'bad.jsonl'), '{"ok":true}\n不是JSON\n', 'utf8')

    let caught: unknown
    try {
      await fixture.store.readJsonLines('bad.jsonl', z.object({ ok: z.boolean() }))
    } catch (error: unknown) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StateFileInvalidError)
    if (!(caught instanceof StateFileInvalidError)) {
      throw new Error('期望抛出 StateFileInvalidError')
    }
    expect(caught.message).toContain('第 2 行')
  })
})

describe('构造期校验', () => {
  it('锁超时不是正数时拒绝构造', async () => {
    const parent = await createTemporaryParent()
    const stateDir = join(parent, 'state')
    const configDir = join(parent, 'config')

    expect(() => createStateStore(buildOptions(stateDir, configDir, { lockTimeoutMs: 0 }))).toThrow(
      ConfigError,
    )
  })
})
