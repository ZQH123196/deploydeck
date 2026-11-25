import { defineConfig } from 'vitest/config'

/**
 * 真机耗费测试配置。
 *
 * 判据（AGENTS.md 测试规范 4.1）：耗费测试要花钱，必须与常规测试分开，
 * 且默认不跑。入口是 `pnpm test:e2e`，先过 `e2e/support/gate.ts` 的授权闸门。
 *
 * 串行执行：真机测试会开关机、克隆、释放，任何并行都会互相干扰。
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    fileParallelism: false,
    // 克隆一次约 7 分钟，单个用例的超时给到 45 分钟；钩子同理。
    testTimeout: 45 * 60 * 1000,
    hookTimeout: 30 * 60 * 1000,
    // 真机测试的输出要一眼看得出在做什么，不做静默。
    reporters: ['verbose'],
  },
})
