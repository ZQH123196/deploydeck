import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { TUNNEL_LISTEN_HOST } from '../cli/commands/tunnel.js'
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

/**
 * 转发监听的绑定地址。
 *
 * 判据：`listenHost` 必须真的传给 `net.createServer(...).listen({ host })`。
 * 退化成 `0.0.0.0` 等于把远端服务暴露到整个局域网 —— 而端口转发的本意是
 * 「本机把远端当成本地可信网络」，恰恰是相反的语义。
 *
 * 这里的做法不连 SSH：直接把 `ForwardRequest.listenHost` 喂给 `node:net` 的
 * `server.listen({ host, port })`，用 `server.address()` 读实际绑定地址。
 * 它与 `forwardPortWithSsh2` 内部那句调用同形，所以能独立钉住这条判据。
 */
describe('转发监听地址', () => {
  it('listenHost 传 127.0.0.1 时实际绑定的就是回环地址', async () => {
    // Arrange
    const server = createServer()

    // Act
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: TUNNEL_LISTEN_HOST, port: 0 }, () => {
        resolve()
      })
    })
    const address = server.address()

    // Assert
    expect(address).not.toBeNull()
    expect(typeof address).toBe('object')
    if (typeof address === 'object' && address !== null) {
      expect(address.address).toBe('127.0.0.1')
      expect(address.family).toBe('IPv4')
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })

  it('监听 0.0.0.0 时 address 会暴露成通配地址：这条判据能识别出错误的 host', async () => {
    // 反例：同样的读法读 `0.0.0.0`，得到的是通配地址而不是回环。
    // 这条用例保证前一条不是「无论传什么都读到 127.0.0.1」的假绿。
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '0.0.0.0', port: 0 }, () => {
        resolve()
      })
    })
    const address = server.address()

    if (typeof address === 'object' && address !== null) {
      expect(address.address).not.toBe('127.0.0.1')
      expect(address.address).toBe('0.0.0.0')
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  })
})
