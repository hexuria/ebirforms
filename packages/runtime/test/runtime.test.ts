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

function serializedKeys(xml: string): string[] {
  return Array.from(xml.matchAll(/<div>([\s\S]*?)<\/div>/gi), ([, record]) => {
    const separator = record.indexOf('=')
    if (separator < 1) {
      throw new Error(`Invalid serialized record: ${record}`)
    }
    return record.slice(0, separator)
  })
}

function occurrences(keys: string[]): Map<string, number> {
  const result = new Map<string, number>()
  for (const key of keys) {
    result.set(key, (result.get(key) ?? 0) + 1)
  }
  return result
}

describe('openOfficialForm', () => {
  test('runs the official ready logic and builds the 1601C RDO select', async () => {
    const form = await openOfficialForm('1601Cv2018')
    try {
      expect(form.fields().find((field) => field.id === 'frm1601c:txtRDOCode')).toMatchObject({
        type: 'select-one',
      })
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

  test('serializes fields in official order with the rules keys', async () => {
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
      ) as { source: string; keys: string[] }
      const form = await openOfficialForm(code)
      try {
        const actual = serializedKeys(form.captureSaveXml())
        if (JSON.stringify(actual) === JSON.stringify(fixture.keys)) {
          continue
        }
        const expectedOccurrences = occurrences(fixture.keys)
        const actualOccurrences = occurrences(actual)
        differences.push({
          code,
          expectedLength: fixture.keys.length,
          actualLength: actual.length,
          firstMismatch: fixture.keys.findIndex((key, index) => actual[index] !== key),
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
  })
})
