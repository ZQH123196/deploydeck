import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { beijingNowIso } from '../util/time.js'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogSink {
  write(line: string): void
}

/** 结构化日志。一行一条 JSON，便于机器读取。 */
export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

function formatLine(level: LogLevel, event: string, fields: Record<string, unknown> | undefined): string {
  const record: Record<string, unknown> = {
    time: beijingNowIso(),
    level,
    event,
  }
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      record[key] = value
    }
  }
  return JSON.stringify(record)
}

export function createLogger(sink: LogSink): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    sink.write(formatLine(level, event, fields))
  }
  return {
    info: (event, fields) => {
      emit('info', event, fields)
    },
    warn: (event, fields) => {
      emit('warn', event, fields)
    },
    error: (event, fields) => {
      emit('error', event, fields)
    },
  }
}

/**
 * 把同一条日志同时写给多个 logger。
 *
 * 控制台动作模块既要写自己的动作证据文件（落 run 目录），也要进本次运行的日志。
 * 两条出口共用一份事件，避免各写一份文案。
 */
export function createFanoutLogger(...loggers: readonly Logger[]): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    for (const logger of loggers) {
      if (level === 'info') {
        logger.info(event, fields)
      } else if (level === 'warn') {
        logger.warn(event, fields)
      } else {
        logger.error(event, fields)
      }
    }
  }
  return {
    info: (event, fields) => {
      emit('info', event, fields)
    },
    warn: (event, fields) => {
      emit('warn', event, fields)
    },
    error: (event, fields) => {
      emit('error', event, fields)
    },
  }
}

/** 写到 stderr。用于人读的即时反馈。 */
export function createStderrLogger(): Logger {
  return createLogger({
    write: (line) => {
      process.stderr.write(`${line}\n`)
    },
  })
}

/** 追加写到文件。目录不存在时先创建。 */
export function createJsonlFileLogger(filePath: string): Logger {
  mkdirSync(dirname(filePath), { recursive: true })
  return createLogger({
    write: (line) => {
      appendFileSync(filePath, `${line}\n`, 'utf8')
    },
  })
}
