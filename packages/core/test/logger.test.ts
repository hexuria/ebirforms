import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { dataDir, Logger } from '../src/logger.js'

describe('dataDir', () => {
  test('uses the configured directory or the platform default', () => {
    const home = join(tmpdir(), 'ebirforms-home')
    const configured = join(tmpdir(), 'custom-ebirforms-data')
    expect(dataDir({ EBIRFORMS_DATA_DIR: configured }, 'win32', home)).toBe(configured)
    expect(dataDir({ APPDATA: 'C:\\Users\\example\\AppData\\Roaming' }, 'win32', home)).toBe(
      join('C:\\Users\\example\\AppData\\Roaming', 'ebirforms'),
    )
    expect(dataDir({}, 'darwin', home)).toBe(
      join(home, 'Library', 'Application Support', 'ebirforms'),
    )
    expect(dataDir({ XDG_DATA_HOME: join(home, 'xdg') }, 'linux', home)).toBe(
      join(home, 'xdg', 'ebirforms'),
    )
  })
})

describe('Logger', () => {
  test('redacts sensitive fields before writing and notifying subscribers', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-logger-'))
    try {
      const logger = new Logger(root)
      const streamed: unknown[] = []
      logger.subscribe((entry) => streamed.push(entry))
      const entry = logger.log('info', 'test', 'created', {
        password: 'secret-value',
        nested: { accessToken: 'nested-secret' },
        safe: 'visible',
      })
      const content = readFileSync(
        join(root, 'logs', `${entry.ts.slice(0, 10)}.jsonl`),
        'utf8',
      )
      expect(content).not.toContain('secret-value')
      expect(content).not.toContain('nested-secret')
      expect(JSON.parse(content)).toMatchObject({
        password: '[redacted]',
        nested: { accessToken: '[redacted]' },
        safe: 'visible',
      })
      expect(streamed).toEqual([entry])
      expect(logger.getEntries()).toEqual([entry])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('keeps a 1000-entry ring buffer and writes parseable JSONL', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-logger-'))
    try {
      const logger = new Logger(root)
      for (let index = 0; index < 1005; index += 1) {
        logger.log('debug', 'test', `entry-${index}`)
      }
      const entries = logger.getEntries()
      const file = join(root, 'logs', `${entries[0].ts.slice(0, 10)}.jsonl`)
      const parsed = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { msg: string })
      expect(entries).toHaveLength(1000)
      expect(entries[0].msg).toBe('entry-5')
      expect(entries.at(-1)?.msg).toBe('entry-1004')
      expect(parsed).toHaveLength(1005)
      expect(parsed[0].msg).toBe('entry-0')
      expect(parsed.at(-1)?.msg).toBe('entry-1004')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
