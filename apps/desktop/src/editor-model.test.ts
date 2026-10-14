import { describe, expect, test } from 'bun:test'
import {
  autoFieldIds,
  buildEditorModel,
  buildPrefillValues,
  mergeDraftPrefill,
  prefillMap,
  type PrefillFormCode,
} from './editor-model.js'
import type { FieldSnapshot, ValidationIssue } from '@ebirforms/runtime'
import { openOfficialForm } from '@ebirforms/runtime'

const field = (id: string, item: string | null, type: FieldSnapshot['type'] = 'text') =>
  ({
    id,
    name: type === 'radio' ? 'period' : id,
    type,
    value: '',
    label: id,
    item,
    section: null,
    disabled: false,
  }) as FieldSnapshot

const sectionCases: Record<PrefillFormCode, Array<[string, string]>> = {
  '1601Cv2018': [
    ['frm1601c:txtTaxpayerName', 'Part IV'],
    ['frm1601c:txtTax14', 'Part IV'],
    ['frm1601c:txtAgency37', 'Part IV'],
  ],
  '2551Qv2018': [
    ['frm2551Qv2018:registeredName', 'Part III'],
    ['frm2551Qv2018:txt15', 'Part III'],
    ['frm2551Qv2018:txtAgency25', 'Part III'],
  ],
  '0619E': [
    ['frm0619E:txtTaxpayerName', 'Part III'],
    ['frm0619E:txtTax14', 'Part III'],
    ['txtAgency19', 'Part III'],
  ],
}

describe('buildEditorModel', () => {
  test('groups by official section and combines radios by name', () => {
    const snapshot = [
      { ...field('a', '1'), section: 'Part I - Background Information' },
      { ...field('period-1', '1', 'radio'), section: 'Part I - Background Information' },
      { ...field('period-2', '1', 'radio'), section: 'Part I - Background Information' },
      { ...field('b', '2'), section: 'Part II - Computation of tax' },
    ]
    const model = buildEditorModel(snapshot, [])
    expect(model.sections.map((section) => section.section)).toEqual([
      'Part I - Background Information',
      'Part II - Computation of tax',
    ])
    expect(model.sections[0].rows.map((row) => row.id)).toEqual(['a', 'period'])
    expect(model.sections[0].rows[1].fields.map((radio) => radio.id)).toEqual([
      'period-1',
      'period-2',
    ])
  })

  test('marks automatic and computed fields as read-only', () => {
    const model = buildEditorModel(
      [
        { ...field('auto', null), disabled: false },
        { ...field('computed', null), disabled: true },
      ],
      [],
      new Set(['auto']),
    )
    expect(model.sections[0].rows.map((row) => row.locked)).toEqual([true, true])
  })

  test('always returns string error rows and reserves null-field issues for the banner', () => {
    const issues: ValidationIssue[] = [
      { message: 'Invalid field', fieldId: 'a', source: 'guard' },
      { message: 'General error', fieldId: null, source: 'official' },
    ]
    const model = buildEditorModel([field('a', '1'), field('b', '1')], issues)
    expect(model.sections[0].rows.map((row) => row.errorText)).toEqual([
      'Invalid field',
      '',
    ])
    expect(typeof model.sections[0].rows[1].errorText).toBe('string')
    expect(model.bannerErrorText).toBe('General error')
  })
})

describe('form prefill maps', () => {
  test(
    'map every profile value to a live official field and split long addresses',
    async () => {
      const profile = {
        tin9: '123456788',
        branch: '00002',
        rdo: '039',
        registeredName: 'Test Taxpayer',
        address: 'A'.repeat(180),
        zip: '1000',
        email: 'TEST@example.com',
        phone: '5551234',
      }
      for (const code of Object.keys(prefillMap) as Array<keyof typeof prefillMap>) {
        const form = await openOfficialForm(code)
        try {
          const fields = form.fields()
          for (const [id, section] of sectionCases[code]) {
            expect(fields.find((field) => field.id === id)?.section).toMatch(
              new RegExp(`^${section}\\b`, 'i'),
            )
          }
          const period = code === '2551Qv2018' ? '2025-Q2' : '2025-02'
          const values = buildPrefillValues(code, profile, fields, period)
          const mapping = prefillMap[code]
          const reopenedValues = mergeDraftPrefill(
            {
              [mapping.period.year]: '2026',
              ...(mapping.period.kind === 'monthly' ? { [mapping.period.month]: '10' } : {}),
              'user-entered': 'preserved',
            },
            values,
          )
          expect(reopenedValues[mapping.period.year]).toBe('2025')
          expect(reopenedValues['user-entered']).toBe('preserved')
          if (mapping.period.kind === 'monthly') {
            expect(reopenedValues[mapping.period.month]).toBe(values[mapping.period.month])
          }
          expect(Object.keys(values).length).toBeGreaterThanOrEqual(9)
          expect(Object.keys(values).every((id) => fields.some((field) => field.id === id))).toBe(
            true,
          )
          if (mapping.period.kind === 'monthly') {
            expect(values[mapping.period.year]).toBe('2025')
            expect(values[mapping.period.month]).toBe(
              fields.find((field) => field.id === mapping.period.month)?.options?.find(
                (option) =>
                  option.value === '02' ||
                  option.label.toLowerCase().startsWith('feb'),
              )?.value,
            )
          } else {
            expect(values[mapping.period.year]).toBe('2025')
            expect(
              mapping.period.quarter.map((id) => values[id]),
            ).toEqual([false, true, false, false])
          }
          expect([...autoFieldIds(code)].every((id) => fields.some((field) => field.id === id))).toBe(
            true,
          )
          if (mapping.address2) {
            const addressLimit =
              fields.find((field) => field.id === mapping.address)?.maxLength ?? 0
            expect(values[mapping.address]).toBe('A'.repeat(addressLimit))
            expect(values[mapping.address2]).toBe(profile.address.slice(addressLimit))
          } else {
            expect(values[mapping.address]).toBe(profile.address.slice(0, 100))
          }
          for (const [id, value] of Object.entries(values)) {
            form.set(id, value)
          }
          expect(form.errors).toEqual([])
        } finally {
          await form.close()
        }
      }
    },
    30_000,
  )
})
