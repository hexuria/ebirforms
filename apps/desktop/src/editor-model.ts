import type { Profile } from '@ebirforms/core'
import type { FieldSnapshot, ValidationIssue } from '@ebirforms/runtime'

export interface EditorRow {
  id: string
  name: string
  label: string
  item: string | null
  type: FieldSnapshot['type']
  fields: FieldSnapshot[]
  errorText: string
}

export interface EditorSection {
  item: string | null
  rows: EditorRow[]
}

export interface EditorModel {
  bannerErrorText: string
  sections: EditorSection[]
}

export type PrefillFormCode = '1601Cv2018' | '2551Qv2018' | '0619E'

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
  },
}

export function buildPrefillValues(
  code: PrefillFormCode,
  profile: Pick<
    Profile,
    'tin9' | 'branch' | 'rdo' | 'registeredName' | 'address' | 'zip' | 'email' | 'phone'
  >,
  fields: FieldSnapshot[],
): Record<string, string> {
  const mapping = prefillMap[code]
  const widths = code === '2551Qv2018' ? [4, 4, 1] : [3, 3, 3]
  let tinOffset = 0
  const values: Record<string, string> = {}
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
  return values
}

export function buildEditorModel(
  snapshot: FieldSnapshot[],
  issues: ValidationIssue[],
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
  const radioRows = new Map<string, EditorRow>()
  for (const field of snapshot) {
    const radioGroup = field.type === 'radio' ? field.name || field.id : null
    const existing = radioGroup ? radioRows.get(radioGroup) : undefined
    if (existing) {
      existing.fields.push(field)
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
      id: radioGroup ?? field.id,
      name: radioGroup ?? field.name,
      label: field.label,
      item: field.item,
      type: field.type,
      fields: [field],
      errorText: messages.join('\n'),
    }
    rows.push(row)
    if (radioGroup) {
      radioRows.set(radioGroup, row)
    }
  }
  const sections: EditorSection[] = []
  for (const row of rows) {
    let section = sections.find((entry) => entry.item === row.item)
    if (!section) {
      section = { item: row.item, rows: [] }
      sections.push(section)
    }
    section.rows.push(row)
  }
  return {
    bannerErrorText: issues
      .filter((issue) => issue.fieldId === null)
      .map((issue) => issue.message)
      .join('\n'),
    sections,
  }
}
