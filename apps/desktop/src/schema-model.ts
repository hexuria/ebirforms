import type { FieldSnapshot, ValidationIssue } from '@ebirforms/runtime'

/**
 * On-screen form layout from the design prototype's schema
 * (hexuria/buwiz-ui-redesign forms/forms-schema.json, built from the
 * buwiz-forms rules corpus). Field keys are the official runtime field ids,
 * so each schema field binds to a live FieldSnapshot.
 */
export type SchemaFieldType = 'text' | 'money' | 'pct' | 'date' | 'sel' | 'radio' | 'chk' | 'int' | 'email' | 'phone'

export interface SchemaField {
  /** Field label (option text for a radio). */
  l: string
  t: SchemaFieldType
  /** Official runtime field id. */
  k?: string
  r?: 1
  c?: 1
  m?: number
  o?: string[]
  a?: 1
}

export interface SchemaItem {
  no: string
  l: string
  p: number
  f?: SchemaField[]
  cols?: Array<{ l: string; t: SchemaFieldType; c?: 1 }>
  rows?: number
  keys?: Array<Array<string | null>>
}

export interface FormSchema {
  title: string
  frequency: string
  revision: string
  pages: number
  fields: number
  draftLayout: boolean
  rulesId: string
  parts: Array<{ name: string; items: SchemaItem[] }>
}

export interface BoundField {
  spec: SchemaField
  field: FieldSnapshot | null
}

export interface ModelItem {
  id: string
  no: string
  label: string
  kind: 'fields' | 'table' | 'more'
  fields: BoundField[]
  cols: Array<{ l: string; t: SchemaFieldType; c?: 1 }>
  cells: Array<Array<FieldSnapshot | null>>
  required: boolean
  computed: boolean
  /** Filled from the tax profile and locked (D18). */
  auto: boolean
  tin: boolean
  /** Messages for this item; the editor reserves one line for it whether or not it is empty. */
  errorText: string
}

export interface ModelPart {
  name: string
  items: ModelItem[]
}

const STOPWORDS = new Set(['please', 'enter', 'valid', 'select', 'option', 'item', 'items', 'the', 'for', 'your', 'and', 'this', 'with', 'from', 'must', 'not', 'are', 'that', 'number'])

/** "01" and "1" name the same item; compare without leading zeros. */
export function normalizeItemNo(no: string): string {
  return no.trim().replace(/^0+(?=\d)/, '').toUpperCase()
}

export function itemNoInMessage(message: string): string | null {
  const match = /\bitems?\s*(?:no\.?\s*)?(\d+[A-Za-z]?)\b/i.exec(message)
  return match ? normalizeItemNo(match[1]) : null
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
}

/** First and last Part names a "Page 1" header block as the return details (prototype partName). */
export function partDisplayName(name: string, index: number): string {
  return index === 0 && /^Page \d+$/.test(name) ? 'Return details' : name
}

export function buildSchemaModel(
  schema: FormSchema,
  snapshot: FieldSnapshot[],
  issues: ValidationIssue[],
  lockedFieldIds: ReadonlySet<string> = new Set(),
): ModelPart[] {
  const byId = new Map(snapshot.map((field) => [field.id, field]))
  const parts: ModelPart[] = schema.parts.map((part, partIndex) => ({
    name: partDisplayName(part.name, partIndex),
    items: part.items.map((item, itemIndex) => {
      const id = `${partIndex}:${itemIndex}`
      if (item.rows && item.cols) {
        const cells = (item.keys ?? []).map((row) => row.map((key) => (key ? byId.get(key) ?? null : null)))
        return { id, no: item.no, label: item.l, kind: 'table', fields: [], cols: item.cols, cells, required: false, computed: false, auto: false, tin: false, errorText: '' }
      }
      const fields = (item.f ?? []).map((spec) => ({ spec, field: spec.k ? byId.get(spec.k) ?? null : null }))
      const tin = /\bTIN\b|Identification Number/i.test(item.l) && fields.length >= 3 && fields.length <= 5 && fields.every(({ spec }) => spec.t === 'text' || spec.t === 'int')
      const auto = tin || fields.some(({ spec }) => (spec.a && !spec.c) || (spec.k ? lockedFieldIds.has(spec.k) : false))
      return {
        id,
        no: item.no,
        label: item.l,
        kind: item.l === 'Additional details' ? 'more' : 'fields',
        fields,
        cols: [],
        cells: [],
        required: fields.some(({ spec }) => spec.r),
        computed: fields.length > 0 && fields.every(({ spec }) => spec.c),
        auto,
        tin,
        errorText: '',
      } satisfies ModelItem
    }),
  }))

  const all = parts.flatMap((part) => part.items)
  const placeable = all.filter((item) => item.kind !== 'more')
  const byKey = new Map<string, ModelItem>()
  for (const item of all) {
    for (const { spec } of item.fields) if (spec.k) byKey.set(spec.k, item)
    for (const row of item.cells) for (const cell of row) if (cell) byKey.set(cell.id, item)
  }
  const byNo = new Map<string, ModelItem>()
  for (const item of placeable) if (item.no && !byNo.has(normalizeItemNo(item.no))) byNo.set(normalizeItemNo(item.no), item)

  const add = (item: ModelItem, message: string) => {
    if (!item.errorText.split('\n').includes(message)) item.errorText = item.errorText ? `${item.errorText}\n${message}` : message
  }
  for (const issue of issues) {
    const message = issue.message
    const viaField = issue.fieldId ? byKey.get(issue.fieldId) : undefined
    if (viaField) {
      add(viaField, message)
      continue
    }
    const no = itemNoInMessage(message)
    const viaNo = no ? byNo.get(no) : undefined
    if (viaNo) {
      add(viaNo, message)
      continue
    }
    const tokens = words(message)
    let best: ModelItem | undefined
    let bestScore = 0
    for (const item of placeable) {
      const label = new Set(words(item.label))
      const score = tokens.filter((token) => label.has(token)).length
      if (score > bestScore) {
        best = item
        bestScore = score
      }
    }
    const target = best ?? placeable[0] ?? all[0]
    if (target) add(target, message)
  }
  return parts
}
