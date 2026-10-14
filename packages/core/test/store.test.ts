import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { formatTin, openStore, parseTin } from '../src/store.js'
import { Logger } from '../src/logger.js'

describe('parseTin', () => {
  test('parses 9-digit, 14-digit, and dashed TINs', () => {
    expect(parseTin('123456788')).toEqual({ tin9: '123456788', branch: '00000' })
    expect(parseTin('12345678800002')).toEqual({ tin9: '123456788', branch: '00002' })
    expect(parseTin('123 - 456 - 788 - 00002')).toEqual({
      tin9: '123456788',
      branch: '00002',
    })
    expect(formatTin('123456788')).toBe('123-456-788-00000')
    expect(formatTin('12345678800002')).toBe('123-456-788-00002')
  })

  test('rejects invalid TIN lengths and characters', () => {
    for (const input of ['12345678', '1234567880000', '123456788000020', '12345678a']) {
      expect(() => parseTin(input)).toThrow('9-digit TIN or a 14-digit TIN')
    }
  })
})

describe('SQLite profile and form library store', () => {
  test('creates nested taxpayer, branch, and year profiles and rejects duplicates', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-store-'))
    const store = openStore(join(root, 'forms.sqlite'), new Logger(root))
    try {
      expect(store.db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(store.db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
      expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 1 })

      const main2025 = store.createProfile({
        tin: '123-456-788',
        branch: '00000',
        year: 2025,
        registeredName: 'Main Branch',
        rdo: 'RDO 1',
      })
      store.createProfile({
        tin: '123-456-788',
        branch: '00000',
        year: 2026,
      })
      store.createProfile({
        tin: '123-456-788',
        branch: '00002',
        year: 2026,
      })

      expect(() =>
        store.createProfile({
          tin: '123456788',
          branch: '00000',
          year: 2025,
        }),
      ).toThrow('A profile already exists')

      expect(store.listTaxpayers()).toEqual([
        {
          tin9: '123456788',
          branches: [
            {
              code: '00000',
              years: [
                expect.objectContaining({ id: main2025.id, year: 2025, registeredName: 'Main Branch' }),
                expect.objectContaining({ year: 2026 }),
              ],
            },
            {
              code: '00002',
              years: [expect.objectContaining({ year: 2026 })],
            },
          ],
        },
      ])
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('returns only selected catalog forms and removes a selection', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-library-'))
    const store = openStore(join(root, 'forms.sqlite'), new Logger(root))
    try {
      const profile = store.createProfile({
        tin: '123456788',
        year: 2025,
      })
      expect(store.listLibrary(profile.id)).toEqual([])
      store.addForms(profile.id, ['1601Cv2018', '0619E'])
      expect(store.listLibrary(profile.id)).toEqual([
        expect.objectContaining({ formCode: '1601Cv2018', label: expect.any(String) }),
        expect.objectContaining({ formCode: '0619E', label: expect.any(String) }),
      ])

      expect(() => store.addForms(profile.id, ['1601Cv2018', 'not-a-form'])).toThrow(
        'Unknown form code: not-a-form',
      )
      expect(store.listLibrary(profile.id).map((entry) => entry.formCode)).toEqual([
        '1601Cv2018',
        '0619E',
      ])

      store.removeForm(profile.id, '1601Cv2018')
      expect(store.listLibrary(profile.id).map((entry) => entry.formCode)).toEqual(['0619E'])
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
