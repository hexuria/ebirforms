import { describe, expect, test } from 'bun:test'
import { openOfficialForm } from '../src/index.js'
import type { FieldSnapshot, ValidationLogger } from '../src/index.js'

const now = new Date('2026-10-14T00:00:00')
const forms = [
  { code: '1601Cv2018', issues: 8, guards: 14 },
  { code: '2551Qv2018', issues: 8, guards: 17 },
  { code: '0619E', issues: 9, guards: 26 },
] as const

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function randomIndex(random: () => number, length: number): number {
  return Math.floor(random() * length)
}

function fillRandom(
  formFields: FieldSnapshot[],
  set: (id: string, value: string | boolean) => void,
  random: () => number,
): void {
  const radios = new Map<string, FieldSnapshot[]>()
  for (const field of formFields) {
    if (field.disabled) {
      continue
    }
    if (field.type === 'radio') {
      const group = field.name || field.id.replace(/_\d+$/, '')
      radios.set(group, [...(radios.get(group) ?? []), field])
      continue
    }
    if (field.type === 'text' || field.type === 'textarea') {
      const choices = ['', '123', 'garbage']
      set(field.id, choices[randomIndex(random, choices.length)])
    } else if (field.type === 'select-one' && field.options?.length) {
      set(field.id, field.options[randomIndex(random, field.options.length)].value)
    } else if (field.type === 'checkbox') {
      set(field.id, random() >= 0.5)
    }
  }
  for (const group of radios.values()) {
    const selected = randomIndex(random, group.length)
    for (let index = 0; index < group.length; index += 1) {
      set(group[index].id, index === selected)
    }
  }
}

describe('official validation', () => {
  test(
    'blank forms preserve official first-error ordering and expose guard coverage',
    async () => {
      for (const expected of forms) {
        const form = await openOfficialForm(expected.code, { now })
        try {
          const before = form.fields()
          const result = form.validate()
          expect(form.fields()).toEqual(before)
          expect(result.officialFirst).not.toBeNull()
          expect(result.issues[0]).toEqual(result.officialFirst!)
          expect(result.issues.length).toBeGreaterThan(1)
          expect(result.issues.length).toBe(expected.issues)
          expect(result.coverage.guards).toBe(expected.guards)
          expect(result.coverage.evaluated + result.coverage.failedToEvaluate).toBe(
            result.coverage.guards,
          )
          expect(result.coverage.failedToEvaluate).toBe(0)
        } finally {
          await form.close()
        }
      }
    },
    30_000,
  )

  test(
    'advances 1601C validation through the official sequence without retaining validation mutations',
    async () => {
      const form = await openOfficialForm('1601Cv2018', { now })
      try {
        form.set('frm1601c:txtYear', '2025')
        form.set('frm1601c:txtMonth', '01')
        let result = form.validate()
        expect(result.officialFirst?.message).toBe('Please select an option for Item 3.')

        const itemThree = result.officialFirst
        form.set('frm1601c:TaxWithheld_2', true)
        result = form.validate()
        expect(result.officialFirst?.message).toBe('Please enter a valid TIN number on Item 6.')
        expect(result.issues).not.toContainEqual(itemThree)

        const tinIssue = result.officialFirst
        form.set('frm1601c:txtTIN1', '123')
        form.set('frm1601c:txtTIN2', '456')
        form.set('frm1601c:txtTIN3', '788')
        form.set('frm1601c:txtBranchCode', '000')
        const before = form.fields()
        result = form.validate()
        expect(result.officialFirst?.message).toBe('Please enter a valid RDO Code on Item 7.')
        expect(result.issues).not.toContainEqual(tinIssue)
        expect(form.fields()).toEqual(before)
      } finally {
        await form.close()
      }
    },
    20_000,
  )

  test(
    'restores values changed by official validation and captures its focused field',
    async () => {
      const form = await openOfficialForm('0619E', { now })
      try {
        form.set('frm0619E:txtYear', '2027')
        const before = form.fields()
        const result = form.validate()
        expect(result.officialFirst).toEqual({
          message: 'Invalid year on Item 1. Year should not be a future Date.',
          fieldId: 'frm0619E:txtYear',
          source: 'official',
        })
        expect(form.fields()).toEqual(before)
        expect(form.get('frm0619E:txtYear')).toBe('2027')
      } finally {
        await form.close()
      }
    },
    20_000,
  )

  test(
    'matches official first errors for 50 seeded fills per form',
    async () => {
      for (let formIndex = 0; formIndex < forms.length; formIndex += 1) {
        const expected = forms[formIndex]
        const form = await openOfficialForm(expected.code, { now })
        const warnings: string[] = []
        const logger: ValidationLogger = {
          log(level, _scope, message) {
            if (level === 'warn') {
              warnings.push(message)
            }
          },
        }
        try {
          const random = seededRandom(0x51a7 + formIndex)
          let coverage = { guards: 0, evaluated: 0, failedToEvaluate: 0 }
          for (let run = 0; run < 50; run += 1) {
            fillRandom(
              form.fields(),
              (id, value) => {
                form.set(id, value)
                if (form.errors.length > 0) {
                  throw new Error(
                    `Sandbox error after setting ${id}: ${form.errors.join('; ')}`,
                  )
                }
              },
              random,
            )
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(form.errors).toEqual([])
            const before = form.fields()
            const result = form.validate(logger)
            expect(form.fields()).toEqual(before)
            expect(form.errors).toEqual([])
            expect(result.coverage.evaluated + result.coverage.failedToEvaluate).toBe(
              result.coverage.guards,
            )
            if (result.officialFirst) {
              expect(result.issues[0]).toEqual(result.officialFirst)
            } else {
              expect(result.issues).toEqual([])
            }
            coverage = result.coverage
          }
          expect(warnings).toEqual([])
          console.log(
            `[validation coverage] ${expected.code}: guards=${coverage.guards} evaluated=${coverage.evaluated} failed=${coverage.failedToEvaluate} runs=50`,
          )
        } finally {
          await form.close()
        }
      }
    },
    360_000,
  )
})
