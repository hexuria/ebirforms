import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { loadCatalog } from '@ebirforms/forms'
import { dataDir, Logger } from './logger.js'

export interface ParsedTin {
  tin9: string
  branch: string
}

export interface CreateProfileInput {
  tin: string
  branch?: string
  year: number
  registeredName?: string
  rdo?: string
  address?: string
  zip?: string
  lineOfBusiness?: string
  email?: string
  phone?: string
}

export interface Profile {
  id: string
  tin9: string
  branch: string
  year: number
  registeredName: string
  rdo: string
  address: string
  zip: string
  lineOfBusiness: string
  email: string
  phone: string
}

export interface TaxpayerTree {
  tin9: string
  branches: Array<{
    code: string
    years: Profile[]
  }>
}

export interface LibraryEntry {
  profileId: string
  formCode: string
  label: string
  printable: string | null
  addedAt: number
}

export type DraftValues = Record<string, string | boolean>

export interface Draft {
  id: string
  profileId: string
  formCode: string
  values: DraftValues
  status: 'draft'
  createdAt: number
  updatedAt: number
}

export function parseTin(input: string): ParsedTin {
  const digits = input.replace(/[\s-]/g, '')
  if (/^\d{9}$/.test(digits)) {
    return { tin9: digits, branch: '00000' }
  }
  if (/^\d{14}$/.test(digits)) {
    return { tin9: digits.slice(0, 9), branch: digits.slice(9) }
  }
  throw new Error('Enter a 9-digit TIN or a 14-digit TIN including the 5-digit branch code.')
}

export function formatTin(tin: string, branch?: string): string {
  const parsed = parseTin(tin)
  const branchCode = branch ?? parsed.branch
  if (!/^\d{5}$/.test(branchCode)) {
    throw new Error('Branch code must contain exactly 5 digits.')
  }
  return `${parsed.tin9.slice(0, 3)}-${parsed.tin9.slice(3, 6)}-${parsed.tin9.slice(6)}-${branchCode}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function migrate(db: Database): void {
  const version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version
  const migration = db.transaction(() => {
    if (version < 1) {
      db.exec(`
        CREATE TABLE taxpayers (
          tin9 TEXT PRIMARY KEY
        )
      `)
      db.exec(`
        CREATE TABLE branches (
          tin9 TEXT NOT NULL REFERENCES taxpayers(tin9) ON DELETE CASCADE,
          code TEXT NOT NULL DEFAULT '00000',
          PRIMARY KEY (tin9, code)
        )
      `)
      db.exec(`
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
        )
      `)
      db.exec(`
        CREATE TABLE library (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          form_code TEXT NOT NULL,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (profile_id, form_code)
        )
      `)
      db.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          payload JSON NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'dead')),
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          run_after INTEGER NOT NULL,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec('CREATE INDEX jobs_due_order ON jobs (state, created_at, id)')
      db.exec('PRAGMA user_version = 1')
    }
    if (version < 2) {
      db.exec(`
        CREATE TABLE jobs_v2 (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          payload JSON NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'dead')),
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 5,
          run_after INTEGER NOT NULL,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        INSERT INTO jobs_v2 (
          id, kind, payload, state, attempts, max_attempts, run_after,
          last_error, created_at, updated_at
        )
        SELECT
          id, kind, payload, state, attempts, max_attempts, run_after,
          last_error, created_at, updated_at
        FROM jobs
      `)
      db.exec('DROP TABLE jobs')
      db.exec('ALTER TABLE jobs_v2 RENAME TO jobs')
      db.exec('CREATE INDEX jobs_due_order ON jobs (state, created_at, id)')
      db.exec('PRAGMA user_version = 2')
    }
    if (version < 3) {
      db.exec(`
        CREATE TABLE drafts (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          form_code TEXT NOT NULL,
          "values" JSON NOT NULL,
          status TEXT NOT NULL CHECK (status = 'draft'),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec('CREATE INDEX drafts_profile_form_updated ON drafts (profile_id, form_code, updated_at)')
      db.exec('PRAGMA user_version = 3')
    }
  })
  migration()
}

export class Store {
  constructor(
    readonly db: Database,
    readonly logger: Logger,
  ) {}

  private withErrorLogging<T>(operation: string, action: () => T): T {
    try {
      return action()
    } catch (error) {
      try {
        this.logger.log('error', 'store', `${operation} failed`, {
          error: errorMessage(error),
        })
      } catch {}
      throw error
    }
  }

  createProfile(input: CreateProfileInput): Profile {
    return this.withErrorLogging('createProfile', () => {
      const parsedTin = parseTin(input.tin)
      const branch = input.branch ?? parsedTin.branch
      if (!/^\d{5}$/.test(branch)) {
        throw new Error('Branch code must contain exactly 5 digits.')
      }
      if (!Number.isInteger(input.year) || input.year < 1 || input.year > 9999) {
        throw new Error('Enter a valid tax year.')
      }

      const profile: Profile = {
        id: randomUUID(),
        tin9: parsedTin.tin9,
        branch,
        year: input.year,
        registeredName: input.registeredName ?? '',
        rdo: input.rdo ?? '',
        address: input.address ?? '',
        zip: input.zip ?? '',
        lineOfBusiness: input.lineOfBusiness ?? '',
        email: input.email ?? '',
        phone: input.phone ?? '',
      }
      const insert = this.db.transaction(() => {
        this.db.query('INSERT OR IGNORE INTO taxpayers (tin9) VALUES (?)').run(profile.tin9)
        this.db
          .query('INSERT OR IGNORE INTO branches (tin9, code) VALUES (?, ?)')
          .run(profile.tin9, profile.branch)
        this.db
          .query(`
            INSERT INTO profiles (
              id, tin9, branch, year, registered_name, rdo, address, zip,
              line_of_business, email, phone
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            profile.id,
            profile.tin9,
            profile.branch,
            profile.year,
            profile.registeredName,
            profile.rdo,
            profile.address,
            profile.zip,
            profile.lineOfBusiness,
            profile.email,
            profile.phone,
          )
        return profile
      })

      try {
        const created = insert()
        this.logger.log('info', 'store', 'Profile created', {
          profileId: created.id,
          branch: created.branch,
          year: created.year,
        })
        return created
      } catch (error) {
        if (errorMessage(error).includes('UNIQUE constraint failed: profiles.tin9')) {
          throw new Error(
            `A profile already exists for TIN ${profile.tin9}, branch ${profile.branch}, and year ${profile.year}.`,
          )
        }
        throw error
      }
    })
  }

  listTaxpayers(): TaxpayerTree[] {
    return this.withErrorLogging('listTaxpayers', () => {
      const rows = this.db
        .query(`
          SELECT
            t.tin9,
            b.code AS branch,
            p.id,
            p.year,
            p.registered_name AS registeredName,
            p.rdo,
            p.address,
            p.zip,
            p.line_of_business AS lineOfBusiness,
            p.email,
            p.phone
          FROM taxpayers t
          JOIN branches b ON b.tin9 = t.tin9
          LEFT JOIN profiles p ON p.tin9 = b.tin9 AND p.branch = b.code
          ORDER BY t.tin9, b.code, p.year
        `)
        .all() as Array<
        Omit<Profile, 'id' | 'branch' | 'year'> & {
          tin9: string
          branch: string
          id: string | null
          year: number | null
        }
      >
      const taxpayers = new Map<string, TaxpayerTree>()
      for (const row of rows) {
        let taxpayer = taxpayers.get(row.tin9)
        if (!taxpayer) {
          taxpayer = { tin9: row.tin9, branches: [] }
          taxpayers.set(row.tin9, taxpayer)
        }
        let branch = taxpayer.branches.find((item) => item.code === row.branch)
        if (!branch) {
          branch = { code: row.branch, years: [] }
          taxpayer.branches.push(branch)
        }
        if (row.id !== null && row.year !== null) {
          branch.years.push({
            id: row.id,
            tin9: row.tin9,
            branch: row.branch,
            year: row.year,
            registeredName: row.registeredName,
            rdo: row.rdo,
            address: row.address,
            zip: row.zip,
            lineOfBusiness: row.lineOfBusiness,
            email: row.email,
            phone: row.phone,
          })
        }
      }
      return [...taxpayers.values()]
    })
  }

  addForms(profileId: string, codes: string[]): void {
    this.withErrorLogging('addForms', () => {
      const catalogCodes = new Set(loadCatalog().map((entry) => entry.code))
      const unknownCode = codes.find((code) => !catalogCodes.has(code))
      if (unknownCode) {
        throw new Error(`Unknown form code: ${unknownCode}.`)
      }
      const add = this.db.transaction(() => {
        const insert = this.db.query(
          'INSERT OR IGNORE INTO library (profile_id, form_code, added_at) VALUES (?, ?, ?)',
        )
        const now = Date.now()
        for (const [index, code] of codes.entries()) {
          insert.run(profileId, code, now + index)
        }
      })
      add()
      this.logger.log('info', 'store', 'Forms added to library', {
        profileId,
        count: codes.length,
      })
    })
  }

  removeForm(profileId: string, code: string): void {
    this.withErrorLogging('removeForm', () => {
      this.db
        .query('DELETE FROM library WHERE profile_id = ? AND form_code = ?')
        .run(profileId, code)
    })
  }

  listLibrary(profileId: string): LibraryEntry[] {
    return this.withErrorLogging('listLibrary', () => {
      const catalogByCode = new Map(loadCatalog().map((entry) => [entry.code, entry]))
      const rows = this.db
        .query(
          'SELECT form_code AS formCode, added_at AS addedAt FROM library WHERE profile_id = ? ORDER BY added_at, rowid',
        )
        .all(profileId) as Array<{ formCode: string; addedAt: number }>
      return rows.map(({ formCode, addedAt }) => {
        const catalogEntry = catalogByCode.get(formCode)
        if (!catalogEntry) {
          throw new Error(`Library contains an unknown form code: ${formCode}.`)
        }
        return {
          profileId,
          formCode,
          label: catalogEntry.label,
          printable: catalogEntry.printable,
          addedAt,
        }
      })
    })
  }

  createDraft(profileId: string, formCode: string, values: DraftValues = {}): Draft {
    return this.withErrorLogging('createDraft', () => {
      const latest = this.db
        .query(
          'SELECT MAX(updated_at) AS updatedAt FROM drafts WHERE profile_id = ? AND form_code = ?',
        )
        .get(profileId, formCode) as { updatedAt: number | null }
      const now = Math.max(Date.now(), (latest.updatedAt ?? 0) + 1)
      const draft: Draft = {
        id: randomUUID(),
        profileId,
        formCode,
        values,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      }
      this.db
        .query(
          'INSERT INTO drafts (id, profile_id, form_code, "values", status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(draft.id, profileId, formCode, JSON.stringify(values), draft.status, now, now)
      this.logger.log('info', 'store', 'Draft created', { draftId: draft.id, formCode })
      return draft
    })
  }

  saveDraft(id: string, values: DraftValues): Draft {
    return this.withErrorLogging('saveDraft', () => {
      const current = this.db
        .query('SELECT updated_at AS updatedAt FROM drafts WHERE id = ?')
        .get(id) as { updatedAt: number } | null
      if (!current) {
        throw new Error(`Draft not found: ${id}.`)
      }
      const updatedAt = Math.max(Date.now(), current.updatedAt + 1)
      const result = this.db
        .query('UPDATE drafts SET "values" = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(values), updatedAt, id)
      if (!result.changes) {
        throw new Error(`Draft not found: ${id}.`)
      }
      this.logger.log('info', 'store', 'Draft saved', { draftId: id })
      return this.getDraft(id)!
    })
  }

  listDrafts(profileId: string, formCode?: string): Draft[] {
    return this.withErrorLogging('listDrafts', () => {
      const rows = formCode
        ? this.db
            .query(
              'SELECT id, profile_id AS profileId, form_code AS formCode, "values" AS valuesJson, status, created_at AS createdAt, updated_at AS updatedAt FROM drafts WHERE profile_id = ? AND form_code = ? ORDER BY updated_at DESC, created_at DESC, rowid DESC',
            )
            .all(profileId, formCode)
        : this.db
            .query(
              'SELECT id, profile_id AS profileId, form_code AS formCode, "values" AS valuesJson, status, created_at AS createdAt, updated_at AS updatedAt FROM drafts WHERE profile_id = ? ORDER BY updated_at DESC, created_at DESC, rowid DESC',
            )
            .all(profileId)
      return (rows as Array<Omit<Draft, 'values'> & { valuesJson: string }>).map(
        ({ valuesJson, ...row }) => ({
          ...row,
          values: JSON.parse(valuesJson) as DraftValues,
        }),
      )
    })
  }

  getDraft(id: string): Draft | null {
    return this.withErrorLogging('getDraft', () => {
      const row = this.db
        .query(
          'SELECT id, profile_id AS profileId, form_code AS formCode, "values" AS valuesJson, status, created_at AS createdAt, updated_at AS updatedAt FROM drafts WHERE id = ?',
        )
        .get(id) as (Omit<Draft, 'values'> & { valuesJson: string }) | null
      if (!row) return null
      const { valuesJson, ...draft } = row
      return { ...draft, values: JSON.parse(valuesJson) as DraftValues }
    })
  }

  close(): void {
    this.db.close()
  }
}

export function openStore(path: string, logger?: Logger): Store {
  const dbPath = path === ':memory:' ? path : resolve(path)
  const rootDir = path === ':memory:' ? dataDir() : dirname(dbPath)
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const storeLogger = logger ?? new Logger(rootDir)
  const db = new Database(dbPath)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA journal_mode = WAL')
    migrate(db)
    return new Store(db, storeLogger)
  } catch (error) {
    try {
      storeLogger.log('error', 'store', 'openStore failed', {
        error: errorMessage(error),
      })
    } catch {}
    db.close()
    throw error
  }
}
