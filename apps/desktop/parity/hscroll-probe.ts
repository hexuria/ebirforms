/** bun parity/hscroll-probe.ts : sideways wheel must not move any page or panel horizontally (text x positions before/after). */
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { launchApp, restoreWorkspace } from './launch.ts'
const app = await launchApp({ NODE_ENV: 'production', EBIRFORMS_DATA_DIR: mkdtempSync(join(tmpdir(), 'ebf-h-')), EBIRFORMS_SEED: 'demo' })
const w = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function positions() {
  const byText = new Map<string, { x: number; y: number }>()
  const dupes = new Set<string>()
  for (const node of await app.getByType('text').all()) {
    const text = node.text ?? ''
    if (!text || !node.bounds) continue
    if (byText.has(text)) dupes.add(text)
    byText.set(text, { x: node.bounds.x, y: node.bounds.y })
  }
  for (const text of dupes) byText.delete(text)
  return byText
}
let failed = 0
async function check(label: string, at: { x: number; y: number }) {
  await w(800)
  const before = await positions()
  for (let i = 0; i < 6; i++) { await app.mouse.wheel(at, i % 2 ? 120 : -120, 0); await w(30) }
  for (let i = 0; i < 4; i++) { await app.mouse.wheel(at, 150, 20); await w(30) }
  for (let i = 0; i < 4; i++) { await app.mouse.wheel(at, -150, 20); await w(30) }
  await w(600)
  const after = await positions()
  let dx = 0, dy = 0, compared = 0
  for (const [text, a] of before) { const b = after.get(text); if (!b) continue; compared++; dx = Math.max(dx, Math.abs(b.x - a.x)); dy = Math.max(dy, Math.abs(b.y - a.y)) }
  const ok = dx < 0.5 && compared > 3
  if (!ok) failed++
  console.log(`${ok ? 'ok   ' : 'MOVED'} ${label.padEnd(17)} max dx ${dx.toFixed(1)}px, max dy ${dy.toFixed(1)}px over ${compared} texts`)
}
const main = { x: 900, y: 600 }
for (const page of ['home', 'library', 'calendar', 'filings']) { await app.getByTestId(`nav-${page}`).click(); await check(page, main) }
await app.getByTestId('tb-bell').click(); await w(400)
const bell = await app.getByTestId('tb-bell').bounds()
await check('notifications', { x: bell.x - 120, y: bell.y + 220 })
await app.getByTestId('tb-bell').click(); await w(300)
await app.getByTestId('titlebar-pill').click(); await w(400)
const open = await app.getByTestId('panel-open-profile').bounds()
await check('taxprofile-panel', { x: open.x + open.width / 2, y: open.y + 120 })
await app.getByTestId('titlebar-pill').click(); await w(300)
await app.getByTestId('nav-home').click(); await app.getByTestId('sidebar-new').click(); await w(300)
await app.getByTestId('start-open').click()
for (let i = 0; i < 80 && (await app.getByType('input').count()) < 6; i++) await w(250)
await check('form', main)
console.log(failed ? `${failed} MOVED` : 'all still horizontally')
await app.close()
restoreWorkspace()
