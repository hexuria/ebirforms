/**
 * Launches src/app.tsx under automation on an empty AeroSpace workspace.
 *
 * AeroSpace tiles a new window into the current workspace at half size. The
 * window moves to PARITY_WORKSPACE (default 2) so it renders full size without
 * disturbing the workspace in use; that workspace shows for a moment because
 * AeroSpace only lays out a visible one, then focus returns.
 */
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, type App } from '@gpuix/native/automation'

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

function aerospaceWindowIds(): Set<string> {
  const out = spawnSync('aerospace', ['list-windows', '--all', '--format', '%{window-id}|%{window-title}'], { encoding: 'utf8' })
  if (out.status !== 0) return new Set()
  return new Set(out.stdout.split('\n').filter((line) => line.endsWith('|eBIRForms')).map((line) => line.split('|')[0]))
}

export const homeWorkspace = spawnSync('aerospace', ['list-workspaces', '--focused'], { encoding: 'utf8' }).stdout?.trim() || '1'

export function restoreWorkspace(): void {
  spawnSync('aerospace', ['workspace', homeWorkspace])
}

export async function launchApp(env: Record<string, string>): Promise<App> {
  const before = aerospaceWindowIds()
  const app = await launch({ command: 'bun', args: ['src/app.tsx'], cwd: resolve(import.meta.dir, '..'), env: { EBIRFORMS_AUTOMATION: 'stdio', ...env } })
  await app.getByTestId('nav-home').waitFor({ timeoutMs: 20000 })
  const workspace = process.env.PARITY_WORKSPACE ?? '2'
  for (let attempt = 0; attempt < 20; attempt++) {
    const fresh = [...aerospaceWindowIds()].filter((id) => !before.has(id))
    if (fresh.length) {
      for (const id of fresh) spawnSync('aerospace', ['move-node-to-workspace', '--window-id', id, workspace])
      spawnSync('aerospace', ['workspace', workspace])
      await pause(600)
      restoreWorkspace()
      break
    }
    await pause(250)
  }
  await pause(800)
  return app
}
