import { describe, expect, it } from 'bun:test'

import { openStore } from '../src/store'

function seededStore() {
  const store = openStore(':memory:')
  store.createTaxpayer({
    tin: '009123456',
    name: 'Goldcoders Corp',
    type: 'non-individual',
    birthDate: null,
    rdo: '080',
    address: 'Ayala Ave',
    zip: '1200',
    email: 'tax@goldcoders.ph',
    phone: '8888-0000',
  })
  const profile = store.createProfile({
    tin: '009123456',
    branch: '00000',
    year: 2026,
    registeredName: 'Goldcoders Corp',
  })
  return { store, profile }
}

describe('store v4 settings', () => {
  it('round-trips settings values', () => {
    const { store } = seededStore()
    expect(store.getSetting('theme')).toBeNull()
    store.setSetting('theme', 'dark')
    store.setSetting('theme', 'light')
    store.setSetting('displayName', 'Juan')
    expect(store.getSetting('theme')).toBe('light')
    expect(store.getSetting('displayName')).toBe('Juan')
  })

  it('creates the settings table when migrating an existing v3 database', () => {
    // :memory: opens run all migrations; verify the pragma lands at 4+.
    const { store } = seededStore()
    const version = (store.db.query('PRAGMA user_version').get() as { user_version: number })
      .user_version
    expect(version).toBeGreaterThanOrEqual(4)
    // And the table is usable.
    store.setSetting('k', 'v')
    expect(store.getSetting('k')).toBe('v')
  })
})

describe('store v4 draft queries', () => {
  it('listRecentDrafts orders by updated_at across profiles', () => {
    const { store, profile } = seededStore()
    const a = store.openDraft(profile.id, '1601Cv2018', '2026-09')
    const b = store.openDraft(profile.id, '0619E', '2026-09')
    // Make `a` the most recently touched.
    store.touchDraft(a.id)
    const recent = store.listRecentDrafts(4)
    expect(recent.map((d) => d.id)).toEqual([a.id, b.id])
    expect(store.listRecentDrafts(1)).toHaveLength(1)
  })

  it('listFiledDrafts only returns queued/submitted/confirmed/paid', () => {
    const { store, profile } = seededStore()
    const live = store.openDraft(profile.id, '1601Cv2018', '2026-09')
    store.openDraft(profile.id, '2550Qv2024', '2026-Q3')
    const queued = store.openDraft(profile.id, '0619E', '2026-09')
    store.setDraftStatus(queued.id, 'confirmed')
    const filed = store.listFiledDrafts()
    expect(filed.map((d) => d.id)).toEqual([queued.id])
    expect(filed[0].status).toBe('confirmed')
    store.setDraftStatus(live.id, 'submitted')
    expect(store.listFiledDrafts().map((d) => d.id).sort()).toEqual(
      [live.id, queued.id].sort(),
    )
  })

  it('touchDraft bumps updated_at and preserves values', () => {
    const { store, profile } = seededStore()
    const draft = store.openDraft(profile.id, '0619E', '2026-08')
    store.saveDraft(draft.id, { frm0619E_txtTaxpayerName: 'Test' })
    const touched = store.touchDraft(draft.id)
    expect(touched.values.frm0619E_txtTaxpayerName).toBe('Test')
    expect(touched.updatedAt).toBeGreaterThan(draft.updatedAt)
    expect(() => store.touchDraft('nope')).toThrow()
  })
})
