import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../errors.js'
import { copyChromeProfile } from '../../e2e/support/profile-copy.js'

/**
 * profile 副本的判据。
 *
 * 本文件只操作本仓 `.tmp/` 下的临时目录，不碰真实 Chrome profile，不启动任何进程。
 */

/** 每次用例一个独立目录，互不干扰，也便于失败后回查。 */
function workPath(name: string): string {
  return join(
    process.cwd(),
    '.tmp',
    'profile-copy-test',
    `${name}-${String(Math.random()).slice(2, 8)}`,
  )
}

/** 造一个主 profile：登录态必要文件 + 体积大但与登录无关的内容。 */
async function createFakeProfile(dir: string): Promise<void> {
  await mkdir(join(dir, 'Default', 'Local Storage', 'leveldb'), { recursive: true })
  await writeFile(join(dir, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'token=logged-in')
  await writeFile(join(dir, 'Default', 'Cookies'), 'cookie-bytes')
  await writeFile(join(dir, 'Default', 'Preferences'), '{"profile":{"name":"x"}}')
  await writeFile(join(dir, 'Local State'), '{"profile":{}}')
  // 与登录无关的重目录：真实 profile 里它们占 250 MB 的绝大部分。
  await mkdir(join(dir, 'Default', 'Cache'), { recursive: true })
  await writeFile(join(dir, 'Default', 'Cache', 'data_3'), 'x'.repeat(1024))
  await mkdir(join(dir, 'Default', 'Web Applications'), { recursive: true })
  await writeFile(join(dir, 'Default', 'Web Applications', 'icon'), 'icon')
  await mkdir(join(dir, 'optimization_guide_model_store'), { recursive: true })
  await writeFile(join(dir, 'optimization_guide_model_store', 'model.tflite'), 'model')
  await mkdir(join(dir, 'component_crx_cache'), { recursive: true })
  await writeFile(join(dir, 'component_crx_cache', 'blob'), 'blob')
}

describe('复制主 profile 作为 e2e 副本', () => {
  it('只复制登录态必要文件，大目录与缓存一律跳过', async () => {
    const source = workPath('src')
    const destination = workPath('dst')
    await createFakeProfile(source)

    const result = await copyChromeProfile(source, destination)

    // 判据：副本要带着登录态，测试才能直接用。
    expect(await readFile(join(destination, 'Default', 'Cookies'), 'utf8')).toBe('cookie-bytes')
    expect(
      await readFile(join(destination, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'utf8'),
    ).toBe('token=logged-in')
    expect(await readFile(join(destination, 'Default', 'Preferences'), 'utf8')).toBe(
      '{"profile":{"name":"x"}}',
    )
    expect(await readFile(join(destination, 'Local State'), 'utf8')).toBe('{"profile":{}}')

    // 判据：与登录无关的大目录不复制。真实 profile 250 MB、复制 7 到 12 秒；
    // 只取必要文件约 300 KB、1 秒内。这是「每次运行都复制」能成立的前提。
    await expect(stat(join(destination, 'Default', 'Cache'))).rejects.toThrow()
    await expect(stat(join(destination, 'Default', 'Web Applications'))).rejects.toThrow()
    await expect(stat(join(destination, 'optimization_guide_model_store'))).rejects.toThrow()
    await expect(stat(join(destination, 'component_crx_cache'))).rejects.toThrow()
    // 顶层 Local State 1 项 + Default 下 Cookies / Local Storage / Preferences 3 项。
    expect(result.copiedEntries).toBe(4)
  })

  it('复制是单向的：改副本不会改到主 profile', async () => {
    const source = workPath('src')
    const destination = workPath('dst')
    await createFakeProfile(source)

    await copyChromeProfile(source, destination)
    await writeFile(join(destination, 'Default', 'Cookies'), '测试污染')

    expect(await readFile(join(source, 'Default', 'Cookies'), 'utf8')).toBe('cookie-bytes')
  })

  it('副本目录与主 profile 相同时直接报错', async () => {
    const source = workPath('src')
    await createFakeProfile(source)

    await expect(copyChromeProfile(source, source)).rejects.toThrow(ConfigError)
  })

  it('副本目录已存在且非空时拒绝，不覆盖、不合并', async () => {
    const source = workPath('src')
    const destination = workPath('dst')
    await createFakeProfile(source)
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'stale'), 'leftover')

    await expect(copyChromeProfile(source, destination)).rejects.toThrow(/已存在且非空/)
    expect(await readdir(destination)).toEqual(['stale'])
  })

  it('主 profile 不存在时报错，不创建空的副本冒充登录态', async () => {
    const source = workPath('missing')
    const destination = workPath('dst')

    await expect(copyChromeProfile(source, destination)).rejects.toThrow(/主 profile 目录不存在/)
    await expect(stat(destination)).rejects.toThrow()
  })

  it('主 profile 没有 Default 目录时报错：这份 profile 从没登录过', async () => {
    const source = workPath('src')
    const destination = workPath('dst')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'Local State'), '{}')

    await expect(copyChromeProfile(source, destination)).rejects.toThrow(/没有 Default 目录/)
  })
})
