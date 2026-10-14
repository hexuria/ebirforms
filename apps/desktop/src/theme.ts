export type ThemeMode = 'light' | 'dark'

export interface ThemeTokens {
  bg: string
  fg: string
  border: string
  input: string
  muted: string
  mutedFg: string
  primary: string
  primaryFg: string
  secondary: string
  accent: string
  danger: string
  success: string
  warning: string
  warnText: string
  chrome: string
  mark: string
  markBg: string
  good: string
  goodBg: string
}

export const themes: Record<ThemeMode, ThemeTokens> = {
  light: {
    bg: '#ffffff',
    fg: '#0a0a0a',
    border: '#e5e5e5',
    input: '#e5e5e5',
    muted: '#f5f5f5',
    mutedFg: '#737373',
    primary: '#171717',
    primaryFg: '#fafafa',
    secondary: '#e5e5e5',
    accent: '#f5f5f5',
    danger: '#ef4444',
    success: '#22c55e',
    warning: '#eab308',
    warnText: '#7a6104',
    chrome: '#ffffff',
    mark: '#f0a020',
    markBg: '#fff4dc',
    good: '#18a058',
    goodBg: '#e3f6ec',
  },
  dark: {
    bg: '#0a0a0a',
    fg: '#fafafa',
    border: '#262626',
    input: '#2f2f2f',
    muted: '#262626',
    mutedFg: '#a3a3a3',
    primary: '#fafafa',
    primaryFg: '#171717',
    secondary: '#262626',
    accent: '#262626',
    danger: '#f87171',
    success: '#4ade80',
    warning: '#facc15',
    warnText: '#facc15',
    chrome: '#1c1c1c',
    mark: '#f5b54a',
    markBg: '#3a2c12',
    good: '#4ade80',
    goodBg: '#12301f',
  },
}
