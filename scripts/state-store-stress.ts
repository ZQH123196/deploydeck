/**
 * 状态存储跨进程压测。手动运行，不进自动测试。
 *
 *   ./node_modules/.bin/tsx scripts/state-store-stress.ts
 *
 * 判据（工单 11 验收 1）：两个进程各写状态目录 100 次，无文件损坏、无丢失记录。
 *
 * 做法：两个子进程共享同一状态目录。每次读改写计数都在同一把锁内，
 * 并发追加账本与写运行记录。父进程等两个子进程退出后逐项核对。
 * 任何一项不符即退出码 1，并保留状态目录供人工查看。
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { LedgerEntrySchema, type LedgerEntry } from '../src/state/ledger.js'
import { createLedgerStore } from '../src/state/ledger-store.js'
import { createStateStore } from '../src/state/store.js'
import { beijingNowIso } from '../src/util/time.js'

const WORKER_COUNT = 2
const ITERATIONS_PER_WORKER = 100
const TOTAL_WRITES = WORKER_COUNT * ITERATIONS_PER_WORKER
const COUNTER_RELATIVE_PATH = 'counter.jsonc'
const RUNS_DIRECTORY = 'runs'
const LOCK_NAME = 'stress-counter'
const PAYLOAD_LENGTH = 4096

const CounterSchema = z.object({ count: z.number().int().nonnegative() })
const RunRecordSchema = z.object({
  worker: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  payload: z.string(),
})

interface WorkerExit {
  readonly worker: number
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

function runRecordRelativePath(worker: number, sequence: number): string {
  return `${RUNS_DIRECTORY}/worker-${worker}-${sequence}.jsonc`
}

function ledgerEntry(worker: number, sequence: number): LedgerEntry {
  const now = beijingNowIso()
  return {
    planId: 'stress-plan',
    runId: `run-${worker}-${sequence}`,
    instanceId: `instance-${worker}`,
    gpuSpec: 'RTX 4090',
    startedAt: now,
    stoppedAt: now,
    unitPriceYuanPerHour: 1.5,
    amountYuan: 0.01,
  }
}

function fail(message: string): never {
  process.stderr.write(`[stress] 失败：${message}\n`)
  process.exit(1)
}

async function runWorker(stateDir: string, configDir: string, worker: number): Promise<void> {
  const store = createStateStore({
    stateDir,
    configDir,
    lockTimeoutMs: 60_000,
    lockRetryIntervalMs: 2,
  })
  const ledger = createLedgerStore(store)
  const payload = 'x'.repeat(PAYLOAD_LENGTH)

  for (let sequence = 0; sequence < ITERATIONS_PER_WORKER; sequence += 1) {
    // 读改写整体在锁内。锁失效时两个进程会丢写，计数器就对不上。
    await store.withLock(LOCK_NAME, async () => {
      const counter = await store.readJson(COUNTER_RELATIVE_PATH, CounterSchema)
      await store.writeJson(COUNTER_RELATIVE_PATH, { count: counter.count + 1 })
    })
    await store.writeJson(runRecordRelativePath(worker, sequence), {
      worker,
      sequence,
      payload,
    })
    await ledger.append(ledgerEntry(worker, sequence))
  }
}

function spawnWorker(
  scriptPath: string,
  packageRoot: string,
  stateDir: string,
  configDir: string,
  worker: number,
): Promise<WorkerExit> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now()
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        scriptPath,
        '--worker',
        String(worker),
        '--state-dir',
        stateDir,
        '--config-dir',
        configDir,
      ],
      { cwd: packageRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error: Error) => {
      stderr += `子进程启动失败：${error.message}\n`
    })
    child.on('close', (code) => {
      resolvePromise({ worker, code, stdout, stderr, durationMs: Date.now() - startedAt })
    })
  })
}

async function findTemporaryFiles(directoryPath: string): Promise<string[]> {
  const found: string[] = []
  const entries = await readdir(directoryPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(directoryPath, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await findTemporaryFiles(fullPath)))
    } else if (entry.name.endsWith('.tmp')) {
      found.push(fullPath)
    }
  }
  return found
}

async function runParent(): Promise<void> {
  const scriptPath = fileURLToPath(import.meta.url)
  const packageRoot = resolve(dirname(scriptPath), '..')
  const baseDirectory = join(packageRoot, '.tmp', 'state-store-stress')
  await mkdir(baseDirectory, { recursive: true })
  const runDirectory = await mkdtemp(join(baseDirectory, 'run-'))
  const stateDir = join(runDirectory, 'state')
  const configDir = join(runDirectory, 'config')

  const store = createStateStore({
    stateDir,
    configDir,
    lockTimeoutMs: 60_000,
    lockRetryIntervalMs: 2,
  })
  await store.writeJson(COUNTER_RELATIVE_PATH, { count: 0 })

  process.stdout.write(`[stress] 状态目录：${stateDir}\n`)
  process.stdout.write(
    `[stress] 启动 ${WORKER_COUNT} 个子进程，每个写 ${ITERATIONS_PER_WORKER} 次\n`,
  )

  const startedAt = Date.now()
  const exits = await Promise.all(
    Array.from({ length: WORKER_COUNT }, (_value, worker) =>
      spawnWorker(scriptPath, packageRoot, stateDir, configDir, worker),
    ),
  )
  const durationMs = Date.now() - startedAt

  for (const exit of exits) {
    process.stdout.write(
      `[stress] 子进程 ${exit.worker} 完成：退出码 ${String(exit.code)}，耗时 ${exit.durationMs}ms\n`,
    )
    if (exit.stdout.length > 0) {
      process.stdout.write(exit.stdout)
    }
    if (exit.code !== 0) {
      process.stderr.write(exit.stderr)
      fail(`子进程 ${exit.worker} 退出码 ${String(exit.code)}`)
    }
  }

  // 校验 1：两次写入都不丢，计数器必须精确等于总写次数。
  const counter = await store.readJson(COUNTER_RELATIVE_PATH, CounterSchema)
  if (counter.count !== TOTAL_WRITES) {
    fail(`计数器为 ${counter.count}，期望 ${TOTAL_WRITES}（有写丢失）`)
  }
  process.stdout.write(`[stress] 校验 1/4：计数器 ${counter.count} = ${TOTAL_WRITES}\n`)

  // 校验 2：账本行数、唯一性、内容完整性。
  const ledger = createLedgerStore(store)
  const entries = await ledger.readAll()
  if (entries.length !== TOTAL_WRITES) {
    fail(`账本 ${entries.length} 行，期望 ${TOTAL_WRITES} 行`)
  }
  const expectedRunIds = new Set<string>()
  for (let worker = 0; worker < WORKER_COUNT; worker += 1) {
    for (let sequence = 0; sequence < ITERATIONS_PER_WORKER; sequence += 1) {
      expectedRunIds.add(`run-${worker}-${sequence}`)
    }
  }
  const actualRunIds = new Set(entries.map((entry) => entry.runId))
  if (actualRunIds.size !== TOTAL_WRITES) {
    fail(`账本只有 ${actualRunIds.size} 个不同的 runId（有重复或覆盖）`)
  }
  const missingRunIds = [...expectedRunIds].filter((runId) => !actualRunIds.has(runId))
  if (missingRunIds.length > 0) {
    fail(`账本缺少 ${missingRunIds.length} 行，例如 ${missingRunIds.slice(0, 5).join('、')}`)
  }
  for (const entry of entries) {
    LedgerEntrySchema.parse(entry)
  }
  process.stdout.write(`[stress] 校验 2/4：账本 ${entries.length} 行，全部通过 schema 校验\n`)

  // 校验 3：运行记录文件数量与内容。
  const runFileNames = await readdir(join(stateDir, RUNS_DIRECTORY))
  if (runFileNames.length !== TOTAL_WRITES) {
    fail(`运行记录 ${runFileNames.length} 个，期望 ${TOTAL_WRITES} 个`)
  }
  const expectedFileNames = new Set<string>()
  for (let worker = 0; worker < WORKER_COUNT; worker += 1) {
    for (let sequence = 0; sequence < ITERATIONS_PER_WORKER; sequence += 1) {
      expectedFileNames.add(`worker-${worker}-${sequence}.jsonc`)
    }
  }
  for (const fileName of expectedFileNames) {
    if (!runFileNames.includes(fileName)) {
      fail(`运行记录缺失：${fileName}`)
    }
  }
  for (const fileName of runFileNames) {
    const record = await store.readJson(`${RUNS_DIRECTORY}/${fileName}`, RunRecordSchema)
    if (record.payload.length !== PAYLOAD_LENGTH) {
      fail(`运行记录内容不完整：${fileName}（payload ${record.payload.length} 字节）`)
    }
  }
  process.stdout.write(`[stress] 校验 3/4：运行记录 ${runFileNames.length} 个，内容完整\n`)

  // 校验 4：无临时文件残留，锁已全部释放。
  const temporaryFiles = await findTemporaryFiles(stateDir)
  if (temporaryFiles.length > 0) {
    fail(`残留临时文件 ${temporaryFiles.length} 个，例如 ${temporaryFiles[0] ?? ''}`)
  }
  const lockFiles = await readdir(join(stateDir, 'locks'))
  if (lockFiles.length > 0) {
    fail(`锁目录未清空，残留 ${lockFiles.join('、')}`)
  }
  process.stdout.write('[stress] 校验 4/4：无 .tmp 残留，锁目录已清空\n')

  process.stdout.write(`[stress] 总耗时 ${durationMs}ms，全部校验通过\n`)
  await rm(runDirectory, { recursive: true, force: true })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      worker: { type: 'string' },
      'state-dir': { type: 'string' },
      'config-dir': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })

  const workerText = values.worker
  if (workerText === undefined) {
    await runParent()
    return
  }

  const stateDir = values['state-dir']
  const configDir = values['config-dir']
  if (stateDir === undefined || configDir === undefined) {
    fail('子进程参数不完整：需要同时给出 --worker、--state-dir、--config-dir')
  }
  await runWorker(stateDir, configDir, Number.parseInt(workerText, 10))
}

await main()
