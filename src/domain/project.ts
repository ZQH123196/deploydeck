import { z } from 'zod'

/** 一个部署步骤。`run` 必须有；`verify` 用于部署后的产物校验。 */
export const DeployStepSchema = z.object({
  id: z.string().min(1),
  run: z.string().min(1),
  timeoutSeconds: z.number().int().positive().default(600),
  verify: z.string().min(1).optional(),
})

export type DeployStep = z.infer<typeof DeployStepSchema>

/**
 * 项目清单。它随被部署的项目走，不进 deploydeck 仓库。
 * 多个项目共用一个 deploydeck，各自带自己的清单。
 */
export const ProjectManifestSchema = z.object({
  id: z.string().min(1),
  /** 容器内的项目目录。 */
  workdir: z.string().min(1),
  steps: z.array(DeployStepSchema).min(1),
})

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>
