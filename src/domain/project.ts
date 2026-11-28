import { z } from 'zod'

/**
 * 项目清单。它随被部署的项目走，不进 deploydeck 仓库。
 *
 * 字段含义见 docs/specs/deploydeck-phase2.md 第 3.2 节。
 * 步骤不写在清单里：引擎按本文件的 healthCheck 生成内置步骤。
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  /**
   * 实例内的项目目录。健康检查命令在它里面执行。
   *
   * 判据：健康检查的 cwd 由此定，不得由引擎猜一个目录。项目代码可能按相对路径找自己的
   * 文件；cwd 不对时检查结果与「项目没起来」无法区分。它还进 stray 报错的现场指引。
   */
  workdir: z.string().min(1),
  /** 健康检查命令。判据是退出码 0；它只证明实例已连通，不证明业务可用。 */
  healthCheck: z.string().min(1),
})

export type Project = z.infer<typeof ProjectSchema>
