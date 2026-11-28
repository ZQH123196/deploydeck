import { writeJson, writeLine, writeTable } from '../output.js'
import { formatOnDeployFailure, formatPowerOnMode, type CommandContext } from './shared.js'

/**
 * `profile list`：列出配置目录里的全部部署配置。
 *
 * 只读配置目录，不碰状态目录，不连控制台。任一配置文件非法时加载器一次报完全部问题。
 */
export async function runProfileListCommand(context: CommandContext): Promise<void> {
  const profiles = await context.deps.loadProfiles()

  if (context.json) {
    writeJson(context.deps.stdout, { profiles })
    return
  }
  if (profiles.length === 0) {
    writeLine(context.deps.stdout, '没有找到任何部署配置。可从仓库的 examples/profiles 复制一份。')
    return
  }

  const headers = ['ID', '项目', 'provider', '开机', '时长(分)', '预算(元)', '失败后', '锁定commit']
  const rows = profiles.map((profile) => [
    profile.id,
    profile.project,
    profile.provider,
    formatPowerOnMode(profile.powerOnMode),
    String(profile.ttlMinutes),
    String(profile.budgetCapYuan),
    formatOnDeployFailure(profile.onDeployFailure),
    profile.requirePinnedCommit ? '是' : '否',
  ])
  writeTable(context.deps.stdout, headers, rows)
}
