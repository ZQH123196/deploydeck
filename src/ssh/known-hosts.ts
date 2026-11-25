import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HostKeyChangedError, StateFileInvalidError } from '../errors.js'
import { beijingNowIso, parseIso } from '../util/time.js'
import { isErrnoCode } from '../util/validate.js'

/**
 * 主机密钥指纹记录。
 *
 * 目的只有一个：同一个 SSH 端点第二次出现时，主机密钥必须与第一次一致。
 * 不一致时不自动更新，交给人判断是中间人还是实例重建。
 *
 * 文件格式是行式文本，不是 JSON：答案要求人能读、能手工删一行。
 * 删掉某一行即让该端点按首次连接重新记录。
 */

/** 字段分隔符。用制表符：地址里有空格也能一眼分开，手工删行不受影响。 */
const FIELD_SEPARATOR = '\t'
/** 数据行的字段数：主机、端口、指纹、实例、首次记录时刻。 */
const FIELD_COUNT = 5
const COMMENT_PREFIX = '#'

/** 指纹用 OpenSSH 写法，见 ssh-channel.ts 的计算处。 */
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/

const FILE_HEADER = [
  '# deploydeck 主机密钥指纹。一行一个 SSH 端点。',
  '# 字段以制表符分隔：主机、端口、指纹、实例 ID、首次记录时刻。',
  '# 指纹是主机公钥的 sha256，OpenSSH 写法（SHA256: 加 base64 编码）。不得手工改写。',
  '# 删除一行即让该端点按首次连接重新记录。',
].join('\n')

/** 一条已记录的指纹。 */
export interface KnownHostsRecord {
  readonly host: string
  readonly port: number
  /** sha256 指纹，形如 `SHA256:xxxx`。 */
  readonly fingerprint: string
  readonly instanceId: string
  /** 首次记录时刻，北京时间 ISO 串。 */
  readonly recordedAt: string
}

/** 本次连接要核对的事实。 */
export interface HostKeyVerification {
  readonly instanceId: string
  readonly host: string
  readonly port: number
  /** 本次握手拿到的主机公钥 sha256 指纹。 */
  readonly fingerprint: string
}

export interface KnownHostsOptions {
  /** 指纹文件绝对路径。由装配方给出。 */
  readonly filePath: string
}

export interface KnownHosts {
  readonly filePath: string
  /**
   * 核对主机密钥。
   *
   * 端点没有记录时写入记录并放行；已有记录且指纹一致时放行；
   * 已有记录但指纹不一致时抛 `HostKeyChangedError`，绝不自动更新。
   */
  verify(verification: HostKeyVerification): Promise<void>
}

export function createKnownHosts(options: KnownHostsOptions): KnownHosts {
  const filePath = options.filePath
  if (filePath.length === 0) {
    throw new TypeError('known-hosts 文件路径不能为空。')
  }

  async function readRecords(): Promise<readonly KnownHostsRecord[]> {
    let text: string
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error: unknown) {
      // 文件不存在是正常状态：这台机器从没连过任何实例。它不是错误，更不能当成「全部放行」。
      if (isErrnoCode(error, 'ENOENT')) {
        return []
      }
      throw error
    }
    return parseRecords(text, filePath)
  }

  async function appendRecord(record: KnownHostsRecord): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    // 先用 wx 建文件写表头，与另一个进程同时首连时只有一个能建成功，另一个安静跳过。
    try {
      await writeFile(filePath, `${FILE_HEADER}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch (error: unknown) {
      if (!isErrnoCode(error, 'EEXIST')) {
        throw error
      }
    }
    const line = [
      record.host,
      String(record.port),
      record.fingerprint,
      record.instanceId,
      record.recordedAt,
    ].join(FIELD_SEPARATOR)
    // 只追加，不改写：手工删掉的行不会被机器悄悄补回旧指纹。
    await appendFile(filePath, `${line}\n`, 'utf8')
  }

  return {
    filePath,
    async verify(verification: HostKeyVerification): Promise<void> {
      assertVerification(verification)
      const records = await readRecords()
      // 同一端点可能因人工追加留下多行；以最后一行为准，删掉它即可重新记录。
      const lastRecord = records.filter(
        (record) => record.host === verification.host && record.port === verification.port,
      ).at(-1)

      if (lastRecord === undefined) {
        await appendRecord({
          host: verification.host,
          port: verification.port,
          fingerprint: verification.fingerprint,
          instanceId: verification.instanceId,
          recordedAt: beijingNowIso(),
        })
        return
      }

      if (lastRecord.fingerprint === verification.fingerprint) {
        return
      }

      throw new HostKeyChangedError(
        `主机密钥指纹与首次记录不一致：${formatEndpoint(verification.host, verification.port)}。` +
          `已记录 ${lastRecord.fingerprint}` +
          `（实例 ${lastRecord.instanceId}，记录于 ${lastRecord.recordedAt}），` +
          `本次为 ${verification.fingerprint}。` +
          '可能是中间人，也可能是实例已重建。' +
          '确认无风险后，删除下列文件里对应的一行，再重试。' +
          `文件：${filePath}`,
      )
    },
  }
}

function parseRecords(text: string, filePath: string): readonly KnownHostsRecord[] {
  const records: KnownHostsRecord[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').replace(/\r$/, '')
    if (line.trim().length === 0 || line.trimStart().startsWith(COMMENT_PREFIX)) {
      continue
    }
    const location = `主机密钥指纹文件第 ${index + 1} 行（${filePath}）`
    const fields = line.split(FIELD_SEPARATOR)
    if (fields.length !== FIELD_COUNT) {
      throw new StateFileInvalidError(
        `${location}字段数不是 ${FIELD_COUNT}，收到 ${fields.length} 个。` +
          '一行必须依次是：主机、端口、指纹、实例 ID、首次记录时刻，用制表符分隔。',
      )
    }
    const [host = '', portText = '', fingerprint = '', instanceId = '', recordedAt = ''] = fields
    if (host.length === 0 || instanceId.length === 0) {
      throw new StateFileInvalidError(`${location}的主机或实例 ID 为空。`)
    }
    if (!/^\d+$/.test(portText)) {
      throw new StateFileInvalidError(`${location}的端口不是十进制整数：${JSON.stringify(portText)}`)
    }
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new StateFileInvalidError(`${location}的端口越界：${portText}`)
    }
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new StateFileInvalidError(
        `${location}的指纹形状不对：${JSON.stringify(fingerprint)}。` +
          '本文件的指纹一律是 SHA256: 加 43 位 base64 字符，不得手工改写。',
      )
    }
    try {
      parseIso(recordedAt)
    } catch {
      throw new StateFileInvalidError(`${location}的首次记录时刻不是 ISO 时间：${JSON.stringify(recordedAt)}`)
    }
    records.push({ host, port, fingerprint, instanceId, recordedAt })
  }
  return records
}

function assertVerification(verification: HostKeyVerification): void {
  if (verification.host.trim().length === 0) {
    throw new TypeError('主机不能为空。')
  }
  if (!Number.isInteger(verification.port) || verification.port < 1 || verification.port > 65535) {
    throw new RangeError(`端口必须是 1 到 65535 的整数，收到 ${verification.port}。`)
  }
  if (!FINGERPRINT_PATTERN.test(verification.fingerprint)) {
    throw new TypeError(`指纹形状不对：${JSON.stringify(verification.fingerprint)}`)
  }
  if (verification.instanceId.trim().length === 0) {
    throw new TypeError('实例 ID 不能为空。')
  }
}

function formatEndpoint(host: string, port: number): string {
  return `${host}:${port}`
}

