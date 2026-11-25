import { describe, expect, it } from 'vitest'
import { ConfigError } from '../errors.js'
import { assertPositiveInteger, isErrnoCode, isInsideOrEqual } from './validate.js'

/**
 * 共享入参校验。这些判据原先分散在多个文件里各写一份，本文件锁住统一后的语义。
 */

describe('isInsideOrEqual', () => {
  it('目录内的路径为真，目录本身也为真', () => {
    expect(isInsideOrEqual('/state', '/state/runs/run-1')).toBe(true)
    expect(isInsideOrEqual('/state', '/state')).toBe(true)
  })

  it('目录外与 .. 越界为假', () => {
    expect(isInsideOrEqual('/state', '/state2/runs')).toBe(false)
    expect(isInsideOrEqual('/state', '/state/../etc')).toBe(false)
    expect(isInsideOrEqual('/state', '/etc/passwd')).toBe(false)
  })

  it('相对路径按当前工作目录归一后比较', () => {
    expect(isInsideOrEqual('.', './tmp/file')).toBe(true)
    expect(isInsideOrEqual('.', '../outside')).toBe(false)
  })
})

describe('assertPositiveInteger', () => {
  it('正整数通过', () => {
    expect(() => assertPositiveInteger(1, 'timeoutMs')).not.toThrow()
    expect(() => assertPositiveInteger(600, 'timeoutMs')).not.toThrow()
  })

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    '非法值 %s 抛 ConfigError 并带参数名',
    (value) => {
      let caught: unknown
      try {
        assertPositiveInteger(value, 'timeoutMs')
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ConfigError)
      if (!(caught instanceof ConfigError)) {
        throw new Error('期望抛出 ConfigError')
      }
      expect(caught.message).toContain('timeoutMs')
      expect(caught.exitCode).toBe(2)
    },
  )
})

describe('isErrnoCode', () => {
  it('带 code 字段的错误对象命中', () => {
    expect(isErrnoCode(Object.assign(new Error('missing'), { code: 'ENOENT' }), 'ENOENT')).toBe(true)
  })

  it('码不同、非对象、缺字段一律不命中', () => {
    expect(isErrnoCode(Object.assign(new Error('exists'), { code: 'EEXIST' }), 'ENOENT')).toBe(false)
    expect(isErrnoCode(null, 'ENOENT')).toBe(false)
    expect(isErrnoCode('ENOENT', 'ENOENT')).toBe(false)
    expect(isErrnoCode(new Error('missing'), 'ENOENT')).toBe(false)
  })
})
