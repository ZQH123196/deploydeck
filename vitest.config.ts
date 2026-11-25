import { defineConfig } from 'vitest/config'

/**
 * 常规单测配置。
 *
 * 判据（AGENTS.md 测试规范）：耗费测试必须与常规测试分开跑。
 * 这里只收 `src/**\/*.spec.ts`，真机测试在 `e2e/` 下，走 `vitest.e2e.config.ts`。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
})
