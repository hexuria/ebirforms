/**
 * Demo seed for screenshots and manual verification.
 *
 * Runs only when `EBIRFORMS_SEED=demo`; idempotent — existing taxpayers are
 * skipped. All data uses the mockup's test TINs, never real taxpayer data.
 */

import type { Draft, Store } from '@ebirforms/core'

function ts(iso: string): number {
  return Date.parse(`${iso}T08:00:00`)
}

export function seedDemo(store: Store): void {
  const existing = new Set(store.listTaxpayers().map((taxpayer) => taxpayer.tin9))

  if (!existing.has('009123456')) {
    store.createTaxpayer({
      tin: '009123456',
      name: 'Goldcoders Corp',
      type: 'non-individual',
      birthDate: null,
      rdo: '080',
      address: '2314 Ayala Ave, Makati City',
      zip: '1200',
      email: 'tax@goldcoders.ph',
      phone: '(02) 8888-0000',
    })
    store.createBranch({
      tin9: '009123456',
      code: '00001',
      name: 'Cebu',
      address: '88 Osmeña Blvd, Cebu City',
      zip: '6000',
      rdo: '082',
    })
    const ho = store.createProfile({ tin: '009123456', branch: '00000', year: 2026, registeredName: 'Goldcoders Corp' })
    const cebu = store.createProfile({ tin: '009123456', branch: '00001', year: 2026, registeredName: 'Goldcoders Corp — Cebu' })
    store.addForms(ho.id, ['1601Cv2018', '0619E', '1601EQ', '2550Qv2024', '1604C', '1702RTv2018C', '1702Qv2018C'])
    store.addForms(cebu.id, ['0619E', '1601EQ'])

    // Filed drafts power Filings + Recently filed; statuses must match the
    // projection rows (Oct pending / Q3 pending / overdue Cebu draft).
    const filed: Array<[string, string, string, Draft['status'], string]> = []
    const mk = (profileId: string, formCode: string, period: string, status: Draft['status'], updatedIso: string) =>
      filed.push([profileId, formCode, period, status, updatedIso])

    mk(ho.id, '1601Cv2018', '2026-09', 'confirmed', '2026-10-08')
    mk(ho.id, '0619E', '2026-09', 'submitted', '2026-10-09')
    mk(ho.id, '2550Qv2024', '2026-Q2', 'paid', '2026-07-25')
    mk(ho.id, '1601EQ', '2026-Q2', 'confirmed', '2026-07-30')

    const s2550 = store.openDraft(ho.id, '2550Qv2024', '2026-Q3')
    store.saveDraft(s2550.id, { 'frm2550Q:txtTaxpayerName': 'Goldcoders Corp' })
    const ceb0619 = store.openDraft(cebu.id, '0619E', '2026-09')
    store.saveDraft(ceb0619.id, { 'frm0619E:txtTaxpayerName': 'Goldcoders Corp — Cebu' })

    for (const [profileId, formCode, period, status, updatedIso] of filed) {
      const draft = store.openDraft(profileId, formCode, period)
      store.saveDraft(draft.id, { seeded: true })
      store.setDraftStatus(draft.id, status)
      store.db.query('UPDATE drafts SET updated_at = ? WHERE id = ?').run(ts(updatedIso), draft.id)
    }
    // Recent-returns ordering: Q3 draft newest, Cebu draft next.
    store.db.query('UPDATE drafts SET updated_at = ? WHERE id = ?').run(ts('2026-10-12'), s2550.id)
    store.db.query('UPDATE drafts SET updated_at = ? WHERE id = ?').run(ts('2026-10-11'), ceb0619.id)
  }

  if (!existing.has('234567890')) {
    store.createTaxpayer({
      tin: '234567890',
      name: 'Maria Santos Dela Cruz',
      type: 'individual',
      birthDate: '1985-06-12',
      rdo: '039',
      address: 'Unit 5, Commonwealth Ave, Quezon City',
      zip: '1121',
      email: 'maria.delacruz@example.ph',
      phone: '0917 555 0123',
    })
    const profile = store.createProfile({ tin: '234567890', branch: '00000', year: 2026, registeredName: 'Maria Santos Dela Cruz' })
    store.addForms(profile.id, ['1701Qv2018', '1701v2018', '2551Qv2018', '0619E'])
    const q2 = store.openDraft(profile.id, '1701Qv2018', '2026-Q2')
    store.saveDraft(q2.id, { seeded: true })
    store.setDraftStatus(q2.id, 'submitted')
    store.db.query('UPDATE drafts SET updated_at = ? WHERE id = ?').run(ts('2026-08-14'), q2.id)
  }

  if (!existing.has('345678901')) {
    store.createTaxpayer({
      tin: '345678901',
      name: 'Sari-Sari ni Aling Nena',
      type: 'non-individual',
      birthDate: null,
      rdo: '034',
      address: '12 Mabini St, Brgy. San Jose',
      zip: '4023',
      email: 'alingnena.sarisari@example.ph',
      phone: '0918 555 0456',
    })
    const profile = store.createProfile({ tin: '345678901', branch: '00000', year: 2026, registeredName: 'Sari-Sari ni Aling Nena' })
    store.addForms(profile.id, ['2551Qv2018', '0619E', '1701v2018'])
    const q2 = store.openDraft(profile.id, '2551Qv2018', '2026-Q2')
    store.saveDraft(q2.id, { seeded: true })
    store.setDraftStatus(q2.id, 'confirmed')
    store.db.query('UPDATE drafts SET updated_at = ? WHERE id = ?').run(ts('2026-07-24'), q2.id)
  }

  if (!store.getSetting('displayName')) store.setSetting('displayName', 'Juan')
  if (!store.getSetting('email')) store.setSetting('email', 'juan@goldcoders.ph')
  store.logger.log('info', 'seed', 'Demo data seeded', { mode: 'demo' })
}
