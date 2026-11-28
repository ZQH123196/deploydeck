import { runLoginCommand } from '../../console/login.js'
import { writeJson, writeLine } from '../output.js'
import type { CommandContext } from './shared.js'

export interface LoginCommandOptions {
  /** 等待人在专用窗口完成登录的秒数。 */
  readonly timeoutSeconds: number
}

/**
 * `login`：打开专用 Chrome 窗口，等人登录完成。
 *
 * 判据（spec 第 6.3 节）：页面不再出现登录入口才算完成；超时抛 `LoginRequiredError`（退出码 2）。
 * 不填账号密码，不保存任何凭据。
 */
export async function runLoginCommandWithDependencies(
  context: CommandContext,
  options: LoginCommandOptions,
): Promise<void> {
  const session = await context.deps.openConsoleSession()
  try {
    const result = await runLoginCommand({
      channel: session.channel,
      consoleUrl: context.deps.consoleUrl,
      timeoutMs: options.timeoutSeconds * 1000,
      clock: context.deps.clock,
      onWaitStart: ({ timeoutMs }) => {
        // 界面命令要给可见反馈：不给提示时，等 300 秒看起来就是卡住了。
        writeLine(
          context.deps.stderr,
          `已打开专用 Chrome 窗口，请在窗口里完成 AutoDL 登录。` +
            `最多等待 ${String(Math.round(timeoutMs / 1000))} 秒。`,
        )
      },
    })
    if (context.json) {
      writeJson(context.deps.stdout, result)
      return
    }
    writeLine(
      context.deps.stdout,
      `登录完成：${result.url}（耗时 ${String(result.elapsedMs)}ms）`,
    )
  } finally {
    await session.close()
  }
}
