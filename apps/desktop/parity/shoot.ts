/**
 * Design-parity screenshots of the real desktop app.
 *
 *   bun parity/shoot.ts <outDir> [light|dark] [scene...]
 *
 * Launches src/app.tsx with EBIRFORMS_AUTOMATION=stdio against a throwaway
 * data dir seeded with the demo data, walks each scene and saves
 * <outDir>/<theme>-<scene>.png. Compare against the prototype in
 * hexuria/buwiz-ui-redesign (prototype/shell-prototype.html).
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, type App } from '@gpuix/native/automation'

/**
 * AeroSpace tiles a new window into the current workspace at half size.
 * Move the parity window to an empty workspace (default 2, override with
 * PARITY_WORKSPACE) so it renders full size without disturbing the one in use.
 */
function aerospaceWindowIds(): Set<string> {
  const out = spawnSync('aerospace', ['list-windows', '--all', '--format', '%{window-id}|%{window-title}'], { encoding: 'utf8' })
  if (out.status !== 0) return new Set()
  return new Set(out.stdout.split('\n').filter((line) => line.endsWith('|eBIRForms')).map((line) => line.split('|')[0]))
}

const outDir = resolve(process.argv[2] ?? 'parity-out')
const theme = (process.argv[3] ?? 'light') as 'light' | 'dark'
const only = process.argv.slice(4)
mkdirSync(outDir, { recursive: true })

const dataDir = mkdtempSync(join(tmpdir(), 'ebirforms-parity-'))
const before = aerospaceWindowIds()
const homeWorkspace = spawnSync('aerospace', ['list-workspaces', '--focused'], { encoding: 'utf8' }).stdout.trim() || '1'
const app: App = await launch({
  command: 'bun',
  args: ['src/app.tsx'],
  cwd: resolve(import.meta.dir, '..'),
  env: { EBIRFORMS_AUTOMATION: 'stdio', EBIRFORMS_DATA_DIR: dataDir, EBIRFORMS_SEED: 'demo', EBIRFORMS_THEME: theme },
})

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function shot(name: string) {
  await pause(400)
  const path = join(outDir, `${theme}-${name}.png`)
  await app.screenshot({ path })
  console.log('saved', path)
}
async function tryClick(testId: string) {
  try {
    await app.getByTestId(testId).click()
    return true
  } catch (error) {
    console.log(`  (no ${testId}: ${error instanceof Error ? error.message : error})`)
    return false
  }
}

const scenes: Record<string, () => Promise<void>> = {
  home: async () => {
    await tryClick('nav-home')
    await shot('home')
  },
  'hover-nav': async () => {
    await tryClick('nav-home')
    await app.getByTestId('nav-calendar').hover().catch(() => {})
    await shot('hover-nav')
  },
  'hover-titlebar': async () => {
    await app.getByTestId('tb-bell').hover().catch(() => {})
    await shot('hover-titlebar')
  },
  taxpayer: async () => {
    await tryClick('titlebar-pill')
    await shot('panel-taxpayer')
    await tryClick('titlebar-pill')
  },
  notifications: async () => {
    await tryClick('tb-bell')
    await shot('panel-notifications')
    await tryClick('tb-bell')
  },
  library: async () => {
    await tryClick('nav-library')
    await shot('library')
  },
  calendar: async () => {
    await tryClick('nav-calendar')
    await shot('calendar')
  },
  filings: async () => {
    await tryClick('nav-filings')
    await shot('filings')
  },
  settings: async () => {
    await tryClick('nav-settings')
    await shot('settings')
  },
  collapsed: async () => {
    await tryClick('tb-sidebar')
    await shot('sidebar-collapsed')
    await tryClick('tb-sidebar')
  },
  search: async () => {
    await tryClick('sidebar-search')
    await shot('search')
    await app.getByTestId('palette-input').press('escape').catch(() => {})
  },
  profile: async () => {
    await tryClick('titlebar-pill')
    await tryClick('panel-open-profile')
    await tryClick('titlebar-pill')
    await shot('profile')
  },
  'forms-tab': async () => {
    await tryClick('tab-forms')
    await shot('forms-tab')
  },
  templates: async () => {
    await tryClick('tab-templates')
    await shot('templates')
  },
  'new-return': async () => {
    await tryClick('sidebar-new')
    await shot('new-return')
    await tryClick('start-open')
    await pause(7000)
    await shot('form')
    await tryClick('save-return-top')
    await pause(800)
    await shot('form-errors')
  },
}

try {
  await app.getByTestId('nav-home').waitFor({ timeoutMs: 20000 })
  const workspace = process.env.PARITY_WORKSPACE ?? '2'
  for (let attempt = 0; attempt < 20; attempt++) {
    const fresh = [...aerospaceWindowIds()].filter((id) => !before.has(id))
    if (fresh.length) {
      for (const id of fresh) spawnSync('aerospace', ['move-node-to-workspace', '--window-id', id, workspace])
      // AeroSpace only lays out a visible workspace: show the empty one for a moment so the
      // window tiles full size there, then hand focus straight back.
      spawnSync('aerospace', ['workspace', workspace])
      await pause(600)
      spawnSync('aerospace', ['workspace', homeWorkspace])
      console.log(`moved window ${fresh.join(',')} to workspace ${workspace}`)
      break
    }
    await pause(250)
  }
  await pause(800)
  const size = await app.getByTestId('tb-theme').bounds()
  console.log(`window width ~${Math.round(size.x + size.width + 10)}`)
  if (theme === 'dark') await tryClick('tb-theme')
  for (const [name, run] of Object.entries(scenes)) {
    if (only.length && !only.includes(name)) continue
    console.log('scene', name)
    await run()
  }
} finally {
  await app.close()
  spawnSync('aerospace', ['workspace', homeWorkspace])
}
