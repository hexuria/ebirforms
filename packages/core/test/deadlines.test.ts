import { describe, expect, it } from 'bun:test'

import {
  dueDateFor,
  familyCode,
  nextPeriod,
  periodLabel,
  periodsForYear,
  projectDue,
} from '../src/deadlines'

describe('familyCode', () => {
  it('strips version suffixes', () => {
    expect(familyCode('1601Cv2018')).toBe('1601C')
    expect(familyCode('2550Qv2024')).toBe('2550Q')
    expect(familyCode('0619E')).toBe('0619E')
    expect(familyCode('1702MXv2018C')).toBe('1702MX')
  })
})

describe('periodsForYear / nextPeriod', () => {
  it('enumerates monthly, quarterly, annual periods', () => {
    expect(periodsForYear(2026, 'monthly')[10]).toBe('2026-11')
    expect(periodsForYear(2026, 'quarterly')).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'])
    expect(periodsForYear(2026, 'annual')).toEqual(['2026'])
  })

  it('rolls across year boundaries', () => {
    expect(nextPeriod('2026-10')).toBe('2026-11')
    expect(nextPeriod('2026-12')).toBe('2027-01')
    expect(nextPeriod('2026-Q3')).toBe('2026-Q4')
    expect(nextPeriod('2026-Q4')).toBe('2027-Q1')
    expect(nextPeriod('2026')).toBe('2027')
  })
})

describe('periodLabel', () => {
  it('formats monthly, quarterly, annual', () => {
    expect(periodLabel('2026-10')).toBe('October 2026')
    expect(periodLabel('2026-Q3')).toBe('Q3 2026')
    expect(periodLabel('2026')).toBe('TY 2026')
  })
})

describe('dueDateFor', () => {
  it('monthly remittance returns are due on the 10th of the next month', () => {
    expect(dueDateFor('1601Cv2018', 'monthly', '2026-10')).toBe('2026-11-10')
    expect(dueDateFor('0619E', 'monthly', '2026-09')).toBe('2026-10-10')
    expect(dueDateFor('1601Cv2018', 'monthly', '2026-12')).toBe('2027-01-10')
  })

  it('quarterly VAT/percentage returns are due on the 25th of the month after the quarter', () => {
    expect(dueDateFor('2550Qv2024', 'quarterly', '2026-Q3')).toBe('2026-10-25')
    expect(dueDateFor('2551Qv2018', 'quarterly', '2026-Q3')).toBe('2026-10-25')
    expect(dueDateFor('2550Q', 'quarterly', '2026-Q4')).toBe('2027-01-25')
  })

  it('quarterly remittance returns are due on the last day of the month after the quarter', () => {
    expect(dueDateFor('1601EQ', 'quarterly', '2026-Q3')).toBe('2026-10-31')
    expect(dueDateFor('1601EQ', 'quarterly', '2026-Q4')).toBe('2027-01-31')
    expect(dueDateFor('1603Qv2018', 'quarterly', '2026-Q1')).toBe('2026-04-30')
  })

  it('1701Q lands on the 15th of the second month after the quarter, 1702Q 60 days out', () => {
    expect(dueDateFor('1701Qv2018', 'quarterly', '2026-Q3')).toBe('2026-11-15')
    expect(dueDateFor('1702Qv2018C', 'quarterly', '2026-Q3')).toBe('2026-11-29')
    expect(dueDateFor('1701Qv2018', 'quarterly', '2026-Q4')).toBe('2027-02-15')
    expect(dueDateFor('1702Qv2018C', 'quarterly', '2026-Q4')).toBe('2027-03-01')
  })

  it('1604 annual information returns are due January 31 of the next year', () => {
    expect(dueDateFor('1604C', 'annual', '2026')).toBe('2027-01-31')
    expect(dueDateFor('1604CF', 'annual', '2026')).toBe('2027-01-31')
  })

  it('annual income tax returns are due April 15 of the next year', () => {
    expect(dueDateFor('1701v2018', 'annual', '2026')).toBe('2027-04-15')
    expect(dueDateFor('1702RTv2018C', 'annual', '2026')).toBe('2027-04-15')
    expect(dueDateFor('1706', 'annual', '2026')).toBe('2027-04-15')
  })

  it('falls back by frequency for unmapped forms', () => {
    // '9999X' is not in any table.
    expect(dueDateFor('9999X', 'monthly', '2026-05')).toBe('2026-06-10')
    expect(dueDateFor('9999X', 'quarterly', '2026-Q2')).toBe('2026-07-25')
    expect(dueDateFor('9999X', 'annual', '2026')).toBe('2027-04-15')
  })
})

describe('projectDue', () => {
  const TODAY = new Date('2026-10-14T12:00:00Z')
  const base = {
    profileId: 'p1',
    tin9: '009123456',
    branchCode: '00000',
    year: 2026,
  }

  it('picks the first unfiled period whose window has not ended', () => {
    const rows = projectDue([
      { ...base, formCode: '1601Cv2018', frequency: 'monthly', statuses: { '2026-09': 'submitted' } },
    ], TODAY)
    expect(rows).toHaveLength(1)
    // Jan–Aug were skipped without drafts; October is the first live period.
    expect(rows[0].period).toBe('2026-10')
    expect(rows[0].dueDate).toBe('2026-11-10')
    expect(rows[0].draftStatus).toBeNull()
  })

  it('marks a pending period with a live draft as Draft', () => {
    const rows = projectDue([
      {
        ...base,
        formCode: '2550Qv2024',
        frequency: 'quarterly',
        statuses: { '2026-Q1': 'paid', '2026-Q2': 'confirmed', '2026-Q3': 'draft' },
      },
    ], TODAY)
    expect(rows).toHaveLength(1)
    expect(rows[0].period).toBe('2026-Q3')
    expect(rows[0].dueDate).toBe('2026-10-25')
    expect(rows[0].draftStatus).toBe('draft')
  })

  it('still surfaces a draft left behind in an earlier period', () => {
    const rows = projectDue([
      { ...base, formCode: '0619E', frequency: 'monthly', statuses: { '2026-08': 'draft' } },
    ], TODAY)
    expect(rows[0].period).toBe('2026-08')
    expect(rows[0].dueDate).toBe('2026-09-10')
  })

  it('skips forms that are fully filed for the year', () => {
    const rows = projectDue([
      { ...base, formCode: '1701v2018', frequency: 'annual', statuses: { '2026': 'confirmed' } },
      { ...base, formCode: '0619E', frequency: 'monthly', statuses: Object.fromEntries(
        periodsForYear(2026, 'monthly').map((p) => [p, 'paid']),
      ) },
    ], TODAY)
    expect(rows).toHaveLength(0)
  })

  it('projects future profile years from their first period', () => {
    const rows = projectDue([
      { ...base, year: 2027, formCode: '1601Cv2018', frequency: 'monthly', statuses: {} },
    ], TODAY)
    expect(rows[0].period).toBe('2027-01')
    expect(rows[0].dueDate).toBe('2027-02-10')
  })

  it('sorts rows by due date', () => {
    const rows = projectDue([
      { ...base, formCode: '1601Cv2018', frequency: 'monthly', statuses: {} },
      { ...base, profileId: 'p2', tin9: '234567890', formCode: '2550Qv2024', frequency: 'quarterly', statuses: {} },
    ], TODAY)
    // Monthly Oct → due Nov 10; quarterly Q3 → due Oct 25.
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-10-25', '2026-11-10'])
  })
})
