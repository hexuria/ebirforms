import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
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
      expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 })

      const main2025 = store.createProfile({
        tin: '123-456-788',
        branch: '00000',
        year: 2025,
        registeredName: 'Main Branch',
        rdo: 'RDO 1',
        address: '123 Test St',
        zip: '1000',
        email: 'taxpayer@example.test',
        phone: '555-0100',
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
                expect.objectContaining({
                  id: main2025.id,
                  year: 2025,
                  registeredName: 'Main Branch',
                  address: '123 Test St',
                  zip: '1000',
                  email: 'taxpayer@example.test',
                  phone: '555-0100',
                }),
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

  test('persists draft values by profile and form, ordered by most recent update', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-drafts-'))
    const store = openStore(join(root, 'forms.sqlite'), new Logger(root))
    try {
      const profile = store.createProfile({ tin: '123456788', year: 2025 })
      const first = store.createDraft(profile.id, '1601Cv2018', {
        'frm1601c:txtYear': '2025',
        'frm1601c:radio': true,
      })
      const second = store.createDraft(profile.id, '0619E', { 'frm0619E:txtTax14': '1000' })
      const saved = store.saveDraft(first.id, { 'frm1601c:txtYear': '2026' })

      expect(saved.values).toEqual({ 'frm1601c:txtYear': '2026' })
      expect(store.getDraft(first.id)).toEqual(saved)
      expect(store.listDrafts(profile.id)).toEqual([saved, second])
      expect(store.listDrafts(profile.id, '0619E')).toEqual([second])
      expect(store.getDraft('missing')).toBeNull()
      expect(() => store.saveDraft('missing', {})).toThrow('Draft not found')
      expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 })
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('migrates version 1 jobs to the supported state constraint', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-migration-'))
    const path = join(root, 'forms.sqlite')
    const legacyDb = new Database(path)
    legacyDb.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload JSON NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('queued', 'running', 'succeeded', 'failed', 'dead')
        ),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        run_after INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX jobs_due_order ON jobs (state, created_at, id);
      INSERT INTO jobs (
        id, kind, payload, state, attempts, max_attempts, run_after,
        last_error, created_at, updated_at
      ) VALUES ('legacy-job', 'test', '{}', 'queued', 1, 5, 1000, 'retry', 1, 2);
      PRAGMA user_version = 1;
    `)
    legacyDb.close()

    const store = openStore(path, new Logger(root))
    try {
      expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 })
      expect(store.db.query('SELECT id, state FROM jobs').get()).toEqual({
        id: 'legacy-job',
        state: 'queued',
      })
      const schema = store.db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
        .get() as { sql: string }
      expect(schema.sql).not.toContain("'failed'")
      expect(() =>
        store.db.exec(`
          INSERT INTO jobs (
            id, kind, payload, state, attempts, max_attempts, run_after,
            last_error, created_at, updated_at
          ) VALUES ('invalid-job', 'test', '{}', 'failed', 0, 5, 1000, NULL, 1, 2)
        `),
      ).toThrow()
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
