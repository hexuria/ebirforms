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
      expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 })

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
        expect.objectContaining({
          tin9: '123456788',
          name: 'Main Branch',
          type: 'individual',
          birthDate: null,
          branches: [
            expect.objectContaining({
              code: '00000',
              name: 'Head office',
              facts: expect.objectContaining({
                rdo: 'RDO 1',
                address: '123 Test St',
                zip: '1000',
                email: 'taxpayer@example.test',
                phone: '555-0100',
              }),
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
            }),
            expect.objectContaining({
              code: '00002',
              name: 'Branch 00002',
              facts: expect.objectContaining({
                rdo: 'RDO 1',
                address: '123 Test St',
                inherited: {
                  rdo: true,
                  zip: true,
                  address: true,
                  phone: true,
                  email: true,
                },
              }),
              years: [expect.objectContaining({ year: 2026 })],
            }),
          ],
        }),
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

  test('creates taxpayers and resolves branch fact inheritance', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-branches-'))
    const store = openStore(join(root, 'forms.sqlite'), new Logger(root))
    try {
      const taxpayer = store.createTaxpayer({
        tin: '123456788',
        name: 'Sample Taxpayer',
        type: 'individual',
        birthDate: '1990-02-03',
        rdo: '039',
        zip: '1000',
        address: 'Head Office St',
        phone: '555-0100',
        email: 'taxpayer@example.test',
      })
      expect(taxpayer.name).toBe('Sample Taxpayer')
      expect(taxpayer.birthDate).toBe('1990-02-03')
      const branch = store.createBranch({
        tin9: '123456788',
        code: '00002',
        name: 'Makati',
      })
      expect(branch.facts).toEqual({
        rdo: '039',
        zip: '1000',
        address: 'Head Office St',
        phone: '555-0100',
        email: 'taxpayer@example.test',
        inherited: {
          rdo: true,
          zip: true,
          address: true,
          phone: true,
          email: true,
        },
      })

      store.updateBranch(branch.id, { rdo: '040', email: '' })
      expect(store.resolveBranchFacts(branch.id)).toEqual({
        rdo: '040',
        zip: '1000',
        address: 'Head Office St',
        phone: '555-0100',
        email: 'taxpayer@example.test',
        inherited: {
          rdo: false,
          zip: true,
          address: true,
          phone: true,
          email: true,
        },
      })
      store.updateTaxpayer('123456788', { name: 'Updated Name', type: 'non-individual' })
      expect(store.listTaxpayers()[0]).toMatchObject({
        name: 'Updated Name',
        type: 'non-individual',
      })
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('opens one draft per profile, form, and period and updates its status', () => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-drafts-'))
    const store = openStore(join(root, 'forms.sqlite'), new Logger(root))
    try {
      const profile = store.createProfile({ tin: '123456788', year: 2025 })
      const first = store.openDraft(profile.id, '1601Cv2018', '2025-01')
      const firstAgain = store.openDraft(profile.id, '1601Cv2018', '2025-01')
      const second = store.openDraft(profile.id, '1601Cv2018', '2025-02')
      const third = store.openDraft(profile.id, '0619E', '2025-01')
      expect(firstAgain.id).toBe(first.id)
      expect(second.id).not.toBe(first.id)
      expect(() => store.openDraft(profile.id, '0619E', '2025-13')).toThrow('valid period')
      store.saveDraft(first.id, {
        'frm1601c:txtYear': '2025',
        'frm1601c:radio': true,
      })
      const saved = store.setDraftStatus(first.id, 'confirmed')
      const savedSecond = store.saveDraft(second.id, { 'frm1601c:txtYear': '2026' })
      expect(saved.values).toEqual({
        'frm1601c:txtYear': '2025',
        'frm1601c:radio': true,
      })
      expect(saved.status).toBe('confirmed')
      expect(store.getDraft(first.id)).toEqual(saved)
      expect(savedSecond.values).toEqual({ 'frm1601c:txtYear': '2026' })
      expect(store.listDrafts(profile.id).map((draft) => draft.id)).toContain(third.id)
      expect(store.listDrafts(profile.id, '0619E')).toEqual([third])
      expect(store.listDrafts(profile.id, '1601Cv2018')).toHaveLength(2)
      expect(store.getDraft('missing')).toBeNull()
      expect(() => store.saveDraft('missing', {})).toThrow('Draft not found')
      expect(() => store.setDraftStatus('missing', 'paid')).toThrow('Draft not found')
      expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 })
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([1, 2])('migrates a version %d fixture with facts and form data intact', (version) => {
    const root = mkdtempSync(join(tmpdir(), 'ebirforms-migration-'))
    const path = join(root, 'forms.sqlite')
    const legacyDb = new Database(path)
    const stateCheck =
      version === 1
        ? "('queued', 'running', 'succeeded', 'failed', 'dead')"
        : "('queued', 'running', 'succeeded', 'dead')"
    legacyDb.exec(`
      CREATE TABLE taxpayers (tin9 TEXT PRIMARY KEY);
      CREATE TABLE branches (
        tin9 TEXT NOT NULL REFERENCES taxpayers(tin9) ON DELETE CASCADE,
        code TEXT NOT NULL DEFAULT '00000',
        PRIMARY KEY (tin9, code)
      );
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        tin9 TEXT NOT NULL,
        branch TEXT NOT NULL,
        year INTEGER NOT NULL,
        registered_name TEXT NOT NULL DEFAULT '',
        rdo TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        zip TEXT NOT NULL DEFAULT '',
        line_of_business TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        UNIQUE (tin9, branch, year),
        FOREIGN KEY (tin9, branch) REFERENCES branches(tin9, code) ON DELETE CASCADE
      );
      CREATE TABLE library (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        form_code TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, form_code)
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload JSON NOT NULL,
        state TEXT NOT NULL CHECK (state IN ${stateCheck}),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        run_after INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX jobs_due_order ON jobs (state, created_at, id);
      INSERT INTO taxpayers (tin9) VALUES ('123456788');
      INSERT INTO branches (tin9, code) VALUES ('123456788', '00000');
      INSERT INTO branches (tin9, code) VALUES ('123456788', '00002');
      INSERT INTO profiles (
        id, tin9, branch, year, registered_name, rdo, address, zip, email, phone
      ) VALUES
        ('main-2024', '123456788', '00000', 2024, 'Old Name', '001', 'Old Main', '1000', 'old@example.test', 'old-phone'),
        ('main-2025', '123456788', '00000', 2025, 'Latest Name', '002', 'Latest Main', '2000', 'main@example.test', 'main-phone'),
        ('branch-2024', '123456788', '00002', 2024, 'Branch Old', '003', 'Old Branch', '3000', 'branch-old@example.test', 'branch-old'),
        ('branch-2025', '123456788', '00002', 2025, 'Branch Latest', '004', 'Latest Branch', '4000', 'branch@example.test', 'branch-phone');
      INSERT INTO library (profile_id, form_code, added_at)
        VALUES ('main-2025', '1601Cv2018', 10);
      INSERT INTO jobs (
        id, kind, payload, state, attempts, max_attempts, run_after,
        last_error, created_at, updated_at
      ) VALUES ('legacy-job', 'test', '{}', 'queued', 1, 5, 1000, 'retry', 1, 2);
      PRAGMA user_version = ${version};
    `)
    legacyDb.close()

    const store = openStore(path, new Logger(root))
    try {
      expect(store.db.query('PRAGMA user_version').get()).toEqual({ user_version: 5 })
      expect(store.db.query('SELECT id, state FROM jobs').get()).toEqual({
        id: 'legacy-job',
        state: 'queued',
      })
      const schema = store.db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
        .get() as { sql: string }
      expect(schema.sql).not.toContain("'failed'")
      expect(store.listTaxpayers()).toEqual([
        expect.objectContaining({
          tin9: '123456788',
          name: 'Latest Name',
          branches: [
            expect.objectContaining({
              code: '00000',
              facts: expect.objectContaining({
                rdo: '002',
                address: 'Latest Main',
                inherited: {
                  rdo: false,
                  zip: false,
                  address: false,
                  phone: false,
                  email: false,
                },
              }),
              years: [
                expect.objectContaining({ id: 'main-2024', year: 2024 }),
                expect.objectContaining({ id: 'main-2025', year: 2025 }),
              ],
            }),
            expect.objectContaining({
              code: '00002',
              facts: expect.objectContaining({
                rdo: '004',
                address: 'Latest Branch',
                inherited: {
                  rdo: false,
                  zip: false,
                  address: false,
                  phone: false,
                  email: false,
                },
              }),
              years: [
                expect.objectContaining({ id: 'branch-2024', year: 2024 }),
                expect.objectContaining({ id: 'branch-2025', year: 2025 }),
              ],
            }),
          ],
        }),
      ])
      expect(store.listLibrary('main-2025')).toEqual([
        expect.objectContaining({ formCode: '1601Cv2018' }),
      ])
      expect(store.db.query("SELECT COUNT(*) AS count FROM drafts").get()).toEqual({
        count: 0,
      })
      const draftsSchema = store.db
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'drafts'")
        .get() as { sql: string }
      expect(draftsSchema.sql).toContain("period TEXT NOT NULL")
      expect(draftsSchema.sql).toContain("'confirmed'")
      expect(draftsSchema.sql).toContain('UNIQUE (profile_id, form_code, period)')
      expect(() =>
        store.db.exec(`
          INSERT INTO jobs (
            id, kind, payload, state, attempts, max_attempts, run_after,
            last_error, created_at, updated_at
          ) VALUES ('invalid-job', 'test', '{}', 'failed', 0, 5, 1000, NULL, 1, 2)
        `),
      ).toThrow()
      expect(() =>
        store.db.exec(`
          INSERT INTO drafts (
            id, profile_id, form_code, period, "values", status, created_at, updated_at
          ) VALUES ('invalid-period', 'main-2025', '1601Cv2018', '2025-13', '{}', 'draft', 1, 1)
        `),
      ).toThrow()
    } finally {
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
