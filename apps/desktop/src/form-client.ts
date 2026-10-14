import type { FieldSnapshot, ValidationIssue } from '@ebirforms/runtime'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

/**
 * Client for form-worker.ts. One worker serves every open form; calls for one
 * form run in order (RemoteForm chains them), so a burst of edits applies in
 * the order typed and a validation sees every edit before it.
 */
export class FormClient {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly onLog?: (level: LogLevel, scope: string, msg: string, fields?: Record<string, unknown>) => void) {}

  private ensure(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(new URL('./form-worker.ts', import.meta.url).href)
    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: 'result'; id: number; result?: unknown; error?: string } | { type: 'log'; level: LogLevel; scope: string; msg: string; fields?: Record<string, unknown> }
      if (message.type === 'log') {
        this.onLog?.(message.level, message.scope, message.msg, message.fields)
        return
      }
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error !== undefined) waiter.reject(new Error(message.error))
      else waiter.resolve(message.result)
    }
    worker.onerror = (event) => {
      const error = new Error(`Form worker failed: ${event.message}`)
      for (const waiter of this.pending.values()) waiter.reject(error)
      this.pending.clear()
      this.worker = null
    }
    this.worker = worker
    return worker
  }

  call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    const worker = this.ensure()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      worker.postMessage({ id, op, ...args })
    })
  }

  async open(code: string): Promise<RemoteForm> {
    const { handle, fields } = await this.call<{ handle: number; fields: FieldSnapshot[] }>('open', { code })
    return new RemoteForm(this, code, handle, fields)
  }
}

export class RemoteForm {
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    private readonly client: FormClient,
    readonly code: string,
    private readonly handle: number,
    /** Last snapshot the worker returned. */
    public fields: FieldSnapshot[],
  ) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.catch(() => undefined)
    return run
  }

  setMany(values: Record<string, string | boolean>): Promise<FieldSnapshot[]> {
    return this.enqueue(async () => {
      if (this.closed) return this.fields
      const { fields } = await this.client.call<{ fields: FieldSnapshot[] }>('setMany', { handle: this.handle, values })
      this.fields = fields
      return fields
    })
  }

  validate(): Promise<{ issues: ValidationIssue[]; fields: FieldSnapshot[] }> {
    return this.enqueue(async () => {
      if (this.closed) return { issues: [], fields: this.fields }
      const outcome = await this.client.call<{ issues: ValidationIssue[]; fields: FieldSnapshot[] }>('validate', { handle: this.handle })
      this.fields = outcome.fields
      return outcome
    })
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    return this.enqueue(() => this.client.call<void>('close', { handle: this.handle }))
  }
}
