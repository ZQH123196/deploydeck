import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { E2eWorkDir } from './runtime.js'

/**
 * 真机测试的花费与结果账。
 *
 * 判据（AGENTS.md 可观测性）：摘要类记录只记已封口的值。每个用例跑完就把
 * 起止余额与差额固定下来，不再二次推断。报告落本次工作目录，便于事后核对钱花在哪。
 */

/** 一个用例的记账结果。 */
export interface E2eCaseRecord {
  readonly caseName: string
  readonly startedAt: string
  readonly durationMs: number
  /** 用例开始前的账户余额，元。读不到时为空。 */
  readonly balanceBeforeYuan: number | null
  /** 用例结束后的账户余额，元。读不到时为空。 */
  readonly balanceAfterYuan: number | null
  /** 余额差额，元。两侧都读到才有值。 */
  readonly costYuan: number | null
  /** 人读的补充说明，例如克隆出来的实例 ID、最终状态。 */
  readonly note: string
}

/** 一份真机测试报告。 */
export interface E2eReport {
  readonly startedAt: string
  readonly finishedAt: string
  readonly approvedCostYuan: number
  readonly estimatedCostYuan: number
  readonly cases: readonly E2eCaseRecord[]
  readonly totalCostYuan: number | null
}

export interface E2eRecorder {
  /** 记一条用例结果。 */
  recordCase(record: E2eCaseRecord): void
  /** 封口并落盘，返回报告对象与路径。 */
  write(input: {
    readonly startedAt: string
    readonly approvedCostYuan: number
    readonly estimatedCostYuan: number
  }): Promise<{ readonly filePath: string; readonly report: E2eReport }>
  /** 当前累计花费，元。还对不齐时返回 null。 */
  totalCostYuan(): number | null
}

/** 创建记账器。报告文件的路径由工作目录决定。 */
export function createE2eRecorder(workDir: E2eWorkDir): E2eRecorder {
  const cases: E2eCaseRecord[] = []
  return {
    recordCase: (record) => {
      cases.push(record)
    },
    totalCostYuan: () => {
      if (cases.length === 0) {
        return null
      }
      let total = 0
      for (const item of cases) {
        if (item.costYuan === null) {
          return null
        }
        total += item.costYuan
      }
      return Math.round(total * 100) / 100
    },
    write: async ({ startedAt, approvedCostYuan, estimatedCostYuan }) => {
      const report: E2eReport = {
        startedAt,
        finishedAt: new Date().toISOString(),
        approvedCostYuan,
        estimatedCostYuan,
        cases: [...cases],
        totalCostYuan: cases.every((item) => item.costYuan !== null)
          ? Math.round(cases.reduce((sum, item) => sum + (item.costYuan ?? 0), 0) * 100) / 100
          : null,
      }
      const filePath = join(workDir.root, 'report.json')
      await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
      return { filePath, report }
    },
  }
}

/** 报告的人读版本。测试末尾打印它。 */
export function formatE2eReport(report: E2eReport): string {
  const lines = [
    '===== 真机测试报告 =====',
    `开始：${report.startedAt}`,
    `结束：${report.finishedAt}`,
    `批准额度：${report.approvedCostYuan.toFixed(2)} 元；预计：${report.estimatedCostYuan.toFixed(2)} 元`,
    '',
    '用例                                                 耗时     花费(元)',
  ]
  for (const item of report.cases) {
    const cost = item.costYuan === null ? '-' : item.costYuan.toFixed(2)
    lines.push(`${item.caseName.padEnd(50, ' ')} ${String(Math.round(item.durationMs / 1000)).padStart(4, ' ')}s ${cost.padStart(8, ' ')}`)
    if (item.note.length > 0) {
      lines.push(`  说明：${item.note}`)
    }
  }
  lines.push('')
  lines.push(`合计：${report.totalCostYuan === null ? '（有差额读不到）' : `${report.totalCostYuan.toFixed(2)} 元`}`)
  return lines.join('\n')
}
