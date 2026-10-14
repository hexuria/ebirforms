/** bun parity/release-probe.ts <binary> : runs a release build from outside the repo with fresh data; home, a form, validation. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch } from '@gpuix/native/automation'
import { restoreWorkspace } from './launch.ts'
const bin = process.argv[2]
const w = (ms: number) => new Promise((r) => setTimeout(r, ms))
const before = new Set(spawnSync('aerospace', ['list-windows', '--all', '--format', '%{window-id}'], { encoding: 'utf8' }).stdout.split('\n'))
const app = await launch({ command: bin, args: [], cwd: tmpdir(), env: { EBIRFORMS_AUTOMATION: 'stdio', EBIRFORMS_DATA_DIR: mkdtempSync(join(tmpdir(), 'ebf-rel-')), EBIRFORMS_SEED: 'demo' } })
await app.getByTestId('nav-home').waitFor({ timeoutMs: 30000 })
const fresh = spawnSync('aerospace', ['list-windows', '--all', '--format', '%{window-id}'], { encoding: 'utf8' }).stdout.split('\n').filter((id) => id && !before.has(id))
for (const id of fresh) spawnSync('aerospace', ['move-node-to-workspace', '--window-id', id, '2'])
restoreWorkspace()
console.log('home loaded')
await app.getByTestId('sidebar-new').click(); await w(300)
const t0 = performance.now()
await app.getByTestId('start-open').click()
let inputs = 0
for (let i = 0; i < 80 && inputs < 6; i++) { inputs = await app.getByType('input').count(); await w(250) }
console.log('form opened:', inputs >= 6, `(${inputs} inputs, ${((performance.now() - t0) / 1000).toFixed(1)}s)`)
await app.getByTestId('save-return-top').click()
let errs = 0
for (let i = 0; i < 120 && errs === 0; i++) { errs = await app.getByText('Item').count(); await w(250) }
console.log('validation ran:', errs > 0)
await app.close(); restoreWorkspace()
