#!/usr/bin/env node
import { createRequire } from 'node:module'
import { Command } from 'commander'
import { loadProfiles } from '../config/loader.js'
import { resolveConfigDir, resolveProfilesDir } from '../config/paths.js'
import type { Profile } from '../domain/profile.js'
import { DeploydeckError, NotImplementedError } from '../errors.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

interface GlobalOptions {
  json: boolean
}

function readGlobalOptions(program: Command): GlobalOptions {
  const opts: Record<string, unknown> = program.opts()
  return { json: opts['json'] === true }
}

function isWideChar(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    width += isWideChar(code) ? 2 : 1
  }
  return width
}

function padCell(text: string, width: number): string {
  const gap = width - displayWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

function formatOnDeployFailure(profile: Profile): string {
  return profile.onDeployFailure === 'keep-container' ? '保留容器' : '销毁容器'
}

function printProfileTable(profiles: readonly Profile[]): void {
  const headers = ['ID', '项目', 'provider', '时长(分)', '预算(元)', '失败后', '锁定commit']
  const rows = profiles.map((profile) => [
    profile.id,
    profile.project,
    profile.provider,
    String(profile.ttlMinutes),
    String(profile.budgetCapYuan),
    formatOnDeployFailure(profile),
    profile.requirePinnedCommit ? '是' : '否',
  ])

  const widths = headers.map((header, index) => {
    let width = displayWidth(header)
    for (const row of rows) {
      width = Math.max(width, displayWidth(row[index] ?? ''))
    }
    return width
  })

  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, index) => padCell(cell, widths[index] ?? 0)).join('  ').trimEnd()

  process.stdout.write(`${renderRow(headers)}\n`)
  for (const row of rows) {
    process.stdout.write(`${renderRow(row)}\n`)
  }
}

function registerProfileCommands(program: Command): void {
  const profileCommand = program.command('profile').description('查看部署配置')

  profileCommand
    .command('list')
    .description('列出全部部署配置')
    .action(async () => {
      const { profiles } = await loadProfiles(resolveProfilesDir(resolveConfigDir()))
      const options = readGlobalOptions(program)
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ profiles }, null, 2)}\n`)
        return
      }
      if (profiles.length === 0) {
        process.stdout.write('没有找到任何部署配置。\n')
        return
      }
      printProfileTable(profiles)
    })
}

function registerPlanCommands(program: Command): void {
  const planCommand = program.command('plan').description('管理部署计划')

  planCommand
    .command('create')
    .description('创建一份计划。给出使用时长与预算上限。')
    .requiredOption('--profile <id>', '部署配置 id')
    .option('--ttl <minutes>', '覆盖配置里的可用分钟数')
    .option('--budget <yuan>', '覆盖配置里的预算上限')
    .action(() => {
      throw new NotImplementedError('plan create：计划落盘与预算校验尚未实现')
    })

  planCommand
    .command('show <planId>')
    .description('查看计划。含剩余时长与预算余额。')
    .action(() => {
      throw new NotImplementedError('plan show：计划读取尚未实现')
    })

  planCommand
    .command('extend <planId>')
    .description('延长计划。必须显式调用。')
    .requiredOption('--minutes <n>', '延长的分钟数')
    .action(() => {
      throw new NotImplementedError('plan extend：计划续期尚未实现')
    })
}

function registerRunCommands(program: Command): void {
  program
    .command('run')
    .description('在计划下执行部署')
    .requiredOption('--plan <planId>', '计划 id')
    .option('--commit <sha>', '指定 commit。配置要求锁定 commit 时必填。')
    .action(() => {
      throw new NotImplementedError('run：创建容器与步骤执行尚未实现')
    })

  program
    .command('status')
    .description('查看当前全部容器与花费')
    .action(() => {
      throw new NotImplementedError('status：资源与账本查询尚未实现')
    })

  program
    .command('teardown <planId>')
    .description('销毁容器，并确认容器消失')
    .action(() => {
      throw new NotImplementedError('teardown：销毁链与终态验证尚未实现')
    })

  program
    .command('ledger')
    .description('查看账本')
    .action(() => {
      throw new NotImplementedError('ledger：账本读取尚未实现')
    })
}

function buildProgram(): Command {
  const program = new Command()
  program
    .name('deploydeck')
    .description('声明式部署执行内核：按计划创建容器、部署项目、验证产物、销毁容器。')
    .version(pkg.version, '-v, --version', '打印版本号')
    .option('--json', '输出机器可读 JSON')

  registerProfileCommands(program)
  registerPlanCommands(program)
  registerRunCommands(program)

  return program
}

function reportError(error: unknown): never {
  if (error instanceof DeploydeckError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(error.exitCode)
  }
  if (error instanceof Error) {
    process.stderr.write(`[UNEXPECTED] ${error.message}\n${error.stack ?? ''}\n`)
    process.exit(1)
  }
  process.stderr.write(`[UNEXPECTED] ${String(error)}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const program = buildProgram()
  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    reportError(error)
  }
}

await main()
