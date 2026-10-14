import { randomUUID } from 'node:crypto'
import type { Store } from './store.js'

export type JobState = 'queued' | 'running' | 'succeeded' | 'dead'

export interface Job {
  id: string
  kind: string
  payload: unknown
  state: JobState
  attempts: number
  maxAttempts: number
  runAfter: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

export interface EnqueueOptions {
  maxAttempts?: number
  runAfter?: number
  now?: number
}

export type JobHandler = (payload: unknown, job: Job) => void | Promise<void>

interface JobRow {
  id: string
  kind: string
  payload: string
  state: JobState
  attempts: number
  maxAttempts: number
  runAfter: number
  lastError: string | null
  createdAt: number
  updatedAt: number
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function decodeJob(row: JobRow): Job {
  return {
    id: row.id as string,
    kind: row.kind as string,
    payload: JSON.parse(row.payload as string) as unknown,
    state: row.state as JobState,
    attempts: row.attempts as number,
    maxAttempts: row.maxAttempts as number,
    runAfter: row.runAfter as number,
    lastError: row.lastError as string | null,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
  }
}

const jobColumns = `
  id,
  kind,
  payload,
  state,
  attempts,
  max_attempts AS maxAttempts,
  run_after AS runAfter,
  last_error AS lastError,
  created_at AS createdAt,
  updated_at AS updatedAt
`

export class JobQueue {
  private readonly subscribers = new Set<(jobs: Job[]) => void>()

  constructor(
    readonly store: Store,
    private readonly clock: () => number = Date.now,
  ) {
    this.recoverStale(this.clock())
  }

  enqueue(kind: string, payload: unknown, options: EnqueueOptions = {}): Job {
    const serialized = JSON.stringify(payload)
    if (serialized === undefined) {
      throw new Error('Job payload must be JSON-serializable.')
    }
    const now = options.now ?? this.clock()
    const maxAttempts = options.maxAttempts ?? 5
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer.')
    }
    const row = this.store.db
      .query(`
        INSERT INTO jobs (id, kind, payload, state, max_attempts, run_after, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)
        RETURNING ${jobColumns}
      `)
      .get(randomUUID(), kind, serialized, maxAttempts, options.runAfter ?? now, now, now) as
      | JobRow
      | null
    if (!row) {
      throw new Error('The job could not be enqueued.')
    }
    const job = decodeJob(row)
    this.store.logger.log('info', 'queue', 'Job queued', {
      jobId: job.id,
      kind: job.kind,
      state: job.state,
    })
    this.notify()
    return job
  }

  claim(now: number = this.clock()): Job | null {
    const row = this.store.db
      .query(`
        UPDATE jobs
        SET state = 'running', attempts = attempts + 1, updated_at = ?
        WHERE id = (
          SELECT id FROM jobs
          WHERE state = 'queued' AND run_after <= ?
          ORDER BY created_at ASC, id ASC
          LIMIT 1
        )
        RETURNING ${jobColumns}
      `)
      .get(now, now) as JobRow | null
    if (!row) {
      return null
    }
    const job = decodeJob(row)
    this.store.logger.log('info', 'queue', 'Job claimed', {
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
      state: job.state,
    })
    this.notify()
    return job
  }

  complete(id: string, now: number = this.clock()): void {
    const row = this.store.db
      .query(`
        UPDATE jobs
        SET state = 'succeeded', last_error = NULL, updated_at = ?
        WHERE id = ? AND state = 'running'
        RETURNING ${jobColumns}
      `)
      .get(now, id) as JobRow | null
    if (!row) {
      throw new Error(`Job ${id} is not running.`)
    }
    const job = decodeJob(row)
    this.store.logger.log('info', 'queue', 'Job succeeded', {
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
      state: job.state,
    })
    this.notify()
  }

  fail(id: string, error: unknown, now: number = this.clock()): void {
    const job = this.store.db
      .query(`SELECT ${jobColumns} FROM jobs WHERE id = ?`)
      .get(id) as JobRow | null
    if (!job || job.state !== 'running') {
      throw new Error(`Job ${id} is not running.`)
    }
    const lastError = errorMessage(error)
    const dead = job.attempts >= job.maxAttempts
    const runAfter = dead
      ? now
      : now + Math.min(2 ** job.attempts * 1000, 300000)
    const row = this.store.db
      .query(`
        UPDATE jobs
        SET state = ?, run_after = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND state = 'running'
        RETURNING ${jobColumns}
      `)
      .get(dead ? 'dead' : 'queued', runAfter, lastError, now, id) as JobRow | null
    if (!row) {
      throw new Error(`Job ${id} is not running.`)
    }
    const updated = decodeJob(row)
    this.store.logger.log(dead ? 'error' : 'warn', 'queue', 'Job failed', {
      jobId: updated.id,
      kind: updated.kind,
      attempts: updated.attempts,
      maxAttempts: updated.maxAttempts,
      state: updated.state,
      error: updated.lastError,
    })
    this.notify()
  }

  recoverStale(now: number = this.clock()): number {
    const rows = this.store.db
      .query(`
        UPDATE jobs
        SET state = 'queued', run_after = ?, updated_at = ?
        WHERE state = 'running'
        RETURNING id, kind, attempts
      `)
      .all(now, now) as Array<{ id: string; kind: string; attempts: number }>
    for (const job of rows) {
      this.store.logger.log('warn', 'queue', 'Recovered stale job', {
        jobId: job.id,
        kind: job.kind,
        attempts: job.attempts,
        state: 'queued',
      })
    }
    if (rows.length > 0) {
      this.notify()
    }
    return rows.length
  }

  list(): Job[] {
    const rows = this.store.db
      .query(`SELECT ${jobColumns} FROM jobs ORDER BY created_at DESC, id DESC`)
      .all() as JobRow[]
    return rows.map(decodeJob)
  }

  onChange(subscriber: (jobs: Job[]) => void): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  private notify(): void {
    const jobs = this.list()
    for (const subscriber of this.subscribers) {
      try {
        subscriber(jobs)
      } catch {}
    }
  }
}

export class Worker {
  private readonly handlers = new Map<string, JobHandler>()
  private busy = false
  private running = false
  private loop: Promise<void> | undefined

  constructor(
    readonly queue: JobQueue,
    handlers: Record<string, JobHandler> = {},
    private readonly clock: () => number = Date.now,
  ) {
    for (const [kind, handler] of Object.entries(handlers)) {
      this.register(kind, handler)
    }
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler)
  }

  async runOnce(): Promise<boolean> {
    if (this.busy) {
      return false
    }
    this.busy = true
    try {
      const job = this.queue.claim(this.clock())
      if (!job) {
        return false
      }
      try {
        const handler = this.handlers.get(job.kind)
        if (!handler) {
          throw new Error(`No handler registered for job kind: ${job.kind}.`)
        }
        await handler(job.payload, job)
        this.queue.complete(job.id, this.clock())
      } catch (error) {
        this.queue.fail(job.id, error, this.clock())
      }
      return true
    } finally {
      this.busy = false
    }
  }

  start(pollIntervalMs = 500): void {
    if (this.running) {
      return
    }
    this.running = true
    this.loop = this.runLoop(pollIntervalMs)
  }

  async stop(): Promise<void> {
    this.running = false
    await this.loop
  }

  private async runLoop(pollIntervalMs: number): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce()
      } catch (error) {
        try {
          this.queue.store.logger.log('error', 'worker', 'Worker loop failed', {
            error: errorMessage(error),
          })
        } catch {}
      }
      if (this.running) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, pollIntervalMs))
      }
    }
    this.loop = undefined
  }
}
