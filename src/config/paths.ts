import { homedir } from 'node:os'
import { join } from 'node:path'

/** 配置目录。存放 profiles。 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DEPLOYDECK_CONFIG_DIR'] ?? ''
  return override.length > 0 ? override : join(homedir(), '.config', 'deploydeck')
}

/** 状态目录。存放计划、运行记录、账本、日志。 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['DEPLOYDECK_STATE_DIR'] ?? ''
  return override.length > 0 ? override : join(homedir(), '.local', 'state', 'deploydeck')
}

export function resolveProfilesDir(configDir: string): string {
  return join(configDir, 'profiles')
}
