/**
 * 算力规格 id 与选主机页 GPU 型号显示名的映射。
 *
 * Profile 的 `gpuPreference` 用 AutoDL 的算力规格 id（如 `v-48g`），选主机页
 * 显示的是型号名（如 `vGPU-48GB`）。两者不是同一套字面量，必须有映射。
 *
 * 来源是《容器实例Pro API》附录的「GPU型号和算力规格ID对应表」
 * （docs/refs/autodl/instance_pro_api.md），逐条与选主机页实测型号清单对照：
 *
 * ```text
 * 文档前台型号   文档规格名   文档规格 id     选主机页显示名     对照依据
 * 4090-48G       通用型       v-48g          vGPU-48GB          48GB 显存唯一
 * 4080(S)-32G    性能型       v-32g-p        vGPU-32GB          32GB 显存唯一
 * 5090-32G       性能型       5090-p         RTX 5090           型号名一致
 * PRO6000-96G    性能型       pro6000-p      RTX PRO 6000       型号名一致
 * 3090-48G       通用型       v-48g-350w     vGPU-48GB-350W     350W 后缀唯一
 * H800-80G       通用型       h800           H800               型号名一致
 * 4090D          通用型       4090D          RTX 4090D          型号名一致
 * ```
 *
 * 判据：映射只收上表七条。表外取值一律不猜，Profile 可以直接写页面显示的型号名
 * （如 `RTX PRO 5000`），由 `resolveGpuModelPageName` 原样返回，交给页面匹配裁决。
 * 映射写错会安静地租到另一档 GPU，所以宁可匹配失败把页面可选型号报出来。
 */
export const GPU_SPEC_ID_TO_PAGE_MODEL: Readonly<Record<string, string>> = {
  'v-48g': 'vGPU-48GB',
  'v-32g-p': 'vGPU-32GB',
  '5090-p': 'RTX 5090',
  'pro6000-p': 'RTX PRO 6000',
  'v-48g-350w': 'vGPU-48GB-350W',
  h800: 'H800',
  '4090D': 'RTX 4090D',
}

/**
 * 去掉页面型号文字里的「(空闲/总数)」，得到型号名。
 *
 * 复选框原文形如 `vGPU-32GB (128/2510)`，括号里是可用数与总数。
 */
export function stripGpuAvailability(text: string): string {
  return text
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 把 Profile 的优先级项解析成页面型号名。
 *
 * 先查规格 id 映射表；没收录的按原样当作页面显示名，交给页面匹配裁决。
 */
export function resolveGpuModelPageName(preference: string): string {
  const trimmed = preference.trim()
  return GPU_SPEC_ID_TO_PAGE_MODEL[trimmed] ?? trimmed
}
