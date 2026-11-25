import { describe, expect, it } from 'vitest'
import { toOpenSshSha256Fingerprint } from './ssh-channel.js'

/**
 * 测试向量由 `ssh-keygen -t ed25519` 生成，再用 `ssh-keygen -lf` 读出指纹。
 * 这样断言的是「OpenSSH 认的指纹」，不是「本仓库自己算的另一个值」。
 *
 * 不连真实 SSH：这里只做纯函数换算。
 */
const ED25519_PUBLIC_KEY_BASE64 =
  'AAAAC3NzaC1lZDI1NTE5AAAAIOdXIiMwAi6ZLkPY/Odu5/wpWpkLyCSGirhbOxtUtIaI'
const ED25519_FINGERPRINT = 'SHA256:Xj/Np9j64gqMrleztS4IWQ3HP70HBl11h0rajMvQJpM'

describe('主机密钥指纹', () => {
  it('ssh2 给出的公钥字节换成 OpenSSH 的 SHA256 指纹', () => {
    const hostPublicKey = Buffer.from(ED25519_PUBLIC_KEY_BASE64, 'base64')

    expect(toOpenSshSha256Fingerprint(hostPublicKey)).toBe(ED25519_FINGERPRINT)
  })

  it('同一公钥的指纹稳定，不同公钥的指纹不同', () => {
    const first = toOpenSshSha256Fingerprint(Buffer.from('host-key-one'))
    const second = toOpenSshSha256Fingerprint(Buffer.from('host-key-one'))
    const other = toOpenSshSha256Fingerprint(Buffer.from('host-key-two'))

    expect(first).toBe(second)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
  })
})
