/**
 * Design tokens ported verbatim from the shell mockup (Components tab).
 * ThemeMode adds 'system', resolved against the OS preference when
 * detectable, else light.
 */

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeTokens {
  /** Window ground, sidebar, right panel. */
  bg: string
  /** Main content, inputs, dialogs. */
  surface: string
  /** Popovers, selected segment. */
  raised: string
  /** Hover fill, chip/segment tracks. */
  hover: string
  /** Current nav row, pressed icon button. */
  selected: string
  /** Hairlines, card/list borders. */
  border: string
  /** Inputs, secondary buttons. */
  borderStrong: string
  /** Primary text/icons. */
  fg: string
  /** Secondary text, resting icons. */
  fg2: string
  /** Labels, hints, placeholders. */
  fg3: string
  /** Primary button ink (inverted, NOT blue). */
  primary: string
  primaryFg: string
  /** State accent: focus ring, Draft pill, unread dot, switch on. */
  accent: string
  accentSoft: string
  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
}

export const themes: Record<ResolvedTheme, ThemeTokens> = {
  light: {
    bg: '#f4f4f6',
    surface: '#ffffff',
    raised: '#ffffff',
    hover: '#ebebee',
    selected: '#e2e2e7',
    border: '#e2e2e6',
    borderStrong: '#cdcdd3',
    fg: '#18181b',
    fg2: '#54545d',
    fg3: '#71717a',
    primary: '#18181b',
    primaryFg: '#fbfbfd',
    accent: '#2557d6',
    accentSoft: 'rgba(37,87,214,0.10)',
    success: '#157a3c',
    successSoft: 'rgba(21,122,60,0.10)',
    warning: '#a5520a',
    warningSoft: 'rgba(165,82,10,0.10)',
    danger: '#c0262d',
    dangerSoft: 'rgba(192,38,45,0.10)',
  },
  dark: {
    bg: '#0e0e10',
    surface: '#161619',
    raised: '#232328',
    hover: '#1f1f23',
    selected: '#29292f',
    border: '#25252a',
    borderStrong: '#38383f',
    fg: '#f3f3f5',
    fg2: '#a7a7b1',
    fg3: '#8b8b95',
    primary: '#f3f3f5',
    primaryFg: '#121214',
    accent: '#7ea2ff',
    accentSoft: 'rgba(126,162,255,0.14)',
    success: '#5bd68a',
    successSoft: 'rgba(91,214,138,0.12)',
    warning: '#f3b44a',
    warningSoft: 'rgba(243,180,74,0.14)',
    danger: '#ff7b7b',
    dangerSoft: 'rgba(255,123,123,0.12)',
  },
}

/**
 * Resolve 'system' to a concrete theme. On Windows the preference lives in
 * HKCU\...\Personalize!AppsUseLightTheme; on macOS, `AppleInterfaceStyle`.
 * Anything unreadable falls back to light — cheap, synchronous, once.
 */
export function resolveSystemTheme(platform: NodeJS.Platform = process.platform): ResolvedTheme {
  try {
    if (platform === 'win32') {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
      const out = spawnSync(
        'reg',
        ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'],
        { encoding: 'utf8', timeout: 3000 },
      )
      const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out.stdout ?? '')
      if (match) return parseInt(match[1], 16) === 0 ? 'dark' : 'light'
      return 'light'
    }
    if (platform === 'darwin') {
      const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
      const out = spawnSync('defaults', ['read', '-g', 'AppleInterfaceStyle'], {
        encoding: 'utf8',
        timeout: 3000,
      })
      return /dark/i.test(out.stdout ?? '') ? 'dark' : 'light'
    }
  } catch {}
  return 'light'
}

export function resolveTheme(mode: ThemeMode, system?: ResolvedTheme): ResolvedTheme {
  return mode === 'system' ? (system ?? resolveSystemTheme()) : mode
}
