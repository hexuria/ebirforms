import { useEffect, useRef, useState, type ReactNode } from 'react'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { render } from '@gpuix/react'
import {
  dataDir,
  describeSftpConfig,
  type Draft,
  type DraftValues,
  formatTin,
  JobQueue,
  loadSftpConfig,
  Logger,
  openStore,
  parseTin,
  type Job,
  type LibraryEntry,
  type LogEntry,
  type LogLevel,
  type Profile,
  type TaxpayerTree,
} from '@ebirforms/core'
import { loadCatalog, type CatalogEntry, type ReturnFrequency } from '@ebirforms/forms'
import { openOfficialForm } from '@ebirforms/runtime'
import type { FieldSnapshot, FormInstance, ValidationIssue } from '@ebirforms/runtime'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useGpuixRequired,
  type PublicInstance,
} from '@gpuix/react'
import {
  autoFieldIds,
  buildEditorModel,
  buildPrefillValues,
  cleanFormTitle,
  displayFormCode,
  formCategory,
  mergeDraftPrefill,
  type PrefillFormCode,
} from './editor-model.js'
import { themes, type ThemeMode, type ThemeTokens } from './theme.js'
import { beginWindowDrag, closeWindow, dragWindowTo, type DragAnchor } from './win32.js'

const appDir = dataDir()
mkdirSync(appDir, { recursive: true })
const store = openStore(join(appDir, 'ebirforms.sqlite'))
const logger: Logger = store.logger
const queue = new JobQueue(store)
const catalog = loadCatalog()
const themePath = join(appDir, 'theme.json')
const fontPath = join(import.meta.dir, '../assets/fonts/BricolageGrotesque-Variable.ttf')

function readTheme(): ThemeMode {
  try {
    if (existsSync(themePath)) {
      const parsed = JSON.parse(readFileSync(themePath, 'utf8')) as { mode?: ThemeMode }
      if (parsed.mode === 'light' || parsed.mode === 'dark') return parsed.mode
    }
  } catch {
    return 'light'
  }
  return 'light'
}

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

type NavPage = 'taxpayer' | 'tasks' | 'logs' | 'calendar' | 'settings' | 'form' | 'import'
type TaxpayerTab = 'details' | 'forms' | 'templates' | 'email' | 'export'
type NavState = {
  page: NavPage
  tab: TaxpayerTab
  tin?: string
  branchId?: string
  profileId?: string
  formCode?: string
  period?: string
}
const WINDOW_TITLE = 'eBIRForms'
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
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
type PeriodChoice = { period: string; label: string }

const blankFacts: FactsForm = {
  name: '',
  rdo: '',
  zip: '',
  address: '',
  phone: '',
  email: '',
}
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

function Button({
  children,
  onClick,
  disabled = false,
  quiet = false,
  testId,
}: {
  children: string
  onClick: () => void
  disabled?: boolean
  quiet?: boolean
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
        padding: 10,
        minHeight: 36,
        borderRadius: 7,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.46 : 1,
        backgroundColor: quiet ? t.secondary : t.primary,
        hover: { opacity: disabled ? 0.46 : 0.86 },
      }}
    >
      <text style={{ color: quiet ? t.fg : t.primaryFg, fontSize: 13, fontWeight: 600 }}>
        {children}
      </text>
    </div>
  )
}

let activeTheme: ThemeTokens = themes.light
function useTheme(): ThemeTokens {
  return activeTheme
}

function Field({
  label,
  value,
  onChange,
  error = '',
  placeholder,
  disabled = false,
  auto = false,
  testId,
}: {
  label: string
  value: string
  onChange?: (value: string) => void
  error?: string
  placeholder?: string
  disabled?: boolean
  auto?: boolean
  testId?: string
}) {
  const t = useTheme()
  return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flexGrow: 1, flexBasis: 180 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <text style={{ color: t.fg, fontSize: 12, fontWeight: 600 }}>{label}</text>
        {auto && (
          <text style={{ color: t.mutedFg, fontSize: 10 }}>AUTO</text>
        )}
      </div>
      <input
        testId={testId}
        value={value}
        placeholder={placeholder}
        readOnly={disabled}
        onChange={(event) => onChange?.(event.value ?? '')}
        style={{
          height: 36,
          minHeight: 36,
          padding: 9,
          color: disabled ? t.mutedFg : t.fg,
          backgroundColor: disabled ? t.muted : t.bg,
          borderWidth: 1,
          borderColor: t.input,
          borderRadius: 6,
        }}
      />
      <div testId={testId ? `${testId}-validation` : undefined} style={{ height: 18, minHeight: 18 }}>
        <text style={{ color: error ? t.danger : t.mutedFg, fontSize: 11 }}>{error}</text>
      </div>
    </div>
  )
}

function Panel({
  title,
  subtitle,
  aside,
  children,
}: {
  title: string
  subtitle?: string
  aside?: string
  children?: ReactNode
}) {
  const t = useTheme()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 18,
        borderWidth: 1,
        borderColor: t.border,
        borderRadius: 10,
        backgroundColor: t.chrome,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <text style={{ color: t.fg, fontSize: 15, fontWeight: 700 }}>{title}</text>
        {aside ? <text style={{ color: t.mutedFg, fontSize: 11 }}>{aside}</text> : subtitle && <text style={{ color: t.mutedFg, fontSize: 12 }}>{subtitle}</text>}
      </div>
      {children}
    </div>
  )
}

function periodChoices(year: number, frequency: ReturnFrequency): PeriodChoice[] {
  if (frequency === 'monthly') {
    return Array.from({ length: 12 }, (_, index) => {
      const month = String(index + 1).padStart(2, '0')
      return {
        period: `${year}-${month}`,
        label: new Date(Date.UTC(2020, index, 1)).toLocaleString('en', { month: 'short' }),
      }
    })
  }
  if (frequency === 'quarterly') {
    return [1, 2, 3, 4].map((quarter) => ({
      period: `${year}-Q${quarter}`,
      label: `Q${quarter}`,
    }))
  }
  return [{ period: String(year), label: `${year} annual return` }]
}

const SUPPORTED_FORM_CODES = ['1601Cv2018', '2551Qv2018', '0619E'] as const

function App() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readTheme)
  activeTheme = themes[themeMode]
  const t = activeTheme
  const [page, setPage] = useState<NavPage>('taxpayer')
  const [tab, setTab] = useState<TaxpayerTab>('details')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [tree, setTree] = useState<TaxpayerTree[]>(() => store.listTaxpayers())
  const [selectedTin, setSelectedTin] = useState<string | undefined>(() => store.listTaxpayers()[0]?.tin9)
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>(() => {
    const first = store.listTaxpayers()[0]
    return first?.branches[0] ? branchId(first.tin9, first.branches[0].code) : undefined
  })
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(() =>
    allProfiles(store.listTaxpayers())[0]?.id,
  )
  const [taxpayerSearch, setTaxpayerSearch] = useState('')
  const [newTaxpayer, setNewTaxpayer] = useState(blankTaxpayer)
  const [newTaxpayerErrors, setNewTaxpayerErrors] = useState<Record<string, string>>({})
  const [showNewTaxpayer, setShowNewTaxpayer] = useState(false)
  const [showNewBranch, setShowNewBranch] = useState(false)
  const [showPrintTip, setShowPrintTip] = useState(false)
  const [newBranch, setNewBranch] = useState(blankBranch)
  const [branchError, setBranchError] = useState('')
  const [taxpayerEdit, setTaxpayerEdit] = useState({ name: '', type: 'individual', birthDate: '' })
  const [branchEdit, setBranchEdit] = useState<NewBranchForm>(blankBranch)
  const [yearInput, setYearInput] = useState(String(new Date().getFullYear()))
  const [showNewYear, setShowNewYear] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [search, setSearch] = useState('')
  const [pendingCodes, setPendingCodes] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [preset, setPreset] = useState('Employer')
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
  const [rightSidebar, setRightSidebar] = useState(false)
  const [formFilter, setFormFilter] = useState('')
  const searchInputRef = useRef<PublicInstance | null>(null)
  const pendingSearchFocus = useRef(false)
  const dragAnchor = useRef<DragAnchor | null>(null)
  const histRef = useRef<{ stack: NavState[]; idx: number }>({ stack: [], idx: -1 })
  const formLoadSeq = useRef(0)
  const [, setHistVersion] = useState(0)
  const gpuix = useGpuixRequired()

  const taxpayer = tree.find((item) => item.tin9 === selectedTin)
  const branch = taxpayer?.branches.find((item) => branchId(taxpayer.tin9, item.code) === selectedBranchId)
  const selectedProfile =
    branch?.years.find((item) => item.id === selectedProfileId) ?? branch?.years.at(-1)
  const selectedLibrary = selectedProfile ? store.listLibrary(selectedProfile.id) : []
  const filteredTaxpayers = tree.filter(
    (item) =>
      !taxpayerSearch ||
      formatTin(item.tin9).toLowerCase().includes(taxpayerSearch.toLowerCase()) ||
      item.name.toLowerCase().includes(taxpayerSearch.toLowerCase()),
  )
  const filteredCatalog = catalog.filter(
    (entry) =>
      !search ||
      entry.code.toLowerCase().includes(search.trim().toLowerCase()) ||
      entry.label.toLowerCase().includes(search.trim().toLowerCase()),
  )
  const editorModel = buildEditorModel(fieldSnapshot, issues, formEntry ? autoFieldIds(formEntry.formCode as PrefillFormCode) : new Set())
  const shownLogs = logFilter === 'all' ? logs : logs.filter((entry) => entry.level === logFilter)

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
  useEffect(() => logger.subscribe((entry) => setLogs((current) => [...current.slice(-999), entry])), [])
  useEffect(() => {
    if (pendingSearchFocus.current && !sidebarCollapsed) {
      pendingSearchFocus.current = false
      focusSearchNow()
    }
  }, [sidebarCollapsed])
  useEffect(() => {
    writeFileSync(themePath, JSON.stringify({ mode: themeMode }))
  }, [themeMode])
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
      setStatusMessage(`${next.formCode} isn't editable yet — the editor covers 1601C, 2551Q and 0619E for now.`)
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

  function chooseBranch(tin9: string, code: string) {
    const id = branchId(tin9, code)
    const item = tree.find((entry) => entry.tin9 === tin9)?.branches.find((entry) => entry.code === code)
    navTo({ ...navNow, page: 'taxpayer', tin: tin9, branchId: id, profileId: item?.years.at(-1)?.id, formCode: undefined, period: undefined })
  }

  function chooseProfile(profile: Profile) {
    navTo({ ...navNow, page: 'taxpayer', tab: 'forms', tin: profile.tin9, branchId: branchId(profile.tin9, profile.branch), profileId: profile.id, formCode: undefined, period: undefined })
  }

  function openNewTaxpayer() {
    setShowNewTaxpayer(true)
    navTo({ ...navNow, page: 'taxpayer', tab: 'details', formCode: undefined, period: undefined })
  }

  function focusSearchNow() {
    const el = searchInputRef.current
    if (el?.id != null && gpuix.focusElement) {
      try {
        gpuix.focusElement(el.id)
      } catch {
        // Renderer without focusElement: expanding the sidebar still helps.
      }
    }
  }

  function focusSidebarSearch() {
    if (sidebarCollapsed) {
      pendingSearchFocus.current = true
      setSidebarCollapsed(false)
      return
    }
    focusSearchNow()
  }

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
      setStatusMessage('Taxpayer added.')
      navTo({ ...navNow, page: 'taxpayer', tab: 'details', tin: created.tin9, branchId: branchId(created.tin9, '00000'), profileId: undefined, formCode: undefined, period: undefined })
    } catch (error) {
      setNewTaxpayerErrors({ tin: error instanceof Error ? error.message : String(error) })
    }
  }

  function saveTaxpayerDetails() {
    if (!taxpayer) return
    store.updateTaxpayer(taxpayer.tin9, {
      name: taxpayerEdit.name,
      type: taxpayerEdit.type as 'individual' | 'non-individual',
      birthDate: taxpayerEdit.birthDate || null,
    })
    refreshTree(taxpayer.tin9)
    setStatusMessage('Taxpayer details saved.')
  }

  function saveBranchDetails() {
    if (!branch) return
    const id = branchId(taxpayer!.tin9, branch.code)
    store.updateBranch(id, {
      name: branchEdit.name,
      rdo: branchEdit.rdo || null,
      zip: branchEdit.zip || null,
      address: branchEdit.address || null,
      phone: branchEdit.phone || null,
      email: branchEdit.email || null,
    })
    refreshTree(taxpayer!.tin9, id)
    setStatusMessage('Branch details saved.')
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
      navTo({ ...navNow, page: 'taxpayer', tab: 'details', tin: taxpayer.tin9, branchId: created.id, profileId: undefined, formCode: undefined, period: undefined })
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
      setStatusMessage(`${profile.year} added.`)
      navTo({ ...navNow, page: 'taxpayer', tab: 'forms', tin: taxpayer.tin9, branchId: branchId(taxpayer.tin9, branch.code), profileId: profile.id, formCode: undefined, period: undefined })
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error))
    }
  }

  function toggleCode(code: string) {
    if (selectedLibrary.some((entry) => entry.formCode === code)) return
    setPendingCodes((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    )
  }

  function addSelectedForms() {
    if (!selectedProfile || !pendingCodes.length) return
    store.addForms(selectedProfile.id, pendingCodes)
    setPendingCodes([])
    setPickerOpen(false)
  }

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

  const supportedPresets: Record<string, string[]> = {
    Employer: ['1601Cv2018', '0619E', '1604C'],
    'Non-VAT business': ['2551Qv2018', '0619E', '1701Q'],
    'VAT business': ['2550Q', '0619E', '1701Q'],
  }
  const availablePresetCodes = new Set(catalog.map((entry) => entry.code))
  const visibleCatalog = search
    ? filteredCatalog
    : catalog.filter(
        (entry) =>
          availablePresetCodes.has(entry.code) &&
          (preset === 'Employer'
            ? ['1601Cv2018', '0619E', '1604C'].includes(entry.code)
            : preset === 'Non-VAT business'
              ? ['2551Qv2018', '0619E', '1701Q'].includes(entry.code)
              : ['2550Q', '0619E', '1701Q'].includes(entry.code)),
      )

  function pickerRow(entry: CatalogEntry) {
    const isInLibrary = selectedLibrary.some((item) => item.formCode === entry.code)
    const checked = isInLibrary || pendingCodes.includes(entry.code)
    return (
      <div
        key={entry.code}
        testId={`picker-${entry.code}`}
        onClick={() => toggleCode(entry.code)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          minHeight: 38,
          padding: 7,
          borderBottomWidth: 1,
          borderColor: t.border,
          cursor: isInLibrary ? 'default' : 'pointer',
          backgroundColor: t.chrome,
        }}
      >
        <div style={{
          width: 18, minWidth: 18, height: 18, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderWidth: 1, borderColor: checked ? t.primary : t.border,
          borderRadius: 4, backgroundColor: checked ? t.primary : t.bg,
        }}>
          <text style={{ color: t.primaryFg, fontSize: 12 }}>{checked ? '✓' : ''}</text>
        </div>
        <text style={{
          flexGrow: 1, minWidth: 0, color: t.fg, fontSize: 12,
          whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden',
        }}>{entry.label}</text>
        {isInLibrary && <text style={{ color: t.mutedFg, fontSize: 10 }}>IN LIBRARY</text>}
        <text style={{ width: 112, minWidth: 112, textAlign: 'right', color: t.mutedFg, fontSize: 11 }}>
          {entry.code}
        </text>
      </div>
    )
  }

  function statusStyle(status: DraftStatus | undefined) {
    if (status === 'draft') return { color: t.warnText, backgroundColor: t.markBg, borderColor: t.mark }
    if (status === 'confirmed' || status === 'paid') {
      return { color: t.good, backgroundColor: t.goodBg, borderColor: t.good }
    }
    if (status === 'queued' || status === 'submitted') {
      return { color: t.primary, backgroundColor: t.secondary, borderColor: t.border }
    }
    return { color: t.mutedFg, backgroundColor: t.bg, borderColor: t.border }
  }

  function statusLabel(status: DraftStatus | undefined) {
    if (!status) return 'New'
    return status[0].toUpperCase() + status.slice(1)
  }

  function statusFor(entry: LibraryEntry, period: string) {
    return selectedProfile
      ? store.listDrafts(selectedProfile.id, entry.formCode).find((item) => item.period === period)?.status
      : undefined
  }

  function periodCard(entry: LibraryEntry) {
    const form = catalog.find((item) => item.code === entry.formCode)
    if (!form || !selectedProfile) return null
    const choices = periodChoices(selectedProfile.year, form.frequency)
    return (
      <div key={entry.formCode} style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '32.5%', minWidth: 340, flexGrow: 1, padding: 14, borderWidth: 1, borderColor: t.border, borderRadius: 10, backgroundColor: t.chrome }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <text style={{ color: t.fg, fontSize: 22, fontWeight: 800, width: 100, minWidth: 100 }}>{displayFormCode(entry.formCode)}</text>
          <text style={{ color: t.mutedFg, fontSize: 10, padding: 5, borderRadius: 12, backgroundColor: t.secondary }}>{formCategory(entry.formCode)}</text>
        </div>
        <text style={{ color: t.fg, fontSize: 12, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{cleanFormTitle(form.label)}</text>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <text style={{ color: t.mutedFg, fontSize: 11 }}>{`Year ${selectedProfile.year}:`}</text>
          <text style={{ color: t.mutedFg, fontSize: 10, textAlign: 'right' }}>Dev preview (not yet certified)</text>
        </div>
        {form.frequency === 'annual' && (
          <div
            testId={`period-${entry.formCode}-annual`}
            onClick={() => navOpenForm(entry, choices[0].period)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 9, borderWidth: 1, borderColor: t.border, borderRadius: 7, cursor: 'pointer', backgroundColor: t.bg }}
          >
            <text style={{ color: t.primary, fontSize: 12, fontWeight: 600 }}>+ File Annual Return</text>
          </div>
        )}
        {form.frequency !== 'annual' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {choices.map((choice) => {
            const status = statusFor(entry, choice.period)
            const statusTokens = statusStyle(status)
            return (
              <div
                key={choice.period}
                testId={`period-${entry.formCode}-${choice.period}`}
                onClick={() => navOpenForm(entry, choice.period)}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center',
                  padding: 7, width: 85, minWidth: 85, height: 60,
                  borderWidth: 1, borderColor: statusTokens.borderColor, borderRadius: 7,
                  cursor: 'pointer', backgroundColor: statusTokens.backgroundColor,
                }}
              >
                <text style={{ color: t.fg, fontSize: 12 }}>{choice.label}</text>
                <text style={{ color: statusTokens.color, fontSize: 10 }}>{statusLabel(status)}</text>
              </div>
            )
          })}
        </div>
        )}
      </div>
    )
  }

  function detailsContent() {
    if (showNewTaxpayer) {
      const setNew = (field: keyof NewTaxpayerForm, value: string) =>
        setNewTaxpayer((current) => ({ ...current, [field]: value }))
      return (
        <Panel title="New taxpayer" subtitle="Add a taxpayer and its head office facts.">
          <div style={{ display: 'flex', gap: 8 }}>
            {(['tin1', 'tin2', 'tin3'] as const).map((part, index) => (
              <Field
                key={part}
                label={`TIN ${index + 1}`}
                value={newTaxpayer[part]}
                placeholder={['123', '456', '788'][index]}
                onChange={(value) => setNew(part, value.replace(/\D/g, '').slice(0, 3))}
                error={index === 0 ? newTaxpayerErrors.tin ?? '' : ''}
                testId={`new-taxpayer-${part}`}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 8, backgroundColor: t.muted, width: 280 }}>
            {(['individual', 'non-individual'] as const).map((type) => (
              <div key={type} onClick={() => setNewTaxpayer((current) => ({ ...current, type }))} style={{ flexGrow: 1, padding: 9, borderRadius: 6, backgroundColor: newTaxpayer.type === type ? t.chrome : t.muted }}>
                <text style={{ color: t.fg, fontSize: 12, textAlign: 'center' }}>{type === 'individual' ? 'Individual' : 'Non-individual'}</text>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            <Field label="Taxpayer name" value={newTaxpayer.name} onChange={(value) => setNew('name', value)} error={newTaxpayerErrors.name ?? ''} />
            <Field label="Birth date" value={newTaxpayer.birthDate} onChange={(value) => setNew('birthDate', value)} />
            <Field label="Head office RDO" value={newTaxpayer.rdo} onChange={(value) => setNew('rdo', value)} />
            <Field label="ZIP" value={newTaxpayer.zip} onChange={(value) => setNew('zip', value)} />
            <Field label="Address" value={newTaxpayer.address} onChange={(value) => setNew('address', value)} />
            <Field label="Telephone" value={newTaxpayer.phone} onChange={(value) => setNew('phone', value)} />
            <Field label="Email" value={newTaxpayer.email} onChange={(value) => setNew('email', value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button testId="new-taxpayer-save" onClick={saveNewTaxpayer}>Add taxpayer</Button>
            <Button quiet onClick={() => setShowNewTaxpayer(false)}>Cancel</Button>
          </div>
        </Panel>
      )
    }
    if (!taxpayer || !branch) {
      return (
        <Panel title="No taxpayer selected" subtitle="Choose a taxpayer from the sidebar or add a new one.">
          <Button onClick={() => setShowNewTaxpayer(true)}>New taxpayer</Button>
        </Panel>
      )
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Panel title="Taxpayer" aside="Shared by all branches">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <Field label="TIN" value={formatTin(taxpayer.tin9)} disabled auto />
            <Field label="Name" value={taxpayerEdit.name} onChange={(value) => setTaxpayerEdit((current) => ({ ...current, name: value }))} />
            <Field label="Birth date" value={taxpayerEdit.birthDate} onChange={(value) => setTaxpayerEdit((current) => ({ ...current, birthDate: value }))} />
          </div>
          <div style={{ display: 'flex', gap: 4, padding: 4, borderRadius: 8, backgroundColor: t.muted, width: 280 }}>
            {(['individual', 'non-individual'] as const).map((type) => (
              <div key={type} onClick={() => setTaxpayerEdit((current) => ({ ...current, type }))} style={{ flexGrow: 1, padding: 9, borderRadius: 6, backgroundColor: taxpayerEdit.type === type ? t.chrome : t.muted }}>
                <text style={{ color: t.fg, fontSize: 12, textAlign: 'center' }}>{type === 'individual' ? 'Individual' : 'Non-individual'}</text>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-start', width: '100%' }}>
            <Button testId="save-taxpayer" onClick={saveTaxpayerDetails}>Save</Button>
          </div>
        </Panel>
        <Panel title="Branch" aside={branch.name}>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ width: '30%' }}><Field label="Branch code" value={branch.code} disabled /></div>
            <div style={{ width: '66%' }}><Field label="Branch name" value={branchEdit.name} onChange={(value) => setBranchEdit((current) => ({ ...current, name: value }))} /></div>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ width: '48%' }}><Field label="RDO" value={branchEdit.rdo} onChange={(value) => setBranchEdit((current) => ({ ...current, rdo: value }))} /></div>
            <div style={{ width: '48%' }}><Field label="Zip" value={branchEdit.zip} onChange={(value) => setBranchEdit((current) => ({ ...current, zip: value }))} /></div>
          </div>
          <div style={{ width: '100%' }}>
            <Field label="Address" value={branchEdit.address} onChange={(value) => setBranchEdit((current) => ({ ...current, address: value }))} />
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ width: '48%' }}><Field label="Phone" value={branchEdit.phone} onChange={(value) => setBranchEdit((current) => ({ ...current, phone: value }))} /></div>
            <div style={{ width: '48%' }}><Field label="Email" value={branchEdit.email} onChange={(value) => setBranchEdit((current) => ({ ...current, email: value }))} /></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button quiet onClick={() => setShowNewBranch((current) => !current)}>Add branch</Button>
          </div>
          {showNewBranch && (
            <Panel title="New branch">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <Field label="Branch code" value={newBranch.code} onChange={(value) => setNewBranch((current) => ({ ...current, code: value.replace(/\D/g, '').slice(0, 5) }))} error={branchError} />
                <Field label="Branch name" value={newBranch.name} onChange={(value) => setNewBranch((current) => ({ ...current, name: value }))} />
                {(['rdo', 'zip', 'address', 'phone', 'email'] as const).map((field) => (
                  <Field key={field} label={field === 'rdo' ? 'RDO' : field === 'zip' ? 'ZIP' : field[0].toUpperCase() + field.slice(1)} value={newBranch[field]} onChange={(value) => setNewBranch((current) => ({ ...current, [field]: value }))} />
                ))}
              </div>
              <Button onClick={addBranch}>Create branch</Button>
            </Panel>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-start', width: '100%' }}>
            <Button testId="save-branch" onClick={saveBranchDetails}>Save</Button>
          </div>
        </Panel>
        {statusMessage && <text style={{ color: t.success, fontSize: 12 }}>{statusMessage}</text>}
      </div>
    )
  }

  function taxpayerPage() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flexGrow: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <text style={{ color: t.fg, fontSize: 25, fontWeight: 700 }}>{taxpayer?.name || 'Taxpayers'}</text>
            <text style={{ color: t.mutedFg, fontSize: 12 }}>{taxpayer ? `TIN: ${formatTin(taxpayer.tin9)} · ${taxpayer.type === 'individual' ? 'Individual' : 'Non-individual'} · Tax Year ${selectedProfile?.year ?? '-'} · ${branch?.name ?? ''}` : 'Taxpayer, branch, and return workspace'}</text>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, borderBottomWidth: 1, borderColor: t.border }}>
          {(['details', 'forms', 'templates', 'email', 'export'] as const).map((item) => (
            <div key={item} testId={`tab-${item}`} onClick={() => navTo({ ...navNow, tab: item })} style={{ padding: 12, borderBottomWidth: tab === item ? 2 : 0, borderColor: t.primary }}>
              <text style={{ color: tab === item ? t.fg : t.mutedFg, fontSize: 13, fontWeight: tab === item ? 700 : 500 }}>{item === 'forms' ? 'Forms' : item === 'email' ? 'Email Settings' : item[0].toUpperCase() + item.slice(1)}</text>
            </div>
          ))}
        </div>
        <div style={{ flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>
          {tab === 'details' && detailsContent()}
          {tab === 'templates' && (
            <Panel title="Templates" subtitle="P4b">
              <text style={{ color: t.mutedFg, fontSize: 13 }}>Guided templates and filing workflows are planned for P4b.</text>
            </Panel>
          )}
          {tab === 'email' && (
            <Panel title="Email Settings" subtitle="P5">
              <text style={{ color: t.mutedFg, fontSize: 13 }}>eBIR notification email settings arrive with the filing pipeline.</text>
            </Panel>
          )}
          {tab === 'export' && (
            <Panel title="Export" subtitle="P5">
              <text style={{ color: t.mutedFg, fontSize: 13 }}>Return export packages arrive with the filing pipeline.</text>
            </Panel>
          )}
          {tab === 'forms' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {!selectedProfile && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <text style={{ color: t.fg, fontSize: 22, fontWeight: 700 }}>Forms</text>
                    <Button quiet testId="add-year-toggle" onClick={() => setShowNewYear((value) => !value)}>+ Add year</Button>
                  </div>
                  {showNewYear && (
                    <Panel title="Add tax year" subtitle="A new year starts with the selected branch facts.">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Field label="Tax year" value={yearInput} onChange={(value) => setYearInput(value.replace(/\D/g, '').slice(0, 4))} />
                        <Button testId="add-year-save" onClick={addYear}>Create year</Button>
                      </div>
                    </Panel>
                  )}
                  <Panel title="Select a tax year"><text style={{ color: t.mutedFg }}>Select or add a year for this branch.</text></Panel>
                </>
              )}
              {selectedProfile && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <text style={{ color: t.fg, fontSize: 22, fontWeight: 700 }}>Forms</text>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      {branch?.years.map((profile) => (
              <div key={profile.id} testId={`year-${profile.year}-${profile.branch}`} onClick={() => navTo({ ...navNow, profileId: profile.id })} style={{ padding: 8, borderRadius: 16, borderWidth: 1, borderColor: profile.id === selectedProfile.id ? t.primary : t.border, backgroundColor: profile.id === selectedProfile.id ? t.secondary : t.chrome }}>
                          <text style={{ color: t.fg, fontSize: 11, fontWeight: profile.id === selectedProfile.id ? 700 : 500 }}>Tax Year {profile.year}</text>
                        </div>
                      ))}
                      <Button quiet testId="add-year-toggle" onClick={() => setShowNewYear((value) => !value)}>+ Add year</Button>
                    </div>
                  </div>
                  {showNewYear && (
                    <Panel title="Add tax year" subtitle="A new year starts with the selected branch facts.">
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Field label="Tax year" value={yearInput} onChange={(value) => setYearInput(value.replace(/\D/g, '').slice(0, 4))} />
                        <Button testId="add-year-save" onClick={addYear}>Create year</Button>
                      </div>
                    </Panel>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      testId="form-filter"
                      value={formFilter}
                      placeholder="Filter forms…"
                      onChange={(event) => setFormFilter(event.value ?? '')}
                      style={{ height: 36, minHeight: 36, padding: 9, flexGrow: 1, minWidth: 0, color: t.fg, backgroundColor: t.bg, borderWidth: 1, borderColor: t.input, borderRadius: 6 }}
                    />
                    <Button quiet testId="choose-forms" onClick={() => setPickerOpen((current) => !current)}>{pickerOpen ? 'Close' : 'Filters'}</Button>
                  </div>
                  {pickerOpen && (
                    <Panel title="Choose forms" subtitle="Pick the returns used for this branch and tax year.">
                      <div style={{ display: 'flex', gap: 6 }}>
                        {Object.keys(supportedPresets).map((name) => (
                          <div key={name} onClick={() => setPreset(name)} style={{ padding: 8, backgroundColor: preset === name ? t.secondary : t.bg, borderRadius: 6 }}>
                            <text style={{ color: t.fg, fontSize: 11 }}>{name}</text>
                          </div>
                        ))}
                      </div>
                      <input testId="catalog-search" value={search} placeholder="Search by form name or code" onChange={(event) => setSearch(event.value ?? '')} style={{ height: 36, minHeight: 36, padding: 9, color: t.fg, backgroundColor: t.bg, borderWidth: 1, borderColor: t.input, borderRadius: 6 }} />
                      <div style={{ maxHeight: 300, overflow: 'scroll', borderWidth: 1, borderColor: t.border, borderRadius: 8 }}>
                        {(search ? filteredCatalog : visibleCatalog).filter((entry) => search || availablePresetCodes.has(entry.code)).map(pickerRow)}
                      </div>
                      <Button testId="add-selected-forms" disabled={!pendingCodes.length} onClick={addSelectedForms}>{`Add selected ${pendingCodes.length || ''}`}</Button>
                    </Panel>
                  )}
                  {selectedLibrary.length === 0 && <Panel title="Your form library is empty" subtitle="Choose forms to add returns for this year." />}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
                    {selectedLibrary
                      .filter((entry) => {
                        const needle = formFilter.trim().toLowerCase()
                        if (!needle) return true
                        const catalogEntry = catalog.find((item) => item.code === entry.formCode)
                        return (
                          entry.formCode.toLowerCase().includes(needle) ||
                          (catalogEntry?.label ?? '').toLowerCase().includes(needle)
                        )
                      })
                      .map(periodCard)}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  function legacyFormPage() {
    const currentStatus = draft?.status ?? 'draft'
    const stages: DraftStatus[] = ['draft', 'queued', 'submitted', 'confirmed', 'paid']
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottomWidth: 1, borderColor: t.border }}>
          <Button quiet onClick={() => void closeForm()}>← Back</Button>
          <text style={{ color: t.fg, fontSize: 17, fontWeight: 700 }}>{formEntry?.label ?? 'Return'}</text>
          <div
            onMouseEnter={() => setShowPrintTip(true)}
            onMouseLeave={() => setShowPrintTip(false)}
            style={{ position: 'relative' }}
          >
            <Button quiet disabled onClick={() => {}}>Print preview</Button>
            {showPrintTip && (
              <div style={{
                position: 'absolute', top: 42, right: 0,
                padding: 8, borderWidth: 1, borderColor: t.border,
                borderRadius: 6, backgroundColor: t.chrome,
              }}>
                <text style={{ color: t.fg, fontSize: 11 }}>Coming in P5</text>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: 12, borderBottomWidth: 1, borderColor: t.border }}>
          {stages.map((stage, index) => (
              <div key={stage} onClick={() => updateDraftStatus(stage)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: 8, backgroundColor: index <= stages.indexOf(currentStatus) ? t.primary : t.border }} />
              <text style={{ color: index <= stages.indexOf(currentStatus) ? t.fg : t.mutedFg, fontSize: 11 }}>{stage[0].toUpperCase() + stage.slice(1)}</text>
              {index < stages.length - 1 && <text style={{ color: t.border }}>—</text>}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 18, flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>
          {draft && (
            <Panel title="Taxpayer facts · auto-filled" subtitle={`${formatTin(selectedProfile?.tin9 ?? '', selectedProfile?.branch)} · ${draft.period}`}>
              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                <text style={{ color: t.mutedFg, fontSize: 12 }}>{taxpayer?.name ?? selectedProfile?.registeredName}</text>
                <text style={{ color: t.mutedFg, fontSize: 12 }}>{branch?.facts.rdo ? `RDO ${branch.facts.rdo}` : 'RDO —'}</text>
                <text style={{ color: t.mutedFg, fontSize: 12 }}>{branch?.facts.address ?? 'Address —'}</text>
                <text style={{ color: t.mutedFg, fontSize: 12 }}>{branch?.facts.zip ?? 'ZIP —'}</text>
              </div>
            </Panel>
          )}
          {editorModel.bannerErrorText && (
            <Panel title="Review required"><text style={{ color: t.danger, fontSize: 12 }}>{editorModel.bannerErrorText}</text></Panel>
          )}
          {formLoading && <text style={{ color: t.mutedFg }}>Opening official form…</text>}
          {editorModel.sections.map((section, index) => (
            <Panel key={`${section.section ?? 'other'}-${index}`} title={section.section ?? 'Return fields'}>
              {section.rows.map((row) => (
                <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 8, borderBottomWidth: 1, borderColor: t.border }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {row.item && <text style={{ color: t.mutedFg, fontSize: 10, width: 48 }}>{row.item}</text>}
                    <text style={{ color: t.fg, fontSize: 12, flexGrow: 1 }}>{row.label || row.name}</text>
                    {row.locked && <text style={{ color: t.mutedFg, fontSize: 9 }}>AUTO</text>}
                    {row.type === 'checkbox' ? (
                      <div onClick={() => editField(row.fields[0], !Boolean(editorValues[row.fields[0].id]))} style={{ width: 30, height: 25, display: 'flex', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 5, backgroundColor: t.bg }}>
                        <text style={{ color: t.fg }}>{editorValues[row.fields[0].id] ? '✓' : ''}</text>
                      </div>
                    ) : row.type === 'radio' ? (
                      <div style={{ display: 'flex', gap: 4 }}>
                        {row.fields.map((field) => (
                          <div key={field.id} onClick={() => editField(field, true)} style={{ padding: 8, borderWidth: 1, borderColor: Boolean(editorValues[field.id]) ? t.primary : t.border, borderRadius: 5, backgroundColor: Boolean(editorValues[field.id]) ? t.secondary : t.bg }}>
                            <text style={{ color: t.fg, fontSize: 11 }}>{field.label || field.value || field.id}</text>
                          </div>
                        ))}
                      </div>
                    ) : row.type === 'select-one' ? (
                      <Select value={String(editorValues[row.fields[0].id] ?? '')} onValueChange={(value) => editField(row.fields[0], value)} disabled={row.locked || row.fields[0].disabled}>
                        <SelectTrigger style={{ width: 250, height: 32 }}><SelectValue placeholder="Select" /></SelectTrigger>
                        <SelectContent>{row.fields[0].options?.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                      </Select>
                    ) : (
                      <input
                        testId={`field-${row.fields[0].id}`}
                        value={String(editorValues[row.fields[0].id] ?? '')}
                        readOnly={row.locked || row.fields[0].disabled}
                        onChange={(event) => editField(row.fields[0], event.value ?? '')}
                        style={{
                          width: row.label.toLowerCase().includes('amount') ? 180 : 280,
                          height: 32, padding: 8, textAlign: row.label.toLowerCase().includes('amount') ? 'right' : 'left',
                          color: row.locked || row.fields[0].disabled ? t.mutedFg : t.fg,
                          backgroundColor: row.locked || row.fields[0].disabled ? t.muted : t.bg,
                          borderWidth: 1, borderColor: t.input, borderRadius: 5,
                        }}
                      />
                    )}
                  </div>
                  <div style={{ minHeight: 16, height: 16 }}>
                    <text style={{ color: row.errorText ? t.danger : t.mutedFg, fontSize: 10 }}>{row.errorText}</text>
                  </div>
                </div>
              ))}
            </Panel>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderColor: t.border, backgroundColor: t.chrome }}>
          <Button quiet testId="validate-return" onClick={() => formInstance && refreshEditor(formInstance)}>Validate</Button>
          <Button testId="save-return" onClick={saveDraft}>Save draft</Button>
        </div>
      </div>
    )
  }

  function formPage() {
    if (!formEntry) return legacyFormPage()
    const currentStatus = draft?.status ?? 'draft'
    const stages: DraftStatus[] = ['draft', 'queued', 'submitted', 'confirmed', 'paid']
    const currentIndex = stages.indexOf(currentStatus)
    const trackerDots = [
      { left: 12, top: 0 },
      { left: 20, top: 4 },
      { left: 24, top: 12 },
      { left: 20, top: 20 },
      { left: 12, top: 24 },
      { left: 4, top: 20 },
      { left: 0, top: 12 },
      { left: 4, top: 4 },
    ]
    const revision =
      formEntry.formCode === '1601Cv2018' || formEntry.formCode === '2551Qv2018'
        ? 'January 2018 (ENCS)'
        : formEntry.formCode === '0619E'
          ? 'January 2018'
          : ''

    function control(field: FieldSnapshot, width = 270) {
      const locked = editorModel.sections.some((section) =>
        section.rows.some((row) => row.fields.some((entry) => entry.id === field.id && row.locked)),
      ) || field.disabled
      if (field.type === 'select-one') {
        return (
          <Select value={String(editorValues[field.id] ?? '')} onValueChange={(value) => editField(field, value)} disabled={locked}>
            <SelectTrigger style={{ width, height: 36 }}><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>{field.options?.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        )
      }
      if (field.type === 'checkbox') {
        return (
          <div onClick={() => !locked && editField(field, !Boolean(editorValues[field.id]))} style={{ width: 30, height: 30, display: 'flex', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 5, backgroundColor: locked ? t.muted : t.bg }}>
            <text style={{ color: t.fg, fontSize: 15 }}>{editorValues[field.id] ? '✓' : ''}</text>
          </div>
        )
      }
      return (
        <input
          testId={`field-${field.id}`}
          value={String(editorValues[field.id] ?? '')}
          readOnly={locked}
          onChange={(event) => editField(field, event.value ?? '')}
          style={{
            width,
            height: 36,
            padding: 8,
            textAlign: field.label.toLowerCase().includes('amount') ? 'right' : 'left',
            color: locked ? t.mutedFg : t.fg,
            backgroundColor: locked ? t.muted : t.bg,
            borderWidth: 1,
            borderColor: t.input,
            borderRadius: 5,
          }}
        />
      )
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 12, borderBottomWidth: 1, borderColor: t.border }}>
          <Button quiet testId="form-back" onClick={() => closeForm()}>‹ Back</Button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Button quiet testId="form-dismiss" onClick={() => closeForm()}>Dismiss</Button>
            <Button quiet testId="form-overflow" onClick={() => {}}>⋯</Button>
          <div
            onMouseEnter={() => setShowPrintTip(true)}
            onMouseLeave={() => setShowPrintTip(false)}
            style={{ position: 'relative' }}
          >
            <Button quiet disabled onClick={() => {}}>Print Preview</Button>
            {showPrintTip && <div style={{ position: 'absolute', top: 42, right: 0, padding: 8, borderWidth: 1, borderColor: t.border, borderRadius: 6, backgroundColor: t.chrome }}><text style={{ color: t.fg, fontSize: 11 }}>Coming in P5</text></div>}
          </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 14 }}>
          <text style={{ color: t.fg, fontSize: 25, fontWeight: 800, whiteSpace: 'nowrap' }}>BIR Form No. {displayFormCode(formEntry.formCode)}</text>
          <text style={{ color: t.fg, fontSize: 15, textAlign: 'center' }}>{cleanFormTitle(formEntry.label)}</text>
          {revision && <text style={{ color: t.mutedFg, fontSize: 11 }}>{revision}</text>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 12, borderBottomWidth: 1, borderColor: t.border }}>
          {stages.map((stage, index) => (
            <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div testId={`stage-${stage}`} onClick={() => updateDraftStatus(stage)} style={{
                width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
                position: 'relative',
                borderWidth: index > currentIndex ? 0 : 2,
                borderColor: index < currentIndex ? t.good : index === currentIndex ? t.primary : t.border,
                borderRadius: 18, backgroundColor: index < currentIndex ? t.good : index === currentIndex ? t.primary : t.bg,
              }}>
                {index > currentIndex && trackerDots.map((dot, dotIndex) => (
                  <div key={dotIndex} style={{ position: 'absolute', left: dot.left, top: dot.top, width: 4, height: 4, borderRadius: 2, backgroundColor: t.border }} />
                ))}
                <text style={{ color: index < currentIndex ? '#ffffff' : index === currentIndex ? t.primaryFg : t.mutedFg, fontSize: 12, fontWeight: 700 }}>{index < currentIndex ? '✓' : String(index + 1)}</text>
              </div>
              <text style={{ color: index <= currentIndex ? t.fg : t.mutedFg, fontSize: 11 }}>{stage[0].toUpperCase() + stage.slice(1)}</text>
              {index < stages.length - 1 && <div style={{ width: 28, height: 2, backgroundColor: index < currentIndex ? t.good : t.border }} />}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexGrow: 1, minHeight: 0, overflow: 'scroll', padding: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: 720, maxWidth: '100%' }}>
            {draft && (
              <Panel title="TAXPAYER PROFILE">
                {(() => {
                  const [yearPart, periodPart] = draft.period.split('-')
                  const isMonth = /^\d{2}$/.test(periodPart ?? '')
                  const isQuarter = /^Q\d$/.test(periodPart ?? '')
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <text style={{ color: t.mutedFg, fontSize: 11 }}>
                        {isMonth
                          ? `1 For the Month (MM): ${periodPart}   For the Year (YYYY): ${yearPart}`
                          : isQuarter
                            ? `1 For the Quarter: ${periodPart}   For the Year (YYYY): ${yearPart}`
                            : `1 For the Year (YYYY): ${yearPart}`}
                      </text>
                      <text style={{ color: t.fg, fontSize: 15, fontWeight: 700 }}>{(taxpayer?.name ?? selectedProfile?.registeredName ?? '').toUpperCase()}</text>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                        <text style={{ color: t.mutedFg, fontSize: 11 }}>TIN: {formatTin(selectedProfile?.tin9 ?? '', selectedProfile?.branch)}</text>
                        <text style={{ color: t.mutedFg, fontSize: 11 }}>RDO Code: {branch?.facts.rdo ?? '-'}</text>
                        <text style={{ color: t.mutedFg, fontSize: 11 }}>Address: {branch?.facts.address ?? '-'}</text>
                        <text style={{ color: t.mutedFg, fontSize: 9, padding: 3, borderRadius: 10, backgroundColor: t.muted }}>AUTO</text>
                      </div>
                    </div>
                  )
                })()}
              </Panel>
            )}
            {editorModel.bannerErrorText && (
              <Panel title="Review required"><text style={{ color: t.danger, fontSize: 12 }}>{editorModel.bannerErrorText}</text></Panel>
            )}
            {formLoading && <text style={{ color: t.mutedFg }}>Opening official form.</text>}
            {editorModel.sections.map((section, index) => {
              const filled = section.rows.filter((row) =>
                row.fields.some((field) => {
                  const value = editorValues[field.id]
                  return value !== undefined && value !== '' && value !== false
                }),
              ).length
              return (
              <Panel key={`${section.section ?? 'other'}-${index}`} title={section.section ?? 'Part I - Background Information'} aside={`${filled} of ${section.rows.length} rows`}>
                {section.rows.map((row) => {
                  const fields = row.fields
                  const radios = row.kind === 'radio' || (row.kind === 'period' && fields.some((field) => field.type === 'radio'))
                  const renderRowControls = () => {
                    if (row.kind === 'tin') {
                      return <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{fields.map((field, fieldIndex) => control(field, fieldIndex === 3 ? 82 : 60))}</div>
                    }
                    if (row.kind === 'period') {
                      return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{fields.map((field) => field.type === 'radio' ? (
                        <div key={field.id} onClick={() => editField(field, true)} style={{ padding: 8, borderWidth: 1, borderColor: editorValues[field.id] ? t.primary : t.border, borderRadius: 6, backgroundColor: editorValues[field.id] ? t.secondary : t.bg }}>
                          <text style={{ color: t.fg, fontSize: 11 }}>{field.optionLabel || 'Option'}</text>
                        </div>
                      ) : <div key={field.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}><text style={{ color: t.mutedFg, fontSize: 10 }}>{field.label}</text>{control(field, field.type === 'select-one' ? 150 : 100)}</div>)}</div>
                    }
                    if (radios) {
                      return <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{fields.map((field) => (
                        <div key={field.id} onClick={() => editField(field, true)} style={{ padding: 8, borderWidth: 1, borderColor: editorValues[field.id] ? t.primary : t.border, borderRadius: 6, backgroundColor: editorValues[field.id] ? t.secondary : t.bg }}>
                          <text style={{ color: t.fg, fontSize: 11 }}>{field.optionLabel || 'Option'}</text>
                        </div>
                      ))}</div>
                    }
                    if (fields.length > 1) {
                      return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{fields.map((field) => <div key={field.id}>{control(field, 110)}</div>)}</div>
                    }
                    return control(fields[0])
                  }
                  return (
                    <div key={row.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 7, borderBottomWidth: 1, borderColor: t.border }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 40 }}>
                        {row.item && <text style={{ color: t.mutedFg, fontSize: 10, width: 34, height: 24, padding: 4, borderRadius: 6, backgroundColor: t.secondary }}>{row.item}</text>}
                        <text style={{ color: t.fg, fontSize: 12, flexGrow: 1, minWidth: 0 }}>{row.label || 'Return field'}</text>
                        {row.locked && <text style={{ color: t.mutedFg, fontSize: 9, padding: 3, borderRadius: 10, backgroundColor: t.muted }}>AUTO</text>}
                        {renderRowControls()}
                      </div>
                      <div style={{ minHeight: 18, height: 18 }}>
                        <text style={{ color: row.errorText ? t.danger : t.mutedFg, fontSize: 10 }}>{row.errorText}</text>
                      </div>
                    </div>
                  )
                })}
              </Panel>
              )
            })}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', width: 720, maxWidth: '100%', alignSelf: 'center', gap: 8, padding: 12, borderTopWidth: 1, borderColor: t.border, backgroundColor: t.chrome }}>
          <Button quiet testId="validate-return" onClick={() => formInstance && refreshEditor(formInstance)}>Validate</Button>
          <Button testId="save-return" onClick={saveDraft}>Save draft</Button>
        </div>
      </div>
    )
  }

  function titleBar() {
    const iconButton = (
      key: string,
      content: ReactNode,
      action: () => void,
      options: { disabled?: boolean; danger?: boolean } = {},
    ) => (
      <div
        key={key}
        testId={`tb-${key}`}
        onClick={() => !options.disabled && action()}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 38,
          height: 42,
          cursor: options.disabled ? 'default' : 'pointer',
          opacity: options.disabled ? 0.35 : 1,
          hover: options.disabled
            ? {}
            : { backgroundColor: options.danger ? '#e81123' : t.muted, color: options.danger ? '#ffffff' : t.fg },
        }}
      >
        {content}
      </div>
    )
    const glyph = (label: string, color?: string, weight = 500, size = 15) => (
      <text style={{ color: color ?? t.fg, fontSize: size, fontWeight: weight }}>{label}</text>
    )
    const sidePanelGlyph = (side: 'left' | 'right', active: boolean) => (
      <div style={{ width: 17, height: 14, display: 'flex', borderWidth: 1, borderColor: active ? t.primary : t.mutedFg, borderRadius: 3, overflow: 'hidden' }}>
        {side === 'left' && <div style={{ width: 5, backgroundColor: active ? t.primary : t.mutedFg }} />}
        <div style={{ flexGrow: 1 }} />
        {side === 'right' && <div style={{ width: 5, backgroundColor: active ? t.primary : t.mutedFg }} />}
      </div>
    )
    const separator = <div style={{ width: 1, height: 20, marginLeft: 6, marginRight: 6, backgroundColor: t.border }} />
    return (
      <div style={{ display: 'flex', alignItems: 'center', height: 42, minHeight: 42, paddingLeft: isMac ? 78 : 0, backgroundColor: t.chrome, borderBottomWidth: 1, borderColor: t.border }}>
        {isWin && (
          <>
            {iconButton('close', glyph('✕'), () => closeWindow(WINDOW_TITLE), { danger: true })}
            {iconButton('min', glyph('─'), () => gpuix.minimizeWindow?.())}
            {iconButton('max', glyph('▢'), () => gpuix.zoomWindow?.())}
            {separator}
          </>
        )}
        {iconButton('nav-back', glyph('←', canNavBack ? t.fg : t.mutedFg), () => navJump(-1), { disabled: !canNavBack })}
        {iconButton('nav-fwd', glyph('→', canNavFwd ? t.fg : t.mutedFg), () => navJump(1), { disabled: !canNavFwd })}
        {separator}
        {iconButton('sidebar-left', sidePanelGlyph('left', !sidebarCollapsed), () => setSidebarCollapsed((value) => !value))}
        {iconButton('search', glyph('⌕'), focusSidebarSearch)}
        {iconButton('new-taxpayer', glyph('+', undefined, 600, 17), openNewTaxpayer)}
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
          style={{ flexGrow: 1, height: '100%' }}
        />
        {iconButton('sidebar-right', sidePanelGlyph('right', rightSidebar), () => setRightSidebar((value) => !value))}
      </div>
    )
  }

  function notificationsPanel() {
    const rank = (level: LogLevel) => (level === 'error' ? 0 : level === 'warn' ? 1 : level === 'info' ? 2 : 3)
    const entries = [...logs]
      .sort((a, b) => rank(a.level) - rank(b.level) || b.ts.localeCompare(a.ts))
      .slice(0, 80)
    const alerts = logs.filter((entry) => entry.level === 'error' || entry.level === 'warn').length
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: 300, minWidth: 300, backgroundColor: t.chrome, borderLeftWidth: 1, borderColor: t.border }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 10, borderBottomWidth: 1, borderColor: t.border }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <text style={{ color: t.fg, fontSize: 13, fontWeight: 700 }}>Notifications</text>
            {alerts > 0 && <text style={{ color: '#ffffff', fontSize: 10, padding: 4, borderRadius: 9, backgroundColor: t.danger }}>{alerts}</text>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div testId="theme-quick-toggle" onClick={() => setThemeMode((mode) => (mode === 'light' ? 'dark' : 'light'))} style={{ padding: 6, cursor: 'pointer' }}>
              <text style={{ color: t.mutedFg, fontSize: 14 }}>{themeMode === 'light' ? '☾' : '☀'}</text>
            </div>
            <div testId="notifications-close" onClick={() => setRightSidebar(false)} style={{ padding: 6, cursor: 'pointer' }}>
              <text style={{ color: t.mutedFg, fontSize: 14 }}>✕</text>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, flexGrow: 1, minHeight: 0, overflow: 'scroll' }}>
          {entries.length === 0 && <text style={{ color: t.mutedFg, fontSize: 12 }}>No notifications yet.</text>}
          {entries.map((entry, index) => (
            <div key={`${entry.ts}-${index}`} style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: 9, borderWidth: 1, borderColor: t.border, borderRadius: 7, backgroundColor: t.bg }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <text style={{ color: entry.level === 'error' ? t.danger : entry.level === 'warn' ? t.warning : t.mutedFg, fontSize: 10, fontWeight: 700 }}>{entry.level.toUpperCase()}</text>
                <text style={{ color: t.mutedFg, fontSize: 10 }}>{entry.scope}</text>
                <div style={{ flexGrow: 1 }} />
                <text style={{ color: t.mutedFg, fontSize: 9 }}>{new Date(entry.ts).toLocaleTimeString()}</text>
              </div>
              <text style={{ color: t.fg, fontSize: 11 }}>{entry.msg}</text>
            </div>
          ))}
        </div>
        <div style={{ padding: 8, borderTopWidth: 1, borderColor: t.border }}>
          <div testId="notifications-open-logs" onClick={() => navTo({ ...navNow, page: 'logs', formCode: undefined, period: undefined })} style={{ padding: 6, cursor: 'pointer' }}>
            <text style={{ color: t.primary, fontSize: 11 }}>Open full logs</text>
          </div>
        </div>
      </div>
    )
  }

  function sidebar() {
    const navItems: Array<[NavPage, string, string]> = [
      ['import', 'Import Data', '⇩'],
      ['tasks', 'Background Tasks', '▤'],
      ['calendar', 'Tax Calendars', '▦'],
      ['settings', 'Settings', '⚙'],
    ]
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: sidebarCollapsed ? 64 : 250, minWidth: sidebarCollapsed ? 64 : 250, padding: 12, gap: 10, backgroundColor: t.chrome, borderRightWidth: 1, borderColor: t.border }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 7 }}>
          {!sidebarCollapsed && <text style={{ color: t.fg, fontSize: 18, fontWeight: 800 }}>eBIRForms</text>}
          <div testId="sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)}><text style={{ color: t.mutedFg }}>{sidebarCollapsed ? '›' : '‹'}</text></div>
        </div>
        {!sidebarCollapsed && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 6 }}>
              <text style={{ color: t.mutedFg, fontSize: 10, fontWeight: 700 }}>TAXPAYERS</text>
              <div testId="add-taxpayer" onClick={openNewTaxpayer} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: t.secondary }}>
                <text style={{ color: t.fg, fontSize: 17 }}>+</text>
              </div>
            </div>
            <input ref={searchInputRef} testId="taxpayer-search" value={taxpayerSearch} onChange={(event) => setTaxpayerSearch(event.value ?? '')} placeholder="Search TIN or name" style={{ height: 36, minHeight: 36, padding: 9, color: t.fg, backgroundColor: t.bg, borderWidth: 1, borderColor: t.input, borderRadius: 6 }} />
            <div testId="taxpayer-tree" style={{ display: 'flex', flexDirection: 'column', gap: 8, flexGrow: 1, overflow: 'scroll' }}>
              {filteredTaxpayers.map((item) => (
                <div key={item.tin9} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div onClick={() => item.branches[0] && chooseBranch(item.tin9, item.branches[0].code)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 7, borderRadius: 7, backgroundColor: selectedTin === item.tin9 ? t.secondary : t.chrome }}>
                    <text style={{ color: t.mutedFg, fontSize: 12 }}>⌄</text>
                    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <text style={{ color: t.fg, fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{item.name || formatTin(item.tin9)}</text>
                      <text style={{ color: t.mutedFg, fontSize: 10, whiteSpace: 'nowrap' }}>
                        TIN: {formatTin(item.tin9).split('-').slice(0, 3).join('-')}
                      </text>
                    </div>
                  </div>
                  {item.branches.map((branchItem) => (
                    <div key={branchItem.code} testId={`branch-${item.tin9}-${branchItem.code}`} onClick={() => chooseBranch(item.tin9, branchItem.code)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginLeft: 15, padding: 7, borderRadius: 6, backgroundColor: selectedBranchId === branchId(item.tin9, branchItem.code) ? t.accent : t.chrome }}>
                      <text style={{ color: t.fg, fontSize: 11, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{branchItem.name}</text>
                      <text style={{ color: t.mutedFg, fontSize: 10, fontFamily: 'Consolas, monospace', padding: 3, borderRadius: 5, backgroundColor: t.secondary }}>{branchItem.code}</text>
                    </div>
                  ))}
                  <div testId={`add-branch-${item.tin9}`} onClick={() => {
                    setShowNewBranch(true)
                    navTo({
                      ...navNow,
                      page: 'taxpayer',
                      tab: 'details',
                      tin: item.tin9,
                      branchId: item.branches[0] ? branchId(item.tin9, item.branches[0].code) : undefined,
                      profileId: undefined,
                      formCode: undefined,
                      period: undefined,
                    })
                  }} style={{ marginLeft: 15, padding: 6, borderRadius: 6 }}>
                    <text style={{ color: t.mutedFg, fontSize: 10 }}>+ Add branch</text>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTopWidth: 1, borderColor: t.border, paddingTop: 8 }}>
          {navItems.map(([id, label, icon]) => (
            <div key={id} testId={`nav-${id}`} onClick={() => navTo({ ...navNow, page: id, formCode: undefined, period: undefined })} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 10, borderRadius: 8, backgroundColor: page === id ? t.secondary : t.chrome }}>
              <text style={{ color: t.mutedFg, fontSize: 15, width: 18 }}>{icon}</text>
                {!sidebarCollapsed && <text style={{ color: page === id ? t.fg : t.mutedFg, fontSize: 12 }}>{label}</text>}
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 4 }}>
            <text style={{ color: t.mutedFg, fontSize: 9, padding: 4, borderRadius: 8, backgroundColor: t.secondary }}>Dev</text>
          </div>
        </div>
      </div>
    )
  }

  function taskPage() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <text style={{ color: t.fg, fontSize: 24, fontWeight: 700 }}>Background tasks</text>
        {queueJobs.map((job) => (
          <Panel key={job.id} title={`${job.kind} · ${job.state}`} subtitle={`Attempts ${job.attempts}/${job.maxAttempts}`}>
            <text style={{ color: job.lastError ? t.danger : t.mutedFg, fontSize: 12 }}>{job.lastError ?? JSON.stringify(job.payload)}</text>
          </Panel>
        ))}
      </div>
    )
  }

  function logsPage() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flexGrow: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <text style={{ color: t.fg, fontSize: 24, fontWeight: 700 }}>Logs</text>
          <Select value={logFilter} onValueChange={(value) => setLogFilter(value as LogFilter)}>
            <SelectTrigger style={{ width: 140, height: 34 }}><SelectValue /></SelectTrigger>
            <SelectContent>{(['all', 'debug', 'info', 'warn', 'error'] as LogFilter[]).map((level) => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflow: 'scroll' }}>
          {shownLogs.map((entry, index) => (
            <div key={`${entry.ts}-${index}`} style={{ display: 'flex', gap: 10, padding: 9, backgroundColor: t.chrome, borderWidth: 1, borderColor: t.border, borderRadius: 6 }}>
              <text style={{ color: t.mutedFg, fontSize: 10 }}>{new Date(entry.ts).toLocaleTimeString()}</text>
              <text style={{ color: entry.level === 'error' ? t.danger : entry.level === 'warn' ? t.warning : t.fg, fontSize: 10, width: 48 }}>{entry.level}</text>
              <text style={{ color: t.mutedFg, fontSize: 10, width: 72 }}>{entry.scope}</text>
              <text style={{ color: t.fg, fontSize: 11, flexGrow: 1 }}>{entry.msg}</text>
            </div>
          ))}
        </div>
      </div>
    )
  }

  function mainContent() {
    if (page === 'form') return formPage()
    if (page === 'taxpayer') return taxpayerPage()
    if (page === 'tasks') return taskPage()
    if (page === 'logs') return logsPage()
    if (page === 'calendar') return <Panel title="Tax calendars" subtitle="Coming in a future release." />
    if (page === 'import') return <Panel title="Import data" subtitle="Coming in P5."><text style={{ color: t.mutedFg, fontSize: 13 }}>eBIR package and official-app data import land with the filing pipeline.</text></Panel>
    return (
      <Panel title="Settings">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <text style={{ color: t.fg, fontSize: 13 }}>Appearance</text>
          <Button testId="theme-toggle" quiet onClick={() => setThemeMode((mode) => mode === 'light' ? 'dark' : 'light')}>{themeMode === 'light' ? 'Switch to dark' : 'Switch to light'}</Button>
        </div>
        <text style={{ color: t.mutedFg, fontSize: 12 }}>Theme preference is saved on this device.</text>
      </Panel>
    )
  }

  const sftpMode = describeSftpConfig(loadSftpConfig())
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', backgroundColor: t.bg, fontFamily: 'Bricolage Grotesque, sans-serif' }}>
      {titleBar()}
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        {sidebar()}
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, padding: 20 }}>
            {mainContent()}
          </div>
        </div>
        {rightSidebar && notificationsPanel()}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 7, borderTopWidth: 1, borderColor: t.border, backgroundColor: t.chrome }}>
        <text style={{ color: t.mutedFg, fontSize: 10 }}>{sftpMode}</text>
      </div>
    </div>
  )
}

render(<><FontRegistration /><App /></>, { title: WINDOW_TITLE, width: 1440, height: 940, titlebarTransparent: true })
