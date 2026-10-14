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
  branchName?: string
  year: number
  registeredName?: string
  taxpayerType?: TaxpayerType
  birthDate?: string | null
  rdo?: string
  address?: string
  zip?: string
  email?: string
  phone?: string
}

export type TaxpayerType = 'individual' | 'non-individual'

export interface TaxpayerFacts {
  name: string
  type: TaxpayerType
  birthDate: string | null
}

export interface BranchFacts {
  rdo: string
  zip: string
  address: string
  phone: string
  email: string
}

export type BranchFactOverrides = {
  [K in keyof BranchFacts]?: string | null
}

export interface ResolvedBranchFacts extends BranchFacts {
  inherited: Record<keyof BranchFacts, boolean>
}

export interface CreateTaxpayerInput extends TaxpayerFacts {
  tin: string
  rdo?: string
  zip?: string
  address?: string
  phone?: string
  email?: string
}

export interface CreateBranchInput extends BranchFactOverrides {
  tin9: string
  code: string
  name: string
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
  email: string
  phone: string
}

export interface TaxpayerTree {
  tin9: string
  name: string
  type: TaxpayerType
  birthDate: string | null
  branches: Array<{
    id: string
    code: string
    name: string
    overrides: BranchFactOverrides
    facts: ResolvedBranchFacts
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
  period: string
  values: DraftValues
  status: 'draft' | 'queued' | 'submitted' | 'confirmed' | 'paid'
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
        ALTER TABLE taxpayers ADD COLUMN name TEXT NOT NULL DEFAULT '';
        ALTER TABLE taxpayers ADD COLUMN type TEXT NOT NULL DEFAULT 'individual'
          CHECK (type IN ('individual', 'non-individual'));
        ALTER TABLE taxpayers ADD COLUMN birth_date TEXT;

        ALTER TABLE branches ADD COLUMN name TEXT NOT NULL DEFAULT '';
        ALTER TABLE branches ADD COLUMN rdo TEXT;
        ALTER TABLE branches ADD COLUMN zip TEXT;
        ALTER TABLE branches ADD COLUMN address TEXT;
        ALTER TABLE branches ADD COLUMN phone TEXT;
        ALTER TABLE branches ADD COLUMN email TEXT;

        UPDATE taxpayers
        SET name = COALESCE((
          SELECT registered_name
          FROM profiles
          WHERE profiles.tin9 = taxpayers.tin9
          ORDER BY (profiles.branch = '00000') DESC, profiles.year DESC
          LIMIT 1
        ), '');

        UPDATE branches
        SET
          name = CASE WHEN code = '00000' THEN 'Head office' ELSE 'Branch ' || code END,
          rdo = (
            SELECT rdo FROM profiles
            WHERE profiles.tin9 = branches.tin9 AND profiles.branch = branches.code
            ORDER BY profiles.year DESC LIMIT 1
          ),
          zip = (
            SELECT zip FROM profiles
            WHERE profiles.tin9 = branches.tin9 AND profiles.branch = branches.code
            ORDER BY profiles.year DESC LIMIT 1
          ),
          address = (
            SELECT address FROM profiles
            WHERE profiles.tin9 = branches.tin9 AND profiles.branch = branches.code
            ORDER BY profiles.year DESC LIMIT 1
          ),
          phone = (
            SELECT phone FROM profiles
            WHERE profiles.tin9 = branches.tin9 AND profiles.branch = branches.code
            ORDER BY profiles.year DESC LIMIT 1
          ),
          email = (
            SELECT email FROM profiles
            WHERE profiles.tin9 = branches.tin9 AND profiles.branch = branches.code
            ORDER BY profiles.year DESC LIMIT 1
          );

        CREATE TABLE drafts (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          form_code TEXT NOT NULL,
          period TEXT NOT NULL CHECK (
            period GLOB '[0-9][0-9][0-9][0-9]'
            OR period GLOB '[0-9][0-9][0-9][0-9]-Q[1-4]'
            OR (
              period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
              AND substr(period, 6, 2) BETWEEN '01' AND '12'
            )
          ),
          "values" JSON NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('draft', 'queued', 'submitted', 'confirmed', 'paid')
          ),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (profile_id, form_code, period)
        )
      `)
      db.exec('CREATE INDEX drafts_profile_updated ON drafts (profile_id, updated_at)')
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

  createTaxpayer(input: CreateTaxpayerInput): TaxpayerTree {
    return this.withErrorLogging('createTaxpayer', () => {
      const parsed = parseTin(input.tin)
      if (parsed.branch !== '00000') {
        throw new Error('Enter the taxpayer TIN without a branch code.')
      }
      if (!input.name.trim()) {
        throw new Error('Enter a taxpayer name.')
      }
      if (input.type !== 'individual' && input.type !== 'non-individual') {
        throw new Error('Choose an individual or non-individual taxpayer type.')
      }
      const facts = {
        rdo: input.rdo ?? '',
        zip: input.zip ?? '',
        address: input.address ?? '',
        phone: input.phone ?? '',
        email: input.email ?? '',
      }
      const create = this.db.transaction(() => {
        this.db
          .query('INSERT INTO taxpayers (tin9, name, type, birth_date) VALUES (?, ?, ?, ?)')
          .run(parsed.tin9, input.name.trim(), input.type, input.birthDate ?? null)
        this.db
          .query(`
            INSERT INTO branches (tin9, code, name, rdo, zip, address, phone, email)
            VALUES (?, '00000', 'Head office', ?, ?, ?, ?, ?)
          `)
          .run(
            parsed.tin9,
            facts.rdo,
            facts.zip,
            facts.address,
            facts.phone,
            facts.email,
          )
      })
      try {
        create()
      } catch (error) {
        if (errorMessage(error).includes('UNIQUE constraint failed: taxpayers.tin9')) {
          throw new Error(`A taxpayer with TIN ${parsed.tin9} already exists.`)
        }
        throw error
      }
      this.logger.log('info', 'store', 'Taxpayer created', { tin9: parsed.tin9 })
      return this.listTaxpayers().find((taxpayer) => taxpayer.tin9 === parsed.tin9)!
    })
  }

  updateTaxpayer(tin: string, facts: Partial<TaxpayerFacts>): void {
    this.withErrorLogging('updateTaxpayer', () => {
      const { tin9, branch } = parseTin(tin)
      if (branch !== '00000') {
        throw new Error('Taxpayer updates require the 9-digit TIN.')
      }
      if (facts.type !== undefined && facts.type !== 'individual' && facts.type !== 'non-individual') {
        throw new Error('Choose an individual or non-individual taxpayer type.')
      }
      if (facts.name !== undefined && !facts.name.trim()) {
        throw new Error('Enter a taxpayer name.')
      }
      const current = this.db
        .query('SELECT name, type, birth_date AS birthDate FROM taxpayers WHERE tin9 = ?')
        .get(tin9) as TaxpayerFacts | null
      if (!current) {
        throw new Error(`Taxpayer not found: ${tin9}.`)
      }
      const result = this.db
        .query('UPDATE taxpayers SET name = ?, type = ?, birth_date = ? WHERE tin9 = ?')
        .run(
          facts.name?.trim() ?? current.name,
          facts.type ?? current.type,
          facts.birthDate === undefined ? current.birthDate : facts.birthDate,
          tin9,
        )
      if (!result.changes) {
        throw new Error(`Taxpayer not found: ${tin9}.`)
      }
      this.logger.log('info', 'store', 'Taxpayer facts updated', { tin9 })
    })
  }

  createBranch(input: CreateBranchInput): TaxpayerTree['branches'][number] {
    return this.withErrorLogging('createBranch', () => {
      const parsed = parseTin(input.tin9)
      if (parsed.branch !== '00000' || !/^\d{9}$/.test(parsed.tin9)) {
        throw new Error('Enter a 9-digit taxpayer TIN.')
      }
      if (!/^\d{5}$/.test(input.code) || input.code === '00000') {
        throw new Error('Branch code must be a non-head-office 5-digit code.')
      }
      if (!input.name.trim()) {
        throw new Error('Enter a branch name.')
      }
      const values = (['rdo', 'zip', 'address', 'phone', 'email'] as const).map((key) => {
        const value = input[key]
        return typeof value === 'string' && value.trim() ? value.trim() : null
      })
      try {
        this.db
          .query(`
            INSERT INTO branches (tin9, code, name, rdo, zip, address, phone, email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(parsed.tin9, input.code, input.name.trim(), ...values)
      } catch (error) {
        if (errorMessage(error).includes('UNIQUE constraint failed: branches.tin9')) {
          throw new Error(`Branch ${input.code} already exists for TIN ${parsed.tin9}.`)
        }
        throw error
      }
      this.logger.log('info', 'store', 'Branch created', { tin9: parsed.tin9, branch: input.code })
      return this.listTaxpayers()
        .find((taxpayer) => taxpayer.tin9 === parsed.tin9)!
        .branches.find((branch) => branch.code === input.code)!
    })
  }

  updateBranch(branchId: string, input: { name?: string } & BranchFactOverrides): void {
    this.withErrorLogging('updateBranch', () => {
      const { tin9, branch: code } = parseTin(branchId)
      const current = this.db
        .query('SELECT name, rdo, zip, address, phone, email FROM branches WHERE tin9 = ? AND code = ?')
        .get(tin9, code) as
        | ({ name: string } & { [K in keyof BranchFacts]: string | null })
        | null
      if (!current) {
        throw new Error(`Branch not found: ${branchId}.`)
      }
      const value = (key: keyof BranchFacts) => {
        const next = input[key] === undefined ? current[key] : input[key]
        if (code !== '00000') {
          return typeof next === 'string' && next.trim() ? next.trim() : null
        }
        return typeof next === 'string' ? next.trim() : ''
      }
      const result = this.db
        .query(`
          UPDATE branches SET name = ?, rdo = ?, zip = ?, address = ?, phone = ?, email = ?
          WHERE tin9 = ? AND code = ?
        `)
        .run(
          input.name?.trim() || current.name,
          value('rdo'),
          value('zip'),
          value('address'),
          value('phone'),
          value('email'),
          tin9,
          code,
        )
      if (!result.changes) {
        throw new Error(`Branch not found: ${branchId}.`)
      }
      this.logger.log('info', 'store', 'Branch facts updated', { tin9, branch: code })
    })
  }

  resolveBranchFacts(branchId: string): ResolvedBranchFacts {
    return this.withErrorLogging('resolveBranchFacts', () => {
      const { tin9, branch: code } = parseTin(branchId)
      const branch = this.db
        .query('SELECT rdo, zip, address, phone, email FROM branches WHERE tin9 = ? AND code = ?')
        .get(tin9, code) as BranchFactOverrides | null
      if (!branch) {
        throw new Error(`Branch not found: ${branchId}.`)
      }
      const head = code === '00000'
        ? branch
        : (this.db
            .query('SELECT rdo, zip, address, phone, email FROM branches WHERE tin9 = ? AND code = ?')
            .get(tin9, '00000') as BranchFactOverrides | null) ?? {}
      const inherited = {} as Record<keyof BranchFacts, boolean>
      const facts = {} as BranchFacts
      for (const key of ['rdo', 'zip', 'address', 'phone', 'email'] as const) {
        inherited[key] = code !== '00000' && branch[key] == null
        facts[key] = branch[key] ?? head[key] ?? ''
      }
      return { ...facts, inherited }
    })
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

      const profileId = randomUUID()
      const create = this.db.transaction(() => {
        this.db
          .query('INSERT OR IGNORE INTO taxpayers (tin9) VALUES (?)')
          .run(parsedTin.tin9)
        if (input.registeredName?.trim()) {
          this.db
            .query('UPDATE taxpayers SET name = ? WHERE tin9 = ?')
            .run(input.registeredName.trim(), parsedTin.tin9)
        }
        if (input.taxpayerType) {
          this.db
            .query('UPDATE taxpayers SET type = ? WHERE tin9 = ?')
            .run(input.taxpayerType, parsedTin.tin9)
        }
        if (input.birthDate !== undefined) {
          this.db
            .query('UPDATE taxpayers SET birth_date = ? WHERE tin9 = ?')
            .run(input.birthDate, parsedTin.tin9)
        }
        this.db
          .query(`
            INSERT OR IGNORE INTO branches (tin9, code, name)
            VALUES (?, '00000', 'Head office')
          `)
          .run(parsedTin.tin9)
        const defaultBranchName = branch === '00000' ? 'Head office' : `Branch ${branch}`
        this.db
          .query(`
            INSERT OR IGNORE INTO branches (tin9, code, name)
            VALUES (?, ?, ?)
          `)
          .run(parsedTin.tin9, branch, input.branchName?.trim() || defaultBranchName)
        if (input.branchName?.trim()) {
          this.db
            .query('UPDATE branches SET name = ? WHERE tin9 = ? AND code = ?')
            .run(input.branchName.trim(), parsedTin.tin9, branch)
        }
        for (const key of ['rdo', 'zip', 'address', 'phone', 'email'] as const) {
          const value = input[key]
          if (value !== undefined) {
            const stored =
              branch !== '00000' && !value.trim() ? null : value.trim()
            this.db
              .query(`UPDATE branches SET ${key} = ? WHERE tin9 = ? AND code = ?`)
              .run(stored, parsedTin.tin9, branch)
          } else if (branch === '00000') {
            this.db
              .query(`UPDATE branches SET ${key} = '' WHERE tin9 = ? AND code = ? AND ${key} IS NULL`)
              .run(parsedTin.tin9, branch)
          }
        }
        this.db
          .query(`
            INSERT INTO profiles (
              id, tin9, branch, year, registered_name, rdo, address, zip,
              line_of_business, email, phone
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            profileId,
            parsedTin.tin9,
            branch,
            input.year,
            input.registeredName ?? '',
            input.rdo ?? '',
            input.address ?? '',
            input.zip ?? '',
            '',
            input.email ?? '',
            input.phone ?? '',
          )
      })
      try {
        create()
      } catch (error) {
        if (errorMessage(error).includes('UNIQUE constraint failed: profiles.tin9')) {
          throw new Error(
            `A profile already exists for TIN ${parsedTin.tin9}, branch ${branch}, and year ${input.year}.`,
          )
        }
        throw error
      }
      const profile = this.listTaxpayers()
        .flatMap((taxpayer) => taxpayer.branches.flatMap((item) => item.years))
        .find((item) => item.id === profileId)
      if (!profile) {
        throw new Error(`Could not load created profile ${profileId}.`)
      }
      this.logger.log('info', 'store', 'Profile created', {
        profileId,
        branch,
        year: input.year,
      })
      return profile
    })
  }

  listTaxpayers(): TaxpayerTree[] {
    return this.withErrorLogging('listTaxpayers', () => {
      const rows = this.db
        .query(`
          SELECT
            t.tin9,
            t.name,
            t.type,
            t.birth_date AS birthDate,
            b.code,
            b.name AS branchName,
            b.rdo,
            b.zip,
            b.address,
            b.phone,
            b.email,
            p.id,
            p.year
          FROM taxpayers t
          JOIN branches b ON b.tin9 = t.tin9
          LEFT JOIN profiles p ON p.tin9 = b.tin9 AND p.branch = b.code
          ORDER BY t.tin9, b.code, p.year
        `)
        .all() as Array<{
        tin9: string
        name: string
        type: TaxpayerType
        birthDate: string | null
        code: string
        branchName: string
        rdo: string | null
        zip: string | null
        address: string | null
        phone: string | null
        email: string | null
        id: string | null
        year: number | null
      }>
      const taxpayers = new Map<string, TaxpayerTree>()
      for (const row of rows) {
        let taxpayer = taxpayers.get(row.tin9)
        if (!taxpayer) {
          taxpayer = {
            tin9: row.tin9,
            name: row.name,
            type: row.type,
            birthDate: row.birthDate,
            branches: [],
          }
          taxpayers.set(row.tin9, taxpayer)
        }
        let branch = taxpayer.branches.find((item) => item.code === row.code)
        if (!branch) {
          const id = `${row.tin9}${row.code}`
          const facts = this.resolveBranchFacts(id)
          branch = {
            id,
            code: row.code,
            name: row.branchName,
            overrides: {
              rdo: row.rdo,
              zip: row.zip,
              address: row.address,
              phone: row.phone,
              email: row.email,
            },
            facts,
            years: [],
          }
          taxpayer.branches.push(branch)
        }
        if (row.id !== null && row.year !== null) {
          branch.years.push({
            id: row.id,
            tin9: row.tin9,
            branch: row.code,
            year: row.year,
            registeredName: taxpayer.name,
            rdo: branch.facts.rdo,
            address: branch.facts.address,
            zip: branch.facts.zip,
            email: branch.facts.email,
            phone: branch.facts.phone,
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

  openDraft(profileId: string, formCode: string, period: string): Draft {
    return this.withErrorLogging('openDraft', () => {
      const monthly = /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
      const quarterly = /^\d{4}-Q[1-4]$/.test(period)
      const annual = /^\d{4}$/.test(period)
      if (!monthly && !quarterly && !annual) {
        throw new Error('Enter a valid period as YYYY-MM, YYYY-Qn, or YYYY.')
      }
      const open = this.db.transaction(() => {
        const row = this.db
          .query(`
            SELECT id, profile_id AS profileId, form_code AS formCode, period,
              "values" AS valuesJson, status, created_at AS createdAt, updated_at AS updatedAt
            FROM drafts WHERE profile_id = ? AND form_code = ? AND period = ?
          `)
          .get(profileId, formCode, period) as
          | (Omit<Draft, 'values'> & { valuesJson: string })
          | null
        if (row) {
          const { valuesJson, ...draft } = row
          return { ...draft, values: JSON.parse(valuesJson) as DraftValues }
        }
        const now = Date.now()
        const draft: Draft = {
          id: randomUUID(),
          profileId,
          formCode,
          period,
          values: {},
          status: 'draft',
          createdAt: now,
          updatedAt: now,
        }
        this.db
          .query(`
            INSERT INTO drafts (
              id, profile_id, form_code, period, "values", status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            draft.id,
            profileId,
            formCode,
            period,
            JSON.stringify(draft.values),
            draft.status,
            now,
            now,
          )
        return draft
      })
      const draft = open()
      if (draft.createdAt === draft.updatedAt && Object.keys(draft.values).length === 0) {
        this.logger.log('info', 'store', 'Draft opened', {
          draftId: draft.id,
          formCode,
          period,
        })
      }
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

  setDraftStatus(id: string, status: Draft['status']): Draft {
    return this.withErrorLogging('setDraftStatus', () => {
      if (!['draft', 'queued', 'submitted', 'confirmed', 'paid'].includes(status)) {
        throw new Error(`Invalid draft status: ${status}.`)
      }
      const current = this.db
        .query('SELECT updated_at AS updatedAt FROM drafts WHERE id = ?')
        .get(id) as { updatedAt: number } | null
      if (!current) {
        throw new Error(`Draft not found: ${id}.`)
      }
      this.db
        .query('UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, Math.max(Date.now(), current.updatedAt + 1), id)
      this.logger.log('info', 'store', 'Draft status changed', { draftId: id, status })
      return this.getDraft(id)!
    })
  }

  listDrafts(profileId: string, formCode?: string): Draft[] {
    return this.withErrorLogging('listDrafts', () => {
      const rows = formCode
        ? this.db
            .query(
              'SELECT id, profile_id AS profileId, form_code AS formCode, period, "values" AS valuesJson, status, created_at AS createdAt, updated_at AS updatedAt FROM drafts WHERE profile_id = ? AND form_code = ? ORDER BY updated_at DESC, created_at DESC, rowid DESC',
            )
            .all(profileId, formCode)
        : this.db
            .query(
              'SELECT id, profile_id AS profileId, form_code AS formCode, period, "values" AS valuesJson, status, created_at AS createdAt, updated_at AS updatedAt FROM drafts WHERE profile_id = ? ORDER BY updated_at DESC, created_at DESC, rowid DESC',
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
          'SELECT id, profile_id AS profileId, form_code AS formCode, period, "values" AS valuesJson, status, created_at AS createdAt, updated_at AS updatedAt FROM drafts WHERE id = ?',
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
