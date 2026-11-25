import { describe, expect, it } from 'vitest'
import { GPU_SPEC_ID_TO_PAGE_MODEL, resolveGpuModelPageName, stripGpuAvailability } from './gpu-models.js'

describe('GPU 型号映射', () => {
  it('把 Profile 的规格 id 映射成选主机页的型号名', () => {
    expect(GPU_SPEC_ID_TO_PAGE_MODEL).toEqual({
      'v-48g': 'vGPU-48GB',
      'v-32g-p': 'vGPU-32GB',
      '5090-p': 'RTX 5090',
      'pro6000-p': 'RTX PRO 6000',
      'v-48g-350w': 'vGPU-48GB-350W',
      h800: 'H800',
      '4090D': 'RTX 4090D',
    })
    expect(resolveGpuModelPageName('v-48g')).toBe('vGPU-48GB')
    expect(resolveGpuModelPageName('v-32g-p')).toBe('vGPU-32GB')
    expect(resolveGpuModelPageName('5090-p')).toBe('RTX 5090')
    expect(resolveGpuModelPageName('pro6000-p')).toBe('RTX PRO 6000')
    expect(resolveGpuModelPageName('v-48g-350w')).toBe('vGPU-48GB-350W')
    expect(resolveGpuModelPageName('h800')).toBe('H800')
    expect(resolveGpuModelPageName('4090D')).toBe('RTX 4090D')
  })

  it('表外的取值按页面显示名原样返回，不猜', () => {
    expect(resolveGpuModelPageName('RTX PRO 5000')).toBe('RTX PRO 5000')
    expect(resolveGpuModelPageName('  vGPU-8GB  ')).toBe('vGPU-8GB')
  })

  it('去掉页面型号文字里的可用数括号', () => {
    expect(stripGpuAvailability('vGPU-32GB (128/2510)')).toBe('vGPU-32GB')
    expect(stripGpuAvailability('PRO 6000 Max-Q (0/8)')).toBe('PRO 6000 Max-Q')
    expect(stripGpuAvailability('全部')).toBe('全部')
  })
})
