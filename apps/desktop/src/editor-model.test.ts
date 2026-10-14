import { describe, expect, test } from 'bun:test'
import {
  autoFieldIds,
  buildEditorModel,
  buildPrefillValues,
  cleanFormTitle,
  displayFormCode,
  formCategories,
  formCategory,
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
    ['frm1601c:txtTaxpayerName', 'Part I'],
    ['frm1601c:txtTax14', 'Part II'],
    ['frm1601c:txtAgency37', 'Part III'],
  ],
  '2551Qv2018': [
    ['frm2551Qv2018:registeredName', 'Part I'],
    ['frm2551Qv2018:txt15', 'Part II'],
    ['frm2551Qv2018:txtAgency25', 'Part III'],
  ],
  '0619E': [
    ['frm0619E:txtTaxpayerName', 'Part I'],
    ['frm0619E:txtTax14', 'Part II'],
    ['txtAgency19', 'Part III'],
  ],
}

describe('form library display metadata', () => {
  test('uses explicit categories and cleans official code/title decoration', () => {
    expect(formCategories).toEqual({
      '0619E': 'Withholding Tax',
      '1601C': 'Withholding Tax',
      '1601Cv2018': 'Withholding Tax',
      '1701': 'Income Tax',
      '1701Q': 'Income Tax',
      '2551Q': 'Percentage Tax',
      '2551Qv2018': 'Percentage Tax',
      '2550Q': 'VAT',
    })
    expect(formCategory('1601Cv2018')).toBe('Withholding Tax')
    expect(formCategory('unknown')).toBe('Tax Return')
    expect(displayFormCode('2551Qv2018')).toBe('2551Q')
    expect(cleanFormTitle('BIR Form No. 1601-C - Monthly Return (NEW)')).toBe('Monthly Return')
  })
})

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
    expect(model.sections[0].rows.map((row) => row.id)).toEqual([
      'item:Part I - Background Information:1',
      'radio:Part I - Background Information:period',
    ])
    expect(model.sections[0].rows[1].fields.map((radio) => radio.id)).toEqual([
      'period-1',
      'period-2',
    ])
  })

  test('groups same-item controls, TIN segments, and month/year controls', () => {
    const partI = 'Part I - Background Information'
    const snapshot = [
      { ...field('frm:txtTIN1', '6'), section: partI },
      { ...field('frm:txtTIN2', '6'), section: partI },
      { ...field('frm:txtTIN3', '6'), section: partI },
      { ...field('frm:txtBranchCode', '6'), section: partI },
      { ...field('frm:txtMonth', '2'), section: partI },
      { ...field('frm:txtYear', '2'), section: partI },
      { ...field('amount-a', '14'), section: 'Part II - Tax' },
      { ...field('amount-b', '14'), section: 'Part II - Tax' },
    ]
    const model = buildEditorModel(snapshot, [])
    expect(model.sections[0].rows.find((row) => row.kind === 'tin')?.fields).toHaveLength(4)
    expect(model.sections[0].rows.find((row) => row.kind === 'period')?.fields.map((entry) => entry.id)).toEqual([
      'frm:txtMonth',
      'frm:txtYear',
    ])
    expect(model.sections[1].rows.find((row) => row.item === '14')?.fields.map((entry) => entry.id)).toEqual([
      'amount-a',
      'amount-b',
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
    expect(model.sections[0].rows.map((row) => row.errorText)).toEqual(['Invalid field'])
    expect(typeof model.sections[0].rows[0].errorText).toBe('string')
    expect(model.bannerErrorText).toBe('General error')
  })

  test('binds null-field "Item N" issues under the row whose item matches', () => {
    const issues: ValidationIssue[] = [
      { message: 'Please select an option for Item 3.', fieldId: null, source: 'official' },
      { message: 'Invalid amount in Item no.14. Value must be greater than zero(0).', fieldId: null, source: 'official' },
      { message: 'Please select an option for Item 11.', fieldId: null, source: 'official' },
      { message: 'General error', fieldId: null, source: 'official' },
    ]
    const snapshot = [
      { ...field('a', '3'), section: 'Part I' },
      { ...field('b', '14'), section: 'Part II - Computation' },
    ]
    const model = buildEditorModel(snapshot, issues)
    const rowA = model.sections[0].rows.find((row) => row.item === '3')
    expect(rowA?.errorText).toBe('Please select an option for Item 3.')
    const rowB = model.sections[1].rows.find((row) => row.item === '14')
    expect(rowB?.errorText).toBe('Invalid amount in Item no.14. Value must be greater than zero(0).')
    expect(model.bannerErrorText).toBe('Please select an option for Item 11.\nGeneral error')
  })
})

describe('form prefill maps', () => {
  test(
    'keeps official Parts in order and reports their item ranges',
    async () => {
      const expectedParts: Record<PrefillFormCode, string[]> = {
        '1601Cv2018': ['I', 'II', 'III', 'IV'],
        '2551Qv2018': ['I', 'II', 'III'],
        '0619E': ['I', 'II', 'III'],
      }
      const expectedRanges: Record<PrefillFormCode, Record<string, string | null>> = {
        '1601Cv2018': {
          'Part I - Background Information': '01-13',
          'Part II - Computation of Tax': '14-36',
          'Part III - Details of Payment': '37-40',
          'Part IV - Schedule': null,
        },
        '2551Qv2018': {
          'Part I - Background Information': '1-12A',
          'Part II - Total Tax Payable': '17-17',
          'Part III - Details of Payment': '25-28',
        },
        '0619E': {
          'Part I - Background Information': '01-13',
          'Part II - Tax Remittance': '14-18',
          'Part III - Details of Payment': '19-22',
        },
      }
      for (const code of Object.keys(prefillMap) as Array<keyof typeof prefillMap>) {
        const form = await openOfficialForm(code)
        try {
          const model = buildEditorModel(form.fields(), [])
          const partSections = model.sections.filter((section) => section.section?.startsWith('Part '))
          const parts = partSections.map((section) => section.section!.match(/^Part (I{1,3}|IV|V)\b/)?.[1])
          expect(parts).toEqual(expectedParts[code])
          const ranges = partSections.map((section) => {
            const items = [...new Set(section.rows.flatMap((row) => row.item ? [row.item] : []))]
              .sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10))
            return [section.section!, items.length ? `${items[0]}-${items.at(-1)}` : null] as const
          })
          expect(Object.fromEntries(ranges)).toEqual(expectedRanges[code])
          console.log(
            `[verified Part item ranges] ${code}: ${ranges.map(([part, range]) => `${part} ${range}`).join('; ')}`,
          )
        } finally {
          await form.close()
        }
      }
    },
    120_000,
  )

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
    120_000,
  )
})
