import { randomInt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dataDir, openStore } from '../packages/core/src/index.ts'

delete process.env.BIR_SFTP_LIVE
process.env.EBIRFORMS_DATA_DIR ??= join(homedir(), 'scratch', 'p4-redesign', 'data')
mkdirSync(process.env.EBIRFORMS_DATA_DIR, { recursive: true })

const root = dataDir()
const store = openStore(join(root, 'ebirforms.sqlite'))
const secondTinPath = join(root, 'second-taxpayer-tin')

function existingProfile(tin9: string, branch: string, year: number) {
  return store
    .listTaxpayers()
    .find((taxpayer) => taxpayer.tin9 === tin9)
    ?.branches.find((item) => item.code === branch)
    ?.years.find((profile) => profile.year === year)
}

function ensureProfile(tin: string, branch: string, year: number) {
  return existingProfile(tin, branch, year) ?? store.createProfile({ tin, branch, year })
}

try {
  const headFacts = {
    tin: '123-456-788',
    name: 'Northstar Sample Employer',
    type: 'non-individual',
    birthDate: null,
    rdo: '039',
    zip: '1000',
    address: '100 Sample Road',
    phone: '555-0100',
    email: 'filing@example.test',
  } as const
  const existingHead = store.listTaxpayers().find((item) => item.tin9 === '123456788')
  if (existingHead) {
    store.updateTaxpayer(existingHead.tin9, {
      name: headFacts.name,
      type: headFacts.type,
      birthDate: headFacts.birthDate,
    })
  } else {
    store.createTaxpayer(headFacts)
  }
  const head = store.listTaxpayers().find((item) => item.tin9 === '123456788')!
  store.updateBranch(`${head.tin9}-00000`, {
    name: 'Head office',
    rdo: headFacts.rdo,
    zip: headFacts.zip,
    address: headFacts.address,
    phone: headFacts.phone,
    email: headFacts.email,
  })
  const currentTree = store.listTaxpayers().find((item) => item.tin9 === head.tin9)!
  const existingBranch = currentTree.branches.find((item) => item.code === '00001')
  if (existingBranch) {
    store.updateBranch(existingBranch.id, {
      name: 'Makati',
      rdo: '050',
      address: 'Ayala Avenue',
      zip: '1226',
      phone: '555-0101',
      email: 'makati@example.test',
    })
  } else {
    store.createBranch({
      tin9: head.tin9,
      code: '00001',
      name: 'Makati',
      rdo: '050',
      address: 'Ayala Avenue',
      zip: '1226',
      phone: '555-0101',
      email: 'makati@example.test',
    })
  }
  const headOffice = ensureProfile(head.tin9, '00000', 2025)
  ensureProfile(head.tin9, '00001', 2025)

  const secondTin = existsSync(secondTinPath)
    ? readFileSync(secondTinPath, 'utf8').trim()
    : String(randomInt(100_000_000, 999_999_999))
  if (!existsSync(secondTinPath)) writeFileSync(secondTinPath, secondTin)
  const secondFacts = {
    tin: secondTin,
    name: 'Second Sample Taxpayer',
    type: 'individual',
    birthDate: null,
    rdo: '039',
    zip: '1000',
    address: '200 Sample Street',
    phone: '555-0102',
    email: 'second@example.test',
  } as const
  const existingSecond = store.listTaxpayers().find((item) => item.tin9 === secondTin)
  if (existingSecond) {
    store.updateTaxpayer(existingSecond.tin9, {
      name: secondFacts.name,
      type: secondFacts.type,
      birthDate: secondFacts.birthDate,
    })
    store.updateBranch(`${existingSecond.tin9}-00000`, {
      name: 'Head office',
      rdo: secondFacts.rdo,
      zip: secondFacts.zip,
      address: secondFacts.address,
      phone: secondFacts.phone,
      email: secondFacts.email,
    })
  } else {
    store.createTaxpayer(secondFacts)
  }
  const second = store.listTaxpayers().find((item) => item.tin9 === secondTin)!
  ensureProfile(second.tin9, '00000', 2026)

  const codes = ['1601Cv2018', '2551Qv2018', '0619E']
  const existingCodes = new Set(store.listLibrary(headOffice.id).map((entry) => entry.formCode))
  store.addForms(headOffice.id, codes.filter((code) => !existingCodes.has(code)))

  store.openDraft(headOffice.id, '1601Cv2018', '2025-01')
  store.openDraft(headOffice.id, '0619E', '2025-02')
  const quarterly = store.openDraft(headOffice.id, '2551Qv2018', '2025-Q1')
  store.setDraftStatus(quarterly.id, 'confirmed')
  console.log(`Seeded P4 data in ${root}`)
} finally {
  store.close()
}
