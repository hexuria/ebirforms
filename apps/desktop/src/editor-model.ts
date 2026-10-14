import type { Profile } from '@ebirforms/core'
import type { FieldSnapshot, ValidationIssue } from '@ebirforms/runtime'

export interface EditorRow {
  id: string
  name: string
  label: string
  item: string | null
  kind: 'field' | 'radio' | 'tin' | 'period'
  type: FieldSnapshot['type']
  fields: FieldSnapshot[]
  errorText: string
  locked: boolean
}

export interface EditorSection {
  section: string | null
  rows: EditorRow[]
}

export interface EditorModel {
  bannerErrorText: string
  sections: EditorSection[]
}

export type PrefillFormCode = '1601Cv2018' | '2551Qv2018' | '0619E'

export const formCategories: Record<string, string> = {
  '0619E': 'Withholding Tax',
  '1601C': 'Withholding Tax',
  '1601Cv2018': 'Withholding Tax',
  '1701': 'Income Tax',
  '1701Q': 'Income Tax',
  '2551Q': 'Percentage Tax',
  '2551Qv2018': 'Percentage Tax',
  '2550Q': 'VAT',
}

export function displayFormCode(code: string): string {
  return code.replace(/v\d{4}.*$/i, '')
}

export function cleanFormTitle(label: string): string {
  return label
    .replace(/^BIR Form(?: No\.?)?\s+.*?\s+[-–—]\s*/i, '')
    .replace(/\s*\(NEW\)\s*$/i, '')
    .trim()
}

export function formCategory(code: string): string {
  return formCategories[code] ?? 'Tax Return'
}

export const prefillMap: Record<
  PrefillFormCode,
  {
    tin: [string, string, string]
    branch: string
    rdo: string
    name: string
    address: string
    address2?: string
    zip: string
    email: string
    phone?: string
    period:
      | { kind: 'monthly'; month: string; year: string }
      | { kind: 'quarterly'; year: string; quarter: [string, string, string, string] }
  }
> = {
  '1601Cv2018': {
    tin: ['frm1601c:txtTIN1', 'frm1601c:txtTIN2', 'frm1601c:txtTIN3'],
    branch: 'frm1601c:txtBranchCode',
    rdo: 'frm1601c:txtRDOCode',
    name: 'frm1601c:txtTaxpayerName',
    address: 'frm1601c:txtAddress',
    address2: 'frm1601c:txtAddress2',
    zip: 'frm1601c:txtZipCode',
    email: 'txtEmail',
    phone: 'frm1601c:txtTelNum',
    period: { kind: 'monthly', month: 'frm1601c:txtMonth', year: 'frm1601c:txtYear' },
  },
  '2551Qv2018': {
    tin: [
      'frm2551Qv2018:txtTIN1',
      'frm2551Qv2018:txtTIN2',
      'frm2551Qv2018:txtTIN3',
    ],
    branch: 'frm2551Qv2018:txtBranchCode',
    rdo: 'frm2551Qv2018:txtRDOCode',
    name: 'frm2551Qv2018:registeredName',
    address: 'frm2551Qv2018:registeredAddress',
    zip: 'frm2551Qv2018:zipCode',
    email: 'txtEmail',
    period: {
      kind: 'quarterly',
      year: 'frm2551Qv2018:txtYear',
      quarter: [
        'frm2551Qv2018:qtr_1',
        'frm2551Qv2018:qtr_2',
        'frm2551Qv2018:qtr_3',
        'frm2551Qv2018:qtr_4',
      ],
    },
  },
  '0619E': {
    tin: ['frm0619E:txtTIN1', 'frm0619E:txtTIN2', 'frm0619E:txtTIN3'],
    branch: 'frm0619E:txtBranchCode',
    rdo: 'frm0619E:txtRDOCode',
    name: 'frm0619E:txtTaxpayerName',
    address: 'frm0619E:txtAddress',
    address2: 'frm0619E:txtAddress2',
    zip: 'frm0619E:txtZipCode',
    email: 'txtEmail',
    period: { kind: 'monthly', month: 'frm0619E:txtMonth', year: 'frm0619E:txtYear' },
  },
}

export function autoFieldIds(code: PrefillFormCode): Set<string> {
  const mapping = prefillMap[code]
  const periodIds =
    mapping.period.kind === 'monthly'
      ? [mapping.period.month, mapping.period.year]
      : [mapping.period.year, ...mapping.period.quarter]
  return new Set([
    ...mapping.tin,
    mapping.branch,
    mapping.rdo,
    mapping.name,
    mapping.address,
    ...(mapping.address2 ? [mapping.address2] : []),
    mapping.zip,
    ...periodIds,
  ])
}

export function buildPrefillValues(
  code: PrefillFormCode,
  profile: Pick<
    Profile,
    'tin9' | 'branch' | 'rdo' | 'registeredName' | 'address' | 'zip' | 'email' | 'phone'
  >,
  fields: FieldSnapshot[],
  period: string,
): Record<string, string | boolean> {
  const mapping = prefillMap[code]
  const widths = code === '2551Qv2018' ? [4, 4, 1] : [3, 3, 3]
  let tinOffset = 0
  const values: Record<string, string | boolean> = {}
  for (const [index, id] of mapping.tin.entries()) {
    const width = widths[index]
    values[id] = profile.tin9.slice(tinOffset, tinOffset + width)
    tinOffset += width
  }
  values[mapping.branch] = profile.branch
  values[mapping.rdo] = profile.rdo
  values[mapping.name] = profile.registeredName
  const addressField = fields.find((field) => field.id === mapping.address)
  const addressLimit = addressField?.maxLength ?? profile.address.length
  values[mapping.address] = profile.address.slice(0, addressLimit)
  if (mapping.address2) {
    values[mapping.address2] = profile.address.slice(addressLimit)
  }
  values[mapping.zip] = profile.zip
  values[mapping.email] = profile.email
  if (mapping.phone) {
    values[mapping.phone] = profile.phone
  }
  if (mapping.period.kind === 'monthly') {
    const monthlyPeriod = mapping.period
    const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period)
    if (!match) {
      throw new Error(`Expected a monthly period for ${code}.`)
    }
    const monthField = fields.find((field) => field.id === monthlyPeriod.month)
    values[monthlyPeriod.year] = match[1]
    values[monthlyPeriod.month] =
      monthField?.options?.find((option) => option.value === match[2])?.value ??
      monthField?.options?.[Number(match[2]) - 1]?.value ??
      match[2]
  } else {
    const match = /^(\d{4})-Q([1-4])$/.exec(period)
    if (!match) {
      throw new Error(`Expected a quarterly period for ${code}.`)
    }
    values[mapping.period.year] = match[1]
    mapping.period.quarter.forEach((id, index) => {
      values[id] = String(index + 1) === match[2]
    })
  }
  return values
}

export function mergeDraftPrefill(
  savedValues: Record<string, string | boolean>,
  prefillValues: Record<string, string | boolean>,
): Record<string, string | boolean> {
  return { ...savedValues, ...prefillValues }
}

export function buildEditorModel(
  snapshot: FieldSnapshot[],
  issues: ValidationIssue[],
  lockedFieldIds: ReadonlySet<string> = new Set(),
): EditorModel {
  const issuesByField = new Map<string, string[]>()
  for (const issue of issues) {
    if (issue.fieldId) {
      issuesByField.set(issue.fieldId, [
        ...(issuesByField.get(issue.fieldId) ?? []),
        issue.message,
      ])
    }
  }
  const rows: EditorRow[] = []
  const groupedRows = new Map<string, EditorRow>()
  for (const field of snapshot) {
    if (field.visible === false) continue
    const section = field.section ?? 'Part I - Background Information'
    const group =
      /(?:txtTIN[123]|BranchCode)/i.test(field.id)
        ? `tin:${section}`
        : /(?:txtMonth|rtnMonth|txtYear|qtr_[1-4])/i.test(field.id)
          ? `period:${section}`
          : field.type === 'radio'
            ? `radio:${section}:${field.name || field.id}`
            : null
    const kind: EditorRow['kind'] =
      group?.startsWith('tin:') ? 'tin' : group?.startsWith('period:') ? 'period' : group ? 'radio' : 'field'
    const key = group ?? (field.item ? `item:${section}:${field.item}` : field.id)
    const existing = groupedRows.get(key)
    if (existing) {
      existing.fields.push(field)
      existing.locked ||= lockedFieldIds.has(field.id) || field.disabled
      const messages = issuesByField.get(field.id) ?? []
      if (messages.length) {
        existing.errorText = [...new Set([...existing.errorText.split('\n'), ...messages])]
          .filter(Boolean)
          .join('\n')
      }
      continue
    }
    const messages = issuesByField.get(field.id) ?? []
    const row: EditorRow = {
      id: key,
      name: field.name || field.id,
      label: field.label,
      item: field.item,
      kind,
      type: field.type,
      fields: [field],
      errorText: messages.join('\n'),
      locked: lockedFieldIds.has(field.id) || field.disabled,
    }
    rows.push(row)
    groupedRows.set(key, row)
  }
  const sections: EditorSection[] = []
  for (const row of rows) {
    const sectionName =
      row.kind === 'period'
        ? 'Part I - Background Information'
        : row.fields[0].section ?? 'Part I - Background Information'
    let section = sections.find((entry) => entry.section === sectionName)
    if (!section) {
      section = { section: sectionName, rows: [] }
      sections.push(section)
    }
    section.rows.push(row)
  }
  const sectionOrder = ['Part I', 'Part II', 'Part III', 'Part IV', 'Part V']
  sections.sort(
    (left, right) =>
      sectionOrder.indexOf(left.section?.split(' - ')[0] ?? '') -
      sectionOrder.indexOf(right.section?.split(' - ')[0] ?? ''),
  )
  // Official validation alerts like "Please select an option for Item 3." carry
  // no field focus, so bind them to the row whose item chip matches "Item N"
  // and render them under that row instead of in the banner.
  const rowItems = new Set(
    rows.map((row) => row.item?.toUpperCase()).filter((item): item is string => Boolean(item)),
  )
  const issuesByItem = new Map<string, string[]>()
  const bannerMessages: string[] = []
  for (const issue of issues) {
    if (issue.fieldId) continue
    const match = /\bItem\s*(?:no\.?\s*)?(\d+[A-Za-z]?)\b/i.exec(issue.message)
    const item = match?.[1]?.toUpperCase()
    if (item && rowItems.has(item)) {
      issuesByItem.set(item, [...(issuesByItem.get(item) ?? []), issue.message])
    } else {
      bannerMessages.push(issue.message)
    }
  }
  for (const row of rows) {
    const item = row.item?.toUpperCase()
    const messages = item ? issuesByItem.get(item) : undefined
    if (messages?.length) {
      row.errorText = [...new Set([...row.errorText.split('\n'), ...messages])]
        .filter(Boolean)
        .join('\n')
    }
  }
  return {
    bannerErrorText: bannerMessages.join('\n'),
    sections,
  }
}
