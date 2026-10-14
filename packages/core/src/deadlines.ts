/**
 * BIR filing-deadline rules and due-date projection for the app shell.
 *
 * Rules follow the eBIRForms filing conventions used throughout the official
 * package ("filed on or before the due date"): monthly remittance returns land
 * on the 10th of the next month, quarterly percentage/VAT returns on the 25th
 * of the month after the quarter, quarterly remittance returns on the last day
 * of that month, 1701Q/1702Q a fixed number of days after quarter end, annual
 * income tax returns April 15 of the next year, and the 1604 annual
 * information returns January 31 of the next year. Unknown forms fall back to
 * a per-frequency default.
 *
 * Draft statuses 'queued', 'submitted', 'confirmed' and 'paid' count as filed.
 */

import type { ReturnFrequency } from '@ebirforms/forms'
import type { Draft } from './store.js'

export const FILED_STATUSES: ReadonlySet<Draft['status']> = new Set([
  'queued',
  'submitted',
  'confirmed',
  'paid',
])

export function familyCode(code: string): string {
  return code.replace(/v\d{4}.*$/i, '')
}

export function isMonthlyPeriod(period: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(period)
}

export function isQuarterlyPeriod(period: string): boolean {
  return /^\d{4}-Q[1-4]$/.test(period)
}

export function isAnnualPeriod(period: string): boolean {
  return /^\d{4}$/.test(period)
}

export function periodKind(period: string): ReturnFrequency {
  if (isMonthlyPeriod(period)) return 'monthly'
  if (isQuarterlyPeriod(period)) return 'quarterly'
  if (isAnnualPeriod(period)) return 'annual'
  throw new Error(`Unknown period format: ${period}.`)
}

/** Every period a profile for `year` can file, in filing order. */
export function periodsForYear(year: number, frequency: ReturnFrequency): string[] {
  if (frequency === 'monthly') {
    return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
  }
  if (frequency === 'quarterly') {
    return [1, 2, 3, 4].map((q) => `${year}-Q${q}`)
  }
  return [String(year)]
}

/** The period that follows `period` in filing order, across year boundaries. */
export function nextPeriod(period: string): string {
  const kind = periodKind(period)
  if (kind === 'monthly') {
    const year = Number(period.slice(0, 4))
    const month = Number(period.slice(5, 7))
    return month === 12
      ? `${year + 1}-01`
      : `${year}-${String(month + 1).padStart(2, '0')}`
  }
  if (kind === 'quarterly') {
    const year = Number(period.slice(0, 4))
    const quarter = Number(period.slice(6, 7))
    return quarter === 4 ? `${year + 1}-Q1` : `${year}-Q${quarter + 1}`
  }
  return String(Number(period) + 1)
}

const MONTH_SHORT = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** Human label matching the shell design: 'October 2026', 'Q3 2026', 'TY 2026'. */
export function periodLabel(period: string): string {
  const kind = periodKind(period)
  if (kind === 'monthly') {
    return `${MONTH_SHORT[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`
  }
  if (kind === 'quarterly') {
    return `Q${period.slice(6, 7)} ${period.slice(0, 4)}`
  }
  return `TY ${period}`
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

type DueRule =
  | { kind: 'next-month'; day: number }
  | { kind: 'after-quarter'; months: 1 | 2; day: number | 'last' }
  | { kind: 'days-after-quarter-end'; days: number }
  | { kind: 'next-year'; month: number; day: number }

const MONTHLY_REMITTANCE = new Set([
  '0619E', '0619F', '0620', '1600', '1600PT', '1600VT', '1600WP',
  '1601C', '1601E', '1601F', '1602', '1621', '2000', '2200A', '2200AN',
  '2200C', '2200M', '2200P', '2200S', '2200T', '2550M', '2551M', '2552', '2553',
])
const QUARTERLY_LAST_DAY = new Set(['1601EQ', '1601FQ', '1602Q', '1603', '1603Q'])
const QUARTERLY_25TH = new Set(['2550Q', '2551Q', '2551'])
// 1701Q: 15th day of the second month after the quarter (Aug/Nov/Feb/May 15).
const QUARTERLY_SECOND_MONTH_15 = new Set(['1701Q'])
const DAYS_AFTER_QUARTER = new Map<string, number>([
  // 1702Q: 60 days after the close of the quarter (e.g. Sep 30 → Nov 29).
  ['1702Q', 60],
])
const JAN_31_RETURNS = new Set(['1604C', '1604CF', '1604E', '1604F'])
const APRIL_15_RETURNS = new Set([
  '1700', '1701', '1701A', '1701MS', '1702EX', '1702MX', '1702RT',
  '1704', '1706', '1707', '1707A', '1800', '1801',
])

function dueRule(code: string, frequency: ReturnFrequency): DueRule {
  const family = familyCode(code)
  if (MONTHLY_REMITTANCE.has(family)) return { kind: 'next-month', day: 10 }
  if (QUARTERLY_LAST_DAY.has(family)) return { kind: 'after-quarter', months: 1, day: 'last' }
  if (QUARTERLY_25TH.has(family)) return { kind: 'after-quarter', months: 1, day: 25 }
  if (QUARTERLY_SECOND_MONTH_15.has(family)) return { kind: 'after-quarter', months: 2, day: 15 }
  const days = DAYS_AFTER_QUARTER.get(family)
  if (days !== undefined) return { kind: 'days-after-quarter-end', days }
  if (JAN_31_RETURNS.has(family)) return { kind: 'next-year', month: 1, day: 31 }
  if (APRIL_15_RETURNS.has(family)) return { kind: 'next-year', month: 4, day: 15 }
  if (frequency === 'monthly') return { kind: 'next-month', day: 10 }
  if (frequency === 'quarterly') return { kind: 'after-quarter', months: 1, day: 25 }
  return { kind: 'next-year', month: 4, day: 15 }
}

const MONTHS_IN_QUARTER: Record<number, [number, number, number]> = {
  1: [1, 2, 3],
  2: [4, 5, 6],
  3: [7, 8, 9],
  4: [10, 11, 12],
}

/** ISO due date for one filing of `code` covering `period`. */
export function dueDateFor(code: string, frequency: ReturnFrequency, period: string): string {
  const kind = periodKind(period)
  const rule = dueRule(code, frequency)
  const year = Number(period.slice(0, 4))
  if (rule.kind === 'next-month') {
    if (kind !== 'monthly') throw new Error(`${code} expects a monthly period, got ${period}.`)
    const month = Number(period.slice(5, 7))
    return month === 12 ? iso(year + 1, 1, rule.day) : iso(year, month + 1, rule.day)
  }
  if (rule.kind === 'next-year') {
    return iso(year + 1, rule.month, rule.day)
  }
  if (kind !== 'quarterly') throw new Error(`${code} expects a quarterly period, got ${period}.`)
  const quarter = Number(period.slice(6, 7))
  const quarterEndMonth = MONTHS_IN_QUARTER[quarter][2]
  if (rule.kind === 'after-quarter') {
    // `months` calendar months after the quarter's final month.
    const target = quarterEndMonth + rule.months
    const afterYear = year + Math.floor((target - 1) / 12)
    const afterMonth = ((target - 1) % 12) + 1
    const day = rule.day === 'last' ? daysInMonth(afterYear, afterMonth) : rule.day
    return iso(afterYear, afterMonth, day)
  }
  const end = new Date(Date.UTC(year, quarterEndMonth, 0))
  end.setUTCDate(end.getUTCDate() + rule.days)
  return iso(end.getUTCFullYear(), end.getUTCMonth() + 1, end.getUTCDate())
}

export interface DueProjectionInput {
  profileId: string
  tin9: string
  branchCode: string
  year: number
  formCode: string
  frequency: ReturnFrequency
  /** Draft statuses indexed by period for this profile and form. */
  statuses: Record<string, Draft['status']>
}

export interface DueRow {
  profileId: string
  tin9: string
  branchCode: string
  formCode: string
  period: string
  dueDate: string
  /** Raw draft status at the pending period, or null when untouched. */
  draftStatus: Draft['status'] | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * For every selected form of every tax-year profile, the earliest period that
 * is still actionable: any period whose deadline has not passed is a
 * candidate, plus an earlier period with a live draft (a started-but-late
 * return still needs filing). Deadlines fully missed without a draft stop
 * nagging. Sorted by due date, then taxpayer.
 */
export function projectDue(inputs: DueProjectionInput[], today = new Date()): DueRow[] {
  const rows: DueRow[] = []
  const todayMs = today.getTime()
  for (const input of inputs) {
    let pending: string | null = null
    let pendingDue = ''
    for (const period of periodsForYear(input.year, input.frequency)) {
      const status = input.statuses[period] as Draft['status'] | undefined
      if (status && FILED_STATUSES.has(status)) continue
      const due = dueDateFor(input.formCode, input.frequency, period)
      if (status === 'draft' || Date.parse(`${due}T23:59:59Z`) >= todayMs - DAY_MS) {
        pending = period
        pendingDue = due
        break
      }
    }
    if (!pending) continue
    rows.push({
      profileId: input.profileId,
      tin9: input.tin9,
      branchCode: input.branchCode,
      formCode: input.formCode,
      period: pending,
      dueDate: pendingDue,
      draftStatus: (input.statuses[pending] as Draft['status']) ?? null,
    })
  }
  rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.tin9.localeCompare(b.tin9))
  return rows
}
