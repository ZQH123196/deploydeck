import { z } from 'zod'

/** 代码来源。代码走 git clone，不走文件传输。 */
export const RepositorySchema = z.object({
  /** git 地址。实例内用部署密钥或公开地址 clone。 */
  url: z.string().min(1),
  /** 默认分支。部署时先切到该分支，再切到 commit。 */
  branch: z.string().min(1).default('main'),
})

export type Repository = z.infer<typeof RepositorySchema>

/** 默认数据盘路径。AutoDL 的容器约定：数据盘挂在 `/root/autodl-tmp`。 */
export const DEFAULT_DATA_DISK_PATH = '/root/autodl-tmp'

/**
 * 项目清单。它随被部署的项目走，不进 deploydeck 仓库。
 *
 * 字段含义见 docs/specs/deploydeck-phase2.md 第 3.2 节。
 * 步骤不写在清单里：引擎按 Profile 的两个脚本与 healthCheck 生成内置步骤。
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  repository: RepositorySchema,
  /** 实例内的项目目录。 */
  workdir: z.string().min(1),
  /** 部署后的健康检查命令。判据是退出码 0。 */
  healthCheck: z.string().min(1),
  /**
   * 实例内数据盘的挂载路径。克隆后按它的占用判断拷贝是否完成。
   *
   * 判据：拷完与没拷完只能靠数据盘自己的占用说，控制台状态说不了这件事。
   * 默认 `/root/autodl-tmp`：AutoDL 的数据盘固定挂在这里。换镜像或改挂载点时必须显式写。
   */
  dataDiskPath: z.string().min(1).default(DEFAULT_DATA_DISK_PATH),
})

export type Project = z.infer<typeof ProjectSchema>
