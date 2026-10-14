/** bun parity/frames-probe.ts <out> : p90 frame times per page while scrolling (needs EBIRFORMS_FRAMES hook). */
import { resolve } from 'node:path'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch } from '@gpuix/native/automation'
const OUT = process.argv[2]
rmSync(OUT, { force: true })
const app = await launch({ command: 'bun', args: ['src/app.tsx'], cwd: resolve(import.meta.dir, '..'), env: { EBIRFORMS_AUTOMATION: 'stdio', EBIRFORMS_FRAMES: OUT, NODE_ENV: 'production', EBIRFORMS_DATA_DIR: mkdtempSync(join(tmpdir(), 'ebf-')), EBIRFORMS_SEED: 'demo' } })
const w = (ms: number) => new Promise((r) => setTimeout(r, ms))
await app.getByTestId('nav-home').waitFor({ timeoutMs: 20000 })
async function measure(label: string) {
  await w(1100); appendFileSync(OUT, 'MARK ' + label + '\n')
  const X = Number(process.env.PROBE_X ?? 900)
  for (let i = 0; i < 24; i++) await app.mouse.wheel({ x: X, y: 600 }, 0, i < 12 ? 40 : -40)
  await w(1100); appendFileSync(OUT, 'END\n')
}
const scenes = (process.argv[3] ?? 'home,calendar,profile,forms,library').split(',')
if (scenes.includes('home')) await measure('home')
if (scenes.includes('calendar')) { await app.getByTestId('nav-calendar').click(); await measure('calendar') }
if (scenes.includes('profile')) { await app.getByTestId('titlebar-pill').click(); await app.getByTestId('panel-open-profile').click(); await app.getByTestId('titlebar-pill').click(); await measure('profile') }
if (scenes.includes('forms')) { await app.getByTestId('tab-forms').click(); await measure('forms tab') }
if (scenes.includes('library')) { await app.getByTestId('nav-library').click(); await measure('library') }
await app.close()
let label: string | null = null
const best: Record<string, number[]> = {}
for (const line of readFileSync(OUT, 'utf8').split('\n')) {
  if (line.startsWith('MARK ')) { label = line.slice(5); best[label] = [] } else if (line === 'END') label = null
  else if (label && line.startsWith('{')) { const d = JSON.parse(line); if (d.samples) best[label].push(Math.round(d.p90Ms)) }
}
for (const [k, v] of Object.entries(best)) console.log(k.padEnd(10), 'p90 frame ms:', v.join(', ') || 'no frames')
