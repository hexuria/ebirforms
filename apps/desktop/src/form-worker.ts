/**
 * Runs the official eBIRForms form runtime off the UI thread. Opening a form
 * takes seconds and its first validation up to ~20s (2550Q); on the UI thread
 * that froze the window. The app talks to this worker through form-client.ts.
 */
import { openOfficialForm, type FormInstance } from '@ebirforms/runtime'

declare const self: Worker

type Request =
  | { id: number; op: 'open'; code: string }
  | { id: number; op: 'setMany'; handle: number; values: Record<string, string | boolean> }
  | { id: number; op: 'validate'; handle: number }
  | { id: number; op: 'close'; handle: number }

const forms = new Map<number, FormInstance>()
let nextHandle = 1

const logger = {
  log(level: 'debug' | 'info' | 'warn' | 'error', scope: string, msg: string, fields?: Record<string, unknown>) {
    postMessage({ type: 'log', level, scope, msg, fields })
  },
}

function form(handle: number): FormInstance {
  const instance = forms.get(handle)
  if (!instance) throw new Error(`Form ${handle} is closed.`)
  return instance
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data
  try {
    let result: unknown = null
    switch (request.op) {
      case 'open': {
        const instance = await openOfficialForm(request.code)
        const handle = nextHandle++
        forms.set(handle, instance)
        result = { handle, fields: instance.fields() }
        break
      }
      case 'setMany': {
        const instance = form(request.handle)
        for (const [fieldId, value] of Object.entries(request.values)) instance.set(fieldId, value)
        result = { fields: instance.fields() }
        break
      }
      case 'validate': {
        const instance = form(request.handle)
        const outcome = instance.validate(logger)
        result = { issues: outcome.issues, fields: instance.fields() }
        break
      }
      case 'close': {
        const instance = forms.get(request.handle)
        forms.delete(request.handle)
        await instance?.close()
        break
      }
    }
    postMessage({ type: 'result', id: request.id, result })
  } catch (error) {
    postMessage({ type: 'result', id: request.id, error: error instanceof Error ? error.message : String(error) })
  }
}
