import { describe, expect, it } from 'vitest'
import { BrowserChannelError, ConsoleParseError } from '../errors.js'
import type { ConsoleChannel } from './ports.js'
import {
  buildNoAnimationScript,
  createCdpChannel,
  selectPageTarget,
  type CdpConnection,
  type CdpPageTarget,
  type CdpTransport,
} from './cdp-channel.js'

/**
 * 本文件只验证通道自身的协议行为：id 关联、超时、重连、求值异常、点击序列。
 * 用假传输，不连真实浏览器、不出网。
 */

interface SentCommand {
  readonly id: number
  readonly method: string
  readonly params: Record<string, unknown>
}

const NO_RESPONSE = Symbol('no-response')
type Responder = (command: SentCommand) => unknown

/** 假连接：记录发出的命令，并可按用例给出的规则回应。 */
class FakeConnection implements CdpConnection {
  readonly commands: SentCommand[] = []
  closed = false
  private messageHandler: ((payload: string) => void) | undefined
  private closeHandler: ((reason: string) => void) | undefined

  constructor(private readonly responder: Responder) {}

  send(payload: string): void {
    const parsed = JSON.parse(payload) as SentCommand
    const command: SentCommand = {
      id: parsed.id,
      method: parsed.method,
      params: parsed.params ?? {},
    }
    this.commands.push(command)
    if (this.closed) {
      return
    }
    const result = this.responder(command)
    if (result !== NO_RESPONSE) {
      this.receive({ id: command.id, result })
    }
  }

  close(): void {
    this.closed = true
  }

  setMessageHandler(handler: (payload: string) => void): void {
    this.messageHandler = handler
  }

  setCloseHandler(handler: (reason: string) => void): void {
    this.closeHandler = handler
  }

  receive(message: unknown): void {
    this.messageHandler?.(JSON.stringify(message))
  }

  respond(id: number, result: unknown): void {
    this.receive({ id, result })
  }

  simulateClose(reason = '测试主动断开'): void {
    this.closeHandler?.(reason)
  }

  findCommands(method: string): readonly SentCommand[] {
    return this.commands.filter((command) => command.method === method)
  }

  findEvaluate(marker: string): SentCommand | undefined {
    return this.commands.find(
      (command) =>
        command.method === 'Runtime.evaluate' &&
        String(command.params['expression']).includes(marker),
    )
  }
}

/** 通道自身的握手命令自动应答：用例只关心自己触发的那几条。 */
const defaultResponder: Responder = (command) => {
  switch (command.method) {
    case 'Runtime.enable':
    case 'Page.enable':
    case 'Page.bringToFront':
    case 'Emulation.setFocusEmulationEnabled':
    case 'Input.dispatchMouseEvent':
    case 'Input.dispatchKeyEvent':
    case 'Input.insertText':
      return {}
    case 'Page.addScriptToEvaluateOnNewDocument':
      return { identifier: 'script-1' }
    case 'Page.navigate':
      return { frameId: 'frame-1' }
    case 'Runtime.evaluate': {
      const expression = String(command.params['expression'] ?? '')
      if (expression.includes('deploydeck-no-animation')) {
        return { result: { value: 'injected' } }
      }
      if (expression === 'location.href') {
        return { result: { value: 'about:blank' } }
      }
      return NO_RESPONSE
    }
    default:
      return NO_RESPONSE
  }
}

function withResponders(...responders: readonly Responder[]): Responder {
  return (command) => {
    for (const responder of responders) {
      const result = responder(command)
      if (result !== NO_RESPONSE) {
        return result
      }
    }
    return NO_RESPONSE
  }
}

interface Fixture {
  readonly channel: ConsoleChannel
  readonly connections: FakeConnection[]
}

function createFixture(options: {
  readonly responder?: Responder
  readonly requestTimeoutMs?: number
  readonly rejectReconnect?: boolean
} = {}): Fixture {
  const connections: FakeConnection[] = []
  const transport: CdpTransport = {
    connect: async () => {
      if (options.rejectReconnect === true && connections.length > 0) {
        throw new BrowserChannelError('测试：拒绝重连')
      }
      const connection = new FakeConnection(options.responder ?? defaultResponder)
      connections.push(connection)
      return connection
    },
  }
  const channel = createCdpChannel({
    resolveWebSocketUrl: async () => 'ws://fake/page',
    transport,
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
  })
  return { channel, connections }
}

function assertDefined<Value>(value: Value | undefined, message: string): Value {
  if (value === undefined) {
    throw new Error(message)
  }
  return value
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('测试等待条件超时')
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1)
    })
  }
}

const sampleRect = { x: 10, y: 20, width: 100, height: 40 }
const sampleViewport = { width: 1280, height: 800 }

function geometryValue(rect: typeof sampleRect): unknown {
  return { rect, viewport: sampleViewport }
}

describe('CDP 浏览器通道', () => {
  it('请求与响应按 id 关联：乱序返回也能各归各位', async () => {
    const fixture = createFixture()
    const first = fixture.channel.evaluate<unknown>('first-expression')
    const second = fixture.channel.evaluate<unknown>('second-expression')
    await waitUntil(() => {
      const connection = fixture.connections[0]
      if (connection === undefined) {
        return false
      }
      return (
        connection.findEvaluate('first-expression') !== undefined &&
        connection.findEvaluate('second-expression') !== undefined
      )
    })

    const connection = assertDefined(fixture.connections[0], '应当已建立连接')
    const firstCommand = assertDefined(connection.findEvaluate('first-expression'), '缺少第一个求值')
    const secondCommand = assertDefined(connection.findEvaluate('second-expression'), '缺少第二个求值')

    // 故意反序回应：id 关联正确时结果不会串。
    connection.respond(secondCommand.id, { result: { value: '第二' } })
    connection.respond(firstCommand.id, { result: { value: '第一' } })

    await expect(first).resolves.toBe('第一')
    await expect(second).resolves.toBe('第二')
  })

  it('单条请求超时时抛通道错误，并作废该请求', async () => {
    const fixture = createFixture({ requestTimeoutMs: 10 })
    const pending = fixture.channel.evaluate('no-answer-expression')

    await expect(pending).rejects.toThrow(/CDP 请求超时（10ms）：Runtime\.evaluate/)

    // 超时后迟到的响应不能再改变任何结果。
    const connection = assertDefined(fixture.connections[0], '应当已建立连接')
    const command = assertDefined(connection.findEvaluate('no-answer-expression'), '缺少求值命令')
    connection.respond(command.id, { result: { value: '迟到' } })
    await expect(pending).rejects.toThrow(BrowserChannelError)
  })

  it('断线后重连一次：同一请求在新连接上重发并成功', async () => {
    const fixture = createFixture()
    const pending = fixture.channel.evaluate<unknown>('survive-expression')
    await waitUntil(() => fixture.connections[0]?.findEvaluate('survive-expression') !== undefined)

    const firstConnection = assertDefined(fixture.connections[0], '应当已建立连接')
    firstConnection.simulateClose()

    await waitUntil(() => fixture.connections.length === 2)
    const secondConnection = assertDefined(fixture.connections[1], '断线后应当重连一次')
    await waitUntil(() => secondConnection.findEvaluate('survive-expression') !== undefined)
    const retried = assertDefined(
      secondConnection.findEvaluate('survive-expression'),
      '重连后应当重发请求',
    )
    secondConnection.respond(retried.id, { result: { value: '重连后成功' } })

    await expect(pending).resolves.toBe('重连后成功')
    expect(fixture.connections).toHaveLength(2)
  })

  it('重连失败时把失败抛给调用方', async () => {
    const fixture = createFixture({ rejectReconnect: true })
    const pending = fixture.channel.evaluate('reconnect-fails-expression')
    await waitUntil(() => fixture.connections[0]?.findEvaluate('reconnect-fails-expression') !== undefined)

    assertDefined(fixture.connections[0], '应当已建立连接').simulateClose()

    await expect(pending).rejects.toThrow('测试：拒绝重连')
  })

  it('页面求值抛异常时，错误信息带页面异常描述', async () => {
    const fixture = createFixture({
      responder: withResponders((command) => {
        if (command.method !== 'Runtime.evaluate') {
          return NO_RESPONSE
        }
        if (!String(command.params['expression']).includes('broken-expression')) {
          return NO_RESPONSE
        }
        return {
          exceptionDetails: {
            text: 'Uncaught',
            exception: { description: 'ReferenceError: foo is not defined' },
          },
        }
      }, defaultResponder),
    })

    await expect(fixture.channel.evaluate('broken-expression')).rejects.toThrow(
      /ReferenceError: foo is not defined/,
    )
  })

  it('点击前先把元素滚进可视区，再用鼠标事件点几何中心', async () => {
    const fixture = createFixture({
      responder: withResponders((command) => {
        if (command.method !== 'Runtime.evaluate') {
          return NO_RESPONSE
        }
        const expression = String(command.params['expression'])
        if (expression.includes('scrollIntoView') || expression.includes('getBoundingClientRect')) {
          return { result: { value: geometryValue(sampleRect) } }
        }
        return NO_RESPONSE
      }, defaultResponder),
    })

    await fixture.channel.click('.el-table__row:nth-child(1) button')

    const connection = assertDefined(fixture.connections[0], '应当已建立连接')
    const scrollCommand = assertDefined(
      connection.commands.find(
        (command) =>
          command.method === 'Runtime.evaluate' &&
          String(command.params['expression']).includes('scrollIntoView'),
      ),
      '点击前应当先执行 scrollIntoView',
    )
    const scrollExpression = String(scrollCommand.params['expression'])
    expect(scrollExpression).toContain("block: 'center'")
    expect(scrollExpression).toContain("inline: 'center'")
    expect(scrollExpression).toContain("behavior: 'instant'")

    const mouseCommands = connection.findCommands('Input.dispatchMouseEvent')
    expect(mouseCommands.map((command) => command.params['type'])).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ])
    const scrollIndex = connection.commands.indexOf(scrollCommand)
    for (const command of mouseCommands) {
      expect(connection.commands.indexOf(command)).toBeGreaterThan(scrollIndex)
    }
    // 几何中心：x = 10 + 100/2，y = 20 + 40/2。
    expect(mouseCommands[0]?.params['x']).toBe(60)
    expect(mouseCommands[0]?.params['y']).toBe(40)
  })

  it('选择器匹配不到元素时立即抛错，不静默等待也不发鼠标事件', async () => {
    const fixture = createFixture({
      responder: withResponders((command) => {
        if (command.method === 'Runtime.evaluate') {
          if (String(command.params['expression']).includes('getBoundingClientRect')) {
            return { result: { value: null } }
          }
        }
        return NO_RESPONSE
      }, defaultResponder),
    })

    await expect(fixture.channel.click('#missing-button')).rejects.toThrow(ConsoleParseError)
    const connection = assertDefined(fixture.connections[0], '应当已建立连接')
    expect(connection.findCommands('Input.dispatchMouseEvent')).toHaveLength(0)
  })

  it('几何退化（过渡停半开）时等到稳定再点', async () => {
    const reads = [geometryValue({ ...sampleRect, height: 0 }), geometryValue(sampleRect)]
    let readIndex = 0
    const fixture = createFixture({
      responder: withResponders((command) => {
        if (command.method !== 'Runtime.evaluate') {
          return NO_RESPONSE
        }
        const expression = String(command.params['expression'])
        if (expression.includes('scrollIntoView')) {
          return { result: { value: geometryValue(sampleRect) } }
        }
        if (expression.includes('getBoundingClientRect')) {
          const value = reads[Math.min(readIndex, reads.length - 1)]
          readIndex += 1
          return { result: { value } }
        }
        return NO_RESPONSE
      }, defaultResponder),
    })

    await fixture.channel.click('.el-dropdown button')

    expect(readIndex).toBeGreaterThanOrEqual(2)
    const connection = assertDefined(fixture.connections[0], '应当已建立连接')
    expect(connection.findCommands('Input.dispatchMouseEvent')).toHaveLength(3)
  })

  it('输入框先清空再写入，并校验写入生效', async () => {
    const fixture = createFixture({
      responder: withResponders((command) => {
        if (command.method === 'Runtime.evaluate') {
          const expression = String(command.params['expression'])
          if (expression.includes('getBoundingClientRect')) {
            return { result: { value: geometryValue(sampleRect) } }
          }
          if (expression.includes('.value')) {
            return { result: { value: '2026-11-25 02:34' } }
          }
        }
        return NO_RESPONSE
      }, defaultResponder),
    })

    await fixture.channel.type('#shutdown-time', '2026-11-25 02:34')

    const connection = assertDefined(fixture.connections[0], '应当已建立连接')
    const keyCommands = connection.findCommands('Input.dispatchKeyEvent')
    expect(keyCommands.map((command) => command.params['key'])).toEqual([
      'a',
      'a',
      'Backspace',
      'Backspace',
    ])
    const insertCommand = assertDefined(
      connection.findCommands('Input.insertText')[0],
      '应当发出 insertText',
    )
    expect(insertCommand.params['text']).toBe('2026-11-25 02:34')
    const insertIndex = connection.commands.indexOf(insertCommand)
    expect(connection.commands.indexOf(keyCommands[2] as SentCommand)).toBeLessThan(insertIndex)
  })

  it('close 可重复调用，关闭后不再发起请求', async () => {
    const fixture = createFixture({
      responder: withResponders((command) => {
        if (
          command.method === 'Runtime.evaluate' &&
          String(command.params['expression']).includes('warmup-expression')
        ) {
          return { result: { value: 'ok' } }
        }
        return NO_RESPONSE
      }, defaultResponder),
    })
    await fixture.channel.evaluate('warmup-expression')
    const connection = assertDefined(fixture.connections[0], '应当已建立连接')

    await fixture.channel.close()
    await fixture.channel.close()

    expect(connection.closed).toBe(true)
    await expect(fixture.channel.evaluate('after-close-expression')).rejects.toThrow(
      /浏览器通道已关闭/,
    )
  })
})

describe('页面脚本', () => {
  it('零时长动画样式在文档创建期挂不上节点时，改在 DOMContentLoaded 重试', () => {
    // 实测：作为新文档预注册脚本执行时 documentElement 可能还不存在，
    // 直接 append 会抛 TypeError，样式静默丢失，动画抑制就失效了。
    const script = buildNoAnimationScript()
    expect(script).toContain('DOMContentLoaded')
    expect(script).toContain('document.head ?? document.documentElement')
    expect(script).toContain('transition-duration: 0s !important')
  })
})

describe('页面标签选择', () => {
  const aboutBlank: CdpPageTarget = {
    id: 'blank',
    url: 'about:blank',
    webSocketDebuggerUrl: 'ws://fake/blank',
  }
  const consolePage: CdpPageTarget = {
    id: 'console',
    url: 'https://www.autodl.com/console/instance/list',
    webSocketDebuggerUrl: 'ws://fake/console',
  }

  it('优先选已在控制台域名下的页面', () => {
    expect(selectPageTarget([aboutBlank, consolePage], consolePage.url)).toBe(consolePage)
  })

  it('没有控制台页面时退回第一个页面', () => {
    expect(selectPageTarget([aboutBlank], consolePage.url)).toBe(aboutBlank)
  })

  it('一个页面都没有时返回 undefined', () => {
    expect(selectPageTarget([], consolePage.url)).toBeUndefined()
  })
})
