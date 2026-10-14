import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, useGpuixRequired, useWindowSize } from '@gpuix/react'
import {
  dataDir,
  describeSftpConfig,
  type Draft,
  type DraftValues,
  formatTin,
  JobQueue,
  loadSftpConfig,
  Logger,
  nextPeriod,
  openStore,
  parseTin,
  periodLabel,
  periodsForYear,
  projectDue,
  type DueProjectionInput,
  type Job,
  type LibraryEntry,
  type LogEntry,
  type LogLevel,
  type Profile,
  type TaxpayerTree,
} from '@ebirforms/core'
import { loadCatalog, type ReturnFrequency } from '@ebirforms/forms'
import { openOfficialForm } from '@ebirforms/runtime'
import type { FieldSnapshot, FormInstance, ValidationIssue } from '@ebirforms/runtime'
import {
  autoFieldIds,
  buildPrefillValues,
  cleanFormTitle,
  displayFormCode,
  mergeDraftPrefill,
  prefillMap,
  type PrefillFormCode,
} from './editor-model.js'
import { seedDemo } from './seed-demo.js'
import formSchemaJson from './form-schema.json'
import { buildSchemaModel, type BoundField, type FormSchema, type ModelItem } from './schema-model.js'
import { spawn } from 'node:child_process'
import { resolveSystemTheme, resolveTheme, themes, type ResolvedTheme, type ThemeMode, type ThemeTokens } from './theme.js'
import { beginWindowDrag, closeWindow, dragWindowTo, toggleMaximizeWindow, type DragAnchor } from './win32.js'

const appDir = dataDir()
mkdirSync(appDir, { recursive: true })
const store = openStore(join(appDir, 'ebirforms.sqlite'))
const logger: Logger = store.logger
const queue = new JobQueue(store)
const catalog = loadCatalog()
const catalogByCode = new Map(catalog.map((entry) => [entry.code, entry]))

/** Per-form summary from the design prototype's schema (pages, fields, Part sizes). */
type FormMeta = { title: string; frequency: string; revision: string; pages: number; fields: number; parts: number[]; draftLayout: boolean }
const formSchemas = formSchemaJson as Record<string, FormSchema>
const formMeta: Record<string, FormMeta> = Object.fromEntries(
  Object.entries(formSchemas).map(([key, schema]) => [key, { title: schema.title, frequency: schema.frequency, revision: schema.revision, pages: schema.pages, fields: schema.fields, parts: schema.parts.map((part) => part.items.length), draftLayout: schema.draftLayout }]),
)
/** A taxpayer's own 9-digit TIN (the branch code belongs to the branch). */
const tin9Label = (tin9: string) => `${tin9.slice(0, 3)}-${tin9.slice(3, 6)}-${tin9.slice(6, 9)}`
const isPrefillCode = (code: string): code is PrefillFormCode => code in prefillMap
/** Earliest tax year a branch can add. */
const MIN_TAX_YEAR = 2010
const familyKey = (code: string) => code.replace(/v\d{4}.*$/i, '').toUpperCase()
const versionOf = (code: string) => Number(/v(\d{4})/i.exec(code)?.[1] ?? 0)
/** One library card per form family: the latest catalog variant that has prototype metadata. */
const libraryCatalog: Array<{ key: string; code: string; meta: FormMeta }> = (() => {
  const best = new Map<string, string>()
  for (const entry of catalog) {
    const key = familyKey(entry.code)
    if (!formMeta[key]) continue
    const current = best.get(key)
    if (!current || versionOf(entry.code) > versionOf(current)) best.set(key, entry.code)
  }
  return [...best.entries()].map(([key, code]) => ({ key, code, meta: formMeta[key] })).sort((a, b) => a.key.localeCompare(b.key))
})()
if (process.env.EBIRFORMS_SEED === 'demo') {
  try {
    seedDemo(store)
  } catch (error) {
    logger.log('warn', 'seed', 'Demo seed failed', { error: String(error) })
  }
}
const fontPath = join(import.meta.dir, '../assets/fonts/BricolageGrotesque-Variable.ttf')

function FontRegistration() {
  const renderer = useGpuixRequired()
  useEffect(() => {
    try {
      const registerFont = (
        renderer as typeof renderer & { registerFont?: (font: Uint8Array) => void }
      ).registerFont
      if (registerFont) {
        registerFont.call(renderer, readFileSync(fontPath))
      } else {
        logger.log('info', 'font', 'GPUIX renderer has no registerFont API; using system fonts')
      }
    } catch (error) {
      logger.log('warn', 'font', 'Bricolage Grotesque could not be registered', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [renderer])
  return null
}

/**
 * Dev-only: with EBIRFORMS_AUTOMATION=stdio the window serves the GPUIX
 * automation protocol on stdio, so `@gpuix/native/automation` `launch()` can
 * click through the real app and capture screenshots (design-parity checks).
 */
function AutomationBridge() {
  const renderer = useGpuixRequired()
  useEffect(() => {
    if (process.env.EBIRFORMS_FRAMES) {
      const r = renderer as unknown as { getDebugFrameOverlayStats?: () => unknown; resetDebugFrameOverlayStats?: () => void }
      ;(globalThis as Record<string, unknown>).__frames = () => { const v = r.getDebugFrameOverlayStats?.(); r.resetDebugFrameOverlayStats?.(); return v }
      setInterval(() => { require('node:fs').appendFileSync(process.env.EBIRFORMS_FRAMES!, JSON.stringify((globalThis as any).__frames()) + '\n') }, 1000)
    }
    if (process.env.EBIRFORMS_AUTOMATION !== 'stdio') return
    void import('@gpuix/native/automation').then(({ serveAutomationStdio, InProcessBackend, liveRendererAsTest }) => {
      serveAutomationStdio(new InProcessBackend(liveRendererAsTest(renderer as unknown as Parameters<typeof liveRendererAsTest>[0])))
    })
  }, [renderer])
  return null
}

// ---------------------------------------------------------------------------
// Design constants (verbatim from the mockup's Components tab)

const FONT = 'Segoe UI Variable Text, Segoe UI, Bricolage Grotesque, sans-serif'
const NUM_STYLE = { fontWeight: 600 } as const
const F_CAP = 11
const F_META = 12
const F_BODY = 13
const F_EMPH = 14
const F_TITLE = 16
const F_PAGE = 20

const WINDOW_TITLE = 'eBIRForms'
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

type Page = 'home' | 'library' | 'calendar' | 'filings' | 'taxpayer' | 'settings' | 'jobs' | 'logs' | 'form'
type TpTab = 'profile' | 'forms' | 'templates'
type NavState = {
  page: Page
  tab: TpTab
  tin?: string
  branchId?: string
  profileId?: string
  formCode?: string
  period?: string
}
type PanelKind = 'taxpayer' | 'notifications' | null
type Overlay =
  | null
  | { kind: 'search' }
  | { kind: 'startReturn' }
type LogFilter = LogLevel | 'all'
type DraftStatus = Draft['status']
type FactsForm = {
  name: string
  rdo: string
  zip: string
  address: string
  phone: string
  email: string
}
type NewTaxpayerForm = FactsForm & {
  tin1: string
  tin2: string
  tin3: string
  type: 'individual' | 'non-individual'
  birthDate: string
}
type NewBranchForm = FactsForm & { code: string; name: string }
type GridCell = ReactNode | { full: true; node: ReactNode }

const blankFacts: FactsForm = { name: '', rdo: '', zip: '', address: '', phone: '', email: '' }
const blankTaxpayer: NewTaxpayerForm = {
  ...blankFacts,
  tin1: '',
  tin2: '',
  tin3: '',
  type: 'individual',
  birthDate: '',
}
const blankBranch: NewBranchForm = { ...blankFacts, code: '', name: '' }

function allProfiles(taxpayers: TaxpayerTree[]): Profile[] {
  return taxpayers.flatMap((taxpayer) =>
    taxpayer.branches.flatMap((branch) => branch.years),
  )
}

function branchId(tin9: string, code: string): string {
  return `${tin9}${code}`
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '')
  return letters.join('') || '?'
}

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function fmtDate(iso: string | number): string {
  const date = typeof iso === 'string' ? new Date(`${iso}T00:00:00`) : new Date(iso)
  return `${MONTH_ABBR[date.getMonth()][0]}${MONTH_ABBR[date.getMonth()].slice(1).toLowerCase()} ${date.getDate()}, ${date.getFullYear()}`
}

function fmtDateShort(iso: string): string {
  const date = new Date(`${iso}T00:00:00`)
  return `${MONTH_ABBR[date.getMonth()][0]}${MONTH_ABBR[date.getMonth()].slice(1).toLowerCase()} ${date.getDate()}`
}

function fmtDateTime(ts: number): string {
  const date = new Date(ts)
  return `${fmtDate(ts)}, ${date.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })}`
}

function daysUntil(iso: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((Date.parse(`${iso}T00:00:00`) - today.getTime()) / 86400000)
}

function freqLabel(frequency: ReturnFrequency): string {
  return frequency === 'monthly' ? 'Monthly' : frequency === 'quarterly' ? 'Quarterly' : 'Annual'
}

// ---------------------------------------------------------------------------
// Lucide icon paths (24x24, stroke style) — from the mockup's icon dictionary

const ICON_PATHS: Record<string, string> = {
  panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect x="3" y="3" width="18" height="12" rx="2"/><path d="M12 17v4"/><path d="M8 21h8"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  chevLeft: '<path d="m15 18-6-6 6-6"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01"/><path d="M16 6h.01"/><path d="M12 6h.01"/><path d="M12 10h.01"/><path d="M12 14h.01"/><path d="M16 10h.01"/><path d="M16 14h.01"/><path d="M8 10h.01"/><path d="M8 14h.01"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  branch: '<path d="M6 3v12"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="9" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  hash: '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/>',
  box: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  template: '<rect x="3" y="3" width="18" height="7" rx="1"/><rect x="3" y="14" width="9" height="7" rx="1"/><rect x="16" y="14" width="5" height="7" rx="1"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  upDown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  logout: '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
}

let activeTheme: ThemeTokens = themes.light
function useTheme(): ThemeTokens {
  return activeTheme
}

type IconName = keyof typeof ICON_PATHS

function Icon({ name, size = 16, color, strokeWidth = 1.75 }: {
  name: IconName
  size?: number
  color?: string
  strokeWidth?: number
}) {
  const t = useTheme()
  const ink = color ?? t.fg2
  // GPUI paints an SVG as a one-colour mask tinted by the element's text
  // colour; the markup's own stroke colour is ignored. Set both.
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`
  return <svg source={source} style={{ width: size, height: size, minWidth: size, color: ink }} />
}

/**
 * GPUIX can deliver one click to the same element twice in a row, which made
 * functional toggles (sidebar, disclosures, checkboxes) flip twice and do
 * nothing, and one-shot actions run twice. Every onClick goes through this:
 * a repeat on the same element within 40 ms is dropped.
 */
let lastClick = { element: -1, at: 0 }
let insideClick = false
function once<A extends unknown[]>(handler: ((...args: A) => unknown) | undefined): (...args: A) => void {
  return (...args: A) => {
    // A primitive forwarding to its caller's handler runs inside the outer
    // dispatch: let it through. Only top-level dispatches are de-duplicated.
    if (insideClick) {
      handler?.(...args)
      return
    }
    const element = (args[0] as { elementId?: number } | undefined)?.elementId ?? -2
    const now = performance.now()
    if (element === lastClick.element && now - lastClick.at < 40) return
    lastClick = { element, at: now }
    insideClick = true
    try {
      handler?.(...args)
    } finally {
      insideClick = false
    }
  }
}

// ---------------------------------------------------------------------------
// Primitives — each one mirrors a class in the prototype's stylesheet
// (hexuria/buwiz-ui-redesign prototype/shell-prototype.src.html).

const CLEAR = 'rgba(0,0,0,0)'

/** .ibtn — 28×28, radius 6, fg2 at rest; hover = hover fill + fg; pressed = selected. */
function IBtn({ icon, onClick, size = 28, iconSize = 16, active = false, disabled = false, danger = false, testId }: {
  icon: IconName
  onClick: () => void
  size?: number
  iconSize?: number
  active?: boolean
  disabled?: boolean
  danger?: boolean
  testId?: string
}) {
  const t = useTheme()
  const [hot, setHot] = useState(false)
  const ink = disabled ? t.fg3 : active || hot ? (danger && hot ? '#ffffff' : t.fg) : t.fg2
  return (
    <div
      testId={testId}
      onClick={once(() => !disabled && onClick())}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        minWidth: size,
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        backgroundColor: active ? t.selected : CLEAR,
        hover: disabled ? {} : { backgroundColor: danger ? '#c42b1c' : active ? t.selected : t.hover },
      }}
    >
      <Icon name={icon} size={iconSize} color={ink} />
    </div>
  )
}

/** .btn — md 32 / sm 28; primary = inverted ink, secondary = bordered, ghost, danger = tinted. */
function Btn({ children, onClick, kind = 'primary', disabled = false, small = false, icon, testId }: {
  children: ReactNode
  onClick: () => void
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger'
  disabled?: boolean
  small?: boolean
  icon?: IconName
  testId?: string
}) {
  const t = useTheme()
  const [hot, setHot] = useState(false)
  const look = {
    primary: { bg: t.primary, hoverBg: t.primary, fg: t.primaryFg, hoverFg: t.primaryFg, border: t.primary },
    secondary: { bg: t.surface, hoverBg: t.hover, fg: t.fg, hoverFg: t.fg, border: t.borderStrong },
    ghost: { bg: CLEAR, hoverBg: t.hover, fg: t.fg2, hoverFg: t.fg, border: CLEAR },
    danger: { bg: t.dangerSoft, hoverBg: t.dangerSoft, fg: t.danger, hoverFg: t.danger, border: CLEAR },
  }[kind]
  const ink = hot && !disabled ? look.hoverFg : look.fg
  return (
    <div
      testId={testId}
      onClick={once(() => !disabled && onClick())}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: small ? 28 : 32,
        minHeight: small ? 28 : 32,
        paddingLeft: small ? 10 : 12,
        paddingRight: small ? 10 : 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: look.border,
        backgroundColor: look.bg,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        hover: disabled ? {} : { backgroundColor: look.hoverBg, opacity: kind === 'primary' ? 0.88 : 1 },
      }}
    >
      {icon && <Icon name={icon} size={16} color={ink} />}
      <text style={{ color: ink, fontSize: F_BODY, fontWeight: 500, whiteSpace: 'nowrap' }}>{children}</text>
    </div>
  )
}

/** kbd — 11/500 fg3, 1px border, radius 4, height 18. */
function Kbd({ children }: { children: string }) {
  const t = useTheme()
  return (
    <div style={{ paddingLeft: 4, paddingRight: 4, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, borderWidth: 1, borderColor: t.border }}>
      <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 500 }}>{children}</text>
    </div>
  )
}

/** .switch — 32×18 track, 14 white knob, accent when on. */
function Switch({ on, onToggle, testId }: { on: boolean; onToggle: (value: boolean) => void; testId?: string }) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      onClick={once(() => onToggle(!on))}
      style={{ width: 32, minWidth: 32, height: 18, borderRadius: 9, backgroundColor: on ? t.accent : t.borderStrong, display: 'flex', alignItems: 'center', paddingLeft: on ? 16 : 2, cursor: 'pointer' }}
    >
      <div style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#ffffff' }} />
    </div>
  )
}

/** .seg — hover track, 2px padding, 24px segments 12/500, selected = raised + shadow. */
function Seg<T extends string>({ options, value, onChange, testId }: {
  options: Array<{ value: T; label: string; icon?: IconName }>
  value: T
  onChange: (value: T) => void
  testId?: string
}) {
  const t = useTheme()
  return (
    <div testId={testId} style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, backgroundColor: t.hover, alignSelf: 'flex-start' }}>
      {options.map((option) => {
        const active = option.value === value
        return (
          <div
            key={option.value}
            testId={`${testId}-${option.value}`}
            onClick={once(() => onChange(option.value))}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              height: 24,
              paddingLeft: 10,
              paddingRight: 10,
              borderRadius: 6,
              cursor: 'pointer',
              backgroundColor: active ? t.raised : CLEAR,
              boxShadow: active ? { offsetX: 0, offsetY: 1, blurRadius: 2, spreadRadius: 0, color: 'rgba(0,0,0,0.10)' } : undefined,
            }}
          >
            {option.icon && <Icon name={option.icon} size={14} color={active ? t.fg : t.fg2} />}
            <text style={{ color: active ? t.fg : t.fg2, fontSize: F_META, fontWeight: 500 }}>{option.label}</text>
          </div>
        )
      })}
    </div>
  )
}

type ChipTone = 'plain' | 'accent' | 'success' | 'warning' | 'danger' | 'muted'

/** .chip — 20 tall, full radius, 11/500, soft tint; 12px icon. */
function Chip({ children, tone = 'plain', icon }: { children: ReactNode; tone?: ChipTone; icon?: IconName }) {
  const t = useTheme()
  const tones = {
    plain: { bg: t.hover, fg: t.fg2 },
    muted: { bg: t.hover, fg: t.fg2 },
    accent: { bg: t.accentSoft, fg: t.accent },
    success: { bg: t.successSoft, fg: t.success },
    warning: { bg: t.warningSoft, fg: t.warning },
    danger: { bg: t.dangerSoft, fg: t.danger },
  }[tone]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 20, minHeight: 20, paddingLeft: 8, paddingRight: 8, borderRadius: 10, backgroundColor: tones.bg, alignSelf: 'center' }}>
      {icon && <Icon name={icon} size={12} color={tones.fg} />}
      <text style={{ color: tones.fg, fontSize: F_CAP, fontWeight: 500, whiteSpace: 'nowrap' }}>{children}</text>
    </div>
  )
}

function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100
  const lig = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(lig, 1 - lig)
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`
}

function nameHue(name: string): number {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return hash % 360
}

/** .av — initials from the first and last capitalised word, tinted by a hue derived from the name. */
function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const t = useTheme()
  const dark = t === themes.dark
  const hue = nameHue(name)
  const bg = dark ? hslHex(hue, 40, 26) : hslHex(hue, 55, 90)
  const fg = dark ? hslHex(hue, 40, 84) : hslHex(hue, 55, 30)
  const font = size <= 20 ? 9 : size <= 28 ? 11 : size <= 40 ? 14 : 19
  return (
    <div style={{ width: size, height: size, minWidth: size, borderRadius: size / 2, backgroundColor: bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <text style={{ color: fg, fontSize: font, fontWeight: 600 }}>{initials(name)}</text>
    </div>
  )
}

/** .check — 16, radius 4; on = primary fill with a 12px check. */
function Check({ on, disabled = false }: { on: boolean; disabled?: boolean }) {
  const t = useTheme()
  return (
    <div style={{ width: 16, height: 16, minWidth: 16, borderRadius: 4, borderWidth: 1, borderColor: on ? t.primary : t.borderStrong, backgroundColor: on ? t.primary : t.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
      {on && <Icon name="check" size={12} color={t.primaryFg} strokeWidth={2.5} />}
    </div>
  )
}

/** .input — 32 tall, padding 0 10, radius 8, border-strong; readonly = hover fill + fg2. */
function inputStyle(t: ThemeTokens, opts: { locked?: boolean; error?: boolean; mono?: boolean; align?: 'left' | 'right' | 'center' } = {}) {
  return {
    height: 32,
    minHeight: 32,
    paddingLeft: 10,
    paddingRight: 10,
    color: opts.locked ? t.fg2 : t.fg,
    backgroundColor: opts.locked ? t.hover : t.surface,
    borderWidth: 1,
    borderColor: opts.error ? t.danger : t.borderStrong,
    borderRadius: 8,
    fontSize: F_BODY,
    textAlign: opts.align ?? 'left',
    ...(opts.mono ? NUM_STYLE : {}),
  } as const
}

function FieldInput({ label, value, onChange, placeholder, disabled = false, mono = false, hint, testId }: {
  label?: string
  value: string
  onChange?: (value: string) => void
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  hint?: string
  testId?: string
}) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flexGrow: 1 }}>
      {label && <text style={{ color: t.fg2, fontSize: F_META }}>{label}</text>}
      <input
        testId={testId}
        value={value}
        placeholder={placeholder}
        readOnly={disabled}
        onChange={(event) => onChange?.(event.value ?? '')}
        style={inputStyle(t, { locked: disabled, mono })}
      />
      {hint ? <text style={{ color: t.danger, fontSize: F_META }}>{hint}</text> : null}
    </div>
  )
}

/** .select — a 32px input-looking trigger showing the option label, with an anchored menu. */
function Dropdown({ value, options, onChange, placeholder = 'Choose…', disabled = false, error = false, width, testId }: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  error?: boolean
  width?: number
  testId?: string
}) {
  const t = useTheme()
  const [open, setOpen] = useState(false)
  const current = options.find((option) => option.value === value)
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', width, minWidth: 0 }}>
      <div
        testId={testId}
        onClick={once(() => !disabled && setOpen((state) => !state))}
        style={{ ...inputStyle(t, { locked: disabled, error }), display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer', hover: disabled ? {} : { borderColor: t.fg3 } }}
      >
        <text style={{ flexGrow: 1, minWidth: 0, color: current ? (disabled ? t.fg2 : t.fg) : t.fg3, fontSize: F_BODY, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{current?.label ?? (value || placeholder)}</text>
        <Icon name="chevDown" size={14} color={t.fg3} />
      </div>
      {open && (
        <anchored side="bottom" align="start" gap={4} fit="switch" snapMargin={8} occlude>
          <div
            onMouseDownOutside={() => setOpen(false)}
            style={{ display: 'flex', flexDirection: 'column', minWidth: Math.max(width ?? 180, 160), maxHeight: 280, overflow: 'scroll', padding: 4, borderRadius: 12, borderWidth: 1, borderColor: t.border, backgroundColor: t.raised, boxShadow: { offsetX: 0, offsetY: 8, blurRadius: 24, spreadRadius: 0, color: t === themes.dark ? 'rgba(0,0,0,0.5)' : 'rgba(20,20,30,0.12)' } }}
          >
            {options.map((option) => {
              const chosen = option.value === value
              return (
                <div
                  key={option.value}
                  testId={testId ? `${testId}-${option.value}` : undefined}
                  onClick={once(() => {
                    onChange(option.value)
                    setOpen(false)
                  })}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, paddingLeft: 10, paddingRight: 10, borderRadius: 8, cursor: 'pointer', backgroundColor: chosen ? t.selected : CLEAR, hover: { backgroundColor: chosen ? t.selected : t.hover } }}
                >
                  <text style={{ flexGrow: 1, color: t.fg, fontSize: F_BODY, whiteSpace: 'nowrap' }}>{option.label}</text>
                  {chosen && <Icon name="check" size={14} color={t.fg2} />}
                </div>
              )
            })}
          </div>
        </anchored>
      )}
    </div>
  )
}

/** A bordered group (radius 12) — the prototype's .list / .card / .disc-group container. */
function Card({ children, title, subtitle, aside, onToggle, open }: {
  children?: ReactNode
  title?: string
  subtitle?: string
  aside?: ReactNode
  onToggle?: () => void
  open?: boolean
}) {
  const t = useTheme()
  const disclosure = onToggle !== undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.border, borderRadius: 12, backgroundColor: t.surface, overflow: 'hidden' }}>
      {title !== undefined && (
        <div
          onClick={once(disclosure ? onToggle : undefined)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 44, paddingLeft: 12, paddingRight: 12, cursor: disclosure ? 'pointer' : 'default', borderBottomWidth: disclosure ? (open ? 1 : 0) : 1, borderColor: t.border }}
        >
          {disclosure && <Icon name={open ? 'chevDown' : 'chevRight'} size={16} color={t.fg3} />}
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
            <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 600 }}>{title}</text>
            {subtitle && <text style={{ color: t.fg3, fontSize: F_META }}>{subtitle}</text>}
          </div>
          {aside}
        </div>
      )}
      {(!disclosure || open) && <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>{children}</div>}
    </div>
  )
}

/** h2.sec — 16/600, 32px above (28 for the first), 12 below. */
function SectionLabel({ children, first = false }: { children: ReactNode; first?: boolean }) {
  const t = useTheme()
  return <text style={{ color: t.fg, fontSize: F_TITLE, fontWeight: 600, paddingTop: first ? 28 : 32, paddingBottom: 12 }}>{children}</text>
}

/** .glabel — 12/500 fg3, padding 16 8 4. */
function GroupLabel({ children }: { children: ReactNode }) {
  const t = useTheme()
  return <text style={{ color: t.fg3, fontSize: F_META, fontWeight: 500, paddingTop: 16, paddingLeft: 8, paddingRight: 8, paddingBottom: 4 }}>{children}</text>
}

/** .nav — 32 tall, padding 0 8, gap 10, radius 8, 13/500; fg2 at rest, hover fill + fg, current = selected + fg. */
function NavRow({ icon, avatar, label, current = false, count, trail, onClick, testId, mono }: {
  icon?: IconName
  avatar?: ReactNode
  label: string
  current?: boolean
  count?: string | number
  trail?: ReactNode
  onClick: () => void
  testId?: string
  mono?: string
}) {
  const t = useTheme()
  const [hot, setHot] = useState(false)
  const ink = current || hot ? t.fg : t.fg2
  return (
    <div
      testId={testId}
      onClick={once(onClick)}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, height: 32, minHeight: 32, paddingLeft: 8, paddingRight: 8, borderRadius: 8, cursor: 'pointer', backgroundColor: current ? t.selected : CLEAR, hover: { backgroundColor: current ? t.selected : t.hover } }}
    >
      {icon && <Icon name={icon} size={16} color={ink} />}
      {avatar}
      {mono && <text style={{ color: ink, fontSize: F_META, width: 44, minWidth: 44, ...NUM_STYLE }}>{mono}</text>}
      <text style={{ color: ink, fontSize: F_BODY, fontWeight: 500, flexGrow: 1, flexShrink: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{label}</text>
      {count !== undefined && count !== '' && <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE, fontWeight: 400 }}>{String(count)}</text>}
      {trail}
    </div>
  )
}

/** .list — bordered (radius 12) container; children are rows separated by hairlines. */
function List({ children }: { children: ReactNode }) {
  const t = useTheme()
  return <div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.border, borderRadius: 12, overflow: 'hidden', backgroundColor: t.surface }}>{children}</div>
}

/** .row — min-height 52, padding 8 16, gap 12; hairline between rows; clickable rows hover-fill. */
function Row({ children, first, onClick, testId, dim = false }: { children: ReactNode; first: boolean; onClick?: () => void; testId?: string; dim?: boolean }) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      onClick={once(onClick)}
      style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 52, paddingTop: 8, paddingBottom: 8, paddingLeft: 16, paddingRight: 16, borderTopWidth: first ? 0 : 1, borderColor: t.border, cursor: onClick ? 'pointer' : 'default', opacity: dim ? 1 : 1, hover: onClick ? { backgroundColor: t.hover } : {} }}
    >
      {children}
    </div>
  )
}

/** .ph — page title 20/600 with a lede (fg2, max ~62ch). */
function PageHead({ title, lede, actions }: { title: string; lede?: string; actions?: ReactNode }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
        <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 600 }}>{title}</text>
        {lede && <text style={{ color: t.fg2, fontSize: F_BODY, paddingTop: 6, maxWidth: 520, lineHeight: 19 }}>{lede}</text>}
      </div>
      {actions}
    </div>
  )
}

/** .rname — 13/500 title over a 12/fg3 line, both truncating. */
function RName({ title, sub, dim = false }: { title: string; sub?: string; dim?: boolean }) {
  const t = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 }}>
      <text style={{ color: dim ? t.fg3 : t.fg, fontSize: F_BODY, fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{title}</text>
      {sub !== undefined && <text style={{ color: t.fg3, fontSize: F_META, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{sub}</text>}
    </div>
  )
}

/** .code — 12/600 tabular, fixed column. */
function Code({ children, width = 68, dim = false }: { children: string; width?: number; dim?: boolean }) {
  const t = useTheme()
  return (
    <div style={{ width, minWidth: width }}>
      <text style={{ color: dim ? t.fg3 : t.fg, fontSize: F_META, ...NUM_STYLE }}>{children}</text>
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Starter packs map to real catalog codes (latest variant per family). */
const STARTER_PACKS: Record<string, string[]> = {
  'Non-VAT business': ['2551Qv2018', '1701Qv2018', '1701v2018', '0619E', '1601EQ'],
  'VAT business': ['2550Qv2024', '1702Qv2018C', '1702RTv2018C', '0619E', '1601EQ'],
  Employer: ['1601Cv2018', '1604C'],
  Professional: ['1701Qv2018', '1701v2018', '2551Qv2018'],
}

type Notif = {
  id: string
  kind: 'warning' | 'success' | 'danger' | 'info' | 'plain'
  title: string
  subtitle: string
  ts: number
}

type KeyEvent = {
  key?: string
  keyChar?: string
  modifiers?: { ctrl?: boolean; cmd?: boolean; alt?: boolean; shift?: boolean }
}

let rootKeyHandler: ((event: KeyEvent) => void) | null = null

const perf = { renders: 0, ms: 0 }
if (process.env.EBIRFORMS_PERF) setInterval(() => { require('node:fs').appendFileSync(process.env.EBIRFORMS_PERF!, `PERF renders=${perf.renders} ms=${perf.ms.toFixed(0)}\n`); perf.renders = 0; perf.ms = 0 }, 1000)
function App() {
  const perfStart = performance.now()
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    const saved = store.getSetting('theme')
    return saved === 'dark' || saved === 'system' ? saved : 'light'
  })
  const [systemTheme] = useState<ResolvedTheme>(() => resolveSystemTheme())
  activeTheme = themes[resolveTheme(themeMode, systemTheme)]
  const t = activeTheme

  const [page, setPage] = useState<Page>('home')
  const [tab, setTab] = useState<TpTab>('profile')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [panel, setPanel] = useState<PanelKind>(null)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [panelEdit, setPanelEdit] = useState<null | { name: string; bname: string; address: string }>(null)
  const [libQuery, setLibQuery] = useState('')
  const [libFreq, setLibFreq] = useState<'All' | 'Monthly' | 'Quarterly' | 'Annual' | 'As needed'>('All')
  const windowSize = useWindowSize()
  const [confirmEmails, setConfirmEmails] = useState(true)
  const [showErrors, setShowErrors] = useState(false)
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [openMore, setOpenMore] = useState<Set<string>>(new Set())
  const [guided, setGuided] = useState(false)
  const partRefs = useRef<Array<{ scrollIntoView?: () => void } | null>>([])
  const [lockAfter, setLockAfter] = useState(() => store.getSetting('lockAfter') ?? '15m')
  /** Content-column width; below 640 the prototype drops secondary columns (its container queries). */
  const contentWidth = Math.min(page === 'form' || page === 'library' ? 1120 : 880, windowSize.width - (sidebarCollapsed ? 16 : 256) - (panel ? 320 : 8) - 64)
  const narrow = contentWidth < 640
  /**
   * Centre the content column by computing the side padding here. Centring with
   * alignItems:'center' + maxWidth made the layout engine size the whole column
   * at max-content first, re-measuring every text each frame (200ms+ frames).
   */
  const mainWidth = windowSize.width - (sidebarCollapsed ? 16 : 256) - (panel ? 320 : 8)
  const sidePad = Math.max(narrow ? 16 : 32, Math.floor((mainWidth - (page === 'form' || page === 'library' ? 1120 : 880)) / 2))
  const [tree, setTree] = useState<TaxpayerTree[]>(() => store.listTaxpayers())
  const [selectedTin, setSelectedTin] = useState<string | undefined>(() => store.listTaxpayers()[0]?.tin9)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>(() => {
    const first = store.listTaxpayers()[0]
    return first?.branches[0] ? branchId(first.tin9, first.branches[0].code) : undefined
  })
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(() =>
    allProfiles(store.listTaxpayers())[0]?.id,
  )
  const [newTaxpayer, setNewTaxpayer] = useState(blankTaxpayer)
  const [newTaxpayerErrors, setNewTaxpayerErrors] = useState<Record<string, string>>({})
  const [showNewTaxpayer, setShowNewTaxpayer] = useState(false)
  const [showNewBranch, setShowNewBranch] = useState(false)
  const [newBranch, setNewBranch] = useState(blankBranch)
  const [branchError, setBranchError] = useState('')
  const [openSecs, setOpenSecs] = useState<Set<string>>(() => new Set(['taxpayer', 'branch', 'contact']))
  const [collapsedPartSet, setCollapsedPartSet] = useState<Set<string>>(new Set())
  const togglePart = (key: string) => setCollapsedPartSet((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const [editSec, setEditSec] = useState<string | null>(null)
  const [taxpayerEdit, setTaxpayerEdit] = useState({ name: '', type: 'individual' as 'individual' | 'non-individual', birthDate: '' })
  const [branchEdit, setBranchEdit] = useState<NewBranchForm>(blankBranch)
  const [branchInherit, setBranchInherit] = useState<Record<string, boolean>>({})
  const [yearInput, setYearInput] = useState('')
  const [showNewYear, setShowNewYear] = useState(false)
  const [copyFromYear, setCopyFromYear] = useState(true)
  const [formsEdit, setFormsEdit] = useState(false)
  const [pendingFamilies, setPendingFamilies] = useState<Set<string>>(new Set())
  const [formsQuery, setFormsQuery] = useState('')
  const [formsFreq, setFormsFreq] = useState<'All' | 'Monthly' | 'Quarterly' | 'Annual' | 'As needed'>('All')
  const [tinEdit, setTinEdit] = useState('')
  const [formSearch, setFormSearch] = useState('')
  const [pendingCodes, setPendingCodes] = useState<string[]>([])
  const [startFormCode, setStartFormCode] = useState<string | null>(null)
  const [startPeriod, setStartPeriod] = useState<string>('')
  const [queueJobs, setQueueJobs] = useState<Job[]>(() => queue.list())
  const [logs, setLogs] = useState<LogEntry[]>(() => logger.getEntries())
  const [logFilter, setLogFilter] = useState<LogFilter>('all')
  const [formEntry, setFormEntry] = useState<LibraryEntry | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formInstance, setFormInstance] = useState<FormInstance | null>(null)
  const [fieldSnapshot, setFieldSnapshot] = useState<FieldSnapshot[]>([])
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [editorValues, setEditorValues] = useState<Record<string, string | boolean>>({})
  const [formLoading, setFormLoading] = useState(false)
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteIdx, setPaletteIdx] = useState(0)
  const [showRecent, setShowRecent] = useState(() => store.getSetting('showRecent') !== '0')
  const [askTemplate, setAskTemplate] = useState(() => store.getSetting('askTemplate') === '1')
  const [displayName, setDisplayName] = useState(() => store.getSetting('displayName') ?? '')
  const [email, setEmail] = useState(() => store.getSetting('email') ?? '')
  const [lastRead, setLastRead] = useState(() => Number(store.getSetting('lastReadNotifs') ?? 0))
  const [lastBackup, setLastBackup] = useState(() => store.getSetting('lastBackupAt') ?? '')
  const dragAnchor = useRef<DragAnchor | null>(null)
  const histRef = useRef<{ stack: NavState[]; idx: number }>({ stack: [], idx: -1 })
  const formLoadSeq = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, setHistVersion] = useState(0)
  const gpuix = useGpuixRequired()

  const taxpayer = tree.find((item) => item.tin9 === selectedTin)
  const branch = taxpayer?.branches.find((item) => branchId(taxpayer.tin9, item.code) === selectedBranchId)
  const selectedProfile =
    branch?.years.find((item) => item.id === selectedProfileId) ?? branch?.years.at(-1)
  /**
   * Store reads are synchronous SQLite calls; running them on every render cost
   * 30–55ms per click. Derived data is memoised on `dataVersion`, which every
   * write path bumps (see bumpData / refreshTree).
   */
  const [dataVersion, setDataVersion] = useState(0)
  const bumpData = () => setDataVersion((value) => value + 1)
  const selectedLibrary = useMemo(() => (selectedProfile ? store.listLibrary(selectedProfile.id) : []), [selectedProfile?.id, tree, dataVersion])

  function showToast(text: string) {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ text, seq: Date.now() })
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }

  function setThemeMode(mode: ThemeMode) {
    setThemeModeState(mode)
    store.setSetting('theme', mode)
  }

  function toggleRecent(value: boolean) {
    setShowRecent(value)
    store.setSetting('showRecent', value ? '1' : '0')
  }

  function toggleAskTemplate(value: boolean) {
    setAskTemplate(value)
    store.setSetting('askTemplate', value ? '1' : '0')
  }

  // -- Due projection + notifications (derived from real store data) --------

  function draftStatuses(profileId: string, formCode: string): Record<string, DraftStatus> {
    return Object.fromEntries(
      store.listDrafts(profileId, formCode).map((item) => [item.period, item.status]),
    )
  }

  const { dueRows, dueByKey, filedDrafts, recentDrafts } = useMemo(() => {
    const dueInputs: DueProjectionInput[] = tree.flatMap((item) =>
      item.branches.flatMap((itemBranch) =>
        itemBranch.years.flatMap((profile) =>
          store.listLibrary(profile.id).map((entry) => ({
            profileId: profile.id,
            tin9: item.tin9,
            branchCode: itemBranch.code,
            year: profile.year,
            formCode: entry.formCode,
            frequency: catalogByCode.get(entry.formCode)?.frequency ?? 'annual',
            statuses: draftStatuses(profile.id, entry.formCode),
          })),
        ),
      ),
    )
    const rows = projectDue(dueInputs)
    return {
      dueRows: rows,
      dueByKey: new Map(rows.map((row) => [`${row.profileId}:${row.formCode}`, row])),
      filedDrafts: store.listFiledDrafts(),
      recentDrafts: store.listRecentDrafts(4),
    }
  }, [tree, dataVersion])
  const templatesForBranch = useMemo(() => (taxpayer && branch ? store.listTemplates(taxpayer.tin9, branch.code) : []), [taxpayer?.tin9, branch?.code, tree, dataVersion])
  /** filedRow asks whether each filed form is still on its year's list; answer from one read per profile. */
  const libraryByProfile = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const item of tree) for (const itemBranch of item.branches) for (const profile of itemBranch.years) map.set(profile.id, new Set(store.listLibrary(profile.id).map((entry) => entry.formCode)))
    return map
  }, [tree, dataVersion])

  function profileById(profileId: string): { profile: Profile; taxpayer: TaxpayerTree; branchCode: string; branchName: string } | null {
    for (const item of tree) {
      for (const itemBranch of item.branches) {
        const profile = itemBranch.years.find((entry) => entry.id === profileId)
        if (profile) return { profile, taxpayer: item, branchCode: itemBranch.code, branchName: itemBranch.name }
      }
    }
    return null
  }

  const notifications: Notif[] = (() => {
    const items: Notif[] = []
    for (const row of dueRows) {
      const days = daysUntil(row.dueDate)
      if (days > 14) continue
      const owner = profileById(row.profileId)
      items.push({
        id: `due-${row.profileId}-${row.formCode}-${row.period}`,
        kind: days < 0 ? 'danger' : 'warning',
        title:
          days < 0
            ? `${displayFormCode(row.formCode)} · ${periodLabel(row.period)} is overdue`
            : `${displayFormCode(row.formCode)} · ${periodLabel(row.period)} due ${fmtDateShort(row.dueDate)}`,
        subtitle: `${owner?.taxpayer.name ?? row.tin9} · ${owner?.branchName ?? row.branchCode}`,
        ts: Date.parse(`${row.dueDate}T00:00:00`),
      })
    }
    for (const item of filedDrafts.slice(0, 6)) {
      const owner = profileById(item.profileId)
      items.push({
        id: `filed-${item.id}`,
        kind: 'success',
        title: `${displayFormCode(item.formCode)} · ${periodLabel(item.period)} filed`,
        subtitle: `${owner?.taxpayer.name ?? ''} · ${owner?.branchName ?? ''}`,
        ts: item.updatedAt,
      })
    }
    for (const job of queueJobs.filter((job) => job.state === 'dead')) {
      items.push({
        id: `job-${job.id}`,
        kind: 'danger',
        title: `${job.kind} failed`,
        subtitle: job.lastError ?? 'The job ran out of attempts.',
        ts: job.updatedAt,
      })
    }
    for (const item of tree) {
      const totalYears = item.branches.reduce((count, itemBranch) => count + itemBranch.years.length, 0)
      if (totalYears === 0) {
        items.push({
          id: `profile-${item.tin9}`,
          kind: 'info',
          title: `${item.name || formatTin(item.tin9)} has no tax-year profile`,
          subtitle: 'Add a year under Forms to start filing.',
          ts: Date.now(),
        })
      }
    }
    if (lastBackup) {
      items.push({
        id: 'backup',
        kind: 'plain',
        title: 'Database backed up',
        subtitle: fmtDateTime(Number(lastBackup)),
        ts: Number(lastBackup),
      })
    }
    return items.sort((a, b) => b.ts - a.ts).slice(0, 24)
  })()
  const unreadCount = notifications.filter((item) => item.ts > lastRead).length

  // -- Navigation (history stack, autosave, unsupported-form guard) ---------

  const navNow: NavState = {
    page,
    tab,
    tin: selectedTin,
    branchId: selectedBranchId,
    profileId: selectedProfileId,
    formCode: formEntry?.formCode,
    period: draft?.period,
  }
  if (histRef.current.idx === -1) {
    histRef.current.stack = [navNow]
    histRef.current.idx = 0
  }
  const canNavBack = histRef.current.idx > 0
  const canNavFwd = histRef.current.idx < histRef.current.stack.length - 1

  useEffect(() => queue.onChange(setQueueJobs), [])
  // Re-read getEntries() after subscribing: entries logged between the initial
  // useState seed and this effect's subscription would otherwise be dropped.
  useEffect(() => {
    const unsubscribe = logger.subscribe((entry) => setLogs((current) => [...current.slice(-999), entry]))
    setLogs(logger.getEntries())
    return unsubscribe
  }, [])
  useEffect(() => {
    if (taxpayer) {
      setTaxpayerEdit({ name: taxpayer.name, type: taxpayer.type, birthDate: taxpayer.birthDate ?? '' })
    }
    if (branch) {
      setBranchEdit({
        name: branch.name,
        code: branch.code,
        rdo: branch.overrides.rdo ?? '',
        zip: branch.overrides.zip ?? '',
        address: branch.overrides.address ?? '',
        phone: branch.overrides.phone ?? '',
        email: branch.overrides.email ?? '',
      })
      setBranchInherit({
        rdo: branch.overrides.rdo == null,
        zip: branch.overrides.zip == null,
        address: branch.overrides.address == null,
        phone: branch.overrides.phone == null,
        email: branch.overrides.email == null,
      })
    }
  }, [taxpayer?.tin9, branch?.code])

  function refreshTree(nextTin?: string, nextBranchId?: string, nextProfileId?: string) {
    const nextTree = store.listTaxpayers()
    setTree(nextTree)
    bumpData()
    if (nextTin) setSelectedTin(nextTin)
    if (nextBranchId) setSelectedBranchId(nextBranchId)
    if (nextProfileId) setSelectedProfileId(nextProfileId)
  }

  function navTo(next: NavState) {
    const h = histRef.current
    h.stack = [...h.stack.slice(0, h.idx + 1), next]
    h.idx += 1
    setHistVersion((value) => value + 1)
    void applyNav(next)
  }

  function navJump(delta: -1 | 1) {
    const h = histRef.current
    const idx = h.idx + delta
    if (idx < 0 || idx >= h.stack.length) return
    h.idx = idx
    setHistVersion((value) => value + 1)
    void applyNav(h.stack[idx])
  }

  async function applyNav(next: NavState) {
    const switching = formInstance && (next.page !== 'form' || next.formCode !== formEntry?.formCode || next.period !== draft?.period)
    if (switching) {
      formLoadSeq.current += 1
      if (draft) {
        try {
          store.saveDraft(draft.id, valuesFromForm(formInstance))
        } catch {}
      }
      await formInstance.close()
      setFormInstance(null)
      setFieldSnapshot([])
      setIssues([])
    }
    if (next.page !== 'form' && formEntry) {
      setFormEntry(null)
      setDraft(null)
    }
    if (next.profileId !== selectedProfileId) setPendingCodes([])
    setPage(next.page)
    setTab(next.tab)
    setSelectedTin(next.tin)
    setSelectedBranchId(next.branchId)
    setSelectedProfileId(next.profileId)
    if (next.page === 'form' && next.formCode && next.period && next.profileId) {
      const profile = store
        .listTaxpayers()
        .flatMap((item) => item.branches.flatMap((itemBranch) => itemBranch.years))
        .find((item) => item.id === next.profileId)
      const entry = profile
        ? store.listLibrary(profile.id).find((item) => item.formCode === next.formCode)
        : undefined
      if (profile && entry) await openForm(entry, next.period, profile)
    }
  }

  function goto(page: Page, extra: Partial<NavState> = {}) {
    navTo({ ...navNow, page, formCode: undefined, period: undefined, ...extra })
  }

  function chooseBranch(tin9: string, code: string) {
    const id = branchId(tin9, code)
    const item = tree.find((entry) => entry.tin9 === tin9)?.branches.find((entry) => entry.code === code)
    navTo({ ...navNow, page: 'taxpayer', tin: tin9, branchId: id, profileId: item?.years.at(-1)?.id, formCode: undefined, period: undefined })
  }

  function chooseTaxpayer(tin9: string) {
    const item = tree.find((entry) => entry.tin9 === tin9)
    const firstBranch = item?.branches[0]
    setPanel(null)
    if (item) {
      showToast(`Switched to ${item.name || formatTin(tin9)}`)
    }
    navTo({
      ...navNow,
      page: 'taxpayer',
      tin: tin9,
      branchId: firstBranch ? branchId(tin9, firstBranch.code) : undefined,
      profileId: firstBranch?.years.at(-1)?.id,
      formCode: undefined,
      period: undefined,
    })
  }

  // -- Taxpayer / branch / profile mutations (unchanged semantics) -----------

  function saveNewTaxpayer() {
    const tin = `${newTaxpayer.tin1}-${newTaxpayer.tin2}-${newTaxpayer.tin3}`
    const errors: Record<string, string> = {}
    try {
      parseTin(tin)
    } catch (error) {
      errors.tin = error instanceof Error ? error.message : String(error)
    }
    if (!newTaxpayer.name.trim()) errors.name = 'Enter a taxpayer name.'
    if (Object.keys(errors).length) {
      setNewTaxpayerErrors(errors)
      return
    }
    try {
      const created = store.createTaxpayer({
        tin,
        name: newTaxpayer.name,
        type: newTaxpayer.type,
        birthDate: newTaxpayer.birthDate || null,
        rdo: newTaxpayer.rdo || undefined,
        zip: newTaxpayer.zip || undefined,
        address: newTaxpayer.address || undefined,
        phone: newTaxpayer.phone || undefined,
        email: newTaxpayer.email || undefined,
      })
      refreshTree(created.tin9, branchId(created.tin9, '00000'))
      setShowNewTaxpayer(false)
      setNewTaxpayer(blankTaxpayer)
      setNewTaxpayerErrors({})
      showToast('Taxpayer added.')
      navTo({ ...navNow, page: 'taxpayer', tab: 'profile', tin: created.tin9, branchId: branchId(created.tin9, '00000'), profileId: undefined, formCode: undefined, period: undefined })
    } catch (error) {
      setNewTaxpayerErrors({ tin: error instanceof Error ? error.message : String(error) })
    }
  }

  function saveTaxpayerDetails() {
    if (!taxpayer) return
    let tin9 = taxpayer.tin9
    try {
      const parsed = parseTin(tinEdit || taxpayer.tin9)
      if (parsed.branch !== '00000') throw new Error('Enter the 9-digit TIN without a branch code.')
      if (parsed.tin9 !== taxpayer.tin9) {
        store.renameTaxpayerTin(taxpayer.tin9, parsed.tin9)
        tin9 = parsed.tin9
      }
      store.updateTaxpayer(tin9, {
        name: taxpayerEdit.name,
        type: taxpayerEdit.type,
        birthDate: taxpayerEdit.birthDate || null,
      })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
      return
    }
    refreshTree(tin9, branch ? branchId(tin9, branch.code) : undefined)
    setEditSec(null)
    showToast('Taxpayer details saved.')
  }

  function saveBranchDetails() {
    if (!branch || !taxpayer) return
    const id = branchId(taxpayer.tin9, branch.code)
    store.updateBranch(id, {
      name: branchEdit.name,
      rdo: branchInherit.rdo ? null : branchEdit.rdo || null,
      zip: branchInherit.zip ? null : branchEdit.zip || null,
      address: branchInherit.address ? null : branchEdit.address || null,
      phone: branchInherit.phone ? null : branchEdit.phone || null,
      email: branchInherit.email ? null : branchEdit.email || null,
    })
    refreshTree(taxpayer.tin9, id)
    setEditSec(null)
    showToast('Branch details saved.')
  }

  function addBranch() {
    if (!taxpayer) return
    if (!/^\d{5}$/.test(newBranch.code) || newBranch.code === '00000') {
      setBranchError('Enter a five-digit branch code other than 00000.')
      return
    }
    try {
      const created = store.createBranch({
        tin9: taxpayer.tin9,
        code: newBranch.code,
        name: newBranch.name || `Branch ${newBranch.code}`,
        rdo: newBranch.rdo || null,
        zip: newBranch.zip || null,
        address: newBranch.address || null,
        phone: newBranch.phone || null,
        email: newBranch.email || null,
      })
      refreshTree(taxpayer.tin9, created.id)
      setShowNewBranch(false)
      setNewBranch(blankBranch)
      setBranchError('')
      navTo({ ...navNow, page: 'taxpayer', tab: 'profile', tin: taxpayer.tin9, branchId: created.id, profileId: undefined, formCode: undefined, period: undefined })
    } catch (error) {
      setBranchError(error instanceof Error ? error.message : String(error))
    }
  }

  /** Add a tax year to the current branch (up to next year), optionally copying the latest year's forms. */
  function addYear(year: number) {
    if (!taxpayer || !branch) return
    const max = new Date().getFullYear() + 1
    if (!Number.isInteger(year) || year < MIN_TAX_YEAR || year > max) {
      showToast(`Choose a tax year from ${MIN_TAX_YEAR} to ${max}.`)
      return
    }
    const source = copyFromYear ? branch.years.reduce<Profile | undefined>((best, profile) => (!best || profile.year > best.year ? profile : best), undefined) : undefined
    try {
      const profile = store.createProfile({
        tin: taxpayer.tin9,
        branch: branch.code,
        year,
        registeredName: taxpayer.name,
        rdo: branch.facts.rdo ?? '',
        address: branch.facts.address ?? '',
        zip: branch.facts.zip ?? '',
        email: branch.facts.email ?? '',
        phone: branch.facts.phone ?? '',
      })
      const codes = source ? store.listLibrary(source.id).map((entry) => entry.formCode) : []
      if (codes.length) store.addForms(profile.id, codes)
      refreshTree(taxpayer.tin9, branchId(taxpayer.tin9, branch.code), profile.id)
      setShowNewYear(false)
      showToast(codes.length ? `${year} added with ${codes.length} forms from ${source!.year}.` : `${year} added. Choose its forms next.`)
      navTo({ ...navNow, page: 'taxpayer', tab: 'forms', tin: taxpayer.tin9, branchId: branchId(taxpayer.tin9, branch.code), profileId: profile.id, formCode: undefined, period: undefined })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  // -- Form editor (unchanged semantics) ------------------------------------

  async function openForm(entry: LibraryEntry, period: string, profile: Profile | undefined = selectedProfile) {
    if (!profile) return
    const code = entry.formCode
    const ticket = ++formLoadSeq.current
    const previous = store.listDrafts(profile.id, code).find((item) => item.period === period)
    const opened = store.openDraft(profile.id, code, period)
    bumpData()
    if (formInstance) {
      await formInstance.close()
    }
    setFormEntry(entry)
    setDraft(opened)
    setPage('form')
    setFormLoading(true)
    setFormInstance(null)
    setFieldSnapshot([])
    setIssues([])
    setShowErrors(false)
    setTouched(new Set())
    setOpenMore(new Set())
    setCollapsedPartSet(new Set())
    let form: FormInstance | undefined
    try {
      form = await openOfficialForm(code as PrefillFormCode)
      if (ticket !== formLoadSeq.current) {
        await form.close()
        return
      }
      const prefillValues = isPrefillCode(code) ? buildPrefillValues(code, profile, form.fields(), period) : {}
      const template = previous ? null : store.getTemplate(profile.tin9, profile.branch, code) ?? store.listTemplates(profile.tin9, profile.branch).find((item) => familyKey(item.formCode) === familyKey(code)) ?? null
      const initialValues = mergeDraftPrefill({ ...(template?.values ?? {}), ...opened.values }, prefillValues)
      for (const [id, value] of Object.entries(initialValues)) form.set(id, value)
      const nextDraft = previous
        ? opened
        : store.saveDraft(opened.id, valuesFromForm(form))
      setDraft(nextDraft)
      setFormInstance(form)
      refreshEditor(form)
    } catch (error) {
      await form?.close()
      setIssues([{ message: error instanceof Error ? error.message : String(error), fieldId: null, source: 'official' }])
    } finally {
      setFormLoading(false)
    }
  }

  function valuesFromForm(form: FormInstance): DraftValues {
    return Object.fromEntries(
      form.fields().map((field) => [
        field.id,
        field.type === 'checkbox' || field.type === 'radio' ? Boolean(field.checked) : field.value,
      ]),
    )
  }

  function refreshEditor(form: FormInstance) {
    const snapshot = form.fields()
    const result = form.validate(logger)
    setFieldSnapshot(snapshot)
    setIssues(result.issues)
    setEditorValues(
      Object.fromEntries(
        snapshot.map((field) => [
          field.id,
          field.type === 'checkbox' || field.type === 'radio' ? Boolean(field.checked) : field.value,
        ]),
      ),
    )
    return result
  }

  function editField(field: FieldSnapshot, value: string | boolean) {
    if (!formInstance || !formEntry || field.disabled) return
    if (isPrefillCode(formEntry.formCode) && autoFieldIds(formEntry.formCode).has(field.id)) return
    formInstance.set(field.id, value)
    refreshEditor(formInstance)
  }

  function saveDraft() {
    if (!formInstance || !draft) return
    setDraft(store.saveDraft(draft.id, valuesFromForm(formInstance)))
    bumpData()
    if (askTemplate) showToast('Saved. (Template update prompt arrives with guided mode.)')
  }

  function updateDraftStatus(status: DraftStatus) {
    if (!draft) return
    setDraft(store.setDraftStatus(draft.id, status))
    bumpData()
  }

  function closeForm() {
    navTo({ ...navNow, page: 'taxpayer', tab: 'forms', formCode: undefined, period: undefined })
  }

  function navOpenForm(entry: LibraryEntry, period: string) {
    navTo({ ...navNow, page: 'form', formCode: entry.formCode, period })
  }

  function openDraftById(item: Draft) {
    const owner = profileById(item.profileId)
    if (!owner) return
    const entry = store.listLibrary(item.profileId).find((entry) => entry.formCode === item.formCode)
    if (!entry) return
    store.touchDraft(item.id)
    bumpData()
    navTo({
      ...navNow,
      page: 'form',
      tin: owner.taxpayer.tin9,
      branchId: branchId(owner.taxpayer.tin9, owner.branchCode),
      profileId: item.profileId,
      formCode: item.formCode,
      period: item.period,
    })
  }

  function openDueRow(row: { profileId: string; formCode: string; period: string }) {
    const owner = profileById(row.profileId)
    if (!owner) return
    setSelectedTin(owner.taxpayer.tin9)
    setSelectedBranchId(branchId(owner.taxpayer.tin9, owner.branchCode))
    setSelectedProfileId(row.profileId)
    setStartFormCode(row.formCode)
    setStartPeriod(row.period)
    setOverlay({ kind: 'startReturn' })
  }

  /** "Use as template" on a filed return keeps its setup answers as the branch template (D17). */
  function useAsTemplate(item: Draft) {
    const owner = profileById(item.profileId)
    if (!owner) return
    store.saveTemplate(owner.taxpayer.tin9, owner.branchCode, item.formCode, setupAnswers(item.formCode, item.values), item.id)
    bumpData()
    showToast(`${displayFormCode(item.formCode)} template saved from ${periodLabel(item.period)}. New returns start from it.`)
  }

  function toggleLibraryForm(code: string) {
    if (!selectedProfile) return
    if (selectedLibrary.some((entry) => entry.formCode === code)) {
      store.removeForm(selectedProfile.id, code)
    } else {
      store.addForms(selectedProfile.id, [code])
    }
    refreshTree()
  }

  function applyPack(pack: string) {
    if (!selectedProfile) return
    const missing = (STARTER_PACKS[pack] ?? []).filter(
      (code) => !selectedLibrary.some((entry) => entry.formCode === code),
    )
    if (missing.length) store.addForms(selectedProfile.id, missing)
    refreshTree()
    showToast(missing.length ? `Added ${missing.length} forms from ${pack}.` : `${pack} is already in the library.`)
  }

  function backupNow() {
    try {
      const dir = join(appDir, 'backups')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      copyFileSync(join(appDir, 'ebirforms.sqlite'), join(dir, `ebirforms-${stamp}.sqlite`))
      const at = String(Date.now())
      store.setSetting('lastBackupAt', at)
      setLastBackup(at)
      showToast(`Backed up to backups/ebirforms-${stamp}.sqlite`)
      logger.log('info', 'backup', 'Database backed up', { stamp })
    } catch (error) {
      showToast(`Backup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // -- Keyboard --------------------------------------------------------------

  rootKeyHandler = (event: KeyEvent) => {
    const key = event.key ?? ''
    const ctrl = event.modifiers?.ctrl || event.modifiers?.cmd
    if (ctrl && (key === 'k' || key === 'K')) {
      setPaletteQuery('')
      setPaletteIdx(0)
      setOverlay(overlay?.kind === 'search' ? null : { kind: 'search' })
      return
    }
    if (ctrl && (key === 'b' || key === 'B')) {
      setSidebarCollapsed((value) => !value)
      return
    }
    if (key === 'escape' || key === 'Escape') {
      if (overlay) {
        setOverlay(null)
        return
      }
      if (menuOpen) {
        setMenuOpen(false)
        return
      }
      if (panel) setPanel(null)
    }
  }

  // -- Title bar -------------------------------------------------------------

  function pillButton() {
    const pillLabel = taxpayer ? (taxpayer.name || formatTin(taxpayer.tin9)) : 'Add a taxpayer'
    const pillTin = taxpayer ? formatTin(taxpayer.tin9, branch?.code ?? '00000') : ''
    return (
      <div
        testId="titlebar-pill"
        onClick={once(() => setPanel(panel === 'taxpayer' ? null : 'taxpayer'))}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 30,
          paddingLeft: 4,
          paddingRight: 10,
          borderRadius: 15,
          borderWidth: 1,
          borderColor: panel === 'taxpayer' ? t.borderStrong : t.border,
          backgroundColor: panel === 'taxpayer' ? t.selected : t.surface,
          cursor: 'pointer',
          hover: { borderColor: t.borderStrong },
        }}
      >
        <Avatar name={pillLabel} size={20} />
        <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 600, whiteSpace: 'nowrap' }}>{pillLabel}</text>
        {pillTin !== '' && <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE, fontWeight: 400, whiteSpace: 'nowrap' }}>{pillTin}</text>}
        <Icon name={panel === 'taxpayer' ? 'chevLeft' : 'chevRight'} size={14} color={t.fg3} />
      </div>
    )
  }

  function captionButton(label: string, onClick: () => void, danger = false, testId?: string) {
    return (
      <div
        testId={testId}
        onClick={once(onClick)}
        style={{
          width: 46,
          height: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          hover: { backgroundColor: danger ? '#c42b1c' : t.hover },
        }}
      >
        <text style={{ color: t.fg2, fontSize: 13 }}>{label}</text>
      </div>
    )
  }

  function themeIcon(): IconName {
    return themeMode === 'dark' ? 'moon' : themeMode === 'system' ? 'monitor' : 'sun'
  }

  function cycleTheme() {
    setThemeMode(themeMode === 'light' ? 'dark' : themeMode === 'dark' ? 'system' : 'light')
  }

  function titleBar() {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 40,
          minHeight: 40,
          paddingLeft: isMac ? 76 : 10,
          paddingRight: isWin ? 0 : 10,
          backgroundColor: t.bg,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexGrow: 1, flexBasis: 0, minWidth: 0 }}>
          <IBtn testId="tb-sidebar" icon="panelLeft" onClick={once(() => setSidebarCollapsed((value) => !value))} />
          <IBtn testId="tb-back" icon="arrowLeft" disabled={!canNavBack} onClick={once(() => navJump(-1))} />
          <IBtn testId="tb-fwd" icon="arrowRight" disabled={!canNavFwd} onClick={once(() => navJump(1))} />
          {sidebarCollapsed && (
            <>
              <IBtn testId="tb-search" icon="search" onClick={once(() => setOverlay({ kind: 'search' }))} />
              <IBtn testId="tb-plus" icon="plus" onClick={once(() => setOverlay({ kind: 'startReturn' }))} />
            </>
          )}
          <div
            testId="tb-drag"
            onMouseDown={() => {
              dragAnchor.current = beginWindowDrag(WINDOW_TITLE)
            }}
            onMouseMove={() => {
              if (dragAnchor.current) dragWindowTo(WINDOW_TITLE, dragAnchor.current)
            }}
            onMouseUp={() => {
              dragAnchor.current = null
            }}
            style={{ flexGrow: 1, height: 40 }}
          />
        </div>
        {pillButton()}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexGrow: 1, flexBasis: 0, justifyContent: 'flex-end', height: 40 }}>
          <div
            testId="tb-drag-right"
            onMouseDown={() => {
              dragAnchor.current = beginWindowDrag(WINDOW_TITLE)
            }}
            onMouseMove={() => {
              if (dragAnchor.current) dragWindowTo(WINDOW_TITLE, dragAnchor.current)
            }}
            onMouseUp={() => {
              dragAnchor.current = null
            }}
            style={{ flexGrow: 1, height: 40 }}
          />
          <div style={{ position: 'relative' }}>
            <IBtn
              testId="tb-bell"
              icon="bell"
              active={panel === 'notifications'}
              onClick={once(() => setPanel(panel === 'notifications' ? null : 'notifications'))}
            />
            {unreadCount > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: t.accent,
                  borderWidth: 2,
                  borderColor: t.bg,
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
          <IBtn testId="tb-theme" icon={themeIcon()} onClick={once(cycleTheme)} />
          {isWin && (
            <>
              {captionButton('─', () => gpuix.minimizeWindow?.(), false, 'tb-min')}
              {captionButton('▢', () => { if (!toggleMaximizeWindow(WINDOW_TITLE)) gpuix.zoomWindow?.() }, false, 'tb-max')}
              {captionButton('✕', () => closeWindow(WINDOW_TITLE), true, 'tb-close')}
            </>
          )}
        </div>
      </div>
    )
  }

  // -- Left sidebar ----------------------------------------------------------

  function sidebar() {
    if (sidebarCollapsed) return null
    const accountName = displayName || 'Set your name'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: 248, minWidth: 248, paddingTop: 4, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, backgroundColor: t.bg }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div
            testId="sidebar-search"
            onClick={once(() => setOverlay({ kind: 'search' }))}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexGrow: 1,
              minWidth: 0,
              height: 32,
              paddingLeft: 10,
              paddingRight: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.surface,
              cursor: 'pointer',
              hover: { borderColor: t.borderStrong },
            }}
          >
            <Icon name="search" size={16} color={t.fg3} />
            <text style={{ color: t.fg3, fontSize: F_BODY, flexGrow: 1 }}>Search</text>
            <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
          </div>
          <IBtn testId="sidebar-new" icon="plus" onClick={once(() => setOverlay({ kind: 'startReturn' }))} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 12, flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>
          <NavRow testId="nav-home" icon="home" label="Home" current={page === 'home'} onClick={once(() => goto('home'))} />
          <NavRow testId="nav-library" icon="file" label="Form library" current={page === 'library'} onClick={once(() => goto('library'))} />
          <NavRow testId="nav-calendar" icon="calendar" label="Calendar" current={page === 'calendar'} onClick={once(() => goto('calendar'))} />
          <NavRow testId="nav-filings" icon="history" label="Filings" current={page === 'filings'} onClick={once(() => goto('filings'))} />
          {showRecent && recentDrafts.length > 0 && (
            <>
              <GroupLabel>Recent</GroupLabel>
              {recentDrafts.map((item) => {
                const owner = profileById(item.profileId)
                return (
                  <NavRow
                    key={item.id}
                    testId={`recent-${item.id}`}
                    icon="file"
                    label={`${displayFormCode(item.formCode)} ${periodLabel(item.period)} · ${owner?.taxpayer.name ?? ''}`}
                    onClick={once(() => openDraftById(item))}
                  />
                )
              })}
            </>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 8, position: 'relative' }}>
          <NavRow testId="nav-settings" icon="settings" label="Settings" current={page === 'settings'} onClick={once(() => goto('settings'))} />
          <div
            testId="user-card"
            onClick={once(() => setMenuOpen((value) => !value))}
            style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8, borderRadius: 8, cursor: 'pointer', backgroundColor: menuOpen ? t.hover : CLEAR, hover: { backgroundColor: t.hover } }}
          >
            <Avatar name={accountName} size={28} />
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{accountName}</text>
              <text style={{ color: t.fg3, fontSize: F_META, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{email || 'No email set'}</text>
            </div>
            <Icon name="upDown" size={16} color={t.fg3} />
          </div>
          {menuOpen && (
            <div
              onMouseDownOutside={() => setMenuOpen(false)}
              style={{
                position: 'absolute',
                bottom: 48,
                left: 0,
                right: 0,
                display: 'flex',
                flexDirection: 'column',
                padding: 4,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.raised,
                boxShadow: { offsetX: 0, offsetY: 16, blurRadius: 44, spreadRadius: 0, color: t === themes.dark ? 'rgba(0,0,0,0.55)' : 'rgba(20,20,30,0.14)' },
              }}
            >
              <div style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 8, paddingRight: 8, borderBottomWidth: 1, borderColor: t.border, marginBottom: 4 }}>
                <text style={{ color: t.fg3, fontSize: F_META }}>{`Signed in as ${email || 'no email set'}`}</text>
              </div>
              <NavRow testId="menu-lock" icon="lock" label="Lock app" trail={<Kbd>{isMac ? '⌘L' : 'Ctrl L'}</Kbd>} onClick={once(() => { setMenuOpen(false); showToast('App locked. Enter your PIN to continue.') })} />
              <NavRow testId="menu-account" icon="user" label="Account settings" onClick={once(() => { setMenuOpen(false); goto('settings') })} />
              <NavRow testId="menu-logout" icon="logout" label="Log out" onClick={once(() => { setMenuOpen(false); showToast('Signed out.') })} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // -- Right panel (taxpayer card / notifications) ---------------------------

  function rightPanel() {
    if (!panel) return null
    if (panel === 'notifications') {
      const anyUnread = notifications.some((item) => item.ts > lastRead)
      return (
        <div style={{ display: 'flex', flexDirection: 'column', width: 320, minWidth: 320, backgroundColor: t.bg }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, minHeight: 40, paddingLeft: 20, paddingRight: 12 }}>
            <text style={{ color: t.fg, fontSize: F_EMPH, fontWeight: 600, flexGrow: 1 }}>Notifications</text>
            <Btn
              small
              kind="ghost"
              testId="mark-all-read"
              disabled={!anyUnread}
              onClick={once(() => {
                const now = String(Date.now())
                store.setSetting('lastReadNotifs', now)
                setLastRead(Number(now))
              })}
            >
              Mark all read
            </Btn>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, overflow: 'scroll', paddingLeft: 12, paddingRight: 12, paddingBottom: 12 }}>
            {notifications.length === 0 && <text style={{ color: t.fg3, fontSize: F_META, padding: 12 }}>Nothing to review.</text>}
            {notifications.map((item) => {
              const icon: IconName =
                item.kind === 'warning' || item.kind === 'danger' ? 'alert' : item.kind === 'success' ? 'checkCircle' : item.kind === 'plain' ? 'upload' : 'info'
              const tint =
                item.kind === 'warning'
                  ? { bg: t.warningSoft, fg: t.warning }
                  : item.kind === 'danger'
                    ? { bg: t.dangerSoft, fg: t.danger }
                    : item.kind === 'success'
                      ? { bg: t.successSoft, fg: t.success }
                      : { bg: t.hover, fg: t.fg2 }
              const unread = item.ts > lastRead
              return (
                <div key={item.id} style={{ display: 'flex', gap: 12, paddingTop: 10, paddingBottom: 10, paddingLeft: 8, paddingRight: 8, borderRadius: 8, hover: { backgroundColor: t.hover } }}>
                  <div style={{ width: 28, height: 28, minWidth: 28, borderRadius: 14, backgroundColor: tint.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name={icon} size={16} color={tint.fg} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                    <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500 }}>{item.title}</text>
                    <text style={{ color: t.fg3, fontSize: F_META }}>{item.subtitle}</text>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
                    <text style={{ color: t.fg3, fontSize: F_CAP, whiteSpace: 'nowrap' }}>{fmtDateShort(new Date(item.ts).toISOString().slice(0, 10))}</text>
                    {unread && <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.accent }} />}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )
    }
    // panel === 'taxpayer'
    if (!taxpayer) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', width: 320, minWidth: 320, backgroundColor: t.bg, paddingTop: 16, paddingLeft: 20, paddingRight: 20, gap: 12 }}>
          <text style={{ color: t.fg, fontSize: F_TITLE, fontWeight: 600 }}>No taxpayer yet</text>
          <text style={{ color: t.fg2, fontSize: F_BODY, lineHeight: 19 }}>Add a taxpayer to manage its branches, tax years, forms and templates here.</text>
          <div style={{ display: 'flex' }}>
            <Btn small icon="plus" testId="panel-new-taxpayer" onClick={() => { setShowNewTaxpayer(true); goto('taxpayer', { tab: 'profile' }) }}>New taxpayer</Btn>
          </div>
        </div>
      )
    }
    const formsCount = selectedLibrary.length
    const templateCount = 0
    const branches = taxpayer?.branches ?? []
    const factRows: Array<[IconName, string, string]> = branch
      ? [
          ['branch', 'Branch', `${branch.code} · ${branch.name}`],
          ['pin', 'Address', branch.facts.address || '—'],
          ['building', 'RDO', branch.facts.rdo || '—'],
        ]
      : []
    const hero = panelEdit && taxpayer && branch ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4, paddingLeft: 8, paddingRight: 8, paddingBottom: 8 }}>
        <FieldInput label="Registered name" value={panelEdit.name} onChange={(value) => setPanelEdit({ ...panelEdit, name: value })} testId="pe-name" />
        <FieldInput label="Branch code" value={branch.code} disabled mono />
        <FieldInput label="Branch name" value={panelEdit.bname} onChange={(value) => setPanelEdit({ ...panelEdit, bname: value })} testId="pe-bname" />
        <FieldInput label="Address" value={panelEdit.address} onChange={(value) => setPanelEdit({ ...panelEdit, address: value })} testId="pe-address" />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
          <Btn small kind="ghost" onClick={once(() => setPanelEdit(null))}>Cancel</Btn>
          <Btn
            small
            testId="pe-save"
            onClick={once(() => {
              const id = branchId(taxpayer.tin9, branch.code)
              store.updateTaxpayer(taxpayer.tin9, { name: panelEdit.name.trim() || taxpayer.name, type: taxpayer.type, birthDate: taxpayer.birthDate ?? null })
              store.updateBranch(id, {
                name: panelEdit.bname.trim() || branch.name,
                rdo: branch.overrides.rdo ?? null,
                zip: branch.overrides.zip ?? null,
                address: panelEdit.address.trim() ? panelEdit.address.trim() : branch.overrides.address ?? null,
                phone: branch.overrides.phone ?? null,
                email: branch.overrides.email ?? null,
              })
              refreshTree(taxpayer.tin9, id)
              setPanelEdit(null)
              showToast('Tax profile saved')
            })}
          >
            Save
          </Btn>
        </div>
      </div>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 12, paddingLeft: 8, paddingRight: 8, paddingBottom: 16, position: 'relative' }}>
        {taxpayer && branch && (
          <div style={{ position: 'absolute', top: 8, right: 0 }}>
            <IBtn testId="panel-edit" icon="pencil" onClick={once(() => setPanelEdit({ name: taxpayer.name, bname: branch.name, address: branch.facts.address ?? '' }))} />
          </div>
        )}
        <Avatar name={taxpayer ? taxpayer.name || taxpayer.tin9 : '?'} size={56} />
        <text style={{ color: t.fg, fontSize: F_TITLE, fontWeight: 600, paddingTop: 4, textAlign: 'center' }}>{taxpayer?.name || 'No taxpayer'}</text>
        {taxpayer && <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE, fontWeight: 400 }}>{formatTin(taxpayer.tin9, branch?.code ?? '00000')}</text>}
      </div>
    )
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: 320, minWidth: 320, backgroundColor: t.bg, overflow: 'scroll', paddingTop: 4, paddingLeft: 12, paddingRight: 12, paddingBottom: 12 }}>
        {hero}
        {!panelEdit && factRows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginLeft: 8, marginRight: 8, marginBottom: 4, paddingTop: 12, paddingBottom: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.border }}>
            {factRows.map(([icon, label, value]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 78, minWidth: 78 }}>
                  <Icon name={icon} size={16} color={t.fg3} />
                  <text style={{ color: t.fg3, fontSize: F_META }}>{label}</text>
                </div>
                <text style={{ color: t.fg, fontSize: F_BODY, flexGrow: 1, minWidth: 0 }}>{value}</text>
              </div>
            ))}
          </div>
        )}
        {taxpayer && (
          <>
            <GroupLabel>Open</GroupLabel>
            <NavRow testId="panel-open-profile" icon="user" label="Profile" current={page === 'taxpayer' && tab === 'profile'} onClick={once(() => goto('taxpayer', { tab: 'profile' }))} />
            <NavRow testId="panel-open-forms" icon="file" label="Forms" count={formsCount} current={page === 'taxpayer' && tab === 'forms'} onClick={once(() => goto('taxpayer', { tab: 'forms' }))} />
            <NavRow testId="panel-open-templates" icon="template" label="Templates" count={templateCount} current={page === 'taxpayer' && tab === 'templates'} onClick={once(() => goto('taxpayer', { tab: 'templates' }))} />
          </>
        )}
        {branches.length > 0 && (
          <>
            <GroupLabel>{branches.length > 1 ? 'Branches' : 'Branch'}</GroupLabel>
            {branches.map((itemBranch) => {
              const current = selectedBranchId === branchId(taxpayer!.tin9, itemBranch.code)
              return (
                <NavRow
                  key={itemBranch.code}
                  testId={`panel-branch-${itemBranch.code}`}
                  mono={itemBranch.code}
                  label={itemBranch.name}
                  current={current}
                  trail={current ? <Icon name="check" size={16} color={t.fg3} /> : undefined}
                  onClick={once(() => chooseBranch(taxpayer!.tin9, itemBranch.code))}
                />
              )
            })}
            <NavRow testId="panel-add-branch" icon="plus" label="Add branch" onClick={once(() => { setShowNewBranch(true); goto('taxpayer', { tab: 'profile' }) })} />
          </>
        )}
        <GroupLabel>Switch taxpayer</GroupLabel>
        {tree.filter((item) => item.tin9 !== selectedTin).map((item) => (
          <NavRow
            key={item.tin9}
            testId={`panel-switch-${item.tin9}`}
            avatar={<Avatar name={item.name || item.tin9} size={20} />}
            label={item.name || formatTin(item.tin9)}
            count={item.tin9.slice(0, 3)}
            onClick={once(() => chooseTaxpayer(item.tin9))}
          />
        ))}
        <NavRow testId="panel-new-taxpayer" icon="plus" label="New taxpayer" onClick={once(() => { setShowNewTaxpayer(true); goto('taxpayer', { tab: 'profile' }) })} />
      </div>
    )
  }

  // -- Due/filed rows (prototype .r-due / .r-filed) -------------------------

  function dateBox(iso: string) {
    const date = new Date(`${iso}T00:00:00`)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 44, minWidth: 44 }}>
        <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 600, lineHeight: 12 }}>{MONTH_ABBR[date.getMonth()]}</text>
        <text style={{ color: t.fg, fontSize: F_TITLE, fontWeight: 600, lineHeight: 18 }}>{String(date.getDate())}</text>
      </div>
    )
  }

  function ownerLine(owner: ReturnType<typeof profileById>, fallbackTin = '', fallbackBranch = ''): string {
    if (!owner) return `${fallbackTin}${fallbackBranch ? ` · ${fallbackBranch}` : ''}`
    return owner.taxpayer.branches.length > 1 ? `${owner.taxpayer.name} · ${owner.branchName}` : owner.taxpayer.name
  }

  function dueRow(row: (typeof dueRows)[number], key: string, first: boolean) {
    const owner = profileById(row.profileId)
    const days = daysUntil(row.dueDate)
    const code = displayFormCode(row.formCode)
    return (
      <Row key={key} first={first} testId={`due-${row.formCode}-${row.period}`} onClick={once(() => openDueRow(row))}>
        {dateBox(row.dueDate)}
        {!narrow && <Code>{code}</Code>}
        <RName title={`${code} · ${periodLabel(row.period)}`} sub={ownerLine(owner, row.tin9, row.branchCode)} />
        <div style={{ width: 88, minWidth: 88, display: narrow ? 'none' : 'flex' }}>
          {days < 0 ? (
            <Chip tone="danger">{`${-days} day${days === -1 ? '' : 's'} overdue`}</Chip>
          ) : days <= 14 ? (
            <Chip tone="warning">{days === 0 ? 'Due today' : `In ${days} day${days === 1 ? '' : 's'}`}</Chip>
          ) : (
            <text style={{ color: t.fg2, fontSize: F_META }}>{`In ${days} days`}</text>
          )}
        </div>
        <div style={{ width: 96, minWidth: 96, display: 'flex', justifyContent: 'flex-end' }}>
          {row.draftStatus === 'draft' ? <Chip tone="accent">Draft</Chip> : <Chip>Not started</Chip>}
        </div>
      </Row>
    )
  }

  function filedRow(item: Draft, key: string, first: boolean) {
    const owner = profileById(item.profileId)
    const inLibrary = owner ? libraryByProfile.get(item.profileId)?.has(item.formCode) ?? false : false
    const code = displayFormCode(item.formCode)
    return (
      <Row key={key} first={first} testId={`filed-${item.id}`} onClick={once(() => openDraftById(item))}>
        <Code>{code}</Code>
        <RName title={`${code} · ${periodLabel(item.period)}`} sub={ownerLine(owner)} />
        {!narrow && <text style={{ color: t.fg2, fontSize: F_META, width: 104, minWidth: 104 }}>{fmtDate(item.updatedAt)}</text>}
        <div style={{ width: 132, minWidth: 132, display: 'flex', justifyContent: 'flex-end' }}>
          {inLibrary ? (
            <Btn small kind="secondary" icon="template" testId={`use-template-${item.id}`} onClick={once(() => useAsTemplate(item))}>Use as template</Btn>
          ) : (
            <Chip tone="success" icon="check">Filed</Chip>
          )}
        </div>
      </Row>
    )
  }

  function emptyRow(text: string) {
    return (
      <div style={{ paddingTop: 40, paddingBottom: 40, display: 'flex', justifyContent: 'center' }}>
        <text style={{ color: t.fg3, fontSize: F_BODY }}>{text}</text>
      </div>
    )
  }

  // -- Views -----------------------------------------------------------------

  function homePage() {
    if (tree.length === 0) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <PageHead title="Welcome to eBIRForms" lede="Start with a taxpayer. Add its TIN and head-office details, then the tax years and forms it files. Deadlines, returns and templates follow from there." />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 28, paddingTop: 24, paddingBottom: 24, paddingLeft: 24, paddingRight: 24, borderWidth: 1, borderColor: t.border, borderRadius: 12, backgroundColor: t.surface }}>
            {([
              ['user', 'Add a taxpayer', 'TIN, registered name and head-office address.'],
              ['calendar', 'Add a tax year', 'Any year up to next year, per branch.'],
              ['file', 'Choose its forms', 'Pick from all 43 BIR forms, or start from a pack.'],
            ] as Array<[IconName, string, string]>).map(([icon, title, sub], index) => (
              <div key={title} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 28, height: 28, minWidth: 28, borderRadius: 14, backgroundColor: t.hover, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <text style={{ color: t.fg2, fontSize: F_META, fontWeight: 600 }}>{String(index + 1)}</text>
                </div>
                <Icon name={icon} size={16} color={t.fg2} />
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500 }}>{title}</text>
                  <text style={{ color: t.fg3, fontSize: F_META }}>{sub}</text>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', paddingTop: 4 }}>
              <Btn testId="welcome-new-taxpayer" icon="plus" onClick={() => { setShowNewTaxpayer(true); goto('taxpayer', { tab: 'profile' }) }}>Add your first taxpayer</Btn>
            </div>
          </div>
        </div>
      )
    }
    const hour = new Date().getHours()
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
    const first = (displayName || 'there').split(' ')[0]
    const next30 = dueRows.filter((row) => daysUntil(row.dueDate) <= 30)
    const taxpayerCount = new Set(next30.map((row) => row.tin9)).size
    const today = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <PageHead
          title={`${greeting}, ${first}`}
          lede={`${next30.length} return${next30.length === 1 ? '' : 's'} ${next30.length === 1 ? 'is' : 'are'} due in the next 30 days across ${taxpayerCount} taxpayer${taxpayerCount === 1 ? '' : 's'}. ${today}.`}
        />
        <SectionLabel first>Due in the next 30 days</SectionLabel>
        <List>{next30.length === 0 ? emptyRow('Nothing due in the next 30 days.') : next30.map((row, index) => dueRow(row, `${row.profileId}-${row.formCode}-${row.period}`, index === 0))}</List>
        <SectionLabel>Recently filed</SectionLabel>
        <List>{filedDrafts.length === 0 ? emptyRow('No filed returns yet.') : filedDrafts.slice(0, 3).map((item, index) => filedRow(item, item.id, index === 0))}</List>
      </div>
    )
  }

  function calendarPage() {
    const years = [...new Set(allProfiles(tree).map((profile) => profile.year))].sort()
    const yearLabel = years.length ? String(Math.max(...years)) : String(new Date().getFullYear())
    const byMonth = new Map<string, typeof dueRows>()
    for (const row of dueRows) {
      const month = row.dueDate.slice(0, 7)
      byMonth.set(month, [...(byMonth.get(month) ?? []), row])
    }
    const months = [...byMonth.keys()].sort()
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <PageHead title="Calendar" lede={`Every deadline for the forms your taxpayers file, from the ${yearLabel} BIR tax calendar.`} />
        {months.length === 0 && (
          <>
            <SectionLabel first>Upcoming</SectionLabel>
            <List>{emptyRow('No pending deadlines.')}</List>
          </>
        )}
        {months.map((month, monthIndex) => {
          const [year, mm] = month.split('-')
          return (
            <div key={month} style={{ display: 'flex', flexDirection: 'column' }}>
              <SectionLabel first={monthIndex === 0}>{`${monthNames[Number(mm) - 1]} ${year}`}</SectionLabel>
              <List>{byMonth.get(month)!.map((row, index) => dueRow(row, `${month}-${row.profileId}-${row.formCode}-${row.period}`, index === 0))}</List>
            </div>
          )
        })}
      </div>
    )
  }

  function filingsPage() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <PageHead title="Filings" lede="Filed returns stay exactly as submitted. Use one as a template to prefill the next period." />
        <div style={{ height: 24 }} />
        <List>{filedDrafts.length === 0 ? emptyRow('No filed returns yet.') : filedDrafts.map((item, index) => filedRow(item, item.id, index === 0))}</List>
      </div>
    )
  }

  // -- Form library (prototype .fgrid / .fcard) ------------------------------

  const LIB_FREQS = ['All', 'Monthly', 'Quarterly', 'Annual', 'As needed'] as const

  function libraryForms(): Array<{ meta: FormMeta; key: string; code: string }> {
    const q = libQuery.trim().toLowerCase()
    return libraryCatalog
      .filter(({ meta }) => libFreq === 'All' || meta.frequency === libFreq)
      .filter(({ key, meta }) => !q || `${key} ${meta.title}`.toLowerCase().includes(q))
  }

  function openFromLibrary(code: string) {
    const profile = selectedProfile
    if (!profile) {
      showToast('Add a taxpayer first, then open a form for them.')
      return
    }
    if (!store.listLibrary(profile.id).some((entry) => entry.formCode === code)) {
      store.addForms(profile.id, [code])
      refreshTree()
    }
    const frequency = catalogByCode.get(code)?.frequency ?? 'annual'
    const period = dueByKey.get(`${profile.id}:${code}`)?.period ?? periodsForYear(profile.year, frequency)[0]
    navTo({ ...navNow, page: 'form', profileId: profile.id, formCode: code, period })
  }

  function formCard(item: { meta: FormMeta; key: string; code: string }) {
    const { meta, key, code } = item
    return (
      <div
        key={code}
        testId={`card-${key}`}
        onClick={once(() => openFromLibrary(code))}
        style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 14, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, borderWidth: 1, borderColor: t.border, borderRadius: 12, backgroundColor: t.surface, cursor: 'pointer', minWidth: 0, hover: { borderColor: t.borderStrong } }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <text style={{ color: t.fg, fontSize: F_TITLE, ...NUM_STYLE, flexGrow: 1 }}>{key}</text>
          {meta.draftLayout && <Chip tone="warning">Draft layout</Chip>}
        </div>
        <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500, lineClamp: 2, minHeight: 36, lineHeight: 18 }}>{meta.title}</text>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Chip>{meta.frequency}</Chip>
          <Chip>{`${meta.pages}p`}</Chip>
          <Chip>{`${meta.fields} fields`}</Chip>
        </div>
        <div style={{ display: 'flex', gap: 3, height: 6, marginTop: 2 }}>
          {meta.parts.map((count, index) => (
            <div key={index} style={{ flexGrow: Math.max(1, count), flexBasis: 0, borderRadius: 3, backgroundColor: t.selected }} />
          ))}
        </div>
      </div>
    )
  }

  function libraryTools() {
    const list = libraryForms()
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 36, paddingBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 320, height: 32, paddingLeft: 10, paddingRight: 8, borderRadius: 8, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
          <Icon name="search" size={16} color={t.fg3} />
          <input
            testId="library-search"
            value={libQuery}
            placeholder="Find a form, like 2550Q or VAT"
            onChange={(event) => setLibQuery(event.value ?? '')}
            style={{ flexGrow: 1, minWidth: 0, height: 30, color: t.fg, fontSize: F_BODY, backgroundColor: CLEAR, borderWidth: 0 }}
          />
        </div>
        <Seg options={LIB_FREQS.map((value) => ({ value, label: value }))} value={libFreq} onChange={setLibFreq} testId="library-freq" />
        <text style={{ color: t.fg2, fontSize: F_META }}>{`${list.length} of ${libraryCatalog.length}`}</text>
      </div>
    )
  }

  function libraryPage() {
    const list = libraryForms()
    const contentWidth = Math.min(1120, windowSize.width - (sidebarCollapsed ? 0 : 248) - (panel ? 320 : 0) - 16 - 64)
    const columns = Math.max(1, Math.floor((contentWidth + 12) / (250 + 12)))
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <PageHead title="Form library" lede={`Every return eBIRForms can prepare. Open one to fill it in for ${taxpayer?.name || 'a taxpayer'}.`} />
        {libraryTools()}
        {list.length === 0 ? (
          emptyRow('No form matches. Try a code like 1601C or a word like VAT.')
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: columns, gap: 12 }}>{list.map(formCard)}</div>
        )}
      </div>
    )
  }

  // -- Taxpayer page (prototype tpHead + tabs + disclosure group) -----------

  function disclosure(id: string, title: string, meta: string, aside: ReactNode, body: ReactNode, first = false) {
    const open = openSecs.has(id)
    const toggle = () =>
      setOpenSecs((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    return (
      <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: first ? 0 : 1, borderColor: t.border }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 12 }}>
          <div testId={`disc-${id}`} onClick={once(toggle)} style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, height: 44, paddingLeft: 12, paddingRight: 8, cursor: 'pointer' }}>
            <Icon name={open ? 'chevDown' : 'chevRight'} size={16} color={t.fg3} />
            <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 600 }}>{title}</text>
            <text style={{ color: t.fg3, fontSize: F_META, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', minWidth: 0 }}>{meta}</text>
          </div>
          {open && aside}
        </div>
        {open && <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 4, paddingRight: 20, paddingBottom: 20, paddingLeft: 36 }}>{body}</div>}
      </div>
    )
  }

  /** .fields — two columns, gaps 16 × 32; a `full` cell takes its own row (one column when narrow). */
  function fieldGrid(cells: GridCell[], available?: number) {
    const rows: ReactNode[][] = []
    let pending: ReactNode[] = []
    for (const cell of cells) {
      const full = typeof cell === 'object' && cell !== null && 'full' in (cell as object)
      const node = full ? (cell as { node: ReactNode }).node : (cell as ReactNode)
      if (full || narrow) {
        if (pending.length) rows.push(pending)
        pending = []
        rows.push([node])
      } else {
        pending.push(node)
        if (pending.length === 2) {
          rows.push(pending)
          pending = []
        }
      }
    }
    if (pending.length) rows.push(pending)
    // Pixel widths, not flex-grow: flex-sized text cells cost ~200ms per frame in GPUIX.
    const cellFull = Math.max(200, available ?? contentWidth - 2 - 56)
    const cellHalf = Math.floor((cellFull - 32) / 2)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {rows.map((row, index) => (
          <div key={index} style={{ display: 'flex', gap: 32 }}>
            {row.map((node, cellIndex) => (
              <div key={cellIndex} style={{ display: 'flex', flexDirection: 'column', width: row.length === 1 && rowIsFull(cells, node) ? cellFull : narrow ? cellFull : cellHalf }}>{node}</div>
            ))}
          </div>
        ))}
      </div>
    )
  }

  function rowIsFull(cells: GridCell[], node: ReactNode): boolean {
    return cells.some((cell) => typeof cell === 'object' && cell !== null && 'full' in (cell as object) && (cell as { node: ReactNode }).node === node)
  }

  /** .field — label 12 fg2 over value 13; inherited = fg2 value + "Head office" chip. */
  function factCell(label: string, value: string, opts: { mono?: boolean; inherited?: boolean; full?: boolean; key?: string } = {}): GridCell {
    const node = (
      <div key={opts.key ?? label} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
          <text style={{ color: t.fg2, fontSize: F_META, flexGrow: 1 }}>{label}</text>
          {opts.inherited && <Chip icon="branch">Head office</Chip>}
        </div>
        <text style={{ color: value ? (opts.inherited ? t.fg2 : t.fg) : t.fg3, fontSize: F_BODY, ...(opts.mono && value ? NUM_STYLE : {}), fontWeight: 400 }}>{value || 'Not set'}</text>
      </div>
    )
    return opts.full ? { full: true, node } : node
  }

  function editCell(label: string, value: string, onChange: (value: string) => void, opts: { mono?: boolean; full?: boolean; locked?: boolean; inherit?: { on: boolean; toggle: (value: boolean) => void } } = {}): GridCell {
    const locked = opts.locked || opts.inherit?.on
    const node = (
      <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
          <text style={{ color: t.fg2, fontSize: F_META, flexGrow: 1 }}>{label}</text>
          {opts.inherit && (
            <>
              <text style={{ color: t.fg3, fontSize: F_CAP }}>Same as head office</text>
              <Switch on={opts.inherit.on} onToggle={opts.inherit.toggle} />
            </>
          )}
        </div>
        <input value={value} readOnly={locked} onChange={(event) => onChange(event.value ?? '')} style={inputStyle(t, { locked, mono: opts.mono })} />
      </div>
    )
    return opts.full ? { full: true, node } : node
  }

  function editActions(onSave: () => void, section: string) {
    if (editSec !== section) return null
    return (
      <div style={{ display: 'flex', gap: 8, paddingTop: 20, justifyContent: 'flex-end' }}>
        <Btn small kind="ghost" onClick={once(() => setEditSec(null))}>Cancel</Btn>
        <Btn small testId={`save-${section}`} onClick={once(onSave)}>Save changes</Btn>
      </div>
    )
  }

  function taxpayerProfileTab() {
    if (!taxpayer || !branch) return null
    const facts = branch.facts
    const inherited = facts.inherited
    const isHO = branch.code === '00000'
    const editBtn = (sec: string) => <Btn small kind="ghost" icon="pencil" testId={`edit-${sec}`} onClick={once(() => { if (sec === 'taxpayer') setTinEdit(tin9Label(taxpayer.tin9)); setEditSec(sec) })}>Edit</Btn>
    const inheritOf = (key: 'rdo' | 'zip' | 'address' | 'phone' | 'email') =>
      isHO ? undefined : { on: branchInherit[key] !== false, toggle: (value: boolean) => setBranchInherit((current) => ({ ...current, [key]: value })) }
    const inheritCount = (['address', 'zip', 'phone', 'email'] as const).filter((key) => inherited[key]).length
    const valueFor = (key: 'rdo' | 'zip' | 'address' | 'phone' | 'email') => (!isHO && branchInherit[key] !== false ? facts[key] ?? '' : String(branchEdit[key] ?? ''))
    const setBranchField = (key: keyof NewBranchForm) => (value: string) => setBranchEdit((current) => ({ ...current, [key]: value }))
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.border, borderRadius: 12, overflow: 'hidden', backgroundColor: t.surface }}>
          {disclosure(
            'taxpayer',
            'Taxpayer',
            'Shared by every branch',
            editSec === 'taxpayer' ? null : editBtn('taxpayer'),
            editSec === 'taxpayer' ? (
              <>
                {fieldGrid([
                  editCell('Registered name', taxpayerEdit.name, (value) => setTaxpayerEdit((current) => ({ ...current, name: value })), { full: true }),
                  editCell('TIN', tinEdit, (value) => setTinEdit(value.replace(/[^\d-]/g, '').slice(0, 11)), { mono: true }),
                  <div key="type" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <text style={{ color: t.fg2, fontSize: F_META, minHeight: 20 }}>Taxpayer type</text>
                    <Seg<'individual' | 'non-individual'>
                      options={[{ value: 'individual', label: 'Individual' }, { value: 'non-individual', label: 'Non-individual' }]}
                      value={taxpayerEdit.type}
                      onChange={(value) => setTaxpayerEdit((current) => ({ ...current, type: value }))}
                    />
                  </div>,
                  editCell('Birth date', taxpayerEdit.birthDate, (value) => setTaxpayerEdit((current) => ({ ...current, birthDate: value }))),
                ])}
                <text style={{ color: t.fg3, fontSize: F_META, paddingTop: 12 }}>Changing the TIN moves every branch, tax year, return and template to the new number.</text>
                {editActions(saveTaxpayerDetails, 'taxpayer')}
              </>
            ) : (
              fieldGrid([
                factCell('Registered name', taxpayer.name, { full: true }),
                factCell('TIN', tin9Label(taxpayer.tin9), { mono: true }),
                factCell('Taxpayer type', taxpayer.type === 'individual' ? 'Individual' : 'Non-individual'),
                ...(taxpayer.type === 'individual' ? [factCell('Birth date', taxpayer.birthDate ?? '')] : []),
              ])
            ),
            true,
          )}
          {disclosure(
            'branch',
            'Branch',
            isHO ? 'Head office' : `Branch ${branch.code}`,
            editSec === 'branch' ? null : editBtn('branch'),
            editSec === 'branch' ? (
              <>
                {fieldGrid([
                  factCell('Branch code', branch.code, { mono: true }),
                  editCell('Branch name', branchEdit.name, setBranchField('name')),
                  editCell('RDO', valueFor('rdo'), setBranchField('rdo'), { inherit: inheritOf('rdo') }),
                ])}
                {editActions(saveBranchDetails, 'branch')}
              </>
            ) : (
              fieldGrid([
                factCell('Branch code', branch.code, { mono: true }),
                factCell('Branch name', branch.name),
                factCell('RDO', facts.rdo ?? '', { inherited: inherited.rdo }),
              ])
            ),
          )}
          {disclosure(
            'contact',
            'Address and contact',
            isHO ? 'Used on every return' : inheritCount ? `${inheritCount} of 4 from head office` : 'All set for this branch',
            editSec === 'contact' ? null : editBtn('contact'),
            editSec === 'contact' ? (
              <>
                {fieldGrid([
                  editCell('Registered address', valueFor('address'), setBranchField('address'), { full: true, inherit: inheritOf('address') }),
                  editCell('ZIP code', valueFor('zip'), setBranchField('zip'), { mono: true, inherit: inheritOf('zip') }),
                  editCell('Phone', valueFor('phone'), setBranchField('phone'), { inherit: inheritOf('phone') }),
                  editCell('Email', valueFor('email'), setBranchField('email'), { full: true, inherit: inheritOf('email') }),
                ])}
                {editActions(saveBranchDetails, 'contact')}
              </>
            ) : (
              fieldGrid([
                factCell('Registered address', facts.address ?? '', { full: true, inherited: inherited.address }),
                factCell('ZIP code', facts.zip ?? '', { mono: true, inherited: inherited.zip }),
                factCell('Phone', facts.phone ?? '', { inherited: inherited.phone }),
                factCell('Email', facts.email ?? '', { full: true, inherited: inherited.email }),
              ])
            ),
          )}
          {disclosure(
            'email',
            'Email, security and export',
            'Set once for the taxpayer',
            null,
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {settingsRow('Filing confirmation emails', 'Match BIR confirmation emails to filed returns', <Switch on={confirmEmails} onToggle={setConfirmEmails} />, undefined, true)}
              {settingsRow('Profile PIN', 'Ask for a PIN before opening this taxpayer', <Btn small kind="secondary" onClick={once(() => showToast('PIN setup opens here.'))}>Set PIN</Btn>)}
              {settingsRow('Export', lastBackup ? `Last export ${fmtDate(Number(lastBackup))}` : 'Not exported yet', <Btn small kind="secondary" onClick={once(backupNow)}>Export</Btn>)}
            </div>,
          )}
        </div>
        {showNewBranch && (
          <Card title="New branch" subtitle="Branches inherit head-office details until you change them.">
            {fieldGrid([
              <FieldInput key="code" label="Branch code" value={newBranch.code} placeholder="00001" mono onChange={(value) => setNewBranch((current) => ({ ...current, code: value.replace(/\D/g, '').slice(0, 5) }))} hint={branchError || undefined} />,
              <FieldInput key="name" label="Branch name" value={newBranch.name} placeholder="Cebu branch" onChange={(value) => setNewBranch((current) => ({ ...current, name: value }))} />,
              <FieldInput key="rdo" label="RDO" value={newBranch.rdo} placeholder="Same as head office" onChange={(value) => setNewBranch((current) => ({ ...current, rdo: value }))} />,
              <FieldInput key="zip" label="ZIP code" value={newBranch.zip} placeholder="Same as head office" onChange={(value) => setNewBranch((current) => ({ ...current, zip: value }))} />,
            ], contentWidth - 2 - 32)}
            <FieldInput label="Registered address" value={newBranch.address} placeholder="Same as head office" onChange={(value) => setNewBranch((current) => ({ ...current, address: value }))} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn small kind="ghost" onClick={once(() => setShowNewBranch(false))}>Cancel</Btn>
              <Btn small onClick={once(addBranch)} testId="add-branch-save">Create branch</Btn>
            </div>
          </Card>
        )}
      </div>
    )
  }

  /** Library rows: one per form family. */
  function familyIncluded(key: string): boolean {
    return selectedLibrary.some((entry) => familyKey(entry.formCode) === key)
  }

  function startFormsEdit() {
    setPendingFamilies(new Set(libraryCatalog.filter(({ key }) => familyIncluded(key)).map(({ key }) => key)))
    setFormsQuery('')
    setFormsFreq('All')
    setFormsEdit(true)
  }

  function saveFormsEdit() {
    if (!selectedProfile) return
    const owned = new Map(selectedLibrary.map((entry) => [familyKey(entry.formCode), entry.formCode]))
    const add = libraryCatalog.filter(({ key }) => pendingFamilies.has(key) && !owned.has(key)).map(({ code }) => code)
    const remove = [...owned.entries()].filter(([key]) => !pendingFamilies.has(key)).map(([, code]) => code)
    if (add.length) store.addForms(selectedProfile.id, add)
    remove.forEach((code) => store.removeForm(selectedProfile.id, code))
    refreshTree()
    setFormsEdit(false)
    showToast(add.length || remove.length ? `${selectedProfile.year} forms updated: ${add.length} added, ${remove.length} removed.` : 'No changes to the form list.')
  }

  function togglePending(key: string) {
    setPendingFamilies((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function applyPackPending(pack: string) {
    const keys = (STARTER_PACKS[pack] ?? []).map(familyKey)
    setPendingFamilies((current) => new Set([...current, ...keys]))
    showToast(`${pack} forms selected. Save to keep them.`)
  }

  /** Years a branch can add: from MIN_TAX_YEAR up to one year after the current year, minus the ones it has. */
  function allowedYears(existing: number[]): number[] {
    const years: number[] = []
    for (let year = new Date().getFullYear() + 1; year >= MIN_TAX_YEAR; year--) if (!existing.includes(year)) years.push(year)
    return years
  }

  function addYearPanel(existing: number[], onCancel?: () => void) {
    const choices = allowedYears(existing)
    const latest = branch?.years.reduce<Profile | undefined>((best, profile) => (!best || profile.year > best.year ? profile : best), undefined)
    const latestCount = latest ? store.listLibrary(latest.id).length : 0
    const value = choices.includes(Number(yearInput)) ? yearInput : String(choices[0] ?? '')
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', paddingTop: 12, paddingBottom: 12, paddingLeft: 16, paddingRight: 16, borderRadius: 12, backgroundColor: t.accentSoft, marginBottom: 16 }}>
        <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500 }}>Add tax year</text>
        <Dropdown testId="add-year-select" width={110} value={value} options={choices.map((year) => ({ value: String(year), label: String(year) }))} onChange={setYearInput} />
        {latest && (
          <div testId="copy-forms" onClick={once(() => setCopyFromYear((on) => !on))} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <Check on={copyFromYear} />
            <text style={{ color: t.fg, fontSize: F_BODY }}>{`Copy ${latestCount} form${latestCount === 1 ? '' : 's'} from ${latest.year}`}</text>
          </div>
        )}
        <div style={{ flexGrow: 1 }} />
        {onCancel && <Btn small kind="ghost" onClick={onCancel}>Cancel</Btn>}
        <Btn small testId="add-year-save" disabled={!value} onClick={() => addYear(Number(value))}>{`Add ${value}`}</Btn>
      </div>
    )
  }

  function taxpayerFormsTab() {
    if (!taxpayer || !branch) return null
    const years = branch.years.map((profile) => profile.year)
    if (!selectedProfile) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <text style={{ color: t.fg2, fontSize: F_BODY, lineHeight: 19, marginBottom: 16 }}>{`${branch.name} has no tax year yet. Add one to choose the forms it files.`}</text>
          {addYearPanel(years)}
        </div>
      )
    }
    const ownedRows = libraryCatalog.filter(({ key }) => familyIncluded(key))
    const editing = formsEdit
    const q = formsQuery.trim().toLowerCase()
    const editRows = libraryCatalog
      .filter(({ meta }) => formsFreq === 'All' || meta.frequency === formsFreq)
      .filter(({ key, meta }) => !q || `${key} ${meta.title}`.toLowerCase().includes(q))
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {showNewYear && !editing && addYearPanel(years, () => setShowNewYear(false))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <Seg<string>
            testId="year-seg"
            options={[...years].sort((a, b) => a - b).map((year) => ({ value: String(year), label: String(year) }))}
            value={String(selectedProfile.year)}
            onChange={(value) => {
              setFormsEdit(false)
              const profile = branch.years.find((item) => String(item.year) === value)
              if (profile) navTo({ ...navNow, profileId: profile.id })
            }}
          />
          {!editing && allowedYears(years).length > 0 && (
            <Btn small kind="ghost" icon="plus" testId="add-year-toggle" onClick={() => { setYearInput(''); setCopyFromYear(true); setShowNewYear((open) => !open) }}>Add year</Btn>
          )}
          <div style={{ flexGrow: 1 }} />
          {editing ? (
            <>
              <text style={{ color: t.fg2, fontSize: F_META }}>{`${pendingFamilies.size} selected`}</text>
              <Btn small kind="ghost" testId="forms-cancel" onClick={() => setFormsEdit(false)}>Cancel</Btn>
              <Btn small testId="forms-save" onClick={saveFormsEdit}>Save forms</Btn>
            </>
          ) : (
            <Btn small kind="secondary" icon="pencil" testId="forms-edit" onClick={startFormsEdit}>Edit forms</Btn>
          )}
        </div>

        {editing && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 280, height: 32, paddingLeft: 10, paddingRight: 8, borderRadius: 8, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface }}>
                <Icon name="search" size={16} color={t.fg3} />
                <input testId="forms-search" value={formsQuery} placeholder="Find a form, like 1601C or VAT" onChange={(event) => setFormsQuery(event.value ?? '')} style={{ flexGrow: 1, minWidth: 0, height: 30, color: t.fg, fontSize: F_BODY, backgroundColor: CLEAR, borderWidth: 0 }} />
              </div>
              <Seg options={LIB_FREQS.map((value) => ({ value, label: value }))} value={formsFreq} onChange={setFormsFreq} testId="forms-freq" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              <text style={{ color: t.fg3, fontSize: F_META, marginRight: 2 }}>Starter packs</text>
              {Object.keys(STARTER_PACKS).map((pack) => (
                <Btn key={pack} small kind="secondary" testId={`pack-${pack}`} onClick={() => applyPackPending(pack)}>{pack}</Btn>
              ))}
            </div>
            <List>
              {editRows.length === 0 && emptyRow('No form matches. Try another filter.')}
              {editRows.map(({ key, meta }, index) => {
                const on = pendingFamilies.has(key)
                return (
                  <Row key={key} first={index === 0} testId={`lib-${key}`} onClick={() => togglePending(key)}>
                    <Check on={on} />
                    <Code dim={!on}>{key}</Code>
                    <RName title={meta.title} sub={on ? 'Filed this year' : 'Not filed this year'} dim={!on} />
                    {!narrow && <div style={{ width: 84, minWidth: 84, display: 'flex' }}><Chip>{meta.frequency}</Chip></div>}
                  </Row>
                )
              })}
            </List>
          </>
        )}

        {!editing && (
          <List>
            {ownedRows.length === 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingTop: 36, paddingBottom: 36 }}>
                <text style={{ color: t.fg2, fontSize: F_BODY }}>{`No forms for ${selectedProfile.year} yet.`}</text>
                <Btn small icon="pencil" onClick={startFormsEdit}>Choose forms</Btn>
              </div>
            )}
            {ownedRows.map(({ key, meta }, index) => {
              const owned = selectedLibrary.find((entry) => familyKey(entry.formCode) === key)
              const due = owned ? dueByKey.get(`${selectedProfile.id}:${owned.formCode}`) : undefined
              const tpl = owned ? templatesForBranch.some((item) => familyKey(item.formCode) === key) : false
              return (
                <Row key={key} first={index === 0} testId={`lib-${key}`}>
                  <Code>{key}</Code>
                  <RName title={meta.title} sub={due ? `Next: ${periodLabel(due.period)}` : 'Every period filed'} />
                  {!narrow && <div style={{ width: 84, minWidth: 84, display: 'flex' }}><Chip>{meta.frequency}</Chip></div>}
                  {!narrow && <text style={{ color: t.fg2, fontSize: F_META, width: 104, minWidth: 104 }}>{due ? `Due ${fmtDateShort(due.dueDate)}` : ''}</text>}
                  <div style={{ width: 112, minWidth: 112, display: 'flex' }}>{tpl ? <Chip tone="success" icon="template">Template</Chip> : <Chip>No template</Chip>}</div>
                </Row>
              )
            })}
          </List>
        )}
      </div>
    )
  }

  /** Setup answers only: drop amounts, rates and computed fields (D8). */
  function setupAnswers(formCode: string, values: DraftValues): DraftValues {
    const schema = formSchemas[familyKey(formCode)]
    if (!schema) return values
    const drop = new Set<string>()
    for (const part of schema.parts) {
      for (const item of part.items) {
        for (const field of item.f ?? []) if (field.k && (field.t === 'money' || field.t === 'pct' || field.c)) drop.add(field.k)
        item.keys?.forEach((row) => row.forEach((key, index) => { const col = item.cols?.[index]; if (key && col && (col.t === 'money' || col.t === 'pct' || col.c)) drop.add(key) }))
      }
    }
    return Object.fromEntries(Object.entries(values).filter(([key, value]) => !drop.has(key) && value !== '' && value !== false))
  }

  /** The newest return of a form for this branch, any status and any year. */
  function latestDraftFor(formCode: string): Draft | undefined {
    if (!branch) return undefined
    return branch.years
      .flatMap((profile) => store.listDrafts(profile.id).filter((item) => familyKey(item.formCode) === familyKey(formCode)))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  function makeTemplate(formCode: string, from?: Draft) {
    if (!taxpayer || !branch) return
    const source = from ?? latestDraftFor(formCode)
    if (!source) {
      showToast(`Open and save a ${familyKey(formCode)} return first. The template keeps its setup answers.`)
      return
    }
    const kept = setupAnswers(source.formCode, source.values)
    store.saveTemplate(taxpayer.tin9, branch.code, source.formCode, kept, source.id)
    bumpData()
    showToast(`${familyKey(formCode)} template saved: ${Object.keys(kept).length} setup answers kept, amounts left out.`)
  }

  function taxpayerTemplatesTab() {
    if (!taxpayer || !branch) return null
    const owned = libraryCatalog.filter(({ key }) => familyIncluded(key))
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <text style={{ color: t.fg2, fontSize: F_BODY, lineHeight: 19, marginBottom: 16 }}>
          One template per form for this branch. A template keeps the setup answers from a return and fills them into each new one. It never keeps amounts.
        </text>
        <List>
          {owned.length === 0 && emptyRow(selectedProfile ? 'Choose this year’s forms under the Forms tab first.' : 'Add a tax year under the Forms tab first.')}
          {owned.map(({ key, code, meta }, index) => {
            const tpl = templatesForBranch.find((item) => familyKey(item.formCode) === key)
            return (
              <Row key={key} first={index === 0} dim={!tpl}>
                <Code dim={!tpl}>{key}</Code>
                <RName title={meta.title} sub={tpl ? `Updated ${fmtDate(tpl.updatedAt)}` : 'No template yet'} dim={!tpl} />
                {!narrow && <text style={{ color: t.fg2, fontSize: F_META, width: 140, minWidth: 140 }}>{tpl ? `${Object.keys(tpl.values).length} answers kept` : ''}</text>}
                <div style={{ width: 196, minWidth: 196, display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                  {tpl ? (
                    <>
                      <Btn small kind="ghost" testId={`tpl-update-${key}`} onClick={() => makeTemplate(tpl.formCode)}>Update</Btn>
                      <Btn small kind="ghost" testId={`tpl-delete-${key}`} onClick={() => { store.deleteTemplate(taxpayer.tin9, branch.code, tpl.formCode); bumpData(); showToast(`${key} template deleted.`) }}>Delete</Btn>
                    </>
                  ) : (
                    <Btn small kind="secondary" icon="plus" testId={`tpl-create-${key}`} onClick={() => makeTemplate(selectedLibrary.find((entry) => familyKey(entry.formCode) === key)?.formCode ?? code)}>Create</Btn>
                  )}
                </div>
              </Row>
            )
          })}
        </List>
      </div>
    )
  }

  function newTaxpayerPage() {
    const setNew = (field: keyof NewTaxpayerForm, value: string) => setNewTaxpayer((current) => ({ ...current, [field]: value }))
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <PageHead title="New taxpayer" lede="Add a taxpayer and its head-office details. Branches and tax years come next." />
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
            {(['tin1', 'tin2', 'tin3'] as const).map((part, index) => (
              <div key={part} style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
                {index > 0 && <text style={{ color: t.fg3, fontSize: F_META, paddingBottom: 8 }}>-</text>}
                <div style={{ width: 72 }}>
                  <FieldInput label={index === 0 ? 'TIN' : ' '} value={newTaxpayer[part]} placeholder={['123', '456', '788'][index]} mono onChange={(value) => setNew(part, (value ?? '').replace(/\D/g, '').slice(0, 3))} testId={`new-taxpayer-${part}`} />
                </div>
              </div>
            ))}
          </div>
          {newTaxpayerErrors.tin && <text style={{ color: t.danger, fontSize: F_META }}>{newTaxpayerErrors.tin}</text>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <text style={{ color: t.fg2, fontSize: F_META }}>Taxpayer type</text>
            <Seg<'individual' | 'non-individual'>
              options={[{ value: 'individual', label: 'Individual' }, { value: 'non-individual', label: 'Non-individual' }]}
              value={newTaxpayer.type}
              onChange={(value) => setNewTaxpayer((current) => ({ ...current, type: value }))}
            />
          </div>
          {fieldGrid([
            <FieldInput key="name" label="Registered name" value={newTaxpayer.name} onChange={(value) => setNew('name', value)} hint={newTaxpayerErrors.name} testId="new-taxpayer-name" />,
            <FieldInput key="birth" label="Birth date" value={newTaxpayer.birthDate} placeholder="YYYY-MM-DD (individuals)" onChange={(value) => setNew('birthDate', value)} />,
            <FieldInput key="rdo" label="RDO" value={newTaxpayer.rdo} onChange={(value) => setNew('rdo', value)} />,
            <FieldInput key="zip" label="ZIP code" value={newTaxpayer.zip} onChange={(value) => setNew('zip', value)} />,
            <FieldInput key="phone" label="Phone" value={newTaxpayer.phone} onChange={(value) => setNew('phone', value)} />,
            <FieldInput key="email" label="Email" value={newTaxpayer.email} onChange={(value) => setNew('email', value)} />,
          ], contentWidth - 2 - 32)}
          <FieldInput label="Registered address" value={newTaxpayer.address} onChange={(value) => setNew('address', value)} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn kind="ghost" onClick={once(() => setShowNewTaxpayer(false))}>Cancel</Btn>
            <Btn testId="new-taxpayer-save" onClick={once(saveNewTaxpayer)}>Add taxpayer</Btn>
          </div>
        </Card>
      </div>
    )
  }

  function taxpayerPage() {
    if (showNewTaxpayer || !taxpayer) return newTaxpayerPage()
    const formsCount = selectedLibrary.length
    const tabs: Array<[TpTab, string, number | null]> = [
      ['profile', 'Profile', null],
      ['forms', 'Forms', formsCount],
      ['templates', 'Templates', 0],
    ]
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <Avatar name={taxpayer.name || taxpayer.tin9} size={40} />
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
            <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{taxpayer.name || formatTin(taxpayer.tin9)}</text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', paddingTop: 2 }}>
              <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE, fontWeight: 400 }}>{formatTin(taxpayer.tin9, branch?.code ?? '00000')}</text>
              <div style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: t.fg3 }} />
              <text style={{ color: t.fg2, fontSize: F_META }}>{branch?.name ?? 'Head office'}</text>
              <div style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: t.fg3 }} />
              <text style={{ color: t.fg2, fontSize: F_META }}>{taxpayer.type === 'individual' ? 'Individual' : 'Non-individual'}</text>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn small testId="copy-tin" kind="secondary" icon="copy" onClick={once(() => showToast(`Copied ${formatTin(taxpayer.tin9, branch?.code ?? '00000')}`))}>Copy TIN</Btn>
            <Btn small testId="new-return" icon="plus" onClick={once(() => setOverlay({ kind: 'startReturn' }))}>New return</Btn>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, borderBottomWidth: 1, borderColor: t.border, marginTop: 20, marginBottom: 24 }}>
          {tabs.map(([id, label, count]) => (
            <div
              key={id}
              testId={`tab-${id}`}
              onClick={once(() => navTo({ ...navNow, tab: id }))}
              style={{ display: 'flex', alignItems: 'center', gap: 6, height: 36, paddingLeft: 10, paddingRight: 10, marginBottom: -1, borderBottomWidth: 2, borderColor: tab === id ? t.fg : CLEAR, cursor: 'pointer' }}
            >
              <text style={{ color: tab === id ? t.fg : t.fg2, fontSize: F_BODY, fontWeight: 500 }}>{label}</text>
              {count !== null && (
                <div style={{ paddingLeft: 6, paddingRight: 6, height: 18, borderRadius: 9, backgroundColor: t.hover, display: 'flex', alignItems: 'center' }}>
                  <text style={{ color: t.fg2, fontSize: F_CAP }}>{String(count)}</text>
                </div>
              )}
            </div>
          ))}
        </div>
        {tab === 'profile' && taxpayerProfileTab()}
        {tab === 'forms' && taxpayerFormsTab()}
        {tab === 'templates' && taxpayerTemplatesTab()}
      </div>
    )
  }

  // -- Settings (prototype viewSettings) --------------------------------------

  /** .srow — 14px vertical padding, hairline above; title 13/500 over a 12/fg3 line. */
  function settingsRow(title: string, subtitle: string, control: ReactNode, testId?: string, first = false) {
    return (
      <div testId={testId} style={{ display: 'flex', alignItems: 'center', gap: 16, paddingTop: 14, paddingBottom: 14, borderTopWidth: first ? 0 : 1, borderColor: t.border }}>
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
          <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500 }}>{title}</text>
          <text style={{ color: t.fg3, fontSize: F_META }}>{subtitle}</text>
        </div>
        {control}
      </div>
    )
  }

  function settingsCard(children: ReactNode) {
    return <div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.border, borderRadius: 12, paddingTop: 4, paddingBottom: 4, paddingLeft: 16, paddingRight: 16, backgroundColor: t.surface }}>{children}</div>
  }

  function settingsPage() {
    const stateChip = (job: Job) =>
      job.state === 'running' ? <Chip tone="success">Running</Chip> : job.state === 'dead' ? <Chip tone="danger">Failed</Chip> : job.state === 'succeeded' ? <Chip tone="success">Done</Chip> : <Chip>Queued</Chip>
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <PageHead title="Settings" lede="App-wide preferences for this computer. Taxpayer details live in each tax profile." />
        <SectionLabel first>Appearance</SectionLabel>
        {settingsCard(
          <>
            {settingsRow(
              'Theme',
              `System follows your ${isMac ? 'macOS' : 'Windows'} setting`,
              <Seg<ThemeMode>
                testId="theme-seg"
                options={[
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'system', label: 'System' },
                ]}
                value={themeMode}
                onChange={setThemeMode}
              />,
              undefined,
              true,
            )}
            {settingsRow('Show recent returns in the sidebar', 'The last four returns you opened', <Switch testId="show-recent" on={showRecent} onToggle={toggleRecent} />)}
          </>,
        )}
        <SectionLabel>Returns</SectionLabel>
        {settingsCard(settingsRow('Ask to update the template on save', 'When a saved return differs from its template', <Switch testId="ask-template" on={askTemplate} onToggle={toggleAskTemplate} />, undefined, true))}
        <SectionLabel>Data</SectionLabel>
        {settingsCard(
          <>
            {settingsRow('Import data', 'Bring in returns saved by the official eBIRForms app', <Btn small kind="secondary" icon="upload" onClick={once(() => showToast('Choose an eBIRForms savefile folder.'))}>Import</Btn>, 'import-row', true)}
            {settingsRow('Back up now', lastBackup ? `Last backup ${fmtDateTime(Number(lastBackup))}` : 'No backup yet', <Btn small kind="secondary" onClick={once(backupNow)} testId="backup-now">Back up</Btn>, 'backup-row')}
            {settingsRow('Logs', sftpMode, <Btn small kind="ghost" onClick={once(() => goto('logs'))}>Open</Btn>)}
          </>,
        )}
        <SectionLabel>Background tasks</SectionLabel>
        {settingsCard(
          queueJobs.length === 0
            ? settingsRow('No background tasks', 'Filing and reminder jobs appear here while they run', <Chip>Idle</Chip>, undefined, true)
            : queueJobs.map((job, index) => (
                <div key={job.id}>{settingsRow(job.kind, `Attempt ${job.attempts} of ${job.maxAttempts}${job.lastError ? ` · ${job.lastError}` : ''}`, stateChip(job), undefined, index === 0)}</div>
              )),
        )}
        <SectionLabel>Security</SectionLabel>
        {settingsCard(
          settingsRow(
            'Lock after inactivity',
            'Asks for your account PIN',
            <Seg<string> testId="lock-seg" options={['5m', '15m', 'Never'].map((value) => ({ value, label: value }))} value={lockAfter} onChange={(value) => { setLockAfter(value); store.setSetting('lockAfter', value) }} />,
            undefined,
            true,
          ),
        )}
        <SectionLabel>Account</SectionLabel>
        {settingsCard(
          <>
            {settingsRow('Display name', 'Used for the greeting on Home', <div style={{ width: 220 }}><FieldInput value={displayName} onChange={setDisplayName} testId="display-name" /></div>, undefined, true)}
            {settingsRow('Email', 'Shown on the account card', <div style={{ width: 220 }}><FieldInput value={email} onChange={setEmail} testId="account-email" /></div>)}
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4, paddingBottom: 10 }}>
              <Btn small kind="secondary" onClick={once(() => { store.setSetting('displayName', displayName.trim()); store.setSetting('email', email.trim()); showToast('Account details saved.') })}>Save</Btn>
            </div>
          </>,
        )}
      </div>
    )
  }

  function jobsPage() {
    return settingsPage()
  }

  function logsPage() {
    const shownLogs = logFilter === 'all' ? logs : logs.filter((entry) => entry.level === logFilter)
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <PageHead
          title="Logs"
          lede="What the app recorded on this computer, newest last."
          actions={<Seg<LogFilter> testId="log-filter" options={(['all', 'debug', 'info', 'warn', 'error'] as LogFilter[]).map((value) => ({ value, label: value === 'all' ? 'All' : value[0].toUpperCase() + value.slice(1) }))} value={logFilter} onChange={setLogFilter} />}
        />
        <div style={{ height: 24 }} />
        <List>
          {shownLogs.length === 0 && emptyRow('Nothing logged yet.')}
          {shownLogs.slice(-400).map((entry, index) => (
            <Row key={`${entry.ts}-${index}`} first={index === 0}>
              <text style={{ color: t.fg3, fontSize: F_META, width: 84, minWidth: 84 }}>{new Date(entry.ts).toLocaleTimeString()}</text>
              <div style={{ width: 64, minWidth: 64, display: 'flex' }}>
                <Chip tone={entry.level === 'error' ? 'danger' : entry.level === 'warn' ? 'warning' : 'plain'}>{entry.level}</Chip>
              </div>
              <RName title={entry.msg} sub={entry.scope} />
            </Row>
          ))}
        </List>
      </div>
    )
  }

  // -- Form page (editor logic unchanged, restyled to the tokens) ------------

  function formPage() {
    const key = formEntry ? familyKey(formEntry.formCode) : ''
    const schema = formSchemas[key]
    const title = schema?.title ?? (formEntry ? cleanFormTitle(formEntry.label) : 'Return')
    const status = draft?.status ?? 'draft'
    const stages: DraftStatus[] = ['draft', 'queued', 'submitted', 'confirmed', 'paid']
    const statusTone: ChipTone = status === 'draft' ? 'accent' : status === 'queued' ? 'plain' : 'success'
    const periodText = draft ? periodLabel(draft.period) : ''
    const showFor = (item: ModelItem) => showErrors || touched.has(item.id)
    /** One scroller per window (GPUIX has no nested scrolling): the Parts column sizes to its content. */
    const partsWidth = narrow ? contentWidth : contentWidth - 208 - 28

    function fieldValue(field: FieldSnapshot | null): string {
      return field ? String(editorValues[field.id] ?? '') : ''
    }

    function fieldIsLocked(item: ModelItem, bound: BoundField): boolean {
      return item.auto || Boolean(bound.spec.c) || !bound.field || Boolean(bound.field.disabled)
    }

    function setField(item: ModelItem, field: FieldSnapshot | null, value: string | boolean) {
      if (!field) return
      setTouched((current) => (current.has(item.id) ? current : new Set(current).add(item.id)))
      editField(field, value)
    }

    function control(item: ModelItem, bound: BoundField, multi: boolean) {
      const { spec, field } = bound
      const locked = fieldIsLocked(item, bound)
      const error = item.errorText !== '' && showFor(item) && !locked && fieldValue(field) === ''
      const showSub = multi && spec.l && spec.l !== item.label && !/^\d+[A-Z]?$/.test(spec.l)
      const sub = showSub ? <text style={{ color: t.fg2, fontSize: F_META }}>{spec.l}</text> : null
      const value = spec.c && !fieldValue(field) && spec.t === 'money' ? '0.00' : fieldValue(field)
      const wrap = (basis: number, grow: number, body: ReactNode) => (
        <div key={spec.k ?? spec.l} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flexBasis: narrow ? undefined : basis, flexGrow: narrow ? 1 : grow, flexShrink: 1, width: narrow ? '100%' : undefined }}>
          {sub}
          {body}
        </div>
      )
      const box = (opts: { align?: 'left' | 'right'; prefix?: string; suffix?: string } = {}) => (
        <div style={{ position: 'relative', display: 'flex' }}>
          <input
            testId={field ? `field-${field.id}` : undefined}
            value={value}
            readOnly={locked}
            placeholder={spec.t === 'money' ? '0.00' : spec.t === 'date' ? 'MM/DD/YYYY' : undefined}
            onChange={(event) => setField(item, field, event.value ?? '')}
            style={{ ...inputStyle(t, { locked, error, mono: spec.t === 'money' || spec.t === 'pct', align: opts.align }), flexGrow: 1, minWidth: 0, paddingLeft: opts.prefix ? 24 : 10, paddingRight: opts.suffix ? 24 : 10 }}
          />
          {opts.prefix && <text style={{ position: 'absolute', left: 10, top: 8, color: t.fg3, fontSize: F_META, pointerEvents: 'none' }}>{opts.prefix}</text>}
          {opts.suffix && <text style={{ position: 'absolute', right: 10, top: 8, color: t.fg3, fontSize: F_META, pointerEvents: 'none' }}>{opts.suffix}</text>}
        </div>
      )
      switch (spec.t) {
        case 'money':
          return wrap(230, 0, box({ align: 'right', prefix: '₱' }))
        case 'pct':
          return wrap(88, 0, box({ align: 'right', suffix: '%' }))
        case 'date':
          return wrap(140, 0, box())
        case 'int':
          return wrap(spec.m && spec.m <= 4 ? 88 : 140, 0, box())
        case 'chk':
          return (
            <div key={spec.k ?? spec.l} onClick={once(() => !locked && setField(item, field, !Boolean(field && editorValues[field.id])))} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, cursor: locked ? 'default' : 'pointer' }}>
              <Check on={Boolean(field && editorValues[field.id])} disabled={locked} />
              <text style={{ color: t.fg, fontSize: F_BODY }}>{spec.l || item.label}</text>
            </div>
          )
        case 'sel': {
          const options = field?.options?.length ? field.options : (spec.o ?? []).map((option) => ({ value: option, label: option }))
          return wrap(
            180,
            1,
            <Dropdown testId={field ? `field-${field.id}` : undefined} value={value} options={options} onChange={(next) => setField(item, field, next)} disabled={locked} error={error} />,
          )
        }
        default:
          return wrap(220, 1, box())
      }
    }

    function itemControls(item: ModelItem) {
      if (item.tin) {
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {item.fields.map(({ field }, index) => (
              <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {index > 0 && <text style={{ color: t.fg3, fontSize: F_META }}>-</text>}
                <input value={fieldValue(field)} readOnly style={{ ...inputStyle(t, { locked: true, mono: true, align: 'center' }), width: index === 3 ? 76 : 58, paddingLeft: 6, paddingRight: 6 }} />
              </div>
            ))}
          </div>
        )
      }
      const radios = item.fields.filter(({ spec }) => spec.t === 'radio')
      const others = item.fields.filter(({ spec }) => spec.t !== 'radio')
      const multi = item.fields.length > 1
      return (
        <>
          {radios.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {radios.map((bound) => {
                const checked = Boolean(bound.field && editorValues[bound.field.id])
                const locked = fieldIsLocked(item, bound)
                return (
                  <div
                    key={bound.spec.k ?? bound.spec.l}
                    testId={bound.field ? `radio-${bound.field.id}` : undefined}
                    onClick={once(() => !locked && setField(item, bound.field, true))}
                    style={{ display: 'flex', alignItems: 'center', height: 28, paddingLeft: 12, paddingRight: 12, borderWidth: 1, borderColor: checked ? t.primary : t.borderStrong, borderRadius: 14, backgroundColor: checked ? t.primary : t.surface, cursor: locked ? 'default' : 'pointer', opacity: locked && !checked ? 0.6 : 1, hover: locked || checked ? {} : { borderColor: t.fg3 } }}
                  >
                    <text style={{ color: checked ? t.primaryFg : t.fg2, fontSize: F_META, fontWeight: 500, whiteSpace: 'nowrap' }}>{bound.spec.l}</text>
                  </div>
                )
              })}
            </div>
          )}
          {others.map((bound) => control(item, bound, multi || radios.length > 0))}
        </>
      )
    }

    function tableBlock(item: ModelItem) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.border, borderRadius: 8, overflowX: 'scroll' }}>
          <div style={{ display: 'flex', backgroundColor: t.bg }}>
            <div style={{ width: 36, minWidth: 36, paddingTop: 9, paddingBottom: 9, display: 'flex', justifyContent: 'center' }}><text style={{ color: t.fg3, fontSize: F_META, fontWeight: 500 }}>#</text></div>
            {item.cols.map((col, index) => (
              <div key={index} style={{ minWidth: 136, flexGrow: 1, flexBasis: 0, paddingTop: 9, paddingBottom: 9, paddingLeft: 8, paddingRight: 8 }}>
                <text style={{ color: t.fg3, fontSize: F_META, fontWeight: 500 }}>{col.l}</text>
              </div>
            ))}
          </div>
          {item.cells.map((row, rowIndex) => (
            <div key={rowIndex} style={{ display: 'flex', alignItems: 'center', borderTopWidth: 1, borderColor: t.border }}>
              <div style={{ width: 36, minWidth: 36, display: 'flex', justifyContent: 'center' }}><text style={{ color: t.fg3, fontSize: F_META }}>{String(rowIndex + 1)}</text></div>
              {item.cols.map((col, colIndex) => {
                const cell = row[colIndex] ?? null
                const locked = Boolean(col.c) || !cell || Boolean(cell.disabled)
                return (
                  <div key={colIndex} style={{ minWidth: 136, flexGrow: 1, flexBasis: 0, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 8 }}>
                    {col.t === 'radio' || col.t === 'chk' ? (
                      <div onClick={once(() => !locked && setField(item, cell, !Boolean(cell && editorValues[cell.id])))} style={{ cursor: locked ? 'default' : 'pointer' }}><Check on={Boolean(cell && editorValues[cell.id])} disabled={locked} /></div>
                    ) : (
                      <input
                        value={col.c && col.t === 'money' && !fieldValue(cell) ? '0.00' : fieldValue(cell)}
                        readOnly={locked}
                        placeholder={col.t === 'money' ? '0.00' : undefined}
                        onChange={(event) => setField(item, cell, event.value ?? '')}
                        style={{ ...inputStyle(t, { locked, mono: col.t === 'money', align: col.t === 'money' ? 'right' : 'left' }), height: 30, minHeight: 30, width: '100%' }}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )
    }

    function itemRow(item: ModelItem, first: boolean) {
      const errorLine = showFor(item) ? item.errorText.split('\n').filter(Boolean).join(' · ') : ''
      const numberChip = (
        <div style={{ minWidth: 30, height: 22, paddingLeft: 6, paddingRight: 6, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: item.no ? t.hover : CLEAR, marginTop: 1 }}>
          {item.no !== '' && <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE }}>{item.no}</text>}
        </div>
      )
      if (item.kind === 'more') {
        const open = openMore.has(item.id)
        return (
          <div key={item.id} style={{ display: 'flex', gap: 12, paddingTop: 14, paddingRight: 20, paddingBottom: 16, paddingLeft: 12, borderTopWidth: first ? 0 : 1, borderColor: t.border }}>
            <div style={{ width: 44, minWidth: 44 }} />
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <div onClick={once(() => setOpenMore((current) => { const next = new Set(current); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next }))} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, cursor: 'pointer' }}>
                <Icon name={open ? 'chevDown' : 'chevRight'} size={16} color={t.fg3} />
                <text style={{ color: t.fg2, fontSize: F_META, fontWeight: 500 }}>{`${item.fields.length} more field${item.fields.length === 1 ? '' : 's'} not yet placed on the paper layout`}</text>
              </div>
              {open && <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 16, rowGap: 12, alignItems: 'flex-end', paddingTop: 10 }}>{item.fields.map((bound) => control(item, bound, true))}</div>}
            </div>
          </div>
        )
      }
      return (
        <div key={item.id} testId={`item-${item.no || item.id}`} style={{ display: 'flex', gap: 12, paddingTop: 14, paddingRight: 20, paddingBottom: 12, paddingLeft: 12, borderTopWidth: first ? 0 : 1, borderColor: t.border, backgroundColor: item.computed ? t.bg : CLEAR }}>
          <div style={{ width: 44, minWidth: 44, display: 'flex' }}>{numberChip}</div>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', minHeight: 22, marginBottom: 10 }}>
              <div style={{ display: 'flex', flexGrow: 1, flexShrink: 1, flexBasis: 240, minWidth: 0, gap: 2 }}>
                <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500, lineHeight: 19 }}>{item.label}</text>
                {item.required && <text style={{ color: t.danger, fontSize: F_BODY, fontWeight: 500 }}>*</text>}
              </div>
              {item.kind === 'table' && <Chip>{`${item.cells.length} rows`}</Chip>}
              {item.auto && <Chip icon="user">From tax profile</Chip>}
              {item.computed && <Chip icon="lock">Computed</Chip>}
            </div>
            {item.kind === 'table' ? tableBlock(item) : <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 16, rowGap: 12, alignItems: 'flex-end' }}>{itemControls(item)}</div>}
            <div style={{ height: 18, minHeight: 18, paddingTop: 4, display: 'flex' }}>
              {errorLine !== '' && <text testId={`error-${item.no || item.id}`} style={{ color: t.danger, fontSize: F_META, lineClamp: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{errorLine}</text>}
            </div>
          </div>
        </div>
      )
    }

    const partNav = (
      <div style={{ display: 'flex', flexDirection: narrow ? 'row' : 'column', gap: narrow ? 4 : 2, width: narrow ? undefined : 208, minWidth: narrow ? undefined : 208, overflowX: narrow ? 'scroll' : undefined, paddingBottom: narrow ? 4 : 0 }}>
        {!narrow && <text style={{ color: t.fg3, fontSize: F_META, fontWeight: 500, paddingLeft: 8, paddingBottom: 6 }}>On this form</text>}
        {schemaParts.map((part, index) => (
          <div
            key={index}
            testId={`part-nav-${index}`}
            onClick={once(() => {
              setCollapsedPartSet((current) => { const next = new Set(current); next.delete(String(index)); return next })
              partRefs.current[index]?.scrollIntoView?.()
            })}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minHeight: narrow ? 28 : 32, paddingTop: narrow ? 4 : 6, paddingBottom: narrow ? 4 : 6, paddingLeft: narrow ? 10 : 8, paddingRight: narrow ? 10 : 8, borderRadius: narrow ? 14 : 8, borderWidth: narrow ? 1 : 0, borderColor: t.border, cursor: 'pointer', hover: { backgroundColor: t.hover } }}
          >
            <text style={{ color: t.fg2, fontSize: F_BODY, fontWeight: 500, flexGrow: 1, minWidth: 0, lineHeight: 18, whiteSpace: narrow ? 'nowrap' : 'normal' }}>{part.name}</text>
            <text style={{ color: t.fg3, fontSize: F_META, paddingTop: 1 }}>{String(part.items.length)}</text>
          </div>
        ))}
      </div>
    )

    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 4 }}>
              <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE }}>{`BIR Form ${key}`}</text>
              <div style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: t.fg3 }} />
              <text style={{ color: t.fg2, fontSize: F_META }}>{`Revision ${schema?.revision ?? ''}`}</text>
            </div>
            <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 600 }}>{title}</text>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 8 }}>
              <Chip>{schema?.frequency ?? freqLabel(catalogByCode.get(formEntry?.formCode ?? '')?.frequency ?? 'annual')}</Chip>
              {schema && <Chip>{`${schema.pages} page${schema.pages === 1 ? '' : 's'}`}</Chip>}
              {schema && <Chip>{`${schema.fields} fields`}</Chip>}
              {schema?.draftLayout && <Chip tone="warning" icon="alert">Draft layout</Chip>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn small kind="secondary" icon="file" testId="print-preview" onClick={once(openPrintPreview)}>Print preview</Btn>
            <Btn small testId="save-return-top" onClick={once(() => { saveDraft(); setShowErrors(true); showToast('Draft saved.') })}>Save draft</Btn>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 20, marginBottom: 20, paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, borderWidth: 1, borderColor: t.border, borderRadius: 12, backgroundColor: t.bg }}>
          <Avatar name={taxpayer?.name || '?'} size={20} />
          <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 600 }}>{taxpayer?.name ?? ''}</text>
          <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE, fontWeight: 400 }}>{selectedProfile ? formatTin(selectedProfile.tin9, selectedProfile.branch) : ''}</text>
          {branch && <text style={{ color: t.fg2, fontSize: F_META }}>{branch.name}</text>}
          {periodText && <div style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: t.fg3 }} />}
          {periodText && <text style={{ color: t.fg2, fontSize: F_META }}>{`For ${periodText}`}</text>}
          <div testId="status-chip" onClick={once(() => { const next = stages[(stages.indexOf(status) + 1) % stages.length]; updateDraftStatus(next); showToast(`Marked ${next}.`) })} style={{ cursor: 'pointer' }}>
            <Chip tone={statusTone}>{status[0].toUpperCase() + status.slice(1)}</Chip>
          </div>
          <div style={{ flexGrow: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <text style={{ color: t.fg2, fontSize: F_META }}>Guided mode</text>
            <Switch on={guided} onToggle={(value) => { setGuided(value); if (value) showToast('Guided mode stops at marked fields once this form has a template.') }} />
          </div>
        </div>

        {formLoading && <text style={{ color: t.fg3, fontSize: F_BODY, paddingBottom: 8 }}>Opening official form…</text>}
        {!schema && !formLoading && <text style={{ color: t.fg3, fontSize: F_BODY }}>This form's screen layout isn't available yet. Use Print preview to see the official sheet.</text>}

        <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', alignItems: 'flex-start', gap: narrow ? 16 : 28 }}>
          {partNav}
          <div style={{ display: 'flex', flexDirection: 'column', width: partsWidth, gap: 16 }}>
            {schemaParts.map((part, index) => {
              const open = !collapsedPartSet.has(String(index))
              return (
                <div key={index} ref={(node: unknown) => { partRefs.current[index] = node as { scrollIntoView?: () => void } | null }} testId={`part-${index}`} style={{ display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: t.border, borderRadius: 12, backgroundColor: t.surface, overflow: 'hidden', flexShrink: 0 }}>
                  <div onClick={once(() => togglePart(String(index)))} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 48, paddingLeft: 12, paddingRight: 16, cursor: 'pointer' }}>
                    <Icon name={open ? 'chevDown' : 'chevRight'} size={16} color={t.fg3} />
                    <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 600, flexGrow: 1, minWidth: 0 }}>{part.name}</text>
                    <text style={{ color: t.fg3, fontSize: F_META }}>{`${part.items.length} item${part.items.length === 1 ? '' : 's'}`}</text>
                  </div>
                  {open && <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderColor: t.border }}>{part.items.map((item, itemIndex) => itemRow(item, itemIndex === 0))}</div>}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // -- Overlays (search palette, start-a-return) ------------------------------

  function scrim(content: ReactNode, testId: string) {
    const dark = t === themes.dark
    return (
      <div
        testId={testId}
        onMouseDown={() => setOverlay(null)}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: dark ? 'rgba(0,0,0,0.55)' : 'rgba(24,24,27,0.30)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 64, paddingLeft: 16, paddingRight: 16 }}
      >
        <div
          onMouseDownOutside={() => setOverlay(null)}
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: 560,
            maxWidth: '100%',
            borderRadius: 14,
            borderWidth: 1,
            borderColor: t.border,
            backgroundColor: t.surface,
            overflow: 'hidden',
            boxShadow: { offsetX: 0, offsetY: 18, blurRadius: 44, spreadRadius: 0, color: dark ? 'rgba(0,0,0,0.55)' : 'rgba(20,20,30,0.14)' },
          }}
        >
          {content}
        </div>
      </div>
    )
  }

  /** .opt — 36 tall, padding 6 10, gap 10, radius 8; hover/keyboard = hover fill, chosen = selected. */
  function optRow(opts: { key: string; testId?: string; lead: ReactNode; label: string; hint?: string; chosen?: boolean; on?: boolean; onClick: () => void; onHover?: () => void }) {
    return (
      <div
        key={opts.key}
        testId={opts.testId}
        onClick={once(opts.onClick)}
        onMouseEnter={opts.onHover}
        style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 36, paddingTop: 6, paddingBottom: 6, paddingLeft: 10, paddingRight: 10, borderRadius: 8, cursor: 'pointer', backgroundColor: opts.chosen ? t.selected : opts.on ? t.hover : CLEAR, hover: { backgroundColor: opts.chosen ? t.selected : t.hover } }}
      >
        {opts.lead}
        <text style={{ color: t.fg, fontSize: F_BODY, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{opts.label}</text>
        {opts.hint && <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE, fontWeight: 400 }}>{opts.hint}</text>}
      </div>
    )
  }

  function startReturnOverlay() {
    const profile = selectedProfile
    const forms = profile ? store.listLibrary(profile.id) : []
    const chosen = forms.find((entry) => entry.formCode === startFormCode) ?? forms[0]
    const frequency = catalogByCode.get(chosen?.formCode ?? '')?.frequency ?? 'annual'
    const periods = chosen && profile ? periodsForYear(profile.year, frequency) : []
    const defaultPeriod = chosen && profile ? dueByKey.get(`${profile.id}:${chosen.formCode}`)?.period ?? periods[0] ?? '' : ''
    const activePeriod = startPeriod && periods.includes(startPeriod) ? startPeriod : defaultPeriod
    return scrim(
      <>
        <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 16, paddingLeft: 20, paddingRight: 20, paddingBottom: 4 }}>
          <text style={{ color: t.fg, fontSize: F_TITLE, fontWeight: 600 }}>Start a return</text>
          <text style={{ color: t.fg2, fontSize: F_META, paddingTop: 2 }}>
            {taxpayer && branch ? `${taxpayer.name} · ${formatTin(taxpayer.tin9, branch.code)} ${branch.name}` : 'Choose a taxpayer first.'}
          </text>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 360, overflow: 'scroll', padding: 12 }}>
          {forms.length === 0 && <text style={{ color: t.fg3, fontSize: F_BODY, padding: 14 }}>No forms on this year's list yet. Add them under Forms or open one from the Form library.</text>}
          {forms.map((entry) => {
            const key = familyKey(entry.formCode)
            return optRow({
              key: entry.formCode,
              testId: `start-${entry.formCode}`,
              lead: <text style={{ color: t.fg, fontSize: F_META, ...NUM_STYLE, width: 60, minWidth: 60 }}>{key}</text>,
              label: formMeta[key]?.title ?? cleanFormTitle(catalogByCode.get(entry.formCode)?.label ?? ''),
              hint: formMeta[key]?.frequency ?? freqLabel(catalogByCode.get(entry.formCode)?.frequency ?? 'annual'),
              chosen: chosen?.formCode === entry.formCode,
              onClick: () => {
                setStartFormCode(entry.formCode)
                setStartPeriod('')
              },
            })
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', paddingTop: 12, paddingLeft: 20, paddingRight: 20, paddingBottom: 16, borderTopWidth: 1, borderColor: t.border }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Dropdown testId="start-period" width={170} value={activePeriod} options={periods.map((period) => ({ value: period, label: periodLabel(period) }))} onChange={setStartPeriod} placeholder="Period" />
            {chosen && <Chip>No template</Chip>}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn kind="ghost" onClick={once(() => setOverlay(null))}>Cancel</Btn>
            <Btn
              testId="start-open"
              disabled={!chosen || !activePeriod}
              onClick={once(() => {
                if (!chosen || !activePeriod) return
                setOverlay(null)
                setStartFormCode(null)
                setStartPeriod('')
                navOpenForm(chosen, activePeriod)
              })}
            >
              Open form
            </Btn>
          </div>
        </div>
      </>,
      'overlay-start-return',
    )
  }

  function searchOverlay() {
    const query = paletteQuery.trim().toLowerCase()
    type Item = { id: string; group: string; title: string; hint: string; lead: ReactNode; run: () => void }
    const items: Item[] = []
    const icon = (name: IconName) => <Icon name={name} size={16} color={t.fg2} />
    for (const item of tree) {
      const label = item.name || formatTin(item.tin9)
      if (query && !`${label} ${formatTin(item.tin9)}`.toLowerCase().includes(query)) continue
      items.push({ id: `tp-${item.tin9}`, group: 'Taxpayers', title: label, hint: formatTin(item.tin9), lead: <Avatar name={item.name || item.tin9} size={20} />, run: () => chooseTaxpayer(item.tin9) })
    }
    const gos: Array<[string, string, IconName, () => void]> = [
      ['home', 'Home', 'home', () => goto('home')],
      ['library', 'Form library', 'file', () => goto('library')],
      ['calendar', 'Calendar', 'calendar', () => goto('calendar')],
      ['filings', 'Filings', 'history', () => goto('filings')],
      ['profile', 'Tax profile', 'user', () => goto('taxpayer', { tab: 'profile' })],
      ['forms', 'Forms', 'file', () => goto('taxpayer', { tab: 'forms' })],
      ['templates', 'Templates', 'template', () => goto('taxpayer', { tab: 'templates' })],
      ['settings', 'Settings', 'settings', () => goto('settings')],
    ]
    for (const [id, label, name, run] of gos) {
      if (query && !label.toLowerCase().includes(query)) continue
      items.push({ id: `go-${id}`, group: 'Go to', title: label, hint: '', lead: icon(name), run })
    }
    if (query) {
      for (const { key, code, meta } of libraryCatalog) {
        const label = `${key} · ${meta.title}`
        if (!label.toLowerCase().includes(query)) continue
        items.push({ id: `form-${key}`, group: 'Forms', title: label, hint: '', lead: icon('file'), run: () => openFromLibrary(code) })
      }
    }
    const actions: Array<[string, string, IconName, string, () => void]> = [
      ['sidebar', 'Toggle sidebar', 'panelLeft', isMac ? '⌘B' : 'Ctrl B', () => setSidebarCollapsed((value) => !value)],
      ['theme', 'Change theme', 'moon', '', cycleTheme],
    ]
    for (const [id, label, name, hint, run] of actions) {
      if (query && !label.toLowerCase().includes(query)) continue
      items.push({ id: `act-${id}`, group: 'Actions', title: label, hint, lead: icon(name), run })
    }
    const clampedIdx = Math.max(0, Math.min(paletteIdx, items.length - 1))
    const groups = [...new Set(items.map((item) => item.group))]
    let itemIdx = -1
    return scrim(
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 48, minHeight: 48, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 1, borderColor: t.border }}>
          <Icon name="search" size={16} color={t.fg3} />
          <input
            testId="palette-input"
            value={paletteQuery}
            placeholder="Search taxpayers, forms and pages"
            autoFocus
            onChange={(event) => {
              setPaletteQuery(event.value ?? '')
              setPaletteIdx(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'down') setPaletteIdx((value) => Math.min(value + 1, items.length - 1))
              if (event.key === 'ArrowUp' || event.key === 'up') setPaletteIdx((value) => Math.max(value - 1, 0))
              if ((event.key === 'Enter' || event.key === 'enter') && items[clampedIdx]) {
                const run = items[clampedIdx].run
                setOverlay(null)
                run()
              }
            }}
            style={{ flexGrow: 1, minWidth: 0, height: 30, color: t.fg, fontSize: F_EMPH, backgroundColor: CLEAR, borderWidth: 0 }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'scroll', maxHeight: 420, padding: 12 }}>
          {items.length === 0 && <text style={{ color: t.fg3, fontSize: F_BODY, paddingTop: 40, paddingBottom: 40, textAlign: 'center' }}>No matches. Try a form code like 2550Q.</text>}
          {groups.map((group) => (
            <div key={group} style={{ display: 'flex', flexDirection: 'column' }}>
              <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 600, paddingTop: 10, paddingLeft: 10, paddingRight: 10, paddingBottom: 4 }}>{group.toUpperCase()}</text>
              {items.filter((item) => item.group === group).map((item) => {
                itemIdx += 1
                const idx = itemIdx
                return optRow({
                  key: item.id,
                  lead: item.lead,
                  label: item.title,
                  hint: item.hint,
                  on: idx === clampedIdx,
                  onHover: () => setPaletteIdx(idx),
                  onClick: () => {
                    setOverlay(null)
                    item.run()
                  },
                })
              })}
            </div>
          ))}
        </div>
      </>,
      'overlay-search',
    )
  }

  // -- Root ------------------------------------------------------------------

  const formSchemaNow = formEntry ? formSchemas[familyKey(formEntry.formCode)] : undefined
  const schemaParts = formSchemaNow
    ? buildSchemaModel(formSchemaNow, fieldSnapshot, issues, formEntry && isPrefillCode(formEntry.formCode) ? autoFieldIds(formEntry.formCode) : new Set())
    : []

  /** gpuix has no web view; the official frozen sheet opens in the default browser. */
  function openPrintPreview() {
    const dir = formEntry ? catalogByCode.get(formEntry.formCode)?.printable : null
    if (!dir) {
      showToast('No official print sheet is bundled for this form yet.')
      return
    }
    const file = join(dir, 'index.html')
    const [command, args] = isWin ? ['cmd', ['/c', 'start', '', file]] : isMac ? ['open', [file]] : ['xdg-open', [file]]
    try {
      spawn(command, args as string[], { detached: true, stdio: 'ignore' }).unref()
      showToast(`Opened the official ${displayFormCode(formEntry!.formCode)} sheet.`)
    } catch (error) {
      showToast(`Couldn't open the print sheet: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const sftpMode = describeSftpConfig(loadSftpConfig())

  function mainContent() {
    if (page === 'form') return formPage()
    if (page === 'home') return homePage()
    if (page === 'library') return libraryPage()
    if (page === 'calendar') return calendarPage()
    if (page === 'filings') return filingsPage()
    if (page === 'taxpayer') return taxpayerPage()
    if (page === 'jobs') return jobsPage()
    if (page === 'logs') return logsPage()
    return settingsPage()
  }

  if (process.env.EBIRFORMS_PERF) { perf.renders++; perf.ms += performance.now() - perfStart }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.bg, fontFamily: FONT, position: 'relative' }}>
      {titleBar()}
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        {sidebar()}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flexGrow: 1,
            minWidth: 0,
            minHeight: 0,
            backgroundColor: t.surface,
            borderRadius: 12,
            marginTop: 0,
            marginBottom: 8,
            marginLeft: sidebarCollapsed ? 8 : 0,
            marginRight: panel ? 0 : 8,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingTop: 28, paddingBottom: 56, paddingLeft: sidePad, paddingRight: sidePad, overflow: 'scroll' }}>
            {/* A definite width matters: an auto-width column made Taffy re-measure every text
                each frame (Profile 250ms frames → 30ms with a pixel width). */}
            <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, width: contentWidth }}>
              {mainContent()}
            </div>
          </div>
        </div>
        {rightPanel()}
      </div>
      {overlay?.kind === 'search' && searchOverlay()}
      {overlay?.kind === 'startReturn' && startReturnOverlay()}
      {toast && (
        <div
          key={toast.seq}
          style={{
            position: 'absolute',
            bottom: 18,
            left: 0,
            right: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ padding: 9, paddingLeft: 16, paddingRight: 16, borderRadius: 18, backgroundColor: t.primary }}>
            <text style={{ color: t.primaryFg, fontSize: F_META }}>{toast.text}</text>
          </div>
        </div>
      )}
    </div>
  )
}

render(
  <>
    <FontRegistration />
    <AutomationBridge />
    <App />
  </>,
  {
    title: WINDOW_TITLE,
    width: 1440,
    height: 940,
    titlebarTransparent: true,
    onKeyDown: (event) => rootKeyHandler?.(event as KeyEvent),
  },
)
