import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'

export interface FieldSnapshot {
  id: string
  type: 'text' | 'select-one' | 'radio' | 'checkbox' | 'textarea'
  value: string
  checked?: boolean
  disabled: boolean
  maxLength?: number
  options?: { value: string; label: string }[]
}

export interface FormInstance {
  readonly code: string
  fields(): FieldSnapshot[]
  set(id: string, value: string | boolean): void
  get(id: string): string | boolean
  call(fn: string, ...args: unknown[]): unknown
  readonly alerts: string[]
  captureSaveXml(): string
  close(): Promise<void>
}

interface OpenOfficialFormOptions {
  packageDir?: string
  now?: Date
}

const repositoryRoot = resolve(import.meta.dir, '../../..')
const defaultPackageDir = join(repositoryRoot, 'vendor', 'buwiz-validation', 'package')
const dependencies = ['jq/jquery-1.7.1.min.js', 'js/environment.js', 'js/string-util.js']

export async function openOfficialForm(
  code: string,
  opts: OpenOfficialFormOptions = {},
): Promise<FormInstance> {
  const packageDir = resolve(opts.packageDir ?? defaultPackageDir)
  const formsDir = join(packageDir, 'forms')
  const formPath = join(formsDir, `BIR-Form${code}.hta`)
  const html = readFileSync(formPath, 'utf8').replace(/^\uFEFF/, '')
  const alerts: string[] = []
  const now = opts.now ?? new Date()
  const window = new Window({
    url: pathToFileURL(`${formsDir}${sep}`).href,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      errorCapture: 'processLevel',
    } as any,
  })
  const w = window as any
  let saveXml = ''

  w.alert = (message: unknown) => alerts.push(String(message))
  w.confirm = () => true

  const originalSetTimeout = w.setTimeout.bind(w)
  const originalSetInterval = w.setInterval.bind(w)
  w.setTimeout = (callback: unknown, delay?: number, ...args: unknown[]) =>
    originalSetTimeout(
      typeof callback === 'string' ? () => w.eval(callback) : callback,
      delay,
      ...args,
    )
  w.setInterval = (callback: unknown, delay?: number, ...args: unknown[]) =>
    originalSetInterval(
      typeof callback === 'string' ? () => w.eval(callback) : callback,
      delay,
      ...args,
    )

  const writer = {
    Write: (value: unknown) => {
      saveXml += String(value)
    },
    WriteLine: (value: unknown) => {
      saveXml += `${String(value)}\n`
    },
    write: (value: unknown) => {
      saveXml += String(value)
    },
    WriteLineText: (value: unknown) => {
      saveXml += `${String(value)}\n`
    },
    Close: () => {},
    close: () => {},
  }
  w.ActiveXObject = function () {
    return new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'CreateTextFile' || property === 'OpenTextFile') {
            return () => writer
          }
          if (property === 'FileExists' || property === 'FolderExists') {
            return () => false
          }
          return () => ''
        },
      },
    )
  }
  w.Enumerator = function () {
    let index = 0
    this.moveFirst = () => {
      index = 0
    }
    this.moveNext = () => {
      index += 1
    }
    this.atEnd = () => true
    this.item = () => undefined
  }

  const clockTime = now.getTime()
  const NativeDate = w.Date
  w.Date = class extends NativeDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(clockTime)
      } else {
        super(...(args as [string | number]))
      }
    }

    static now() {
      return clockTime
    }
  }

  try {
    for (const dependency of dependencies) {
      w.eval(readFileSync(join(packageDir, dependency), 'utf8'))
    }

    const inlineScripts: string[] = []
    const documentHtml = html.replace(
      /<script([^>]*)>([\s\S]*?)<\/script>/gi,
      (_match, attributes: string, content: string) => {
        if (!/\bsrc\s*=/i.test(attributes) && !/vbscript/i.test(attributes)) {
          inlineScripts.push(content)
        }
        return ''
      },
    )
    window.document.write(documentHtml)

    for (const script of inlineScripts) {
      w.eval(script)
    }

    for (const element of Array.from(window.document.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        if (!/^on/i.test(attribute.name)) {
          continue
        }
        const eventName = attribute.name.slice(2).toLowerCase()
        const handler = w.Function('event', attribute.value)
        element.addEventListener(eventName, (event) => handler.call(element, event))
      }
    }

    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }))
    window.dispatchEvent(new window.Event('load'))
    if (typeof w.jQuery?.ready === 'function') {
      w.jQuery.ready()
    }
    await new Promise((resolveReady) => globalThis.setTimeout(resolveReady, 1200))

    const mainForm = window.document.getElementById('frmMain') as HTMLFormElement | null
    if (!mainForm) {
      throw new Error(`Official form ${code} does not contain frmMain.`)
    }

    const getElement = (id: string): any => {
      const element = window.document.getElementById(id) as any
      if (!element) {
        throw new Error(`Official form ${code} does not contain field ${id}.`)
      }
      return element
    }

    const instance: FormInstance = {
      code,
      alerts,
      fields() {
        return (Array.from((mainForm as any).elements) as any[])
          .filter((element) => element.type !== 'button' && element.type !== 'hidden')
          .flatMap((element) => {
            const type = element.tagName.toLowerCase() === 'textarea' ? 'textarea' : element.type
            if (
              type !== 'text' &&
              type !== 'select-one' &&
              type !== 'radio' &&
              type !== 'checkbox' &&
              type !== 'textarea'
            ) {
              return []
            }
            const field: FieldSnapshot = {
              id: element.id,
              type,
              value: element.value,
              disabled: element.disabled,
            }
            if (type === 'radio' || type === 'checkbox') {
              field.checked = element.checked
            }
            if (element.maxLength >= 0) {
              field.maxLength = element.maxLength
            }
            if (type === 'select-one') {
              field.options = (Array.from(element.options) as any[]).map((option) => ({
                value: option.value,
                label: option.textContent?.trim() ?? '',
              }))
            }
            return [field]
          })
      },
      set(id, value) {
        const element = getElement(id)
        if (typeof value === 'boolean') {
          if (!('checked' in element)) {
            throw new Error(`Official form field ${id} does not support checked state.`)
          }
          element.checked = value
        } else {
          element.value = value
        }
        for (const eventName of ['focus', 'change', 'blur']) {
          element.dispatchEvent(
            new (w.Event)(eventName, { bubbles: eventName === 'change' }),
          )
        }
      },
      get(id) {
        const element = getElement(id)
        if (element.type === 'radio' || element.type === 'checkbox') {
          return element.checked ?? false
        }
        return element.value ?? ''
      },
      call(fn, ...args) {
        const callable = w[fn]
        if (typeof callable !== 'function') {
          throw new Error(`Official form ${code} does not expose function ${fn}.`)
        }
        return callable.apply(w, args)
      },
      captureSaveXml() {
        const previousReadOnly = w.gIsReadOnly
        const finalFlag = window.document.getElementById('txtFinalFlag') as
          | (HTMLInputElement & { value: string })
          | null
        const previousFinalFlag = finalFlag?.value
        const previousEncryptFile = w.EncryptFile
        const previousShowModalExport = w.showModalExport
        const previousSaveXmlProfile = w.saveXMLProfile

        w.d = window.document
        if (window.document.getElementById('msg')) {
          w.msg = window.document.getElementById('msg')
        }
        if (finalFlag) {
          finalFlag.value = '0'
          w.txtFinalFlag = finalFlag
        }
        w.gIsReadOnly = true
        w.EncryptFile = () => true
        w.showModalExport = () => {}
        w.saveXMLProfile = () => {}
        saveXml = ''
        try {
          instance.call('saveXML', false)
          return saveXml
        } finally {
          if (previousReadOnly === undefined) {
            delete w.gIsReadOnly
          } else {
            w.gIsReadOnly = previousReadOnly
          }
          if (finalFlag && previousFinalFlag !== undefined) {
            finalFlag.value = previousFinalFlag
          }
          w.EncryptFile = previousEncryptFile
          w.showModalExport = previousShowModalExport
          w.saveXMLProfile = previousSaveXmlProfile
        }
      },
      async close() {
        await window.happyDOM.close()
      },
    }

    return instance
  } catch (error) {
    await window.happyDOM.close()
    throw error
  }
}
