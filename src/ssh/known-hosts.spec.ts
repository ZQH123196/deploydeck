import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostKeyChangedError, StateFileInvalidError } from '../errors.js'
import { createKnownHosts } from './known-hosts.js'

/** 合法形状的指纹：SHA256: 加 43 位 base64。 */
const FINGERPRINT_FIRST = `SHA256:${'A'.repeat(43)}`
const FINGERPRINT_SECOND = `SHA256:${'B'.repeat(43)}`

const temporaryParents: string[] = []

afterEach(async () => {
  while (temporaryParents.length > 0) {
    const parent = temporaryParents.pop()
    if (parent !== undefined) {
      await rm(parent, { recursive: true, force: true })
    }
  }
})

async function createKnownHostsFile(): Promise<{ readonly parent: string; readonly filePath: string }> {
  const baseDirectory = join(process.cwd(), '.tmp')
  await mkdir(baseDirectory, { recursive: true })
  const parent = await mkdtemp(join(baseDirectory, 'known-hosts-spec-'))
  temporaryParents.push(parent)
  return { parent, filePath: join(parent, 'ssh-known-hosts.txt') }
}

describe('主机密钥指纹记录', () => {
  it('首次连接：写入人能读的记录，同一指纹再次核对不重复写', async () => {
    const { filePath } = await createKnownHostsFile()
    const knownHosts = createKnownHosts({ filePath })
    const verification = {
      instanceId: 'af9c49bd44-8ee624d7',
      host: 'region-test.autodl.com',
      port: 2222,
      fingerprint: FINGERPRINT_FIRST,
    }

    await knownHosts.verify(verification)
    const afterFirst = await readFile(filePath, 'utf8')
    expect(afterFirst).toContain(FINGERPRINT_FIRST)
    expect(afterFirst).toContain('region-test.autodl.com')
    expect(afterFirst).toContain('af9c49bd44-8ee624d7')
    // 首行是给人看的用法说明：删一行即重新记录。
    expect(afterFirst.split('\n')[0]).toMatch(/^#/)

    await knownHosts.verify(verification)
    const afterSecond = await readFile(filePath, 'utf8')
    expect(afterSecond.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'))).toHaveLength(1)
  })

  it('指纹不一致：抛 HostKeyChangedError（退出码 2），且不自动更新记录', async () => {
    const { filePath } = await createKnownHostsFile()
    const knownHosts = createKnownHosts({ filePath })
    await knownHosts.verify({
      instanceId: 'af9c49bd44-8ee624d7',
      host: 'region-test.autodl.com',
      port: 2222,
      fingerprint: FINGERPRINT_FIRST,
    })

    let caught: unknown
    try {
      await knownHosts.verify({
        instanceId: 'af9c49bd44-8ee624d7',
        host: 'region-test.autodl.com',
        port: 2222,
        fingerprint: FINGERPRINT_SECOND,
      })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HostKeyChangedError)
    expect(caught).toMatchObject({ code: 'HOST_KEY_CHANGED', exitCode: 2 })
    const message = caught instanceof Error ? caught.message : ''
    expect(message).toContain(FINGERPRINT_FIRST)
    expect(message).toContain(FINGERPRINT_SECOND)
    expect(message).toContain(filePath)
    const content = await readFile(filePath, 'utf8')
    expect(content).toContain(FINGERPRINT_FIRST)
    expect(content).not.toContain(FINGERPRINT_SECOND)
  })

  it('手工删掉一行后可按首次连接重新记录', async () => {
    const { filePath } = await createKnownHostsFile()
    const knownHosts = createKnownHosts({ filePath })
    const endpoint = {
      instanceId: 'af9c49bd44-8ee624d7',
      host: 'region-test.autodl.com',
      port: 2222,
    }
    await knownHosts.verify({ ...endpoint, fingerprint: FINGERPRINT_FIRST })

    const content = await readFile(filePath, 'utf8')
    const headerOnly = content
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .join('\n')
    await writeFile(filePath, `${headerOnly}\n`, 'utf8')

    await knownHosts.verify({ ...endpoint, fingerprint: FINGERPRINT_SECOND })
    expect(await readFile(filePath, 'utf8')).toContain(FINGERPRINT_SECOND)
  })

  it('同一端点有多行时以最后一行为准', async () => {
    const { filePath } = await createKnownHostsFile()
    const knownHosts = createKnownHosts({ filePath })
    const endpoint = {
      instanceId: 'af9c49bd44-8ee624d7',
      host: 'region-test.autodl.com',
      port: 2222,
    }
    await knownHosts.verify({ ...endpoint, fingerprint: FINGERPRINT_FIRST })
    // 人工追加一行新指纹等价于「删掉旧行再重记」。
    const content = await readFile(filePath, 'utf8')
    await writeFile(
      filePath,
      `${content}region-test.autodl.com\t2222\t${FINGERPRINT_SECOND}\taf9c49bd44-8ee624d7\t2026-11-25T01:44:02+08:00\n`,
      'utf8',
    )

    await expect(knownHosts.verify({ ...endpoint, fingerprint: FINGERPRINT_SECOND })).resolves.toBeUndefined()
    await expect(knownHosts.verify({ ...endpoint, fingerprint: FINGERPRINT_FIRST })).rejects.toBeInstanceOf(
      HostKeyChangedError,
    )
  })

  it('记录格式非法：抛 StateFileInvalidError 并指出行号', async () => {
    const { filePath } = await createKnownHostsFile()
    await writeFile(filePath, '# 表头\nbroken-line-without-fields\n', 'utf8')

    let caught: unknown
    try {
      await createKnownHosts({ filePath }).verify({
        instanceId: 'af9c49bd44-8ee624d7',
        host: 'region-test.autodl.com',
        port: 2222,
        fingerprint: FINGERPRINT_FIRST,
      })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(StateFileInvalidError)
    expect(caught).toMatchObject({ code: 'STATE_FILE_INVALID', exitCode: 2 })
    expect(caught instanceof Error ? caught.message : '').toContain('第 2 行')
  })
})
