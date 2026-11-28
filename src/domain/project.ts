import { z } from 'zod'

/**
 * 项目清单。它随被部署的项目走，不进 deploydeck 仓库。
 *
 * 判据：清单只承载「这是什么项目」，不承载任何要引擎执行的文本。
 * 引擎在实例里执行的命令由引擎自己写死，见 `src/engine/steps.ts`。
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
})

export type Project = z.infer<typeof ProjectSchema>
