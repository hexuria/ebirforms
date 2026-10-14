import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Logger, Store, openStore } from '../src/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fresh(): Store {
  return openStore(join(mkdtempSync(join(tmpdir(), 'store-v5-')), 'db.sqlite'))
}

describe('store v5', () => {
  test('tax years go up to one year after the current year', () => {
    const store = fresh()
    store.createTaxpayer({ tin: '123-456-788', name: 'Sample Co', type: 'non-individual' })
    const next = new Date().getFullYear() + 1
    expect(store.createProfile({ tin: '123456788', branch: '00000', year: 2023 }).year).toBe(2023)
    expect(store.createProfile({ tin: '123456788', branch: '00000', year: next }).year).toBe(next)
    expect(() => store.createProfile({ tin: '123456788', branch: '00000', year: next + 1 })).toThrow(`Tax years go up to ${next}`)
  })

  test('renaming a TIN moves branches, years, drafts and templates', () => {
    const store = fresh()
    store.createTaxpayer({ tin: '123-456-788', name: 'Sample Co', type: 'non-individual' })
    store.createBranch({ tin9: '123456788', code: '00001', name: 'Cebu', rdo: null, zip: null, address: null, phone: null, email: null })
    const profile = store.createProfile({ tin: '123456788', branch: '00001', year: 2026 })
    store.addForms(profile.id, ['0619E'])
    const draft = store.openDraft(profile.id, '0619E', '2026-10')
    store.saveTemplate('123456788', '00001', '0619E', { a: 'x' })
    store.renameTaxpayerTin('123-456-788', '987-654-321')
    const tree = store.listTaxpayers()
    expect(tree.map((item) => item.tin9)).toEqual(['987654321'])
    expect(tree[0].name).toBe('Sample Co')
    expect(tree[0].branches.map((branch) => branch.code)).toEqual(['00000', '00001'])
    expect(tree[0].branches[1].years[0].id).toBe(profile.id)
    expect(store.listLibrary(profile.id).map((entry) => entry.formCode)).toEqual(['0619E'])
    expect(store.getDraft(draft.id)?.profileId).toBe(profile.id)
    expect(store.getTemplate('987654321', '00001', '0619E')?.values).toEqual({ a: 'x' })
    expect(store.listTemplates('123456788', '00001')).toEqual([])
  })

  test('renaming to a TIN already in use is refused', () => {
    const store = fresh()
    store.createTaxpayer({ tin: '123-456-788', name: 'A', type: 'non-individual' })
    store.createTaxpayer({ tin: '987-654-321', name: 'B', type: 'non-individual' })
    expect(() => store.renameTaxpayerTin('123456788', '987654321')).toThrow('already uses TIN')
  })

  test('templates: one per branch and form, saved and deleted', () => {
    const store = fresh()
    store.createTaxpayer({ tin: '123-456-788', name: 'A', type: 'non-individual' })
    store.saveTemplate('123456788', '00000', '1601Cv2018', { k: '1' })
    store.saveTemplate('123456788', '00000', '1601Cv2018', { k: '2' })
    expect(store.listTemplates('123456788', '00000').map((item) => item.values)).toEqual([{ k: '2' }])
    store.deleteTemplate('123456788', '00000', '1601Cv2018')
    expect(store.listTemplates('123456788', '00000')).toEqual([])
  })
})
