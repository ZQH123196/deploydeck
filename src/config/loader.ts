import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser'
import { ConfigError } from '../errors.js'
import { ProfileSchema, type Profile } from '../domain/profile.js'

export interface ProfileIssue {
  file: string
  problems: readonly string[]
}

export interface ProfileLoadResult {
  profiles: readonly Profile[]
  /** 非法配置一律收录，一次报完。 */
  issues: readonly ProfileIssue[]
}

function isProfileFile(name: string): boolean {
  return name.endsWith('.jsonc') || name.endsWith('.json')
}

/**
 * 读取全部 Profile。
 *
 * 目录不存在即抛错，不静默返回空列表。
 * 任一文件非法即抛错，信息里列出全部问题。
 */
export async function loadProfiles(profilesDir: string): Promise<ProfileLoadResult> {
  let entries: string[]
  try {
    entries = await readdir(profilesDir)
  } catch {
    throw new ConfigError(
      `Profile 目录不存在或不可读：${profilesDir}。可从仓库的 examples/profiles 复制一份。`,
    )
  }

  const files = entries.filter(isProfileFile).sort()
  const profiles: Profile[] = []
  const issues: ProfileIssue[] = []
  const seenIds = new Map<string, string>()

  for (const file of files) {
    const fullPath = join(profilesDir, file)
    const text = await readFile(fullPath, 'utf8')

    const parseErrors: ParseError[] = []
    const raw: unknown = parse(text, parseErrors, { allowTrailingComma: true })
    if (parseErrors.length > 0) {
      issues.push({
        file,
        problems: parseErrors.map(
          (error) => `JSONC 解析失败（偏移 ${error.offset}）：${printParseErrorCode(error.error)}`,
        ),
      })
      continue
    }

    const parsed = ProfileSchema.safeParse(raw)
    if (!parsed.success) {
      issues.push({
        file,
        problems: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<根>'}：${issue.message}`),
      })
      continue
    }

    const existing = seenIds.get(parsed.data.id)
    if (existing !== undefined) {
      issues.push({ file, problems: [`Profile id 与 ${existing} 重复：${parsed.data.id}`] })
      continue
    }
    seenIds.set(parsed.data.id, file)
    profiles.push(parsed.data)
  }

  if (issues.length > 0) {
    const lines = issues.flatMap((issue) => issue.problems.map((problem) => `  ${issue.file} → ${problem}`))
    throw new ConfigError(`配置校验未通过，共 ${issues.length} 个文件有问题：\n${lines.join('\n')}`)
  }

  return { profiles, issues: [] }
}
