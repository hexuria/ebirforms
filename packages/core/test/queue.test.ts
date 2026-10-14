import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { JobQueue, Worker } from '../src/queue.js'
import { Logger } from '../src/logger.js'
import { openStore } from '../src/store.js'

describe('JobQueue', () => {
  test('claims due jobs in creation order and emits changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-queue-order-'))
    const store = openStore(join(root, 'jobs.sqlite'), new Logger(root))
    try {
      const queue = new JobQueue(store, () => 50)
      const changes: string[][] = []
      queue.onChange((jobs) => changes.push(jobs.map((job) => `${job.state}:${job.kind}`)))
      queue.enqueue('older', { id: 1 }, { now: 1, runAfter: 20 })
      queue.enqueue('newer', { id: 2 }, { now: 2, runAfter: 10 })
      queue.enqueue('later', { id: 3 }, { now: 3, runAfter: 100 })

      expect(queue.claim(9)).toBeNull()
      expect(queue.claim(20)).toMatchObject({ kind: 'older', state: 'running', attempts: 1 })
      expect(queue.claim(20)).toMatchObject({ kind: 'newer', state: 'running', attempts: 1 })
      expect(queue.claim(20)).toBeNull()
      expect(changes.length).toBe(5)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('applies exponential backoff and moves exhausted jobs to dead letter', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-queue-backoff-'))
    const store = openStore(join(root, 'jobs.sqlite'), new Logger(root))
    try {
      let now = 100
      const queue = new JobQueue(store, () => now)
      const job = queue.enqueue('retry', {}, { now, maxAttempts: 2 })
      queue.claim()
      queue.fail(job.id, new Error('first failure'))
      expect(queue.list()[0]).toMatchObject({
        state: 'queued',
        attempts: 1,
        runAfter: 2100,
        lastError: 'first failure',
      })
      now = 2099
      expect(queue.claim()).toBeNull()
      now = 2100
      queue.claim()
      queue.fail(job.id, 'second failure')
      expect(queue.list()[0]).toMatchObject({
        state: 'dead',
        attempts: 2,
        runAfter: 2100,
        lastError: 'second failure',
      })
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('caps backoff at five minutes', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-queue-cap-'))
    const store = openStore(join(root, 'jobs.sqlite'), new Logger(root))
    try {
      const queue = new JobQueue(store, () => 0)
      const job = queue.enqueue('retry', {}, { now: 0, maxAttempts: 10 })
      let now = 0
      for (let attempt = 1; attempt <= 9; attempt += 1) {
        const claimed = queue.claim(now)
        expect(claimed?.attempts).toBe(attempt)
        queue.fail(job.id, 'retry', now)
        now = queue.list()[0].runAfter
      }
      expect(now).toBe(810000)
      expect(queue.list()[0].runAfter).toBe(810000)
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('recovers running jobs after reopening the database', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-queue-recovery-'))
    const path = join(root, 'jobs.sqlite')
    const firstStore = openStore(path, new Logger(root))
    const firstQueue = new JobQueue(firstStore, () => 10)
    const job = firstQueue.enqueue('resume', { value: 1 }, { now: 10 })
    firstQueue.claim(10)
    firstStore.close()

    const reopened = openStore(path, new Logger(root))
    try {
      const recovered = new JobQueue(reopened, () => 20)
      expect(recovered.list()[0]).toMatchObject({
        id: job.id,
        state: 'queued',
        attempts: 1,
        runAfter: 20,
      })
    } finally {
      reopened.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('runs registered handlers with concurrency one and an injectable clock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-worker-'))
    const store = openStore(join(root, 'jobs.sqlite'), new Logger(root))
    try {
      const queue = new JobQueue(store)
      queue.enqueue('hold', { value: 1 }, { now: 5 })
      queue.enqueue('hold', { value: 2 }, { now: 5 })
      let active = 0
      let maximumActive = 0
      let startHandler: (() => void) | undefined
      let releaseHandler: (() => void) | undefined
      const started = new Promise<void>((resolveStart) => {
        startHandler = resolveStart
      })
      const held = new Promise<void>((resolveRelease) => {
        releaseHandler = resolveRelease
      })
      const worker = new Worker(
        queue,
        {
          hold: async () => {
            active += 1
            maximumActive = Math.max(maximumActive, active)
            startHandler?.()
            await held
            active -= 1
          },
        },
        () => 5,
      )

      const firstRun = worker.runOnce()
      await started
      expect(await worker.runOnce()).toBe(false)
      releaseHandler?.()
      expect(await firstRun).toBe(true)
      expect(maximumActive).toBe(1)
      expect(queue.list().map((job) => job.state).sort()).toEqual(['queued', 'succeeded'])
      expect(await worker.runOnce()).toBe(true)
      expect(queue.list().map((job) => job.state).sort()).toEqual(['succeeded', 'succeeded'])
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
