/**
 * End-to-end check of tax-profile management on an empty install:
 *   bun parity/e2e-taxprofile.ts [screenshotDir]
 * Welcome → new taxpayer → first year → pick forms in edit mode (frequency
 * filter, starter packs) → add 2023 with copied forms → template → TIN edit.
 */
import { resolve } from 'node:path'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchApp, restoreWorkspace } from './launch.ts'
const OUT = resolve(process.argv[2] ?? 'parity-out/e2e')
mkdirSync(OUT, { recursive: true })
const app = await launchApp({ NODE_ENV: 'production', EBIRFORMS_DATA_DIR: mkdtempSync(join(tmpdir(), 'ebf-empty-')) })
const w = (ms: number) => new Promise((r) => setTimeout(r, ms))
const has = async (id: string) => (await app.getByTestId(id).count()) > 0
const shot = (n: string) => app.screenshot({ path: join(OUT, n + '.png') })
const check = (label: string, ok: boolean) => console.log(ok ? 'PASS' : 'FAIL', label)
await app.getByTestId('nav-home').waitFor({ timeoutMs: 20000 }); await w(400)
check('welcome on empty install', await has('welcome-new-taxpayer')); await shot('01-welcome')
await app.getByTestId('welcome-new-taxpayer').click(); await w(300)
await app.getByTestId('new-taxpayer-tin1').fill('123'); await app.getByTestId('new-taxpayer-tin2').fill('456'); await app.getByTestId('new-taxpayer-tin3').fill('788')
await app.getByTestId('new-taxpayer-name').fill('Sample Trading Co'); await w(200)
await app.getByTestId('new-taxpayer-save').click(); await w(500)
check('taxpayer created (pill shows name)', (await app.getByTestId('titlebar-pill').textContent()).includes('Sample Trading Co'))
await app.getByTestId('tab-forms').click(); await w(300)
check('no-year state shows add-year panel', await has('add-year-select')); await shot('02-no-year')
await app.getByTestId('add-year-select').click(); await w(200)
const next = new Date().getFullYear() + 1
check('next year offered', await has('add-year-select-' + next))
check('year after next not offered', !(await has('add-year-select-' + (next + 1))))
await app.getByTestId('add-year-select-' + (next - 1)).click(); await w(200)
await app.getByTestId('add-year-save').click(); await w(500)
check('year created, read mode empty with Choose forms', (await app.getByText('Choose forms').count()) > 0); await shot('03-year-empty')
await app.getByTestId('forms-edit').click(); await w(300)
check('edit mode shows starter packs', await has('pack-Employer'))
await app.getByTestId('forms-freq-Monthly').click(); await w(200)
check('frequency filter narrows the list', !(await has('lib-1702RT')) && (await has('lib-1601C')))
await app.getByTestId('lib-1601C').click(); await app.getByTestId('lib-0619E').click(); await w(200)
await app.getByTestId('forms-freq-All').click(); await app.getByTestId('lib-0605').click(); await w(200); await shot('04-edit-mode')
await app.getByTestId('forms-save').click(); await w(400)
check('read mode lists only chosen forms', (await has('lib-1601C')) && (await has('lib-0605')) && (await has('lib-0619E')) && !(await has('lib-1702RT')))
check('starter packs hidden outside edit mode', !(await has('pack-Employer'))); await shot('05-read-mode')
await app.getByTestId('add-year-toggle').click(); await w(200)
await app.getByTestId('add-year-select').click(); await w(200); await app.getByTestId('add-year-select-2023').click(); await w(200)
await app.getByTestId('add-year-save').click(); await w(500)
check('2023 added with copied forms', (await has('lib-1601C')) && (await has('lib-0619E')) && (await has('lib-0605')))
check('year selector shows 2023', (await app.getByTestId('year-seg-2023').count()) > 0)
await app.getByTestId('tab-templates').click(); await w(300)
await app.getByTestId('tpl-create-1601C').click(); await w(300); await shot('06-templates')
await app.getByTestId('tab-profile').click(); await w(300)
await app.getByTestId('edit-taxpayer').click(); await w(300)
await shot('07-tin-edit')
await app.mouse.click(await app.getByTestId('save-taxpayer').center()).catch(() => {})
await w(300)
check('save with unchanged TIN keeps taxpayer', (await app.getByTestId('titlebar-pill').textContent()).includes('123-456-788'))
await app.close()
restoreWorkspace()
