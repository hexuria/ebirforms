import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogEntry = {
  ts: string
  level: LogLevel
  scope: string
  msg: string
  [key: string]: unknown
}

const sensitiveKey = /password|secret|token|authorization/i

export function dataDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  if (env.EBIRFORMS_DATA_DIR) {
    return resolve(env.EBIRFORMS_DATA_DIR)
  }
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'ebirforms')
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'ebirforms')
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'ebirforms')
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen))
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  if (seen.has(value)) {
    return '[circular]'
  }

  seen.add(value)
  const safe = Object.fromEntries(
    Object.entries(value).map(([key, fieldValue]) => [
      key,
      sensitiveKey.test(key) ? '[redacted]' : redact(fieldValue, seen),
    ]),
  )
  seen.delete(value)
  return safe
}

export class Logger {
  private readonly entries: LogEntry[] = []
  private readonly subscribers = new Set<(entry: LogEntry) => void>()
  private readonly logsDir: string

  constructor(rootDir: string = dataDir()) {
    this.logsDir = join(rootDir, 'logs')
  }

  log(
    level: LogLevel,
    scope: string,
    msg: string,
    fields: Record<string, unknown> = {},
  ): LogEntry {
    const safeFields = redact(fields) as Record<string, unknown>
    const entry = { ...safeFields, ts: new Date().toISOString(), level, scope, msg }
    mkdirSync(this.logsDir, { recursive: true })
    appendFileSync(
      join(this.logsDir, `${entry.ts.slice(0, 10)}.jsonl`),
      `${JSON.stringify(entry)}\n`,
      'utf8',
    )

    this.entries.push(entry)
    if (this.entries.length > 1000) {
      this.entries.shift()
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry)
      } catch {}
    }
    return entry
  }

  getEntries(): LogEntry[] {
    return this.entries.slice()
  }

  subscribe(subscriber: (entry: LogEntry) => void): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }
}
