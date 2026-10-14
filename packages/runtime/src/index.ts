import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Window } from 'happy-dom'
import { extractGuards } from './validation.js'
import type { ValidationIssue, ValidationLogger, ValidationResult } from './validation.js'

export type {
  GuardDescriptor,
  ValidationIssue,
  ValidationLogger,
  ValidationResult,
} from './validation.js'
export { extractGuards } from './validation.js'

export interface FieldSnapshot {
  id: string
  name: string
  type: 'text' | 'select-one' | 'radio' | 'checkbox' | 'textarea'
  value: string
  label: string
  item: string | null
  section: string | null
  optionLabel?: string
  checked?: boolean
  disabled: boolean
  visible?: boolean
  maxLength?: number
  options?: { value: string; label: string }[]
}

export interface FormInstance {
  readonly code: string
  fields(): FieldSnapshot[]
  set(id: string, value: string | boolean): void
  get(id: string): string | boolean
  call(fn: string, ...args: unknown[]): unknown
  validate(logger?: ValidationLogger): ValidationResult
  readonly alerts: string[]
  readonly errors: string[]
  captureSaveXml(): string
  close(): Promise<void>
}

interface OpenOfficialFormOptions {
  packageDir?: string
  now?: Date
}

const repositoryRoot = resolve(import.meta.dir, '../../..')
const defaultPackageDir = join(repositoryRoot, 'vendor', 'buwiz-validation', 'package')

export async function openOfficialForm(
  code: string,
  opts: OpenOfficialFormOptions = {},
): Promise<FormInstance> {
  const packageDir = resolve(opts.packageDir ?? defaultPackageDir)
  const formsDir = join(packageDir, 'forms')
  const formPath = join(formsDir, `BIR-Form${code}.hta`)
  const html = readFileSync(formPath, 'utf8').replace(/^\uFEFF/, '')
  const alerts: string[] = []
  const errors: string[] = []
  const now = opts.now ?? new Date()
  const window = new Window({
    url: pathToFileURL(`${formsDir}${sep}`).href,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      errorCapture: 'tryAndCatch',
    } as any,
  })
  const w = window as any
  w.d = window.document
  const tableSectionPrototype = w.HTMLTableSectionElement?.prototype
  if (tableSectionPrototype && !('rows' in tableSectionPrototype)) {
    Object.defineProperty(tableSectionPrototype, 'rows', {
      configurable: true,
      get(this: any) {
        return Array.from(this.children).filter((child: any) => child.tagName === 'TR')
      },
    })
  }
  let saveXml = ''

  const focusLog: string[] = []
  const alertFocusMarks: number[] = []
  w.alert = (message: unknown) => {
    alertFocusMarks.push(focusLog.length)
    alerts.push(String(message))
  }
  w.confirm = () => true
  w.onerror = (message: unknown, _source: unknown, _line: unknown, _column: unknown, error: unknown) => {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(message))
    return true
  }
  window.addEventListener('error', (event: any) => {
    const error = event.error
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(event.message ?? error))
  })
  window.addEventListener('unhandledrejection', (event: any) => {
    const reason = event.reason
    errors.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason))
  })

  const trackFocusTarget = (prototype: any, method: string) => {
    if (!prototype || typeof prototype[method] !== 'function') {
      return
    }
    const original = prototype[method]
    prototype[method] = function (this: any, ...args: unknown[]) {
      if (this?.id) {
        focusLog.push(this.id)
      }
      return original.apply(this, args)
    }
  }
  trackFocusTarget(w.HTMLElement?.prototype, 'focus')
  trackFocusTarget(w.HTMLInputElement?.prototype, 'select')
  trackFocusTarget(w.HTMLTextAreaElement?.prototype, 'select')

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
  const insidePackage = (filePath: string) => {
    const lexical = relative(packageDir, filePath)
    if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
      return false
    }
    const real = relative(realpathSync(packageDir), realpathSync(filePath))
    return !(real === '..' || real.startsWith(`..${sep}`) || isAbsolute(real))
  }
  const openPackageTextFile = (fileLocation: string, ioMode = 1) => {
    if (ioMode !== 1 || isAbsolute(fileLocation)) {
      throw new Error(`Unsupported file access: ${fileLocation}`)
    }
    const filePath = resolve(packageDir, fileLocation)
    if (!insidePackage(filePath)) {
      throw new Error(`File access is outside the official package: ${fileLocation}`)
    }
    const contents = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
    let consumed = false
    let closed = false
    return {
      get AtEndOfStream() {
        return !contents.length || consumed || closed
      },
      ReadAll() {
        if (consumed || closed) {
          return ''
        }
        consumed = true
        return contents
      },
      Close() {
        closed = true
      },
    }
  }
  w.ActiveXObject = function (programId: string) {
    return new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'OpenTextFile' && programId === 'Scripting.FileSystemObject') {
            return openPackageTextFile
          }
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
    const scripts: string[] = []
    const documentHtml = html.replace(
      /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
      (_match, attributes: string, content: string) => {
        const isVBScript =
          /\blanguage\s*=\s*["']?\s*vbscript\b/i.test(attributes) ||
          /\btype\s*=\s*["']?\s*text\/vbscript\b/i.test(attributes)
        if (isVBScript) {
          return ''
        }
        const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes)
        if (src) {
          const scriptSrc = (src[1] ?? src[2] ?? src[3] ?? '').trim()
          if (scriptSrc.startsWith('//')) {
            return ''
          }
          const scriptUrl = new URL(scriptSrc, pathToFileURL(formPath))
          if (scriptUrl.protocol === 'file:') {
            const scriptPath = fileURLToPath(scriptUrl)
            if (!insidePackage(scriptPath)) {
              throw new Error(`Script is outside the official package: ${scriptSrc}`)
            }
            scripts.push(readFileSync(scriptPath, 'utf8'))
          }
        } else {
          scripts.push(content)
        }
        return ''
      },
    )
    window.document.write(documentHtml)

    const radioOptionLabels = new Map<string, string>()
    for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
      if (!/\btype\s*=\s*["']?radio\b/i.test(match[0])) continue
      const idMatch = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0])
      const labelMatch = /^\s*<label\b[^>]*>([\s\S]*?)<\/label\s*>/i.exec(
        html.slice((match.index ?? 0) + match[0].length),
      )
      const rawText = labelMatch?.[1].replace(/<[^>]*>/g, '') ?? ''
      const text = rawText
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim()
      const id = idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3]
      if (id && text) radioOptionLabels.set(id, text)
    }

    for (const script of scripts) {
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
    let waitTimer: ReturnType<typeof globalThis.setTimeout> | undefined
    try {
      await Promise.race([
        window.happyDOM.waitUntilComplete(),
        new Promise<void>((resolveWait) => {
          waitTimer = globalThis.setTimeout(resolveWait, 3000)
        }),
      ])
    } finally {
      if (waitTimer !== undefined) {
        globalThis.clearTimeout(waitTimer)
      }
    }

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

    const formElements = (): any[] => Array.from((mainForm as any).elements) as any[]

    const findValidateButton = (): any => {
      const named = (element: any) => String(element.value ?? '').trim() === 'Validate'
      const candidates = formElements().filter(named)
      const fallback = candidates.length
        ? candidates
        : (Array.from(window.document.querySelectorAll('input')) as any[]).filter(named)
      const button =
        fallback.find((element) => String(element.id ?? '').endsWith('cmdValidate')) ?? fallback[0]
      if (!button) {
        throw new Error(`Official form ${code} does not contain a Validate button.`)
      }
      return button
    }

    const captureFormState = () =>
      formElements().map((element) => ({
        element,
        value: element.value,
        checked: element.checked,
        disabled: element.disabled,
        selectedIndex: element.selectedIndex,
      }))

    const restoreFormState = (snapshot: ReturnType<typeof captureFormState>) => {
      for (const state of snapshot) {
        const element = state.element
        if (
          typeof state.selectedIndex === 'number' &&
          element.selectedIndex !== state.selectedIndex
        ) {
          element.selectedIndex = state.selectedIndex
        }
        if (element.value !== state.value) {
          element.value = state.value
        }
        if (typeof state.checked === 'boolean' && element.checked !== state.checked) {
          element.checked = state.checked
        }
        if (element.disabled !== state.disabled) {
          element.disabled = state.disabled
        }
      }
    }

    const evaluateInSandbox = (prelude: string, expression: string): unknown =>
      w.eval(`(function () {\n${prelude}\nreturn (${expression});\n})()`)

    const controlSelector = 'input, select, textarea, button'
    const previousNode = (node: any): any => {
      if (node?.previousSibling) {
        node = node.previousSibling
        if (node.matches?.(controlSelector)) return node
        while (node.lastChild) {
          if (node.lastChild.matches?.(controlSelector)) return node.lastChild
          node = node.lastChild
        }
        return node
      }
      return node?.parentNode
    }
    const nextNode = (node: any): any => {
      if (node?.firstChild) return node.firstChild
      while (node && !node.nextSibling) node = node.parentNode
      return node?.nextSibling
    }
    const adjacentText = (element: any, direction: -1 | 1): string => {
      let node = element
      while ((node = direction < 0 ? previousNode(node) : nextNode(node)) && node !== mainForm) {
        if (node.nodeType === 3) {
          const value = String(node.nodeValue ?? '').replace(/\s+/g, ' ').trim()
          if (value && !/^[\p{P}\p{S}\s]+$/u.test(value) && !/^\d+[A-Z]?$/i.test(value)) {
            const cell = (node.parentElement as any)?.closest?.('td, th')
            const cellText = String(cell?.textContent ?? '').replace(/\s+/g, ' ').trim()
            if (cell && !cell.querySelector(controlSelector) && cellText) return cellText
            return value
          }
        } else if (node.nodeType === 1) {
          if (node.matches?.(controlSelector) && node !== element) return ''
          if (node.matches?.('option')) return ''
          if (node.matches?.('script, style')) {
            node = direction < 0 ? previousNode(node) : node
          }
        }
      }
      return ''
    }

  const splitItem = (value: string): { label: string; item: string | null } => {
      const text = value.replace(/\s+/g, ' ').trim()
      const match = /^(\d+[A-Z]?)(?:\s*[-.)]\s*|\s+|$)(.*)$/i.exec(text)
      return {
        label: match ? match[2].trim() : text,
        item: match?.[1] ?? null,
      }
  }

  const tableColumnLabel = (element: any): string => {
    let cell = element.closest('td, th')
    let row = cell?.parentElement
    let table = row?.closest('table')
    while (cell && row && table) {
      const column = Array.from(row.children).indexOf(cell)
      const rows = (Array.from(table.querySelectorAll('tr')) as any[])
        .filter((candidate) => candidate.closest('table') === table)
      for (let index = rows.indexOf(row) - 1; index >= 0; index -= 1) {
        const candidate = rows[index].children[column]
        if (!candidate || candidate.querySelector(controlSelector)) continue
        const text = String(candidate.textContent ?? '').replace(/\s+/g, ' ').trim()
        if (text && !/^[\p{P}\p{S}\s]+$/u.test(text)) return text
      }
      row = table.closest('tr')
      cell = row?.querySelector('td, th') ?? null
      table = row?.closest('table')
    }
    return ''
  }

  const fieldLabel = (element: any): { label: string; item: string | null; optionLabel: string } => {
    let label = adjacentText(element, -1)
    if (!label) {
      const associatedLabel = Array.from(element.labels ?? []) as any[]
      label = associatedLabel.map((candidate) => String(candidate.textContent ?? '').trim()).find(Boolean) ?? ''
    }
    if (!label) {
      const row = element.closest('tr')
      const controls = row ? Array.from(row.querySelectorAll(controlSelector)) as any[] : []
      const firstControl = controls[0]
      if (firstControl && controls.indexOf(element) > 0) {
        label = adjacentText(firstControl, -1)
      }
    }
    if (!label) label = tableColumnLabel(element)
    if (!label && /2$/.test(element.id)) {
      const baseId = element.id.slice(0, -1)
      const original = mainForm.ownerDocument.getElementById(baseId)
      if (original) label = fieldLabel(original).label
    }
    if (!label && element.type === 'checkbox') label = 'Remove schedule row'
    let optionLabel = ''
    if (element.type === 'radio') {
      const associatedLabel = (Array.from(element.labels ?? []) as any[]).find(
        (candidate) => String(candidate.textContent ?? '').trim(),
      )
      let sibling = element.nextSibling
      let siblingLabel: any = null
      while (sibling) {
        if (sibling.nodeType === 1) {
          if (sibling.tagName?.toLowerCase() === 'label') {
            siblingLabel = sibling
            break
          }
          if (sibling.matches?.(controlSelector)) break
          siblingLabel = sibling.querySelector?.('label') ?? null
          if (siblingLabel) break
        }
        sibling = sibling.nextSibling
      }
      const radioGroup = (Array.from(mainForm.querySelectorAll('input[type="radio"]')) as any[])
        .filter((radio) => radio.name === element.name)
      const groupIndex = radioGroup.indexOf(element)
      const row = element.closest('tr')
      const rowLabels = row ? Array.from(row.querySelectorAll('label')) as any[] : []
      optionLabel =
        radioOptionLabels.get(element.id) ||
        String(associatedLabel?.textContent ?? siblingLabel?.textContent ?? '').trim() ||
        String(rowLabels.slice(-radioGroup.length)[groupIndex]?.textContent ?? '').trim() ||
        adjacentText(element, 1) ||
        adjacentText(element, -1)
    }
    const parsed = splitItem(label)
    const rowItem = splitItem(String(element.closest('tr')?.textContent ?? '')).item
    return {
      label: parsed.label || element.id,
      item: parsed.item ?? rowItem,
      optionLabel: optionLabel.replace(/\s+/g, ' ').trim(),
    }
    }

    const fieldSectionCache = new WeakMap<any, string | null>()
    const fieldSection = (element: any): string | null => {
      if (fieldSectionCache.has(element)) {
        return fieldSectionCache.get(element) ?? null
      }
      const walker = w.document.createTreeWalker(mainForm, w.NodeFilter.SHOW_TEXT)
      let section: string | null = null
      let node = walker.nextNode()
      while (node) {
        if (
          element.compareDocumentPosition(node) &
          w.Node.DOCUMENT_POSITION_FOLLOWING
        ) {
          break
        }
        const text = String(node.nodeValue ?? '').replace(/\s+/g, ' ').trim()
        const match = /^Part\s+(IV|III|II|I|V)\b\s*[--:]?\s*(.*)$/i.exec(text)
        if (match) {
          const smallWords = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to'])
          const title = match[2]
            .toLowerCase()
            .split(/\s+/)
            .map((word, index) =>
              index > 0 && smallWords.has(word)
                ? word
                : word.replace(/^[a-z]/, (letter) => letter.toUpperCase()),
            )
            .join(' ')
          section = `Part ${match[1].toUpperCase()}${title ? ` - ${title}` : ''}`
        }
        node = walker.nextNode()
      }
      fieldSectionCache.set(element, section)
      return section
    }

    const isVisible = (element: any): boolean => {
      let node = element
      while (node) {
        if (
          node.hidden ||
          node.style?.display === 'none' ||
          node.style?.visibility === 'hidden'
        ) {
          return false
        }
        node = node.parentElement
      }
      return true
    }

    let cachedValidation:
      | {
          source: string
          entries: Array<{
            guard: ReturnType<typeof extractGuards>[number]
            evaluate: () => unknown
          }>
        }
      | undefined

    const instance: FormInstance = {
      code,
      alerts,
      errors,
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
            const text = fieldLabel(element)
            const field: FieldSnapshot = {
              id: element.id,
              name: element.name ?? '',
              type,
              value: element.value,
              label: text.label,
              item: text.item,
              section: fieldSection(element),
              optionLabel: text.optionLabel || undefined,
              disabled: element.disabled,
              visible: isVisible(element),
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
      validate(logger) {
        const button = findValidateButton()
        const onclick = button.getAttribute('onclick') ?? ''
        const handlerName = /([A-Za-z_$][\w$]*)\s*\(/.exec(onclick)?.[1]
        const handler = handlerName ? w[handlerName] : undefined
        if (typeof handler !== 'function') {
          throw new Error(`Official form ${code} does not expose a validate handler.`)
        }

        const snapshot = captureFormState()
        alerts.length = 0
        alertFocusMarks.length = 0
        focusLog.length = 0
        let runError: unknown
        try {
          button.dispatchEvent(new (w.Event)('click', { bubbles: true }))
        } catch (error) {
          runError = error
        }
        const firstMessage = alerts[0]
        const alertMark = alertFocusMarks[0] ?? 0
        const nextAlertMark = alertFocusMarks[1] ?? focusLog.length
        const formFieldIds = new Set(instance.fields().map((field) => field.id))
        const officialFieldId =
          [...focusLog.slice(alertMark, nextAlertMark).reverse(), ...focusLog.slice(0, alertMark).reverse()]
            .find((id) => formFieldIds.has(id)) ?? null
        const officialAlerts = alerts.slice()
        restoreFormState(snapshot)

        if (runError) {
          logger?.log('warn', 'runtime.validate', 'Official validate handler threw', {
            code,
            error: String(runError),
          })
        }

        const officialFirst: ValidationIssue | null =
          firstMessage === undefined || /validation successful/i.test(firstMessage)
            ? null
            : { message: firstMessage, fieldId: officialFieldId, source: 'official' }

        const handlerSource = handler.toString()
        if (!cachedValidation || cachedValidation.source !== handlerSource) {
          cachedValidation = {
            source: handlerSource,
            entries: extractGuards(handlerSource).map((guard) => ({
              guard,
              evaluate: w.Function(
                `return (function () {\n${guard.prelude}\nif (!(${guard.test})) { return null; }\nreturn String(${guard.message});\n})()`,
              ) as () => unknown,
            })),
          }
        }
        const issues: ValidationIssue[] = []
        const seen = new Set<string>()
        let evaluated = 0
        let failedToEvaluate = 0
        for (const { guard, evaluate } of cachedValidation.entries) {
          restoreFormState(snapshot)
          try {
            const result = evaluate()
            evaluated += 1
            if (result === null) {
              continue
            }
            const message = String(result)
            const key = `${guard.fieldId}|${message}`
            if (seen.has(key)) {
              continue
            }
            seen.add(key)
            issues.push({
              message,
              fieldId: guard.fieldId,
              source: 'guard',
              guardIndex: guard.index,
            })
          } catch {
            failedToEvaluate += 1
          } finally {
            restoreFormState(snapshot)
          }
        }
        alerts.splice(0, alerts.length, ...officialAlerts)

        if (officialFirst) {
          const duplicate = issues.findIndex(
            (issue) =>
              issue.message === officialFirst.message && issue.fieldId === officialFirst.fieldId,
          )
          if (
            issues[0]?.message !== officialFirst.message ||
            issues[0]?.fieldId !== officialFirst.fieldId
          ) {
            logger?.log('warn', 'runtime.validate', 'Guard extraction disagrees with the official first alert', {
              code,
              officialMessage: officialFirst.message,
              officialFieldId: officialFirst.fieldId,
              extractedFirst: issues[0]?.message ?? null,
            })
          }
          if (duplicate >= 0) {
            issues.splice(duplicate, 1)
          }
          issues.unshift(officialFirst)
        }

        return {
          officialFirst,
          issues,
          coverage: {
            guards: cachedValidation.entries.length,
            evaluated,
            failedToEvaluate,
          },
        }
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
