import { describe, expect, test } from 'bun:test'
import { buildEditorModel, buildPrefillValues, prefillMap } from './editor-model.js'
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
    disabled: false,
  }) as FieldSnapshot

describe('buildEditorModel', () => {
  test('groups by item in DOM order and combines radios by name', () => {
    const snapshot = [
      field('a', '1'),
      field('period-1', '1', 'radio'),
      field('period-2', '1', 'radio'),
      field('b', '2'),
    ]
    const model = buildEditorModel(snapshot, [])
    expect(model.sections.map((section) => section.item)).toEqual(['1', '2'])
    expect(model.sections[0].rows.map((row) => row.id)).toEqual(['a', 'period'])
    expect(model.sections[0].rows[1].fields.map((radio) => radio.id)).toEqual([
      'period-1',
      'period-2',
    ])
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
          const values = buildPrefillValues(code, profile, fields)
          expect(Object.keys(values).length).toBeGreaterThanOrEqual(9)
          expect(Object.keys(values).every((id) => fields.some((field) => field.id === id))).toBe(
            true,
          )
          const mapping = prefillMap[code]
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
