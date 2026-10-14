import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openOfficialForm } from '../src/index.js'

const fixtureDir = resolve(import.meta.dir, 'fixtures')
const parityForms = [
  ['1601Cv2018', '1601c-v2018'],
  ['2551Qv2018', '2551q-v2018'],
  ['0619E', '0619e-v2018'],
] as const

type KnownDifference =
  | {
      key: string
      kind: 'merged' | 'absent'
      reason: string
      evidence: string
    }
  | {
      key: string
      kind: 'moved'
      officialIndex: number
      reason: string
      evidence: string
    }

function serializedKeys(xml: string): string[] {
  return serializedRecords(xml).map((record) => record.key)
}

function serializedRecords(xml: string): Array<{ key: string; value: string }> {
  return Array.from(xml.matchAll(/<div>([\s\S]*?)<\/div>/gi), ([, record]) => {
    const separator = record.indexOf('=')
    if (separator < 1) {
      throw new Error(`Invalid serialized record: ${record}`)
    }
    const key = record.slice(0, separator)
    const suffix = `${key}=`
    if (!record.endsWith(suffix)) {
      throw new Error(`Invalid serialized record: ${record}`)
    }
    return {
      key,
      value: record.slice(separator + 1, -suffix.length),
    }
  })
}

function occurrences(keys: string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const key of keys) {
    result.set(key, (result.get(key) ?? 0) + 1)
  }
  return result
}

function withoutKnownDifferences(
  keys: string[],
  knownDifferences: KnownDifference[],
): string[] {
  const removals = occurrences(
    knownDifferences
      .filter((difference) => difference.kind !== 'moved')
      .map(({ key }) => key),
  )
  const retained = keys.map(() => true)
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const count = removals.get(keys[index]) ?? 0
    if (count > 0) {
      retained[index] = false
      removals.set(keys[index], count - 1)
    }
  }
  const missingDifference = [...removals].find(([, count]) => count > 0)
  if (missingDifference) {
    throw new Error(`Known difference key is missing from the expected keys: ${missingDifference[0]}`)
  }
  return keys.filter((_key, index) => retained[index])
}

function applyKnownDifferences(keys: string[], knownDifferences: KnownDifference[]): string[] {
  const expected = withoutKnownDifferences(keys, knownDifferences)
  for (const difference of knownDifferences) {
    if (difference.kind !== 'moved') {
      continue
    }
    const sourceIndex = expected.indexOf(difference.key)
    if (sourceIndex < 0) {
      throw new Error(`Moved key is missing from the expected keys: ${difference.key}`)
    }
    const [key] = expected.splice(sourceIndex, 1)
    if (difference.officialIndex < 0 || difference.officialIndex > expected.length) {
      throw new Error(`Invalid official index for moved key: ${difference.key}`)
    }
    expected.splice(difference.officialIndex, 0, key)
  }
  return expected
}

describe('openOfficialForm', () => {
  test(
    'labels ten hand-verified fields per form and reports id fallbacks',
    async () => {
      const verified = [
        {
          code: '1601Cv2018',
          fields: [
            ['frm1601c:txtTIN1', 'Taxpayer Identification Number (TIN)', '6', 417],
            ['frm1601c:txtTIN2', 'Taxpayer Identification Number (TIN)', '6', 418],
            ['frm1601c:txtTIN3', 'Taxpayer Identification Number (TIN)', '6', 419],
            ['frm1601c:txtBranchCode', 'Taxpayer Identification Number (TIN)', '6', 420],
            ['frm1601c:txtRDOCode', '7 RDO Code', '7', 4692],
            ['frm1601c:txtZipCode', '9A Zip Code', '9A', 522],
            ['frm1601c:txtTelNum', '10 Contact Number', '10', 542],
            ['txtEmail', 'Email Address', '12', 585],
            ['frm1601c:selTreaty', 'If yes, specify', '13', 621],
            ['frm1601c:txtTax14', '14', '14', 667],
          ],
        },
        {
          code: '2551Qv2018',
          fields: [
            ['frm2551Qv2018:rtnMonth', 'Year Ended(MM/YYYY)', '2', 453],
            ['frm2551Qv2018:txtYear', 'Year Ended(MM/YYYY)', '2', 469],
            ['frm2551Qv2018:txtSheets', 'Attached', null, 571],
            ['frm2551Qv2018:txtTIN1', 'Taxpayer Indentification Number (TIN)', '6', 619],
            ['frm2551Qv2018:txtTIN2', 'Taxpayer Indentification Number (TIN)', '6', 621],
            ['frm2551Qv2018:txtTIN3', 'Taxpayer Indentification Number (TIN)', '6', 623],
            ['frm2551Qv2018:txtBranchCode', 'Taxpayer Indentification Number (TIN)', '6', 625],
            ['frm2551Qv2018:txtRDOCode', '7 RDO Code', '7', 5935],
            ['frm2551Qv2018:txtTaxReliefSpecify', 'If yes, specify', '12A', 874],
            ['frm2551Qv2018:txt17Specify', '(specify)', '17', 1155],
          ],
        },
        {
          code: '0619E',
          fields: [
            ['frm0619E:txtTIN1', 'Taxpayer Identification Number (TIN)', '7', 424],
            ['frm0619E:txtTIN2', 'Taxpayer Identification Number (TIN)', '7', 425],
            ['frm0619E:txtTIN3', 'Taxpayer Identification Number (TIN)', '7', 426],
            ['frm0619E:txtBranchCode', 'Taxpayer Identification Number (TIN)', '7', 427],
            ['frm0619E:txtRDOCode', '8 RDO Code', '8', 3463],
            ['frm0619E:txtTax14', '14', '14', 616],
            ['frm0619E:txtTax15', '15', '15', 634],
            ['frm0619E:txtTax16', '16', '16', 652],
            ['frm0619E:txtTax17A', '17A', '17A', 676],
            ['frm0619E:txtTax17B', '17B', '17B', 694],
          ],
        },
      ] as const
      for (const formCase of verified) {
        const form = await openOfficialForm(formCase.code)
        try {
          const fields = form.fields()
          for (const [id, label, item, line] of formCase.fields) {
            const field = fields.find((entry) => entry.id === id)
            expect(
              { label: field?.label, item: field?.item },
              `${formCase.code} ${id} at BIR-Form${formCase.code}.hta:${line}`,
            ).toEqual({ label, item })
          }
          console.log(
            `[field labels] ${formCase.code}: 10 checked; id fallbacks=${fields.filter((field) => field.label === field.id).length}/${fields.length}`,
          )
        } finally {
          await form.close()
        }
      }
    },
    30_000,
  )

  test('runs the official ready logic and builds the 1601C RDO select', async () => {
    const form = await openOfficialForm('1601Cv2018')
    try {
      expect(form.call('eval', 'd === document')).toBe(true)
      expect(form.call('eval', "document.getElementById('tblSched1a') !== null")).toBe(true)
      expect(
        form.call('eval', "typeof document.getElementById('tblSched1a').rows.length"),
      ).toBe('number')
      expect(form.fields().find((field) => field.id === 'frm1601c:txtRDOCode')).toMatchObject({
        type: 'select-one',
      })
      expect(
        form.call(
          'eval',
          "Array.from(document.getElementById('frm1601c:txtRDOCode').options).some(option => option.value === '039')",
        ),
      ).toBe(true)
      form.set('frm1601c:txtRDOCode', '039')
      expect(form.get('frm1601c:txtRDOCode')).toBe('039')
    } finally {
      await form.close()
    }
  })

  test('runs official compute handlers after setting a field', async () => {
    const form = await openOfficialForm('1601Cv2018')
    try {
      form.set('frm1601c:txtTax14', '1000')
      expect(form.get('frm1601c:txtTax22')).toBe('1,000.00')
    } finally {
      await form.close()
    }
  })

  test('validates a fresh 1601C against the supplied date', async () => {
    const form = await openOfficialForm('1601Cv2018', { now: new Date('2026-10-14T00:00:00') })
    try {
      form.call('validate')
      // Official readiness initializes the current period before validation.
      expect(form.alerts[0]).toBe('Please select an option for Item 3.')
    } finally {
      await form.close()
    }
  })

  test('keeps merged address inputs editable and serializes both values', async () => {
    const addressForms = [
      {
        code: '1601Cv2018',
        slug: '1601c-v2018',
        addressId: 'frm1601c:txtAddress',
        address2Id: 'frm1601c:txtAddress2',
      },
      {
        code: '0619E',
        slug: '0619e-v2018',
        addressId: 'frm0619E:txtAddress',
        address2Id: 'frm0619E:txtAddress2',
      },
    ]
    for (const { code, slug, addressId, address2Id } of addressForms) {
      const fixture = JSON.parse(
        readFileSync(resolve(fixtureDir, `${slug}.keys.json`), 'utf8'),
      ) as {
        knownDifferences: KnownDifference[]
      }
      const form = await openOfficialForm(code)
      try {
        const fields = form.fields()
        for (const difference of fixture.knownDifferences.filter(
          (item) => item.kind === 'merged',
        )) {
          expect(fields.some((field) => field.id === difference.key)).toBe(true)
        }
        form.set(addressId, 'ADDR ONE')
        form.set(address2Id, 'ADDR TWO')
        const record = serializedRecords(form.captureSaveXml()).find(
          (item) => item.key === addressId,
        )
        const value = decodeURIComponent(record?.value ?? '')
        expect(value).toContain('ADDR ONE')
        expect(value).toContain('ADDR TWO')
      } finally {
        await form.close()
      }
    }
  }, 15_000)

  test('serializes fields in official order with only documented rules differences', async () => {
    const differences: Array<{
      code: string
      expectedLength: number
      actualLength: number
      firstMismatch: number
      missing: string[]
      extra: string[]
    }> = []
    for (const [code, slug] of parityForms) {
      const fixture = JSON.parse(
        readFileSync(resolve(fixtureDir, `${slug}.keys.json`), 'utf8'),
      ) as {
        source: string
        keys: string[]
        knownDifferences: KnownDifference[]
      }
      const form = await openOfficialForm(code)
      try {
        const fields = form.fields()
        for (const difference of fixture.knownDifferences) {
          if (difference.kind === 'moved') {
            expect(fields.findIndex((field) => field.id === difference.key)).toBe(
              difference.officialIndex,
            )
          }
        }
        const actual = serializedKeys(form.captureSaveXml())
        const expected = applyKnownDifferences(fixture.keys, fixture.knownDifferences)
        if (JSON.stringify(actual) === JSON.stringify(expected)) {
          continue
        }
        const expectedOccurrences = occurrences(expected)
        const actualOccurrences = occurrences(actual)
        differences.push({
          code,
          expectedLength: expected.length,
          actualLength: actual.length,
          firstMismatch: expected.findIndex((key, index) => actual[index] !== key),
          missing: [...expectedOccurrences].flatMap(([key, count]) =>
            Array.from({ length: count - (actualOccurrences.get(key) ?? 0) }, () => key),
          ),
          extra: [...actualOccurrences].flatMap(([key, count]) =>
            Array.from({ length: count - (expectedOccurrences.get(key) ?? 0) }, () => key),
          ),
        })
      } finally {
        await form.close()
      }
    }
    expect(differences).toEqual([])
  }, 20_000)
})
