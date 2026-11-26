#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Command, CommanderError } from 'commander'
import {
  DeploydeckError,
  EXIT_BUSINESS_FAILURE,
  EXIT_OK,
  NotImplementedError,
  type ExitCode,
} from '../errors.js'
import { createRealCliDependencies, type CliDependencies } from './dependencies.js'
import { DEFAULT_GUARD_INTERVAL_MINUTES, runGuardCommand } from './commands/guard.js'
import type { CommandContext } from './commands/shared.js'
import { runLoginCommandWithDependencies } from './commands/login.js'
import { DEFAULT_LOGIN_TIMEOUT_SECONDS } from '../console/login.js'
import { runPlanCreateCommand, runPlanShowCommand } from './commands/plan.js'
import { runProfileListCommand } from './commands/profile-list.js'
import { runRunCommand } from './commands/run.js'
import { readPositiveIntegerOption } from './commands/shared.js'
import { runStatusCommand } from './commands/status.js'
import { runTeardownCommand } from './commands/teardown.js'
import { writeLine } from './output.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

/**
 * CLI 入口。
 *
 * 本文件只做参数解析、输出与退出码映射。命令的业务逻辑在 `commands/`，
 * 外部依赖在 `dependencies.ts` 注入。
 *
 * 退出码：0 成功、1 业务失败、2 需要人工。错误的 `exitCode` 由错误类自带，
 * 这里只做透传，不另建映射表。
 */

/** 读 `--json`。它既可写在根命令上，也可写在具体命令上；两处都认。 */
function isJsonMode(command: Command): boolean {
  let current: Command | null = command
  while (current !== null) {
    if (current.opts()['json'] === true) {
      return true
    }
    current = current.parent
  }
  return false
}

/** 给叶子命令加 `--json`。根命令也有同一选项，位置不同都要能识别。 */
function withJsonOption(command: Command): Command {
  return command.option('--json', '输出机器可读 JSON')
}

function contextOf(deps: CliDependencies, command: Command): CommandContext {
  return { deps, json: isJsonMode(command) }
}

function registerProfileCommands(program: Command, deps: CliDependencies): void {
  const profileCommand = program.command('profile').description('查看部署配置')
  withJsonOption(profileCommand.command('list').description('列出全部部署配置')).action(
    async (_options: unknown, command: Command) => {
      await runProfileListCommand(contextOf(deps, command))
    },
  )
}

function registerPlanCommands(program: Command, deps: CliDependencies): void {
  const planCommand = program.command('plan').description('管理部署计划')

  withJsonOption(
    planCommand
      .command('create')
      .description('创建一份计划。给出使用时长与预算上限。')
      .requiredOption('--profile <id>', '部署配置 id')
      .option('--ttl <minutes>', '覆盖配置里的可用分钟数')
      .option('--budget <yuan>', '覆盖配置里的预算上限'),
  ).action(
    async (
      commandOptions: { readonly profile: string; readonly ttl?: string; readonly budget?: string },
      command: Command,
    ) => {
      await runPlanCreateCommand(contextOf(deps, command), commandOptions)
    },
  )

  withJsonOption(
    planCommand
      .command('show [planId]')
      .description('查看计划。不带参数时列出全部生效计划，带参数时显示单份。')
      .option('--balance', '读取账户余额。不带时输出里明确写「余额未读取」'),
  ).action(
    async (
      planId: string | undefined,
      commandOptions: { readonly balance?: boolean },
      command: Command,
    ) => {
      await runPlanShowCommand(contextOf(deps, command), planId, {
        balance: commandOptions.balance === true,
      })
    },
  )

  planCommand
    .command('extend <planId>')
    .description('延长计划。必须显式调用。')
    .requiredOption('--minutes <n>', '延长的分钟数')
    .action(() => {
      throw new NotImplementedError('plan extend：计划续期尚未实现')
    })
}

function registerRunCommands(program: Command, deps: CliDependencies): void {
  withJsonOption(
    program
      .command('run')
      .description('在生效计划下执行部署。用 --plan 指定计划，或用 --profile 找该配置的生效计划。')
      .option('--plan <planId>', '计划 id')
      .option('--profile <profileId>', '部署配置 id。只在已有生效计划时可用')
      .option(
        '--create-plan',
        '允许 --profile 在没有生效计划时新建一份。显式授权开关，默认不建',
      )
      .option('--commit <sha>', '指定 commit。配置要求锁定 commit 时必填')
      .option('--run-id <id>', '指定执行 id。测试注入固定值用；默认由 CLI 生成'),
  ).action(
    async (
      commandOptions: {
        readonly plan?: string
        readonly profile?: string
        readonly commit?: string
        readonly runId?: string
        readonly createPlan?: boolean
      },
      command: Command,
    ) => {
      await runRunCommand(contextOf(deps, command), {
        ...(commandOptions.plan === undefined ? {} : { plan: commandOptions.plan }),
        ...(commandOptions.profile === undefined ? {} : { profile: commandOptions.profile }),
        ...(commandOptions.commit === undefined ? {} : { commit: commandOptions.commit }),
        ...(commandOptions.runId === undefined ? {} : { runId: commandOptions.runId }),
        createPlan: commandOptions.createPlan === true,
      })
    },
  )

  withJsonOption(program.command('status').description('查看生效计划、实例状态与花费')).action(
    async (_options: unknown, command: Command) => {
      await runStatusCommand(contextOf(deps, command))
    },
  )

  withJsonOption(
    program.command('teardown <planId>').description('销毁计划绑定的实例，并确认实例消失'),
  ).action(async (planId: string, _options: unknown, command: Command) => {
    await runTeardownCommand(contextOf(deps, command), planId)
  })

  withJsonOption(
    program
      .command('guard')
      .description('前台常驻守护：巡检过期计划、预算熔断与账户余额')
      .option(
        '--interval-minutes <n>',
        '巡检间隔分钟数',
        String(DEFAULT_GUARD_INTERVAL_MINUTES),
      )
      .option('--once', '只巡一轮就退出，供测试与人工排查用'),
  ).action(
    async (
      commandOptions: { readonly intervalMinutes?: string; readonly once?: boolean },
      command: Command,
    ) => {
      const intervalMinutes = readPositiveIntegerOption(
        commandOptions.intervalMinutes ?? String(DEFAULT_GUARD_INTERVAL_MINUTES),
        '--interval-minutes',
      )
      await runGuardCommand(contextOf(deps, command), {
        intervalMinutes,
        once: commandOptions.once === true,
      })
    },
  )

  program.command('ledger').description('查看账本').action(() => {
    throw new NotImplementedError('ledger：账本读取命令尚未实现，请直接读状态目录的 ledger.jsonl')
  })
}

function registerLoginCommand(program: Command, deps: CliDependencies): void {
  withJsonOption(
    program
      .command('login')
      .description('打开专用 Chrome 窗口，等待登录完成')
      .option('--timeout <seconds>', '等待登录完成的秒数', String(DEFAULT_LOGIN_TIMEOUT_SECONDS)),
  ).action(
    async (commandOptions: { readonly timeout?: string }, command: Command) => {
      const timeoutSeconds = readPositiveIntegerOption(
        commandOptions.timeout ?? String(DEFAULT_LOGIN_TIMEOUT_SECONDS),
        '--timeout',
      )
      await runLoginCommandWithDependencies(contextOf(deps, command), { timeoutSeconds })
    },
  )
}

export function buildProgram(deps: CliDependencies): Command {
  const program = new Command()
  program
    .name('deploydeck')
    .description('声明式部署执行内核：按计划创建容器、部署项目、验证产物、销毁容器。')
    .version(pkg.version, '-v, --version', '打印版本号')
    .option('--json', '输出机器可读 JSON')
    .exitOverride()
    .configureOutput({
      // 输出全部经注入的流：测试才能断言 stdout 与 stderr。
      writeOut: (text: string) => {
        deps.stdout.write(text)
      },
      writeErr: (text: string) => {
        deps.stderr.write(text)
      },
    })

  registerProfileCommands(program, deps)
  registerPlanCommands(program, deps)
  registerRunCommands(program, deps)
  registerLoginCommand(program, deps)

  return program
}

/** 退出码映射。命令抛出的错误自带 `exitCode`，这里只透传。 */
function reportError(deps: CliDependencies, error: unknown): ExitCode {
  if (error instanceof DeploydeckError) {
    // 稳定错误码打在行首。退出码只有三个值，区分不了「预算不足」与「脚本失败」，
    // 机器读者按码分叉，不解析中文消息（docs/OPERATIONS.md 第 7.3 节）。
    writeLine(deps.stderr, `[${error.code}] ${error.message}`)
    return error.exitCode
  }
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) {
      return EXIT_OK
    }
    // 给了没有动作的命令组（例如只写 `plan`）时，commander 已经把用法打出来了。
    // 这不是参数写错，只是少了子命令；退出码按 commander 的裁决，不再补错误信息。
    if (error.code === 'commander.help') {
      return EXIT_BUSINESS_FAILURE
    }
    // commander 已经把原始参数错误写到 stderr；补一条中文提示，避免只看到英文原文。
    writeLine(deps.stderr, '参数错误。用 --help 查看全部命令与参数。')
    return EXIT_BUSINESS_FAILURE
  }
  if (error instanceof Error) {
    writeLine(deps.stderr, `[UNEXPECTED] ${error.message}`)
    writeLine(deps.stderr, error.stack ?? '')
    return EXIT_BUSINESS_FAILURE
  }
  writeLine(deps.stderr, `[UNEXPECTED] ${String(error)}`)
  return EXIT_BUSINESS_FAILURE
}

/**
 * 跑一条命令并返回退出码。
 *
 * 不调用 `process.exit`：测试直接读返回值；可执行入口把返回值写进 `process.exitCode`，
 * 让 stdout/stderr 有机会冲刷完。
 */
export async function runCli(
  argv: readonly string[],
  deps: CliDependencies,
): Promise<ExitCode> {
  const program = buildProgram(deps)
  try {
    await program.parseAsync(['node', 'deploydeck', ...argv])
    return EXIT_OK
  } catch (error: unknown) {
    return reportError(deps, error)
  }
}

/** 模块被当脚本执行时才启动。被测试 import 时不执行。 */
function isEntryPoint(): boolean {
  const entryPath = process.argv[1]
  if (entryPath === undefined) {
    return false
  }
  return resolve(entryPath) === fileURLToPath(import.meta.url)
}

if (isEntryPoint()) {
  process.exitCode = await runCli(process.argv.slice(2), createRealCliDependencies())
}
