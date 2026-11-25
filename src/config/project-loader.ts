import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, type ParseError, printParseErrorCode } from 'jsonc-parser'
import { ProjectSchema, type Project } from '../domain/project.js'
import { ConfigError } from '../errors.js'

/**
 * 项目清单的读取。
 *
 * 配置目录由人写、机器只读（spec 第 11.1 节）。清单与 Profile 分开落盘：
 * `projects/<id>.jsonc`。文件名不必等于 id（Profile 的加载器也不要求），
 * 但 id 重复会让「按 id 取项目」变成猜一个，所以重复即报错。
 *
 * 目录不存在、任一文件非法一律抛 `ConfigError` 一次报完，不静默跳过。
 */

export interface ProjectIssue {
  readonly file: string
  readonly problems: readonly string[]
}

function isProjectFile(name: string): boolean {
  return name.endsWith('.jsonc') || name.endsWith('.json')
}

/** 读取目录里的全部项目清单。目录不存在或任一文件非法即抛错。 */
export async function loadProjects(projectsDir: string): Promise<readonly Project[]> {
  let entries: string[]
  try {
    entries = await readdir(projectsDir)
  } catch {
    throw new ConfigError(
      `项目清单目录不存在或不可读：${projectsDir}。可从仓库的 examples/projects 复制一份。`,
    )
  }

  const files = entries.filter(isProjectFile).sort()
  const projects: Project[] = []
  const issues: ProjectIssue[] = []
  const seenIds = new Map<string, string>()

  for (const file of files) {
    const fullPath = join(projectsDir, file)
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

    const parsed = ProjectSchema.safeParse(raw)
    if (!parsed.success) {
      issues.push({
        file,
        problems: parsed.error.issues.map(
          (issue) => `${issue.path.join('.') || '<根>'}：${issue.message}`,
        ),
      })
      continue
    }

    const existing = seenIds.get(parsed.data.id)
    if (existing !== undefined) {
      issues.push({ file, problems: [`项目 id 与 ${existing} 重复：${parsed.data.id}`] })
      continue
    }
    seenIds.set(parsed.data.id, file)
    projects.push(parsed.data)
  }

  if (issues.length > 0) {
    const lines = issues.flatMap((issue) =>
      issue.problems.map((problem) => `  ${issue.file} → ${problem}`),
    )
    throw new ConfigError(`项目清单校验未通过，共 ${issues.length} 个文件有问题：\n${lines.join('\n')}`)
  }

  return projects
}

/**
 * 按 id 取一份项目清单。
 *
 * 找不到即抛错并列出可用 id：Profile 引用了不存在的项目时，人需要立刻看到该写哪一份清单。
 */
export async function loadProject(projectsDir: string, projectId: string): Promise<Project> {
  const projects = await loadProjects(projectsDir)
  const project = projects.find((candidate) => candidate.id === projectId)
  if (project !== undefined) {
    return project
  }
  const available = projects.map((candidate) => candidate.id).join('、')
  throw new ConfigError(
    `项目清单不存在：${projectId}（目录 ${projectsDir}）。` +
      (available.length > 0 ? `现有清单：${available}。` : '该目录里没有任何项目清单。'),
  )
}
