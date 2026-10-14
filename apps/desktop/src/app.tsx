import { useEffect, useRef, useState, type ReactNode } from 'react'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, useGpuixRequired } from '@gpuix/react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@gpuix/react'
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
  buildEditorModel,
  buildPrefillValues,
  cleanFormTitle,
  displayFormCode,
  mergeDraftPrefill,
  type PrefillFormCode,
} from './editor-model.js'
import { seedDemo } from './seed-demo.js'
import { resolveSystemTheme, resolveTheme, themes, type ResolvedTheme, type ThemeMode, type ThemeTokens } from './theme.js'
import { beginWindowDrag, closeWindow, dragWindowTo, toggleMaximizeWindow, type DragAnchor } from './win32.js'

const appDir = dataDir()
mkdirSync(appDir, { recursive: true })
const store = openStore(join(appDir, 'ebirforms.sqlite'))
const logger: Logger = store.logger
const queue = new JobQueue(store)
const catalog = loadCatalog()
const catalogByCode = new Map(catalog.map((entry) => [entry.code, entry]))
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

// ---------------------------------------------------------------------------
// Design constants (verbatim from the mockup's Components tab)

const FONT = 'Segoe UI Variable Text, Segoe UI, Bricolage Grotesque, sans-serif'
const NUM_STYLE = { fontVariantNumeric: 'tabular-nums', fontWeight: 600 } as const
const F_CAP = 11
const F_META = 12
const F_BODY = 13
const F_EMPH = 14
const F_TITLE = 16
const F_PAGE = 20

const WINDOW_TITLE = 'eBIRForms'
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

type Page = 'home' | 'calendar' | 'filings' | 'taxpayer' | 'settings' | 'jobs' | 'logs' | 'form'
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
  const stroke = color ?? t.fg2
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`
  return (
    <svg
      source={source}
      style={{ width: size, height: size, minWidth: size }}
    />
  )
}

// ---------------------------------------------------------------------------
// Primitives

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
  return (
    <div
      testId={testId}
      onClick={() => !disabled && onClick()}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 7,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        backgroundColor: active ? t.selected : 'rgba(0,0,0,0)',
        hover: disabled ? {} : { backgroundColor: danger ? '#e81123' : t.hover },
      }}
    >
      <Icon name={icon} size={iconSize} color={disabled ? t.fg3 : active ? t.fg : t.fg2} />
    </div>
  )
}

function Btn({ children, onClick, kind = 'primary', disabled = false, small = false, icon, testId }: {
  children: ReactNode
  onClick: () => void
  kind?: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
  small?: boolean
  icon?: IconName
  testId?: string
}) {
  const t = useTheme()
  const styles = {
    primary: { bg: t.primary, fg: t.primaryFg, border: t.primary },
    secondary: { bg: t.surface, fg: t.fg, border: t.borderStrong },
    ghost: { bg: 'rgba(0,0,0,0)', fg: t.fg2, border: 'rgba(0,0,0,0)' },
  }[kind]
  return (
    <div
      testId={testId}
      onClick={() => !disabled && onClick()}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: small ? 26 : 32,
        paddingLeft: small ? 10 : 14,
        paddingRight: small ? 10 : 14,
        borderRadius: 7,
        borderWidth: kind === 'secondary' ? 1 : 0,
        borderColor: styles.border,
        backgroundColor: styles.bg,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        hover: disabled ? {} : { opacity: 0.85 },
      }}
    >
      {icon && <Icon name={icon} size={small ? 12 : 14} color={styles.fg} />}
      <text style={{ color: styles.fg, fontSize: small ? F_META : F_BODY, fontWeight: 500 }}>
        {children}
      </text>
    </div>
  )
}

function Kbd({ children }: { children: string }) {
  const t = useTheme()
  return (
    <div
      style={{
        paddingLeft: 6,
        paddingRight: 6,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        borderWidth: 1,
        borderColor: t.border,
        backgroundColor: t.surface,
      }}
    >
      <text style={{ color: t.fg3, fontSize: 10, ...NUM_STYLE }}>{children}</text>
    </div>
  )
}

function Switch({ on, onToggle, testId }: { on: boolean; onToggle: (value: boolean) => void; testId?: string }) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      onClick={() => onToggle(!on)}
      style={{
        width: 32,
        height: 18,
        borderRadius: 9,
        backgroundColor: on ? t.accent : t.borderStrong,
        display: 'flex',
        alignItems: 'center',
        paddingLeft: on ? 16 : 2,
        cursor: 'pointer',
      }}
    >
      <div style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: '#ffffff' }} />
    </div>
  )
}

function Seg<T extends string>({ options, value, onChange, testId }: {
  options: Array<{ value: T; label: string; icon?: IconName }>
  value: T
  onChange: (value: T) => void
  testId?: string
}) {
  const t = useTheme()
  return (
    <div
      testId={testId}
      style={{
        display: 'flex',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        backgroundColor: t.hover,
        alignSelf: 'flex-start',
      }}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <div
            key={option.value}
            testId={`${testId}-${option.value}`}
            onClick={() => onChange(option.value)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              height: 24,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 6,
              cursor: 'pointer',
              backgroundColor: active ? t.raised : 'rgba(0,0,0,0)',
              hover: { backgroundColor: active ? t.raised : t.selected },
            }}
          >
            {option.icon && <Icon name={option.icon} size={14} color={active ? t.fg : t.fg2} />}
            <text style={{ color: active ? t.fg : t.fg2, fontSize: F_META, fontWeight: active ? 600 : 400 }}>
              {option.label}
            </text>
          </div>
        )
      })}
    </div>
  )
}

function Chip({ children, tone = 'plain', icon }: { children: ReactNode; tone?: 'plain' | 'accent' | 'success' | 'warning' | 'danger' | 'muted'; icon?: IconName }) {
  const t = useTheme()
  const tones = {
    plain: { bg: t.hover, fg: t.fg2 },
    muted: { bg: t.hover, fg: t.fg3 },
    accent: { bg: t.accentSoft, fg: t.accent },
    success: { bg: t.successSoft, fg: t.success },
    warning: { bg: t.warningSoft, fg: t.warning },
    danger: { bg: t.dangerSoft, fg: t.danger },
  }[tone]
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 20,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 10,
        backgroundColor: tones.bg,
      }}
    >
      {icon && <Icon name={icon} size={12} color={tones.fg} />}
      <text style={{ color: tones.fg, fontSize: F_CAP, fontWeight: 500 }}>{children}</text>
    </div>
  )
}

function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const t = useTheme()
  return (
    <div
      style={{
        width: size,
        height: size,
        minWidth: size,
        borderRadius: size / 2,
        backgroundColor: t.selected,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <text style={{ color: t.fg, fontSize: size * 0.36, fontWeight: 600 }}>{initials(name)}</text>
    </div>
  )
}

function Check({ on, disabled = false }: { on: boolean; disabled?: boolean }) {
  const t = useTheme()
  return (
    <div
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: on ? t.primary : t.borderStrong,
        backgroundColor: on ? t.primary : t.surface,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {on && <Icon name="check" size={11} color={t.primaryFg} strokeWidth={3} />}
    </div>
  )
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
      {label && (
        <text style={{ color: t.fg3, fontSize: F_CAP }}>{label}</text>
      )}
      <input
        testId={testId}
        value={value}
        placeholder={placeholder}
        readOnly={disabled}
        onChange={(event) => onChange?.(event.value ?? '')}
        style={{
          height: 32,
          minHeight: 32,
          padding: 7,
          paddingLeft: 9,
          paddingRight: 9,
          color: disabled ? t.fg3 : t.fg,
          backgroundColor: disabled ? t.hover : t.surface,
          borderWidth: 1,
          borderColor: t.borderStrong,
          borderRadius: 7,
          ...(mono ? NUM_STYLE : {}),
          fontSize: F_BODY,
        }}
      />
      {hint ? <text style={{ color: t.fg3, fontSize: F_CAP }}>{hint}</text> : null}
    </div>
  )
}

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
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: 10,
        backgroundColor: t.surface,
      }}
    >
      {title !== undefined && (
        <div
          onClick={disclosure ? onToggle : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: 14,
            paddingLeft: 16,
            paddingRight: 16,
            cursor: disclosure ? 'pointer' : 'default',
            borderBottomWidth: disclosure ? (open ? 1 : 0) : 1,
            borderColor: t.border,
          }}
        >
          {disclosure && (
            <Icon name={open ? 'chevDown' : 'chevRight'} size={14} color={t.fg3} />
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexGrow: 1, minWidth: 0 }}>
            <text style={{ color: t.fg, fontSize: F_EMPH, fontWeight: 600 }}>{title}</text>
            {subtitle && <text style={{ color: t.fg3, fontSize: F_META }}>{subtitle}</text>}
          </div>
          {aside}
        </div>
      )}
      {(!disclosure || open) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
          {children}
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children, first = false }: { children: ReactNode; first?: boolean }) {
  const t = useTheme()
  return (
    <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 600, paddingTop: first ? 2 : 12, paddingBottom: 4 }}>
      {children}
    </text>
  )
}

// ---------------------------------------------------------------------------

const SUPPORTED_FORM_CODES = ['1601Cv2018', '2551Qv2018', '0619E'] as const

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

function App() {
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
  const [yearInput, setYearInput] = useState(String(new Date().getFullYear()))
  const [showNewYear, setShowNewYear] = useState(false)
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
  const selectedLibrary = selectedProfile ? store.listLibrary(selectedProfile.id) : []

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
  const dueRows = projectDue(dueInputs)
  const dueByKey = new Map(dueRows.map((row) => [`${row.profileId}:${row.formCode}`, row]))
  const filedDrafts = store.listFiledDrafts()
  const recentDrafts = store.listRecentDrafts(4)

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
    if (next.page === 'form' && next.formCode && !(SUPPORTED_FORM_CODES as readonly string[]).includes(next.formCode)) {
      showToast(`${displayFormCode(next.formCode)} isn't editable yet — the editor covers 1601-C, 2551Q and 0619-E for now.`)
      next = { ...next, page: 'taxpayer', tab: 'forms', formCode: undefined, period: undefined }
    }
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
    store.updateTaxpayer(taxpayer.tin9, {
      name: taxpayerEdit.name,
      type: taxpayerEdit.type,
      birthDate: taxpayerEdit.birthDate || null,
    })
    refreshTree(taxpayer.tin9)
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

  function addYear() {
    if (!taxpayer || !branch || !/^\d{4}$/.test(yearInput)) return
    try {
      const profile = store.createProfile({
        tin: taxpayer.tin9,
        branch: branch.code,
        year: Number(yearInput),
        registeredName: selectedProfile?.registeredName ?? taxpayer.name,
        rdo: selectedProfile?.rdo ?? branch.overrides.rdo ?? '',
        address: selectedProfile?.address ?? branch.overrides.address ?? '',
        zip: selectedProfile?.zip ?? branch.overrides.zip ?? '',
        email: selectedProfile?.email ?? branch.overrides.email ?? '',
        phone: selectedProfile?.phone ?? branch.overrides.phone ?? '',
      })
      refreshTree(taxpayer.tin9, branchId(taxpayer.tin9, branch.code), profile.id)
      setShowNewYear(false)
      showToast(`${profile.year} added.`)
      navTo({ ...navNow, page: 'taxpayer', tab: 'forms', tin: taxpayer.tin9, branchId: branchId(taxpayer.tin9, branch.code), profileId: profile.id, formCode: undefined, period: undefined })
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    }
  }

  // -- Form editor (unchanged semantics) ------------------------------------

  async function openForm(entry: LibraryEntry, period: string, profile: Profile | undefined = selectedProfile) {
    if (!profile || !(SUPPORTED_FORM_CODES as readonly string[]).includes(entry.formCode)) return
    const code = entry.formCode as PrefillFormCode
    const ticket = ++formLoadSeq.current
    const previous = store.listDrafts(profile.id, code).find((item) => item.period === period)
    const opened = store.openDraft(profile.id, code, period)
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
    let form: FormInstance | undefined
    try {
      form = await openOfficialForm(code)
      if (ticket !== formLoadSeq.current) {
        await form.close()
        return
      }
      const prefillValues = buildPrefillValues(code, profile, form.fields(), period)
      const initialValues = mergeDraftPrefill(opened.values, prefillValues)
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
    if (!formInstance || !formEntry || autoFieldIds(formEntry.formCode as PrefillFormCode).has(field.id) || field.disabled) return
    formInstance.set(field.id, value)
    refreshEditor(formInstance)
  }

  function saveDraft() {
    if (!formInstance || !draft) return
    setDraft(store.saveDraft(draft.id, valuesFromForm(formInstance)))
    if (askTemplate) showToast('Saved. (Template update prompt arrives with guided mode.)')
  }

  function updateDraftStatus(status: DraftStatus) {
    if (!draft) return
    setDraft(store.setDraftStatus(draft.id, status))
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
    navTo({
      ...navNow,
      page: 'form',
      tin: owner.taxpayer.tin9,
      branchId: branchId(owner.taxpayer.tin9, owner.branchCode),
      profileId: row.profileId,
      formCode: row.formCode,
      period: row.period,
    })
  }

  /** Copy a filed draft's values into a new draft for the next period. */
  function useAsTemplate(item: Draft) {
    const owner = profileById(item.profileId)
    if (!owner) return
    const next = nextPeriod(item.period)
    const nextYear = Number(next.slice(0, 4))
    let profile = owner.profile
    if (nextYear !== owner.profile.year) {
      const target = tree
        .find((entry) => entry.tin9 === owner.taxpayer.tin9)
        ?.branches.find((entry) => entry.code === owner.branchCode)
        ?.years.find((entry) => entry.year === nextYear)
      if (!target) {
        showToast(`Add a ${nextYear} profile for ${owner.taxpayer.name} first.`)
        return
      }
      profile = target
    }
    const copied = store.openDraft(profile.id, item.formCode, next)
    store.saveDraft(copied.id, { ...item.values })
    showToast(`${displayFormCode(item.formCode)} · ${periodLabel(next)} prefilled from ${periodLabel(item.period)}.`)
    navTo({
      ...navNow,
      page: 'form',
      tin: owner.taxpayer.tin9,
      branchId: branchId(owner.taxpayer.tin9, owner.branchCode),
      profileId: profile.id,
      formCode: item.formCode,
      period: next,
    })
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
    const pillLabel = taxpayer ? (taxpayer.name || formatTin(taxpayer.tin9)) : 'eBIRForms'
    const pillTin = taxpayer ? formatTin(taxpayer.tin9, branch?.code ?? '00000') : ''
    return (
      <div
        testId="titlebar-pill"
        onClick={() => setPanel(panel === 'taxpayer' ? null : 'taxpayer')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          height: 28,
          paddingLeft: 4,
          paddingRight: 9,
          borderRadius: 14,
          borderWidth: 1,
          borderColor: panel === 'taxpayer' ? t.borderStrong : t.border,
          backgroundColor: panel === 'taxpayer' ? t.selected : t.surface,
          cursor: 'pointer',
          hover: { backgroundColor: panel === 'taxpayer' ? t.selected : t.hover },
        }}
      >
        <Avatar name={pillLabel} size={20} />
        <text style={{ color: t.fg, fontSize: F_META, fontWeight: 600 }}>{pillLabel}</text>
        {pillTin !== '' && (
          <text style={{ color: t.fg3, fontSize: F_CAP, ...NUM_STYLE }}>{pillTin}</text>
        )}
        <Icon name="chevDown" size={14} color={t.fg3} />
      </div>
    )
  }

  function captionButton(label: string, onClick: () => void, danger = false, testId?: string) {
    return (
      <div
        testId={testId}
        onClick={onClick}
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
          paddingLeft: isMac ? 72 : 6,
          paddingRight: isWin ? 0 : 6,
          backgroundColor: t.bg,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexGrow: 1, minWidth: 0 }}>
          <IBtn
            testId="tb-sidebar"
            icon="panelLeft"
            active={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((value) => !value)}
          />
          <IBtn testId="tb-back" icon="arrowLeft" disabled={!canNavBack} onClick={() => navJump(-1)} />
          <IBtn testId="tb-fwd" icon="arrowRight" disabled={!canNavFwd} onClick={() => navJump(1)} />
          {sidebarCollapsed && (
            <>
              <IBtn testId="tb-search" icon="search" onClick={() => setOverlay({ kind: 'search' })} />
              <IBtn testId="tb-plus" icon="plus" onClick={() => setOverlay({ kind: 'startReturn' })} />
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexGrow: 1, justifyContent: 'flex-end' }}>
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
              onClick={() => setPanel(panel === 'notifications' ? null : 'notifications')}
            />
            {unreadCount > 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: 5,
                  right: 6,
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: t.accent,
                  borderWidth: 1,
                  borderColor: t.bg,
                }}
              />
            )}
          </div>
          <IBtn testId="tb-theme" icon={themeIcon()} onClick={cycleTheme} />
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

  function navRow(icon: IconName, label: string, active: boolean, onClick: () => void, testId?: string) {
    return (
      <div
        testId={testId}
        onClick={onClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          height: 32,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 7,
          cursor: 'pointer',
          backgroundColor: active ? t.selected : 'rgba(0,0,0,0)',
          hover: { backgroundColor: active ? t.selected : t.hover },
        }}
      >
        <Icon name={icon} size={16} color={active ? t.fg : t.fg2} />
        <text style={{ color: active ? t.fg : t.fg2, fontSize: F_BODY, fontWeight: active ? 600 : 400 }}>
          {label}
        </text>
      </div>
    )
  }

  function sidebar() {
    if (sidebarCollapsed) return null
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 248,
          minWidth: 248,
          padding: 8,
          paddingTop: 4,
          gap: 4,
          backgroundColor: t.bg,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            testId="sidebar-search"
            onClick={() => setOverlay({ kind: 'search' })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexGrow: 1,
              height: 32,
              paddingLeft: 9,
              paddingRight: 6,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: t.borderStrong,
              backgroundColor: t.surface,
              cursor: 'pointer',
              hover: { borderColor: t.fg3 },
            }}
          >
            <Icon name="search" size={14} color={t.fg3} />
            <text style={{ color: t.fg3, fontSize: F_BODY, flexGrow: 1 }}>Search</text>
            <Kbd>Ctrl K</Kbd>
          </div>
          <IBtn testId="sidebar-new" icon="plus" size={32} iconSize={16} onClick={() => setOverlay({ kind: 'startReturn' })} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 4 }}>
          {navRow('home', 'Home', page === 'home', () => goto('home'), 'nav-home')}
          {navRow('calendar', 'Calendar', page === 'calendar', () => goto('calendar'), 'nav-calendar')}
          {navRow('file', 'Filings', page === 'filings', () => goto('filings'), 'nav-filings')}
        </div>
        {showRecent && recentDrafts.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 8 }}>
            <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 600, paddingLeft: 8, paddingBottom: 4 }}>
              Recent
            </text>
            {recentDrafts.map((item) => {
              const owner = profileById(item.profileId)
              return (
                <div
                  key={item.id}
                  testId={`recent-${item.id}`}
                  onClick={() => openDraftById(item)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    height: 32,
                    paddingLeft: 8,
                    paddingRight: 8,
                    borderRadius: 7,
                    cursor: 'pointer',
                    hover: { backgroundColor: t.hover },
                  }}
                >
                  <Icon name="file" size={14} color={t.fg3} />
                  <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE, minWidth: 56 }}>
                    {displayFormCode(item.formCode)}
                  </text>
                  <text
                    style={{
                      color: t.fg2,
                      fontSize: F_META,
                      flexGrow: 1,
                      minWidth: 0,
                      whiteSpace: 'nowrap',
                      textOverflow: 'ellipsis',
                      overflow: 'hidden',
                    }}
                  >
                    {`${periodLabel(item.period)} · ${owner?.taxpayer.name ?? ''}`}
                  </text>
                </div>
              )
            })}
          </div>
        )}
        <div style={{ flexGrow: 1 }} />
        {navRow('settings', 'Settings', page === 'settings', () => goto('settings'), 'nav-settings')}
        <div style={{ position: 'relative' }}>
          <div
            testId="user-card"
            onClick={() => setMenuOpen((value) => !value)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: 8,
              borderRadius: 8,
              cursor: 'pointer',
              hover: { backgroundColor: t.hover },
            }}
          >
            <Avatar name={displayName || 'Devin'} size={28} />
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <text style={{ color: t.fg, fontSize: F_META, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {displayName || 'Set your name'}
              </text>
              <text style={{ color: t.fg3, fontSize: F_CAP, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {email || 'No email set'}
              </text>
            </div>
            <Icon name="chevDown" size={14} color={t.fg3} />
          </div>
          {menuOpen && (
            <div
              onMouseDownOutside={() => setMenuOpen(false)}
              style={{
                position: 'absolute',
                bottom: 46,
                left: 0,
                right: 0,
                display: 'flex',
                flexDirection: 'column',
                padding: 4,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: t.border,
                backgroundColor: t.raised,
              }}
            >
              <div style={{ padding: 8, paddingLeft: 10 }}>
                <text style={{ color: t.fg3, fontSize: F_CAP }}>Signed in as {email || 'no email set'}</text>
              </div>
              <div
                testId="menu-account"
                onClick={() => {
                  setMenuOpen(false)
                  goto('settings')
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}
              >
                <Icon name="settings" size={14} color={t.fg2} />
                <text style={{ color: t.fg, fontSize: F_META }}>Account settings</text>
              </div>
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
      return (
        <div style={{ display: 'flex', flexDirection: 'column', width: 320, minWidth: 320, backgroundColor: t.bg }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 12, paddingLeft: 16, paddingRight: 12 }}>
            <text style={{ color: t.fg, fontSize: F_EMPH, fontWeight: 600 }}>Notifications</text>
            <div
              testId="mark-all-read"
              onClick={() => {
                const now = String(Date.now())
                store.setSetting('lastReadNotifs', now)
                setLastRead(Number(now))
              }}
              style={{ cursor: 'pointer', padding: 4 }}
            >
              <text style={{ color: t.accent, fontSize: F_META }}>Mark all read</text>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minHeight: 0, overflow: 'scroll', paddingLeft: 8, paddingRight: 8, paddingBottom: 12 }}>
            {notifications.length === 0 && (
              <text style={{ color: t.fg3, fontSize: F_META, padding: 12 }}>Nothing to review.</text>
            )}
            {notifications.map((item) => {
              const icon: IconName =
                item.kind === 'warning' || item.kind === 'danger'
                  ? 'alert'
                  : item.kind === 'success'
                    ? 'checkCircle'
                    : item.kind === 'plain'
                      ? 'box'
                      : 'info'
              const iconColor =
                item.kind === 'warning'
                  ? t.warning
                  : item.kind === 'danger'
                    ? t.danger
                    : item.kind === 'success'
                      ? t.success
                      : t.fg3
              const unread = item.ts > lastRead
              return (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    gap: 9,
                    padding: 9,
                    borderRadius: 8,
                    hover: { backgroundColor: t.hover },
                  }}
                >
                  <Icon name={icon} size={15} color={iconColor} />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
                    <text style={{ color: t.fg, fontSize: F_META }}>{item.title}</text>
                    <text style={{ color: t.fg3, fontSize: F_CAP, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{item.subtitle}</text>
                    <text style={{ color: t.fg3, fontSize: 10 }}>{fmtDateTime(item.ts)}</text>
                  </div>
                  {unread && (
                    <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.accent, marginTop: 4 }} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )
    }
    // panel === 'taxpayer'
    const formsCount = selectedLibrary.length
    const branches = taxpayer?.branches ?? []
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: 320, minWidth: 320, backgroundColor: t.bg, overflow: 'scroll' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <Avatar name={taxpayer ? taxpayer.name : '?'} size={56} />
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <text style={{ color: t.fg, fontSize: F_EMPH, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                {taxpayer?.name || 'No taxpayer'}
              </text>
              {taxpayer && (
                <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE }}>{formatTin(taxpayer.tin9)}</text>
              )}
            </div>
            {taxpayer && (
              <IBtn
                testId="panel-edit"
                icon="pencil"
                size={26}
                iconSize={13}
                onClick={() => {
                  setPanel(null)
                  goto('taxpayer', { tab: 'profile' })
                }}
              />
            )}
          </div>
          {branch && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="branch" size={14} color={t.fg3} />
                <text style={{ color: t.fg2, fontSize: F_META }}>{`${branch.code} · ${branch.name}`}</text>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="pin" size={14} color={t.fg3} />
                <text style={{ color: t.fg2, fontSize: F_META }}>{branch.facts.address || 'No address'}</text>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="building" size={14} color={t.fg3} />
                <text style={{ color: t.fg2, fontSize: F_META }}>{branch.facts.rdo ? `RDO ${branch.facts.rdo}` : 'No RDO'}</text>
              </div>
            </div>
          )}
          {taxpayer && (
            <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderColor: t.border, paddingTop: 10 }}>
              <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 600, paddingBottom: 4 }}>Open</text>
              {([['profile', 'Profile'], ['forms', `Forms${formsCount ? ` · ${formsCount}` : ''}`], ['templates', 'Templates']] as const).map(([tpTab, label]) => (
                <div
                  key={tpTab}
                  testId={`panel-open-${tpTab}`}
                  onClick={() => {
                    setPanel(null)
                    goto('taxpayer', { tab: tpTab })
                  }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 30, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}
                >
                  <text style={{ color: t.fg, fontSize: F_META }}>{label}</text>
                  <Icon name="chevRight" size={14} color={t.fg3} />
                </div>
              ))}
            </div>
          )}
          {branches.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderColor: t.border, paddingTop: 10 }}>
              <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 600, paddingBottom: 4 }}>Branches</text>
              {branches.map((itemBranch) => {
                const active = selectedBranchId === branchId(taxpayer!.tin9, itemBranch.code)
                return (
                  <div
                    key={itemBranch.code}
                    testId={`panel-branch-${itemBranch.code}`}
                    onClick={() => {
                      setPanel(null)
                      chooseBranch(taxpayer!.tin9, itemBranch.code)
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', backgroundColor: active ? t.selected : 'rgba(0,0,0,0)', hover: { backgroundColor: active ? t.selected : t.hover } }}
                  >
                    <text style={{ color: t.fg, fontSize: F_META, flexGrow: 1 }}>{itemBranch.name}</text>
                    <text style={{ color: t.fg3, fontSize: F_CAP, ...NUM_STYLE }}>{itemBranch.code}</text>
                    {active && <Icon name="check" size={14} color={t.accent} />}
                  </div>
                )
              })}
              <div
                testId="panel-add-branch"
                onClick={() => {
                  setPanel(null)
                  setShowNewBranch(true)
                  goto('taxpayer', { tab: 'profile' })
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, paddingLeft: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}
              >
                <Icon name="plus" size={14} color={t.fg3} />
                <text style={{ color: t.fg3, fontSize: F_META }}>Add branch</text>
              </div>
            </div>
          )}
          {tree.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', borderTopWidth: 1, borderColor: t.border, paddingTop: 10 }}>
              <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 600, paddingBottom: 4 }}>Switch taxpayer</text>
              {tree.filter((item) => item.tin9 !== selectedTin).map((item) => (
                <div
                  key={item.tin9}
                  testId={`panel-switch-${item.tin9}`}
                  onClick={() => chooseTaxpayer(item.tin9)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, height: 32, paddingLeft: 4, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: t.hover } }}
                >
                  <Avatar name={item.name || item.tin9} size={20} />
                  <text style={{ color: t.fg, fontSize: F_META, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{item.name || formatTin(item.tin9)}</text>
                  <text style={{ color: t.fg3, fontSize: F_CAP, ...NUM_STYLE }}>{formatTin(item.tin9).slice(0, 11)}</text>
                </div>
              ))}
            </div>
          )}
          <div
            testId="panel-new-taxpayer"
            onClick={() => {
              setPanel(null)
              setShowNewTaxpayer(true)
              goto('taxpayer', { tab: 'profile' })
            }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, paddingLeft: 8, borderTopWidth: 1, borderColor: t.border, paddingTop: 10, cursor: 'pointer' }}
          >
            <Icon name="plus" size={14} color={t.fg3} />
            <text style={{ color: t.fg3, fontSize: F_META }}>New taxpayer</text>
          </div>
        </div>
      </div>
    )
  }

  // -- Due/filed row renderer (shared by Home, Calendar, Filings) ------------

  function dateBox(iso: string) {
    const date = new Date(`${iso}T00:00:00`)
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          minWidth: 44,
          height: 44,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <text style={{ color: t.fg3, fontSize: 9, fontWeight: 600 }}>{MONTH_ABBR[date.getMonth()]}</text>
        <text style={{ color: t.fg, fontSize: 15, fontWeight: 700 }}>{date.getDate()}</text>
      </div>
    )
  }

  function statusPill(kind: 'draft' | 'notStarted' | 'filed' | 'overdue' | 'days' | string, label: string) {
    const tone =
      kind === 'draft'
        ? 'accent'
        : kind === 'filed'
          ? 'success'
          : kind === 'overdue'
            ? 'danger'
            : kind === 'days'
              ? 'warning'
              : 'muted'
    return <Chip tone={tone as 'accent'}>{label}</Chip>
  }

  function dueRow(row: (typeof dueRows)[number], key: string) {
    const owner = profileById(row.profileId)
    const days = daysUntil(row.dueDate)
    const entry = catalogByCode.get(row.formCode)
    return (
      <div
        key={key}
        testId={`due-${row.formCode}-${row.period}`}
        onClick={() => openDueRow(row)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 60,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 9,
          cursor: 'pointer',
          hover: { backgroundColor: t.hover },
        }}
      >
        {dateBox(row.dueDate)}
        <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE, width: 68, minWidth: 68 }}>
          {displayFormCode(row.formCode)}
        </text>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexGrow: 1, minWidth: 0 }}>
          <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
            {`${displayFormCode(row.formCode)} · ${periodLabel(row.period)}`}
          </text>
          <text style={{ color: t.fg3, fontSize: F_META, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
            {`${cleanFormTitle(entry?.label ?? '')} — ${owner?.taxpayer.name ?? row.tin9} · ${owner?.branchName ?? row.branchCode}`}
          </text>
        </div>
        <text style={{ color: days < 0 ? t.danger : days <= 14 ? t.warning : t.fg3, fontSize: F_META, width: 88, minWidth: 88, textAlign: 'right' }}>
          {days < 0 ? `${-days}d overdue` : days === 0 ? 'Due today' : `In ${days} day${days === 1 ? '' : 's'}`}
        </text>
        <div style={{ width: 96, minWidth: 96, display: 'flex', justifyContent: 'flex-end' }}>
          {row.draftStatus === 'draft' ? statusPill('draft', 'Draft') : statusPill('notStarted', 'Not started')}
        </div>
      </div>
    )
  }

  function filedRow(item: Draft, key: string) {
    const owner = profileById(item.profileId)
    const inLibrary = owner
      ? store.listLibrary(item.profileId).some((entry) => entry.formCode === item.formCode)
      : false
    const entry = catalogByCode.get(item.formCode)
    return (
      <div
        key={key}
        testId={`filed-${item.id}`}
        onClick={() => openDraftById(item)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          height: 52,
          paddingLeft: 8,
          paddingRight: 8,
          borderRadius: 9,
          cursor: 'pointer',
          hover: { backgroundColor: t.hover },
        }}
      >
        <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE, width: 68, minWidth: 68 }}>
          {displayFormCode(item.formCode)}
        </text>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexGrow: 1, minWidth: 0 }}>
          <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
            {`${displayFormCode(item.formCode)} · ${periodLabel(item.period)}`}
          </text>
          <text style={{ color: t.fg3, fontSize: F_META, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
            {`${cleanFormTitle(entry?.label ?? '')} — ${owner?.taxpayer.name ?? ''} · ${owner?.branchName ?? ''}`}
          </text>
        </div>
        <text style={{ color: t.fg3, fontSize: F_META, width: 88, minWidth: 88, textAlign: 'right' }}>
          {fmtDate(item.updatedAt)}
        </text>
        <div style={{ width: 110, minWidth: 110, display: 'flex', justifyContent: 'flex-end' }}>
          {inLibrary ? (
            <Btn small kind="secondary" onClick={() => useAsTemplate(item)}>Use as template</Btn>
          ) : (
            statusPill('filed', '✓ Filed')
          )}
        </div>
      </div>
    )
  }

  // -- Views -----------------------------------------------------------------

  function homePage() {
    const hour = new Date().getHours()
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
    const first = (displayName || 'there').split(' ')[0]
    const next30 = dueRows.filter((row) => daysUntil(row.dueDate) <= 30)
    const taxpayerCount = new Set(next30.map((row) => row.tin9)).size
    const today = new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 700 }}>{`${greeting}, ${first}`}</text>
        <text style={{ color: t.fg3, fontSize: F_BODY, paddingBottom: 18 }}>
          {`${next30.length} return${next30.length === 1 ? '' : 's'} are due in the next 30 days across ${taxpayerCount} taxpayer${taxpayerCount === 1 ? '' : 's'}. ${today}.`}
        </text>
        <SectionLabel first>Due in the next 30 days</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {next30.length === 0 && (
            <text style={{ color: t.fg3, fontSize: F_META, padding: 14 }}>Nothing due in the next 30 days.</text>
          )}
          {next30.map((row) => dueRow(row, `${row.profileId}-${row.formCode}-${row.period}`))}
        </div>
        <SectionLabel>Recently filed</SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {filedDrafts.length === 0 && (
            <text style={{ color: t.fg3, fontSize: F_META, padding: 14 }}>No filed returns yet.</text>
          )}
          {filedDrafts.slice(0, 8).map((item) => filedRow(item, item.id))}
        </div>
      </div>
    )
  }

  function calendarPage() {
    const years = [...new Set(allProfiles(tree).map((profile) => profile.year))].sort()
    const yearLabel = years.length ? String(Math.max(...years)) : String(new Date().getFullYear())
    const byMonth = new Map<string, typeof dueRows>()
    for (const row of dueRows) {
      const month = row.dueDate.slice(0, 7)
      const list = byMonth.get(month) ?? []
      list.push(row)
      byMonth.set(month, list)
    }
    const months = [...byMonth.keys()].sort()
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 700 }}>Calendar</text>
        <text style={{ color: t.fg3, fontSize: F_BODY, paddingBottom: 18 }}>
          {`Every deadline for the forms your taxpayers file, from the ${yearLabel} BIR tax calendar.`}
        </text>
        {months.length === 0 && (
          <text style={{ color: t.fg3, fontSize: F_META, padding: 14 }}>No pending deadlines.</text>
        )}
        {months.map((month) => {
          const [year, mm] = month.split('-')
          const label = `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(mm) - 1]} ${year}`
          return (
            <div key={month} style={{ display: 'flex', flexDirection: 'column' }}>
              <SectionLabel first={month === months[0]}>{label}</SectionLabel>
              {byMonth.get(month)!.map((row) => dueRow(row, `${month}-${row.profileId}-${row.formCode}-${row.period}`))}
            </div>
          )
        })}
      </div>
    )
  }

  function filingsPage() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 700 }}>Filings</text>
        <text style={{ color: t.fg3, fontSize: F_BODY, paddingBottom: 18 }}>
          Filed returns stay exactly as submitted. Use one as a template to prefill the next period.
        </text>
        {filedDrafts.length === 0 && (
          <text style={{ color: t.fg3, fontSize: F_META, padding: 14 }}>No filed returns yet.</text>
        )}
        {filedDrafts.map((item) => filedRow(item, item.id))}
      </div>
    )
  }

  // -- Taxpayer page ---------------------------------------------------------

  function disclosure(id: string, title: string, subtitle: string, aside: ReactNode, body: ReactNode, first = false) {
    const open = openSecs.has(id)
    const toggle = () =>
      setOpenSecs((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    return (
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 44,
            paddingLeft: 12,
            paddingRight: 16,
            borderTopWidth: first ? 0 : 1,
            borderColor: t.border,
          }}
        >
          <div
            onClick={toggle}
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexGrow: 1, minWidth: 0, height: 44, cursor: 'pointer' }}
          >
            <Icon name={open ? 'chevDown' : 'chevRight'} size={16} color={t.fg3} />
            <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
              <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 600 }}>{title}</text>
              <text style={{ color: t.fg3, fontSize: F_META }}>{subtitle}</text>
            </div>
          </div>
          {open && aside}
        </div>
        {open && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4, paddingRight: 20, paddingBottom: 20, paddingLeft: 36 }}>{body}</div>
        )}
      </div>
    )
  }

  function factRow(label: string, value: string, opts: { mono?: boolean; copy?: string; hint?: string } = {}) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 26 }}>
        <text style={{ color: t.fg2, fontSize: F_META, width: 130, minWidth: 130 }}>{label}</text>
        <text style={{ color: opts.hint ? t.fg2 : t.fg, fontSize: F_BODY, flexGrow: 1, minWidth: 0, ...(opts.mono ? NUM_STYLE : {}) }}>
          {value || '—'}
        </text>
        {opts.hint && <Chip tone="muted">{opts.hint}</Chip>}
        {opts.copy && (
          <IBtn
            icon="copy"
            size={24}
            iconSize={12}
            onClick={() => showToast('TIN copied.')}
          />
        )}
      </div>
    )
  }

  function editRow(label: string, value: string, onChange: (value: string) => void, opts: { mono?: boolean; disabled?: boolean } = {}) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30 }}>
        <text style={{ color: t.fg2, fontSize: F_META, width: 130, minWidth: 130 }}>{label}</text>
        <input
          value={value}
          readOnly={opts.disabled}
          onChange={(event) => onChange(event.value ?? '')}
          style={{
            height: 30,
            padding: 6,
            paddingLeft: 8,
            flexGrow: 1,
            minWidth: 0,
            color: opts.disabled ? t.fg3 : t.fg,
            backgroundColor: opts.disabled ? t.hover : t.surface,
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: 6,
            fontSize: F_BODY,
            ...(opts.mono ? NUM_STYLE : {}),
          }}
        />
      </div>
    )
  }

  function editActions(onSave: () => void, section: string) {
    if (editSec !== section) return null
    return (
      <div style={{ display: 'flex', gap: 8, paddingTop: 4, justifyContent: 'flex-end' }}>
        <Btn small kind="ghost" onClick={() => setEditSec(null)}>Cancel</Btn>
        <Btn small onClick={onSave}>Save changes</Btn>
      </div>
    )
  }

  function inheritEditRow(label: string, key: 'rdo' | 'zip' | 'address' | 'phone' | 'email', resolvedValue: string) {
    const inheriting = branchInherit[key] !== false
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30 }}>
          <text style={{ color: t.fg2, fontSize: F_META, width: 130, minWidth: 130 }}>{label}</text>
          <input
            value={inheriting ? resolvedValue : String(branchEdit[key] ?? '')}
            readOnly={inheriting}
            onChange={(event) => setBranchEdit((current) => ({ ...current, [key]: event.value ?? '' }))}
            style={{
              height: 30,
              padding: 6,
              paddingLeft: 8,
              flexGrow: 1,
              minWidth: 0,
              color: inheriting ? t.fg3 : t.fg,
              backgroundColor: inheriting ? t.hover : t.surface,
              borderWidth: 1,
              borderColor: t.borderStrong,
              borderRadius: 6,
              fontSize: F_BODY,
            }}
          />
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 140, minHeight: 24 }}
        >
          <Switch on={inheriting} onToggle={(value) => setBranchInherit((current) => ({ ...current, [key]: value }))} />
          <text style={{ color: t.fg3, fontSize: F_META }}>Same as head office</text>
        </div>
      </div>
    )
  }

  function taxpayerProfileTab() {
    if (!taxpayer || !branch) {
      return (
        <Card title="No taxpayer selected" subtitle="Choose a taxpayer from the taxpayer menu or add a new one.">
          <Btn kind="secondary" onClick={() => setShowNewTaxpayer(true)}>New taxpayer</Btn>
        </Card>
      )
    }
    const facts = branch.facts
    const inherited = facts.inherited
    const editBtn = (sec: string) => (
      <IBtn
        testId={`edit-${sec}`}
        icon="pencil"
        size={26}
        iconSize={13}
        onClick={() => setEditSec(editSec === sec ? null : sec)}
      />
    )
    const sections = (
      <div style={{ borderWidth: 1, borderColor: t.border, borderRadius: 12, backgroundColor: t.surface, overflow: 'hidden' }}>
        {disclosure(
          'taxpayer',
          'Taxpayer',
          'Shared by every branch',
          editBtn('taxpayer'),
          editSec === 'taxpayer' ? (
            <>
              {editRow('Registered name', taxpayerEdit.name, (value) => setTaxpayerEdit((current) => ({ ...current, name: value })))}
              {factRow('TIN', formatTin(taxpayer.tin9), { mono: true })}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30 }}>
                <text style={{ color: t.fg2, fontSize: F_META, width: 130, minWidth: 130 }}>Type</text>
                <Seg<'individual' | 'non-individual'>
                  options={[
                    { value: 'individual', label: 'Individual' },
                    { value: 'non-individual', label: 'Non-individual' },
                  ]}
                  value={taxpayerEdit.type}
                  onChange={(value) => setTaxpayerEdit((current) => ({ ...current, type: value }))}
                />
              </div>
              {editRow('Birth date', taxpayerEdit.birthDate, (value) => setTaxpayerEdit((current) => ({ ...current, birthDate: value })))}
              {editActions(saveTaxpayerDetails, 'taxpayer')}
            </>
          ) : (
            <>
              {factRow('Registered name', taxpayer.name)}
              {factRow('TIN', formatTin(taxpayer.tin9), { mono: true, copy: formatTin(taxpayer.tin9) })}
              {factRow('Type', taxpayer.type === 'individual' ? 'Individual' : 'Non-individual')}
              {factRow('Birth date', taxpayer.birthDate ?? '')}
            </>
          ),
          true,
        )}
        {disclosure(
          'branch',
          `Branch · ${branch.name}`,
          `${branch.code === '00000' ? 'Head office' : `Branch ${branch.code}`}`,
          editBtn('branch'),
          editSec === 'branch' ? (
            <>
              {factRow('Branch code', branch.code, { mono: true })}
              {editRow('Branch name', branchEdit.name, (value) => setBranchEdit((current) => ({ ...current, name: value })))}
              {branch.code === '00000'
                ? editRow('RDO', branchEdit.rdo, (value) => setBranchEdit((current) => ({ ...current, rdo: value })))
                : inheritEditRow('RDO', 'rdo', facts.rdo)}
              {editActions(saveBranchDetails, 'branch')}
            </>
          ) : (
            <>
              {factRow('Branch code', branch.code, { mono: true })}
              {factRow('Branch name', branch.name)}
              {factRow('RDO', facts.rdo, { hint: inherited.rdo ? 'Head office' : undefined })}
            </>
          ),
        )}
        {disclosure(
          'contact',
          'Address and contact',
          'Used on every return',
          editBtn('contact'),
          editSec === 'contact' ? (
            <>
              {branch.code === '00000' ? (
                <>
                  {editRow('Registered address', branchEdit.address, (value) => setBranchEdit((current) => ({ ...current, address: value })))}
                  {editRow('ZIP', branchEdit.zip, (value) => setBranchEdit((current) => ({ ...current, zip: value })))}
                  {editRow('Phone', branchEdit.phone, (value) => setBranchEdit((current) => ({ ...current, phone: value })))}
                  {editRow('Email', branchEdit.email, (value) => setBranchEdit((current) => ({ ...current, email: value })))}
                </>
              ) : (
                <>
                  {inheritEditRow('Registered address', 'address', facts.address)}
                  {inheritEditRow('ZIP', 'zip', facts.zip)}
                  {inheritEditRow('Phone', 'phone', facts.phone)}
                  {inheritEditRow('Email', 'email', facts.email)}
                </>
              )}
              {editActions(saveBranchDetails, 'contact')}
            </>
          ) : (
            <>
              {factRow('Registered address', facts.address, { hint: inherited.address ? 'Head office' : undefined })}
              {factRow('ZIP', facts.zip, { hint: inherited.zip ? 'Head office' : undefined })}
              {factRow('Phone', facts.phone, { hint: inherited.phone ? 'Head office' : undefined })}
              {factRow('Email', facts.email, { hint: inherited.email ? 'Head office' : undefined })}
            </>
          ),
        )}
        {disclosure(
          'email',
          'Email, security and export',
          'Set once for the taxpayer',
          null,
          <text style={{ color: t.fg3, fontSize: F_META }}>eBIR notification email, signing and export options arrive with the filing pipeline.</text>,
        )}
      </div>
    )
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sections}
        {showNewBranch && (
          <Card title="New branch" subtitle="Branches inherit head-office facts until overridden.">
            <div style={{ display: 'flex', gap: 10 }}>
              <FieldInput label="Branch code" value={newBranch.code} placeholder="00001" onChange={(value) => setNewBranch((current) => ({ ...current, code: value.replace(/\D/g, '').slice(0, 5) }))} />
              <FieldInput label="Branch name" value={newBranch.name} placeholder="Cebu" onChange={(value) => setNewBranch((current) => ({ ...current, name: value }))} />
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <FieldInput label="RDO override" value={newBranch.rdo} onChange={(value) => setNewBranch((current) => ({ ...current, rdo: value }))} />
              <FieldInput label="ZIP override" value={newBranch.zip} onChange={(value) => setNewBranch((current) => ({ ...current, zip: value }))} />
            </div>
            <FieldInput label="Address override" value={newBranch.address} onChange={(value) => setNewBranch((current) => ({ ...current, address: value }))} />
            {branchError && <text style={{ color: t.danger, fontSize: F_META }}>{branchError}</text>}
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn small onClick={addBranch} testId="add-branch-save">Create branch</Btn>
              <Btn small kind="ghost" onClick={() => setShowNewBranch(false)}>Cancel</Btn>
            </div>
          </Card>
        )}
      </div>
    )
  }

  function taxpayerFormsTab() {
    if (!taxpayer || !branch) {
      return <text style={{ color: t.fg3, fontSize: F_META, padding: 14 }}>Select a taxpayer first.</text>
    }
    if (!selectedProfile) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Card title="No tax year yet" subtitle="A year opens the form library for this branch.">
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <FieldInput label="Tax year" value={yearInput} onChange={(value) => setYearInput(value.replace(/\D/g, '').slice(0, 4))} />
              <Btn small onClick={addYear} testId="add-year-save">Create year</Btn>
            </div>
          </Card>
        </div>
      )
    }
    const catalogFiltered = catalog.filter((entry) => {
      const needle = formSearch.trim().toLowerCase()
      if (!needle) return true
      return entry.code.toLowerCase().includes(needle) || entry.label.toLowerCase().includes(needle)
    })
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {branch.years.map((profile) => (
            <div
              key={profile.id}
              testId={`year-${profile.year}`}
              onClick={() => navTo({ ...navNow, profileId: profile.id })}
              style={{ display: 'flex', alignItems: 'center', height: 24, paddingLeft: 10, paddingRight: 10, borderRadius: 12, cursor: 'pointer', backgroundColor: profile.id === selectedProfile.id ? t.accentSoft : t.hover }}
            >
              <text style={{ color: profile.id === selectedProfile.id ? t.accent : t.fg2, fontSize: F_META, fontWeight: 500 }}>{profile.year}</text>
            </div>
          ))}
          <Btn small kind="ghost" icon="plus" testId="add-year-toggle" onClick={() => setShowNewYear((value) => !value)}>Add year</Btn>
          {showNewYear && (
            <>
              <input
                value={yearInput}
                onChange={(event) => setYearInput((event.value ?? '').replace(/\D/g, '').slice(0, 4))}
                style={{ width: 76, height: 28, padding: 5, color: t.fg, backgroundColor: t.surface, borderWidth: 1, borderColor: t.borderStrong, borderRadius: 6, fontSize: F_META }}
              />
              <Btn small kind="secondary" testId="add-year-save" onClick={addYear}>Create</Btn>
            </>
          )}
          <div style={{ flexGrow: 1 }} />
          <input
            testId="form-filter"
            value={formSearch}
            placeholder="Filter forms"
            onChange={(event) => setFormSearch(event.value ?? '')}
            style={{ width: 190, height: 32, paddingLeft: 9, color: t.fg, backgroundColor: t.surface, borderWidth: 1, borderColor: t.borderStrong, borderRadius: 7, fontSize: F_BODY }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <text style={{ color: t.fg3, fontSize: F_CAP }}>Starter packs</text>
          {Object.keys(STARTER_PACKS).map((pack) => (
            <div
              key={pack}
              testId={`pack-${pack}`}
              onClick={() => applyPack(pack)}
              style={{ display: 'flex', alignItems: 'center', height: 24, paddingLeft: 10, paddingRight: 10, borderRadius: 12, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, cursor: 'pointer', hover: { backgroundColor: t.hover } }}
            >
              <text style={{ color: t.fg2, fontSize: F_META }}>{pack}</text>
            </div>
          ))}
        </div>
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {catalogFiltered.map((entry) => {
              const inLibrary = selectedLibrary.some((item) => item.formCode === entry.code)
              const pending = pendingCodes.includes(entry.code)
              const due = dueByKey.get(`${selectedProfile.id}:${entry.code}`)
              const checked = inLibrary || pending
              return (
                <div
                  key={entry.code}
                  testId={`lib-${entry.code}`}
                  onClick={() => toggleLibraryForm(entry.code)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    minHeight: 38,
                    borderBottomWidth: 1,
                    borderColor: t.border,
                    cursor: 'pointer',
                    hover: { backgroundColor: t.hover },
                  }}
                >
                  <Check on={checked} />
                  <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE, width: 76, minWidth: 76 }}>
                    {displayFormCode(entry.code)}
                  </text>
                  <text style={{ color: t.fg, fontSize: F_BODY, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                    {cleanFormTitle(entry.label)}
                  </text>
                  <text style={{ color: t.fg2, fontSize: F_META, width: 130, minWidth: 130 }}>
                    {due ? `Next: ${periodLabel(due.period)}` : 'Not filed this year'}
                  </text>
                  <Chip tone="muted">{freqLabel(entry.frequency)}</Chip>
                  <text style={{ color: t.fg3, fontSize: F_META, width: 86, minWidth: 86, textAlign: 'right' }}>
                    {due ? fmtDateShort(due.dueDate) : '—'}
                  </text>
                </div>
              )
            })}
          </div>
        </Card>
        {pendingCodes.length > 0 && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn small testId="add-selected-forms" onClick={() => {
              if (!selectedProfile) return
              store.addForms(selectedProfile.id, pendingCodes)
              setPendingCodes([])
            }}>{`Add selected (${pendingCodes.length})`}</Btn>
          </div>
        )}
      </div>
    )
  }

  function taxpayerTemplatesTab() {
    if (!taxpayer || !selectedProfile) {
      return <text style={{ color: t.fg3, fontSize: F_META, padding: 14 }}>Select a taxpayer and year first.</text>
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <text style={{ color: t.fg3, fontSize: F_META }}>
          One template per form for this taxpayer and branch — a saved return becomes the starting point for the next period.
        </text>
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {selectedLibrary.length === 0 && (
              <text style={{ color: t.fg3, fontSize: F_META, padding: 10 }}>Add forms to the library first.</text>
            )}
            {selectedLibrary.map((entry) => {
              const item = catalogByCode.get(entry.formCode)
              return (
                <div
                  key={entry.formCode}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, borderBottomWidth: 1, borderColor: t.border }}
                >
                  <Icon name="template" size={15} color={t.fg3} />
                  <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE, width: 76, minWidth: 76 }}>
                    {displayFormCode(entry.formCode)}
                  </text>
                  <text style={{ color: t.fg, fontSize: F_BODY, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                    {cleanFormTitle(item?.label ?? '')}
                  </text>
                  <text style={{ color: t.fg3, fontSize: F_META, width: 110, minWidth: 110 }}>No template yet</text>
                  <Btn
                    small
                    kind="secondary"
                    onClick={() => showToast('Templates arrive with the guided-mode phase.')}
                  >
                    + Create
                  </Btn>
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    )
  }

  function newTaxpayerPage() {
    const setNew = (field: keyof NewTaxpayerForm, value: string) =>
      setNewTaxpayer((current) => ({ ...current, [field]: value }))
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 700 }}>New taxpayer</text>
        <text style={{ color: t.fg3, fontSize: F_BODY, paddingBottom: 18 }}>Add a taxpayer and its head-office facts.</text>
        <Card>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['tin1', 'tin2', 'tin3'] as const).map((part, index) => (
              <FieldInput
                key={part}
                label={`TIN ${index + 1}`}
                value={newTaxpayer[part]}
                placeholder={['123', '456', '788'][index]}
                mono
                onChange={(value) => setNew(part, (value ?? '').replace(/\D/g, '').slice(0, 3))}
                hint={index === 0 ? newTaxpayerErrors.tin : undefined}
                testId={`new-taxpayer-${part}`}
              />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <text style={{ color: t.fg2, fontSize: F_META, width: 130, minWidth: 130 }}>Type</text>
            <Seg<'individual' | 'non-individual'>
              options={[
                { value: 'individual', label: 'Individual' },
                { value: 'non-individual', label: 'Non-individual' },
              ]}
              value={newTaxpayer.type}
              onChange={(value) => setNewTaxpayer((current) => ({ ...current, type: value }))}
            />
          </div>
          <FieldInput label="Taxpayer name" value={newTaxpayer.name} onChange={(value) => setNew('name', value)} hint={newTaxpayerErrors.name} />
          <FieldInput label="Birth date" value={newTaxpayer.birthDate} placeholder="YYYY-MM-DD (individuals)" onChange={(value) => setNew('birthDate', value)} />
          <div style={{ display: 'flex', gap: 10 }}>
            <FieldInput label="Head-office RDO" value={newTaxpayer.rdo} onChange={(value) => setNew('rdo', value)} />
            <FieldInput label="ZIP" value={newTaxpayer.zip} onChange={(value) => setNew('zip', value)} />
          </div>
          <FieldInput label="Registered address" value={newTaxpayer.address} onChange={(value) => setNew('address', value)} />
          <div style={{ display: 'flex', gap: 10 }}>
            <FieldInput label="Telephone" value={newTaxpayer.phone} onChange={(value) => setNew('phone', value)} />
            <FieldInput label="Email" value={newTaxpayer.email} onChange={(value) => setNew('email', value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn testId="new-taxpayer-save" onClick={saveNewTaxpayer}>Add taxpayer</Btn>
            <Btn kind="ghost" onClick={() => setShowNewTaxpayer(false)}>Cancel</Btn>
          </div>
        </Card>
      </div>
    )
  }

  function taxpayerPage() {
    if (showNewTaxpayer) return newTaxpayerPage()
    if (!taxpayer) return newTaxpayerPage()
    const formsCount = selectedLibrary.length
    const tabItem = (id: TpTab, label: string) => (
      <div
        key={id}
        testId={`tab-${id}`}
        onClick={() => navTo({ ...navNow, tab: id })}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 34,
          paddingLeft: 2,
          paddingRight: 2,
          marginRight: 16,
          cursor: 'pointer',
          borderBottomWidth: 2,
          borderColor: tab === id ? t.fg : 'rgba(0,0,0,0)',
        }}
      >
        <text style={{ color: tab === id ? t.fg : t.fg3, fontSize: F_BODY, fontWeight: tab === id ? 600 : 400 }}>
          {label}
        </text>
      </div>
    )
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 14 }}>
          <Avatar name={taxpayer.name || '?'} size={40} />
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
            <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 700, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
              {taxpayer.name || formatTin(taxpayer.tin9)}
            </text>
            <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE }}>{formatTin(taxpayer.tin9, branch?.code ?? '00000')}</text>
          </div>
          <Btn
            testId="copy-tin"
            kind="secondary"
            icon="copy"
            onClick={() => showToast('TIN copied.')}
          >
            Copy TIN
          </Btn>
          <Btn testId="new-return" icon="plus" onClick={() => setOverlay({ kind: 'startReturn' })}>New return</Btn>
        </div>
        <div style={{ display: 'flex', borderBottomWidth: 1, borderColor: t.border, marginBottom: 14 }}>
          {tabItem('profile', 'Profile')}
          {tabItem('forms', `Forms${formsCount ? ` ${formsCount}` : ''}`)}
          {tabItem('templates', 'Templates')}
        </div>
        <div style={{ flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>
          {tab === 'profile' && taxpayerProfileTab()}
          {tab === 'forms' && taxpayerFormsTab()}
          {tab === 'templates' && taxpayerTemplatesTab()}
        </div>
      </div>
    )
  }

  // -- Settings / jobs / logs -------------------------------------------------

  function settingsRow(title: string, subtitle: string, control: ReactNode, testId?: string) {
    return (
      <div
        testId={testId}
        style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 40, borderBottomWidth: 1, borderColor: t.border }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexGrow: 1, minWidth: 0 }}>
          <text style={{ color: t.fg, fontSize: F_BODY }}>{title}</text>
          <text style={{ color: t.fg3, fontSize: F_META }}>{subtitle}</text>
        </div>
        {control}
      </div>
    )
  }

  function settingsPage() {
    const stateChip = (state: Job['state']) =>
      state === 'running' ? 'Running' : state === 'dead' ? 'Failed' : state === 'succeeded' ? 'Done' : 'Queued'
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 700, paddingBottom: 8 }}>Settings</text>
        <Card title="Appearance">
          {settingsRow(
            'Theme',
            'Light, dark, or match Windows.',
            <Seg<ThemeMode>
              testId="theme-seg"
              options={[
                { value: 'light', label: 'Light', icon: 'sun' },
                { value: 'dark', label: 'Dark', icon: 'moon' },
                { value: 'system', label: 'System', icon: 'monitor' },
              ]}
              value={themeMode}
              onChange={setThemeMode}
            />,
          )}
          {settingsRow(
            'Show recent returns in the sidebar',
            'Last four returns you opened.',
            <Switch testId="show-recent" on={showRecent} onToggle={toggleRecent} />,
          )}
          {settingsRow('Display name', 'Used for the greeting on Home.', <div style={{ width: 200 }}><FieldInput value={displayName} onChange={setDisplayName} /></div>)}
          {settingsRow('Email', 'Shown on the account card.', <div style={{ width: 200 }}><FieldInput value={email} onChange={setEmail} /></div>)}
          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 6 }}>
            <Btn small kind="secondary" onClick={() => {
              store.setSetting('displayName', displayName.trim())
              store.setSetting('email', email.trim())
              showToast('Account details saved.')
            }}>Save</Btn>
          </div>
        </Card>
        <Card title="Returns">
          {settingsRow(
            'Ask to update the template on save',
            'When a return is saved, offer to keep it as the branch template.',
            <Switch testId="ask-template" on={askTemplate} onToggle={toggleAskTemplate} />,
          )}
        </Card>
        <Card title="Data">
          {settingsRow(
            'Import data',
            'Bring in returns saved by the official eBIRForms app.',
            <Btn small kind="secondary" onClick={() => showToast('Import arrives with the filing pipeline.')}>Import</Btn>,
            'import-row',
          )}
          {settingsRow(
            'Back up now',
            lastBackup ? `Last backup ${fmtDateTime(Number(lastBackup))}` : 'No backup yet — copies the database next to itself.',
            <Btn small kind="secondary" onClick={backupNow} testId="backup-now">Back up</Btn>,
            'backup-row',
          )}
          {settingsRow('Jobs', 'Background task queue.', <Btn small kind="ghost" onClick={() => goto('jobs')}>Open</Btn>)}
          {settingsRow('Logs', 'Application log entries.', <Btn small kind="ghost" onClick={() => goto('logs')}>Open</Btn>)}
          <text style={{ color: t.fg3, fontSize: F_CAP, paddingTop: 6 }}>{sftpMode}</text>
        </Card>
        <Card title="Background tasks" subtitle="Live rows from the job queue.">
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {queueJobs.length === 0 && (
              <text style={{ color: t.fg3, fontSize: F_META, padding: 6 }}>No background tasks queued.</text>
            )}
            {queueJobs.map((job) => (
              <div key={job.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 34, borderBottomWidth: 1, borderColor: t.border }}>
                <Icon name={job.state === 'running' ? 'history' : job.state === 'dead' ? 'alert' : job.state === 'succeeded' ? 'checkCircle' : 'box'} size={14} color={job.state === 'dead' ? t.danger : job.state === 'succeeded' ? t.success : t.fg3} />
                <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0 }}>
                  <text style={{ color: t.fg, fontSize: F_META }}>{job.kind}</text>
                  <text style={{ color: t.fg3, fontSize: F_CAP }}>{`attempts ${job.attempts}/${job.maxAttempts}${job.lastError ? ` · ${job.lastError}` : ''}`}</text>
                </div>
                <Chip tone={job.state === 'running' ? 'accent' : job.state === 'dead' ? 'danger' : 'muted'}>{stateChip(job.state)}</Chip>
              </div>
            ))}
          </div>
        </Card>
      </div>
    )
  }

  function jobsPage() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 700 }}>Jobs</text>
        {queueJobs.length === 0 && <text style={{ color: t.fg3, fontSize: F_META }}>No background tasks queued.</text>}
        {queueJobs.map((job) => (
          <Card key={job.id} title={`${job.kind} · ${job.state}`} subtitle={`Attempts ${job.attempts}/${job.maxAttempts}`}>
            <text style={{ color: job.lastError ? t.danger : t.fg3, fontSize: F_META }}>{job.lastError ?? JSON.stringify(job.payload)}</text>
          </Card>
        ))}
      </div>
    )
  }

  function logsPage() {
    const shownLogs = logFilter === 'all' ? logs : logs.filter((entry) => entry.level === logFilter)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flexGrow: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 700 }}>Logs</text>
          <Select value={logFilter} onValueChange={(value) => setLogFilter(value as LogFilter)}>
            <SelectTrigger style={{ width: 130, height: 30 }}><SelectValue /></SelectTrigger>
            <SelectContent>
              {(['all', 'debug', 'info', 'warn', 'error'] as LogFilter[]).map((level) => (
                <SelectItem key={level} value={level}>{level}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflow: 'scroll' }}>
          {shownLogs.map((entry, index) => (
            <div key={`${entry.ts}-${index}`} style={{ display: 'flex', gap: 10, padding: 7, borderRadius: 6, hover: { backgroundColor: t.hover } }}>
              <text style={{ color: t.fg3, fontSize: F_CAP }}>{new Date(entry.ts).toLocaleTimeString()}</text>
              <text style={{ color: entry.level === 'error' ? t.danger : entry.level === 'warn' ? t.warning : t.fg2, fontSize: F_CAP, width: 44 }}>{entry.level}</text>
              <text style={{ color: t.fg3, fontSize: F_CAP, width: 70 }}>{entry.scope}</text>
              <text style={{ color: t.fg, fontSize: F_META, flexGrow: 1 }}>{entry.msg}</text>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // -- Form page (editor logic unchanged, restyled to the tokens) ------------

  function formPage() {
    const currentStatus = draft?.status ?? 'draft'
    const stages: DraftStatus[] = ['draft', 'queued', 'submitted', 'confirmed', 'paid']
    const currentIndex = stages.indexOf(currentStatus)
    const trackerDots = [
      { left: 12, top: 0 }, { left: 20, top: 4 }, { left: 24, top: 12 }, { left: 20, top: 20 },
      { left: 12, top: 24 }, { left: 4, top: 20 }, { left: 0, top: 12 }, { left: 4, top: 4 },
    ]
    const revision =
      formEntry?.formCode === '1601Cv2018' || formEntry?.formCode === '2551Qv2018'
        ? 'January 2018 (ENCS)'
        : formEntry?.formCode === '0619E'
          ? 'January 2018'
          : ''
    const isMoneyLabel = (label: string) =>
      /amount|tax due|taxable|sales|receipts|income|compensation|withheld|remittance|premium|cost|payment|proceeds|balance|total/i.test(label)
    const isPctLabel = (label: string) => /%|rate\b/i.test(label)

    function fieldLocked(field: FieldSnapshot) {
      return (
        editorModel.sections.some((section) =>
          section.rows.some((row) => row.fields.some((entry) => entry.id === field.id && row.locked)),
        ) || field.disabled
      )
    }

    function input(field: FieldSnapshot, width: number, money = false, pct = false) {
      const locked = fieldLocked(field)
      const el = (
        <input
          testId={`field-${field.id}`}
          value={String(editorValues[field.id] ?? '')}
          readOnly={locked}
          onChange={(event) => editField(field, event.value ?? '')}
          style={{
            width,
            height: 32,
            padding: 7,
            paddingLeft: money ? 24 : 8,
            paddingRight: pct ? 24 : 8,
            textAlign: money || pct ? 'right' : 'left',
            color: locked ? t.fg3 : t.fg,
            backgroundColor: locked ? t.hover : t.surface,
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: 6,
            fontSize: F_BODY,
            ...(money || pct ? NUM_STYLE : {}),
          }}
        />
      )
      if (!money && !pct) return el
      return (
        <div style={{ position: 'relative', width }}>
          <text
            style={{
              position: 'absolute',
              top: 8,
              ...(money ? { left: 10 } : { right: 10 }),
              color: t.fg3,
              fontSize: F_META,
            }}
          >
            {money ? '₱' : '%'}
          </text>
          {el}
        </div>
      )
    }

    function control(field: FieldSnapshot, subLabel?: string) {
      const locked = fieldLocked(field)
      const labelWidth =
        field.type === 'select-one' ? 220 : isMoneyLabel(field.label) ? 230 : field.maxLength && field.maxLength <= 4 ? 88 : field.label.length > 30 ? 300 : 220
      const body =
        field.type === 'select-one' ? (
          <Select value={String(editorValues[field.id] ?? '')} onValueChange={(value) => editField(field, value)} disabled={locked}>
            <SelectTrigger style={{ width: labelWidth, height: 32 }}><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>{field.options?.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        ) : field.type === 'checkbox' ? (
          <div onClick={() => !locked && editField(field, !Boolean(editorValues[field.id]))} style={{ width: 28, height: 28, display: 'flex', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: t.borderStrong, borderRadius: 6, backgroundColor: locked ? t.hover : t.surface, cursor: locked ? 'default' : 'pointer' }}>
            {Boolean(editorValues[field.id]) && <Icon name="check" size={14} color={t.fg} strokeWidth={2.5} />}
          </div>
        ) : field.type === 'textarea' ? (
          <input
            testId={`field-${field.id}`}
            value={String(editorValues[field.id] ?? '')}
            readOnly={locked}
            onChange={(event) => editField(field, event.value ?? '')}
            style={{ width: Math.max(labelWidth, 320), height: 56, padding: 8, color: locked ? t.fg3 : t.fg, backgroundColor: locked ? t.hover : t.surface, borderWidth: 1, borderColor: t.borderStrong, borderRadius: 6, fontSize: F_BODY }}
          />
        ) : (
          input(field, labelWidth, isMoneyLabel(field.label), !isMoneyLabel(field.label) && isPctLabel(field.label))
        )
      if (!subLabel) return body
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <text style={{ color: t.fg2, fontSize: F_META }}>{subLabel}</text>
          {body}
        </div>
      )
    }

    function rowControls(row: (typeof editorModel.sections)[number]['rows'][number]) {
      const fields = row.fields
      if (row.kind === 'tin') {
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {fields.map((field, fieldIndex) => (
              <div key={field.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {fieldIndex > 0 && <text style={{ color: t.fg3, fontSize: F_META }}>-</text>}
                <input
                  testId={`field-${field.id}`}
                  value={String(editorValues[field.id] ?? '')}
                  readOnly
                  style={{
                    width: fieldIndex === 3 ? 76 : 58,
                    height: 32,
                    padding: 6,
                    textAlign: 'center',
                    color: t.fg2,
                    backgroundColor: t.hover,
                    borderWidth: 1,
                    borderColor: t.borderStrong,
                    borderRadius: 6,
                    fontSize: F_META,
                    ...NUM_STYLE,
                  }}
                />
              </div>
            ))}
          </div>
        )
      }
      if (row.kind === 'radio' || (row.kind === 'period' && fields.some((field) => field.type === 'radio'))) {
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {fields.map((field) => {
              if (field.type === 'radio') {
                const checked = Boolean(editorValues[field.id])
                return (
                  <div
                    key={field.id}
                    testId={`radio-${field.id}`}
                    onClick={() => editField(field, true)}
                    style={{
                      display: 'flex', alignItems: 'center', height: 28, paddingLeft: 12, paddingRight: 12,
                      borderWidth: 1,
                      borderColor: checked ? t.primary : t.borderStrong,
                      borderRadius: 999,
                      backgroundColor: checked ? t.primary : t.surface,
                      cursor: 'pointer',
                    }}
                  >
                    <text style={{ color: checked ? t.primaryFg : t.fg2, fontSize: F_META, fontWeight: 500, whiteSpace: 'nowrap' }}>
                      {field.optionLabel || 'Option'}
                    </text>
                  </div>
                )
              }
              return <div key={field.id}>{control(field, field.label)}</div>
            })}
          </div>
        )
      }
      if (row.kind === 'period') {
        return (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            {fields.map((field) => <div key={field.id}>{control(field, field.label)}</div>)}
          </div>
        )
      }
      if (fields.length > 1) {
        return (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            {fields.map((field) => <div key={field.id}>{control(field, field.label)}</div>)}
          </div>
        )
      }
      return control(fields[0])
    }

    const periodText = draft ? periodLabel(draft.period) : ''
    const catalogEntry = formEntry ? catalogByCode.get(formEntry.formCode) : undefined
    const visibleFieldCount = fieldSnapshot.filter((field) => field.visible !== false).length

    return (
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingBottom: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Btn kind="ghost" icon="chevLeft" testId="form-back" small onClick={() => closeForm()}>Back</Btn>
              <text style={{ color: t.fg3, fontSize: F_META }}>
                BIR Form {formEntry ? displayFormCode(formEntry.formCode) : ''}
                {revision ? ` · Revision ${revision}` : ''}
              </text>
            </div>
            <text style={{ color: t.fg, fontSize: F_PAGE, fontWeight: 600 }}>{formEntry ? cleanFormTitle(formEntry.label) : 'Return'}</text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {catalogEntry && <Chip tone="muted">{catalogEntry.frequency === 'monthly' ? 'Monthly' : catalogEntry.frequency === 'quarterly' ? 'Quarterly' : 'Annual'}</Chip>}
              <Chip tone="muted">{visibleFieldCount} fields</Chip>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Btn kind="ghost" testId="form-dismiss" small onClick={() => closeForm()}>Dismiss</Btn>
            <Btn small testId="save-return-top" onClick={saveDraft}>Save draft</Btn>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: 10,
            paddingLeft: 12,
            paddingRight: 12,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: 12,
            backgroundColor: t.bg,
            marginBottom: 14,
          }}
        >
          <Avatar name={taxpayer?.name ?? '?'} size={20} />
          <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 600 }}>{taxpayer?.name ?? ''}</text>
          <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE }}>
            {selectedProfile ? formatTin(selectedProfile.tin9, selectedProfile.branch) : ''}
          </text>
          {branch && <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE }}>{branch.name}</text>}
          {periodText && <text style={{ color: t.fg3, fontSize: F_META }}>·</text>}
          {periodText && <text style={{ color: t.fg2, fontSize: F_META }}>For {periodText}</text>}
          <div style={{ flexGrow: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <text style={{ color: t.fg2, fontSize: F_META }}>Guided mode</text>
            <Switch on={false} onToggle={() => showToast('Templates arrive with the guided-mode phase.')} />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, paddingBottom: 12 }}>
          {stages.map((stage, index) => (
            <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                testId={`stage-${stage}`}
                onClick={() => updateDraftStatus(stage)}
                style={{
                  width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  position: 'relative', cursor: 'pointer',
                  borderWidth: index > currentIndex ? 0 : 2,
                  borderColor: index < currentIndex ? t.success : index === currentIndex ? t.fg : t.border,
                  borderRadius: 13,
                  backgroundColor: index < currentIndex ? t.success : index === currentIndex ? t.primary : t.hover,
                }}
              >
                {index > currentIndex && trackerDots.map((dot, dotIndex) => (
                  <div key={dotIndex} style={{ position: 'absolute', left: dot.left, top: dot.top, width: 4, height: 4, borderRadius: 2, backgroundColor: t.borderStrong }} />
                ))}
                <text style={{ color: index < currentIndex ? '#ffffff' : index === currentIndex ? t.primaryFg : t.fg3, fontSize: 11, fontWeight: 700 }}>
                  {index < currentIndex ? '✓' : String(index + 1)}
                </text>
              </div>
              <text style={{ color: index <= currentIndex ? t.fg : t.fg3, fontSize: F_CAP }}>{stage[0].toUpperCase() + stage.slice(1)}</text>
              {index < stages.length - 1 && <div style={{ width: 26, height: 2, backgroundColor: index < currentIndex ? t.success : t.border }} />}
            </div>
          ))}
        </div>

        {editorModel.bannerErrorText && (
          <div style={{ padding: 10, paddingLeft: 14, borderRadius: 10, backgroundColor: t.dangerSoft, marginBottom: 12 }}>
            <text style={{ color: t.danger, fontSize: F_META }}>{editorModel.bannerErrorText}</text>
          </div>
        )}
        {formLoading && <text style={{ color: t.fg3, paddingBottom: 8 }}>Opening official form…</text>}

        <div style={{ display: 'flex', flexGrow: 1, minHeight: 0, gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: 208, minWidth: 208, gap: 2 }}>
            <text style={{ color: t.fg3, fontSize: F_META, fontWeight: 500, paddingLeft: 8, paddingBottom: 6 }}>On this form</text>
            {editorModel.sections.map((section, index) => {
              const key = section.section ?? 'other'
              const open = !(collapsedPartSet?.has(key))
              return (
                <div
                  key={key}
                  onClick={() => togglePart(key)}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8, padding: 6, paddingLeft: 8, paddingRight: 8,
                    borderRadius: 8, cursor: 'pointer', minHeight: 32,
                    backgroundColor: open ? t.selected : 'rgba(0,0,0,0)',
                    hover: { backgroundColor: open ? t.selected : t.hover },
                  }}
                >
                  <text style={{ color: t.fg, fontSize: F_META, flexGrow: 1, minWidth: 0 }}>{section.section ?? `Part ${index + 1}`}</text>
                  <text style={{ color: t.fg3, fontSize: F_CAP }}>{section.rows.length}</text>
                </div>
              )
            })}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'scroll', gap: 16, paddingBottom: 20 }}>
            {editorModel.sections.map((section, index) => {
              const key = section.section ?? `part-${index}`
              const open = !collapsedPartSet?.has(key)
              const filled = section.rows.filter((row) =>
                row.fields.some((field) => {
                  const value = editorValues[field.id]
                  return value !== undefined && value !== '' && value !== false
                }),
              ).length
              return (
                <div
                  key={key}
                  testId={`part-${key}`}
                  style={{ borderWidth: 1, borderColor: t.border, borderRadius: 12, backgroundColor: t.surface, overflow: 'hidden', flexShrink: 0 }}
                >
                  <div
                    onClick={() => togglePart(key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 48, paddingLeft: 12, paddingRight: 16, cursor: 'pointer' }}
                  >
                    <Icon name={open ? 'chevDown' : 'chevRight'} size={16} color={t.fg3} />
                    <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 600, flexGrow: 1, minWidth: 0 }}>{section.section ?? `Part ${index + 1}`}</text>
                    <text style={{ color: t.fg3, fontSize: F_META }}>{section.rows.length} items · {filled} filled</text>
                  </div>
                  {open && (
                    <div style={{ borderTopWidth: 1, borderColor: t.border, display: 'flex', flexDirection: 'column' }}>
                      {section.rows.map((row, rowIndex) => (
                        <div
                          key={row.id}
                          style={{
                            display: 'flex',
                            gap: 12,
                            paddingTop: 14, paddingRight: 20, paddingBottom: 16, paddingLeft: 12,
                            borderTopWidth: rowIndex > 0 ? 1 : 0,
                            borderColor: t.border,
                          }}
                        >
                          <div
                            style={{
                              minWidth: 30,
                              height: 22,
                              paddingLeft: 6,
                              paddingRight: 6,
                              borderRadius: 6,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              backgroundColor: row.item ? t.hover : 'rgba(0,0,0,0)',
                            }}
                          >
                            {row.item && <text style={{ color: t.fg2, fontSize: F_META, ...NUM_STYLE }}>{row.item}</text>}
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, gap: 10 }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', minHeight: 22 }}>
                              <text style={{ color: t.fg, fontSize: F_BODY, fontWeight: 500, flexGrow: 1, minWidth: 0 }}>{row.label || 'Return field'}</text>
                              {row.locked && <Chip tone="muted" icon="user">From tax profile</Chip>}
                            </div>
                            {rowControls(row)}
                            {row.errorText !== '' && (
                              <text style={{ color: t.danger, fontSize: F_META }}>{row.errorText}</text>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 10, borderTopWidth: 1, borderColor: t.border }}>
          <Btn kind="secondary" testId="validate-return" onClick={() => formInstance && refreshEditor(formInstance)}>Validate</Btn>
          <Btn testId="save-return" onClick={saveDraft}>Save draft</Btn>
        </div>
      </div>
    )
  }

  // -- Overlays (search palette, start-a-return) ------------------------------

  function scrim(content: ReactNode, testId: string) {
    return (
      <div
        testId={testId}
        onMouseDown={() => setOverlay(null)}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(10,10,12,0.32)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingTop: 110,
        }}
      >
        <div onMouseDownOutside={() => setOverlay(null)} style={{ display: 'flex' }}>
          {content}
        </div>
      </div>
    )
  }

  function startReturnOverlay() {
    const profile = selectedProfile
    const forms = profile ? store.listLibrary(profile.id) : []
    const chosen = forms.find((entry) => entry.formCode === startFormCode) ?? forms[0]
    const periods = chosen && profile
      ? periodsForYear(profile.year, catalogByCode.get(chosen.formCode)?.frequency ?? 'annual')
      : []
    const defaultPeriod = chosen && profile
      ? dueByKey.get(`${profile.id}:${chosen.formCode}`)?.period ?? periods[0] ?? ''
      : ''
    const activePeriod = startPeriod || defaultPeriod
    return scrim(
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 520,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: 16, borderBottomWidth: 1, borderColor: t.border }}>
          <text style={{ color: t.fg, fontSize: F_TITLE, fontWeight: 700 }}>Start a return</text>
          <text style={{ color: t.fg3, fontSize: F_META }}>
            {taxpayer && branch ? `${taxpayer.name} · ${formatTin(taxpayer.tin9, branch.code)} · ${branch.name}` : 'Pick a form below.'}
          </text>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 320, overflow: 'scroll', padding: 8 }}>
          {forms.length === 0 && (
            <text style={{ color: t.fg3, fontSize: F_META, padding: 14 }}>No forms in this library yet — add them under Forms.</text>
          )}
          {forms.map((entry) => {
            const item = catalogByCode.get(entry.formCode)
            const active = chosen?.formCode === entry.formCode
            return (
              <div
                key={entry.formCode}
                testId={`start-${entry.formCode}`}
                onClick={() => {
                  setStartFormCode(entry.formCode)
                  setStartPeriod('')
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  height: 36,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 7,
                  cursor: 'pointer',
                  backgroundColor: active ? t.selected : 'rgba(0,0,0,0)',
                  hover: { backgroundColor: active ? t.selected : t.hover },
                }}
              >
                <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE, width: 72, minWidth: 72 }}>{displayFormCode(entry.formCode)}</text>
                <text style={{ color: t.fg, fontSize: F_BODY, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{cleanFormTitle(item?.label ?? '')}</text>
                <text style={{ color: t.fg3, fontSize: F_META }}>{freqLabel(item?.frequency ?? 'annual')}</text>
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, borderTopWidth: 1, borderColor: t.border }}>
          <text style={{ color: t.fg3, fontSize: F_META }}>Period</text>
          <Select value={activePeriod} onValueChange={setStartPeriod}>
            <SelectTrigger style={{ width: 150, height: 30 }}><SelectValue placeholder="Period" /></SelectTrigger>
            <SelectContent>
              {periods.map((period) => <SelectItem key={period} value={period}>{periodLabel(period)}</SelectItem>)}
            </SelectContent>
          </Select>
          <div style={{ flexGrow: 1 }} />
          <Btn kind="ghost" onClick={() => setOverlay(null)}>Cancel</Btn>
          <Btn
            testId="start-open"
            disabled={!chosen || !activePeriod}
            onClick={() => {
              if (!chosen || !activePeriod) return
              setOverlay(null)
              setStartFormCode(null)
              setStartPeriod('')
              navOpenForm(chosen, activePeriod)
            }}
          >
            Open form
          </Btn>
        </div>
      </div>,
      'overlay-start-return',
    )
  }

  function searchOverlay() {
    const query = paletteQuery.trim().toLowerCase()
    type Item = { id: string; group: string; title: string; sub: string; icon: IconName; run: () => void }
    const items: Item[] = []
    for (const item of tree) {
      if (query && !item.name.toLowerCase().includes(query) && !formatTin(item.tin9).includes(query)) continue
      items.push({
        id: `tp-${item.tin9}`,
        group: 'Taxpayers',
        title: item.name || formatTin(item.tin9),
        sub: formatTin(item.tin9),
        icon: 'user',
        run: () => chooseTaxpayer(item.tin9),
      })
    }
    const gos: Array<[Page | string, string, IconName]> = [
      ['home', 'Home', 'home'],
      ['calendar', 'Calendar', 'calendar'],
      ['filings', 'Filings', 'file'],
      ['taxpayer', 'Tax profile', 'user'],
      ['settings', 'Settings', 'settings'],
      ['logs', 'Logs', 'list'],
      ['jobs', 'Jobs', 'box'],
    ]
    for (const [target, label, icon] of gos) {
      if (query && !label.toLowerCase().includes(query)) continue
      items.push({ id: `go-${target}`, group: 'Go to', title: label, sub: '', icon, run: () => goto(target as Page) })
    }
    for (const entry of selectedLibrary) {
      const item = catalogByCode.get(entry.formCode)
      const label = `${displayFormCode(entry.formCode)} ${cleanFormTitle(item?.label ?? '')}`
      if (query && !label.toLowerCase().includes(query)) continue
      items.push({
        id: `form-${entry.formCode}`,
        group: 'Forms',
        title: displayFormCode(entry.formCode),
        sub: cleanFormTitle(item?.label ?? ''),
        icon: 'file',
        run: () => {
          setStartFormCode(entry.formCode)
          setOverlay({ kind: 'startReturn' })
        },
      })
    }
    const actions: Array<[string, string, IconName, () => void]> = [
      ['new-taxpayer', 'New taxpayer', 'plus', () => { setShowNewTaxpayer(true); goto('taxpayer', { tab: 'profile' }) }],
      ['backup', 'Back up database', 'database', backupNow],
      ['theme', 'Cycle theme', themeIcon(), cycleTheme],
    ]
    for (const [id, label, icon, run] of actions) {
      if (query && !label.toLowerCase().includes(query)) continue
      items.push({ id: `act-${id}`, group: 'Actions', title: label, sub: '', icon, run })
    }
    const clampedIdx = Math.min(paletteIdx, items.length - 1)
    const groups = [...new Set(items.map((item) => item.group))]
    let itemIdx = -1
    return scrim(
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: 540,
          maxHeight: 420,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.surface,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: 12, borderBottomWidth: 1, borderColor: t.border }}>
          <Icon name="search" size={15} color={t.fg3} />
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
              if (event.key === 'ArrowDown') setPaletteIdx((value) => Math.min(value + 1, items.length - 1))
              if (event.key === 'ArrowUp') setPaletteIdx((value) => Math.max(value - 1, 0))
              if (event.key === 'Enter' && items[clampedIdx]) {
                const run = items[clampedIdx].run
                setOverlay(null)
                run()
              }
            }}
            style={{ flexGrow: 1, height: 30, color: t.fg, fontSize: F_BODY, backgroundColor: 'rgba(0,0,0,0)', borderWidth: 0 }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'scroll', padding: 6 }}>
          {items.length === 0 && <text style={{ color: t.fg3, fontSize: F_META, padding: 14 }}>No results.</text>}
          {groups.map((group) => (
            <div key={group}>
              <text style={{ color: t.fg3, fontSize: F_CAP, fontWeight: 600, paddingLeft: 8, paddingTop: 6, paddingBottom: 2 }}>{group.toUpperCase()}</text>
              {items.filter((item) => item.group === group).map((item) => {
                itemIdx += 1
                const idx = itemIdx
                const active = idx === clampedIdx
                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      setOverlay(null)
                      item.run()
                    }}
                    onMouseEnter={() => setPaletteIdx(idx)}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, height: 34, paddingLeft: 8, paddingRight: 8, borderRadius: 7, cursor: 'pointer', backgroundColor: active ? t.selected : 'rgba(0,0,0,0)' }}
                  >
                    <Icon name={item.icon} size={15} color={t.fg2} />
                    <text style={{ color: t.fg, fontSize: F_BODY, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{item.title}</text>
                    {item.sub !== '' && <text style={{ color: t.fg3, fontSize: F_META, ...NUM_STYLE }}>{item.sub}</text>}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>,
      'overlay-search',
    )
  }

  // -- Root ------------------------------------------------------------------

  const editorModel = buildEditorModel(fieldSnapshot, issues, formEntry ? autoFieldIds(formEntry.formCode as PrefillFormCode) : new Set())
  const sftpMode = describeSftpConfig(loadSftpConfig())

  function mainContent() {
    if (page === 'form') return formPage()
    if (page === 'home') return homePage()
    if (page === 'calendar') return calendarPage()
    if (page === 'filings') return filingsPage()
    if (page === 'taxpayer') return taxpayerPage()
    if (page === 'jobs') return jobsPage()
    if (page === 'logs') return logsPage()
    return settingsPage()
  }

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
            marginRight: 8,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, padding: 28, paddingLeft: 32, paddingRight: 32, overflow: 'scroll' }}>
            <div style={{ width: '100%', maxWidth: 880 }}>
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
