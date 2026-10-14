import { describe, expect, test } from 'bun:test'
import type { FieldSnapshot, ValidationIssue } from '@ebirforms/runtime'
import { buildSchemaModel, itemNoInMessage, normalizeItemNo, type FormSchema } from './schema-model.js'
import schemaJson from './form-schema.json'

const schemas = schemaJson as Record<string, FormSchema>

const snap = (id: string): FieldSnapshot => ({ id, name: id, type: 'text', value: '', label: id, item: null, section: null, disabled: false }) as FieldSnapshot
const issue = (message: string, fieldId: string | null = null): ValidationIssue => ({ message, fieldId, source: 'official' }) as ValidationIssue

describe('schema model', () => {
  test('item numbers compare without leading zeros', () => {
    expect(normalizeItemNo('01')).toBe('1')
    expect(normalizeItemNo('9a')).toBe('9A')
    expect(itemNoInMessage('Select a Quarter on Item no. 3.')).toBe('3')
    expect(itemNoInMessage('Please enter a valid TIN number on Item 6.')).toBe('6')
    expect(itemNoInMessage('General error')).toBeNull()
  })

  test('every official message lands on an item, never in a banner', () => {
    const schema = schemas['1601C']
    const keys = schema.parts.flatMap((part) => part.items.flatMap((item) => (item.f ?? []).map((field) => field.k).filter(Boolean))) as string[]
    const issues = [
      issue('Please select an option for Item 3.'),
      issue("Please enter a valid Witholding Agent's Name on Item 8."),
      issue("Please enter Taxpayer's Registered Address on Item 9."),
      issue('Something without an item'),
    ]
    const parts = buildSchemaModel(schema, keys.map(snap), issues)
    const placed = parts.flatMap((part) => part.items).flatMap((item) => item.errorText.split('\n').filter(Boolean))
    expect(placed.sort()).toEqual(issues.map((entry) => entry.message).sort())
    const item8 = parts.flatMap((part) => part.items).find((item) => item.no === '8')
    expect(item8?.errorText).toContain('Item 8')
  })

  test('schema fields bind to runtime snapshots by official id', () => {
    const schema = schemas['0619E']
    const first = schema.parts[0].items[0].f![0]
    const parts = buildSchemaModel(schema, [snap(first.k!)], [])
    expect(parts[0].items[0].fields[0].field?.id).toBe(first.k)
  })
})
