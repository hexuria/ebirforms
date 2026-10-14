import { useEffect, useState, type ReactNode } from 'react'
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
} from '@gpuix/react'
import {
  autoFieldIds,
  buildEditorModel,
  buildPrefillValues,
  mergeDraftPrefill,
  type PrefillFormCode,
} from './editor-model.js'
import { themes, type ThemeMode, type ThemeTokens } from './theme.js'

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

type NavPage = 'taxpayer' | 'tasks' | 'logs' | 'calendar' | 'settings' | 'form'
type TaxpayerTab = 'details' | 'forms' | 'templates'
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
  children,
}: {
  title: string
  subtitle?: string
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
      <div>
        <text style={{ color: t.fg, fontSize: 15, fontWeight: 700 }}>{title}</text>
        {subtitle && <text style={{ color: t.mutedFg, fontSize: 12 }}>{subtitle}</text>}
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

  useEffect(() => queue.onChange(setQueueJobs), [])
  useEffect(() => logger.subscribe((entry) => setLogs((current) => [...current.slice(-999), entry])), [])
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

  function chooseBranch(tin9: string, code: string) {
    const id = branchId(tin9, code)
    const item = tree.find((entry) => entry.tin9 === tin9)?.branches.find((entry) => entry.code === code)
    setSelectedTin(tin9)
    setSelectedBranchId(id)
    setSelectedProfileId(item?.years.at(-1)?.id)
    setPage('taxpayer')
  }

  function chooseProfile(profile: Profile) {
    setSelectedTin(profile.tin9)
    setSelectedBranchId(branchId(profile.tin9, profile.branch))
    setSelectedProfileId(profile.id)
    setPage('taxpayer')
    setTab('forms')
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
      })
      refreshTree(taxpayer.tin9, branchId(taxpayer.tin9, branch.code), profile.id)
      setStatusMessage(`${profile.year} added.`)
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

  async function openForm(entry: LibraryEntry, period: string) {
    if (!selectedProfile || !['1601Cv2018', '2551Qv2018', '0619E'].includes(entry.formCode)) return
    const code = entry.formCode as PrefillFormCode
    const previous = store.listDrafts(selectedProfile.id, code).find((item) => item.period === period)
    const opened = store.openDraft(selectedProfile.id, code, period)
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
      const prefillValues = buildPrefillValues(code, selectedProfile, form.fields(), period)
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

  async function closeForm() {
    await formInstance?.close()
    setFormInstance(null)
    setFormEntry(null)
    setDraft(null)
    setPage('taxpayer')
    setTab('forms')
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

  function statusColor(status: DraftStatus) {
    return status === 'confirmed' || status === 'paid'
      ? t.success
      : status === 'submitted'
        ? t.warning
        : status === 'queued'
          ? t.primary
          : t.mutedFg
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
      <div key={entry.formCode} style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, borderWidth: 1, borderColor: t.border, borderRadius: 10, backgroundColor: t.chrome }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <text style={{ color: t.fg, fontSize: 13, fontWeight: 700, width: 112, minWidth: 112 }}>{entry.formCode}</text>
          <text style={{ color: t.mutedFg, fontSize: 11, flexGrow: 1, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{form.label}</text>
          <text style={{ color: t.mutedFg, fontSize: 10 }}>{form.frequency}</text>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {choices.map((choice) => {
            const status = statusFor(entry, choice.period)
            return (
              <div
                key={choice.period}
                testId={`period-${entry.formCode}-${choice.period}`}
                onClick={() => void openForm(entry, choice.period)}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center',
                  padding: 10, width: form.frequency === 'monthly' ? '15%' : '23%',
                  minWidth: form.frequency === 'monthly' ? 62 : 86,
                  borderWidth: 1, borderColor: t.border, borderRadius: 7,
                  cursor: 'pointer', backgroundColor: t.bg,
                }}
              >
                <text style={{ color: t.fg, fontSize: 12 }}>{choice.label}</text>
                <text style={{ color: status ? statusColor(status) : t.mutedFg, fontSize: 9 }}>
                  {status ?? 'OPEN'}
                </text>
              </div>
            )
          })}
        </div>
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
          <div style={{ display: 'flex', gap: 12 }}>
            {(['individual', 'non-individual'] as const).map((type) => (
              <div key={type} onClick={() => setNewTaxpayer((current) => ({ ...current, type }))} style={{ display: 'flex', gap: 6 }}>
                <text style={{ color: t.fg }}>{newTaxpayer.type === type ? '◉' : '○'} {type}</text>
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
        <Panel title="Add a taxpayer" subtitle="Taxpayer and branch facts are shared by their tax-year profiles.">
          <Button onClick={() => setShowNewTaxpayer(true)}>New taxpayer</Button>
        </Panel>
      )
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Panel title="Taxpayer details" subtitle="Shared identity across all branches and years.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <Field label="TIN" value={formatTin(taxpayer.tin9)} disabled auto />
            <Field label="Name" value={taxpayerEdit.name} onChange={(value) => setTaxpayerEdit((current) => ({ ...current, name: value }))} />
            <Field label="Birth date" value={taxpayerEdit.birthDate} onChange={(value) => setTaxpayerEdit((current) => ({ ...current, birthDate: value }))} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['individual', 'non-individual'] as const).map((type) => (
              <div key={type} onClick={() => setTaxpayerEdit((current) => ({ ...current, type }))} style={{ padding: 8, borderRadius: 6, backgroundColor: taxpayerEdit.type === type ? t.secondary : t.bg }}>
                <text style={{ color: t.fg, fontSize: 12 }}>{taxpayerEdit.type === type ? '●' : '○'} {type}</text>
              </div>
            ))}
            <Button onClick={saveTaxpayerDetails}>Save taxpayer</Button>
          </div>
        </Panel>
        <Panel title={`${branch.name} · ${branch.code}`} subtitle="Blank branch facts inherit from head office.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <Field label="Branch name" value={branchEdit.name} onChange={(value) => setBranchEdit((current) => ({ ...current, name: value }))} />
            {(['rdo', 'zip', 'address', 'phone', 'email'] as const).map((field) => (
              <Field
                key={field}
                label={field.toUpperCase()}
                value={branchEdit[field]}
                onChange={(value) => setBranchEdit((current) => ({ ...current, [field]: value }))}
                auto={branch.code !== '00000' && branch.facts.inherited[field]}
                placeholder={branch.code !== '00000' && branch.facts.inherited[field] ? `Inherited: ${branch.facts[field] ?? '—'}` : ''}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={saveBranchDetails}>Save branch</Button>
            <Button quiet onClick={() => setShowNewBranch((current) => !current)}>Add branch</Button>
          </div>
          {showNewBranch && (
            <Panel title="New branch">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                <Field label="Branch code" value={newBranch.code} onChange={(value) => setNewBranch((current) => ({ ...current, code: value.replace(/\D/g, '').slice(0, 5) }))} error={branchError} />
                <Field label="Branch name" value={newBranch.name} onChange={(value) => setNewBranch((current) => ({ ...current, name: value }))} />
                {(['rdo', 'zip', 'address', 'phone', 'email'] as const).map((field) => (
                  <Field key={field} label={field.toUpperCase()} value={newBranch[field]} onChange={(value) => setNewBranch((current) => ({ ...current, [field]: value }))} />
                ))}
              </div>
              <Button onClick={addBranch}>Create branch</Button>
            </Panel>
          )}
        </Panel>
        <Panel title="Tax years" subtitle="Each year has its own selected forms and period drafts.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {branch.years.map((profile) => (
              <div key={profile.id} onClick={() => setSelectedProfileId(profile.id)} style={{ padding: 10, borderWidth: 1, borderColor: selectedProfile?.id === profile.id ? t.primary : t.border, borderRadius: 7 }}>
                <text style={{ color: t.fg }}>{profile.year}</text>
              </div>
            ))}
            <input testId="new-year-input" value={yearInput} onChange={(event) => setYearInput(event.value ?? '')} style={{ width: 84, height: 34, padding: 7, color: t.fg, backgroundColor: t.bg, borderWidth: 1, borderColor: t.input, borderRadius: 6 }} />
            <Button onClick={addYear}>Add year</Button>
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
            <text style={{ color: t.mutedFg, fontSize: 12 }}>{taxpayer ? `${formatTin(taxpayer.tin9)}  /  ${branch?.name ?? ''}` : 'Taxpayer, branch, and return workspace'}</text>
          </div>
          <Button testId="add-taxpayer" onClick={() => { setShowNewTaxpayer(true); setTab('details') }}>+ Add taxpayer</Button>
        </div>
        <div style={{ display: 'flex', gap: 6, borderBottomWidth: 1, borderColor: t.border }}>
          {(['details', 'forms', 'templates'] as const).map((item) => (
            <div key={item} testId={`tab-${item}`} onClick={() => setTab(item)} style={{ padding: 12, borderBottomWidth: tab === item ? 2 : 0, borderColor: t.primary }}>
              <text style={{ color: tab === item ? t.fg : t.mutedFg, fontSize: 13, fontWeight: tab === item ? 700 : 500 }}>{item === 'forms' ? 'Forms' : item[0].toUpperCase() + item.slice(1)}</text>
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
          {tab === 'forms' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {!selectedProfile && <Panel title="Select a tax year"><text style={{ color: t.mutedFg }}>Add or select a year for this branch.</text></Panel>}
              {selectedProfile && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <text style={{ color: t.mutedFg, fontSize: 12 }}>Tax year</text>
                      <Select value={String(selectedProfile.year)} onValueChange={(value) => {
                        const profile = branch?.years.find((item) => String(item.year) === value)
                        if (profile) setSelectedProfileId(profile.id)
                      }}>
                        <SelectTrigger style={{ width: 110, height: 34 }}><SelectValue /></SelectTrigger>
                        <SelectContent>{branch?.years.map((profile) => <SelectItem key={profile.id} value={String(profile.year)}>{profile.year}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <Button testId="choose-forms" onClick={() => setPickerOpen((current) => !current)}>{pickerOpen ? 'Close picker' : 'Choose forms'}</Button>
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
                  {selectedLibrary.map((entry) => (
                    <div key={entry.formCode} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {periodCard(entry)}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  function formPage() {
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
              <div style={{ width: 8, height: 8, borderRadius: 8, backgroundColor: index <= stages.indexOf(currentStatus) ? statusColor(currentStatus) : t.border }} />
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
          {issues.some((issue) => issue.fieldId === null) && (
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

  function sidebar() {
    const navItems: Array<[NavPage, string]> = [
      ['tasks', 'Background tasks'],
      ['logs', 'Logs'],
      ['calendar', 'Tax calendars'],
      ['settings', 'Settings'],
    ]
    return (
      <div style={{ display: 'flex', flexDirection: 'column', width: sidebarCollapsed ? 64 : 250, minWidth: sidebarCollapsed ? 64 : 250, padding: 12, gap: 10, backgroundColor: t.chrome, borderRightWidth: 1, borderColor: t.border }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 7 }}>
          {!sidebarCollapsed && <text style={{ color: t.fg, fontSize: 18, fontWeight: 800 }}>eBIRForms</text>}
          <div testId="sidebar-toggle" onClick={() => setSidebarCollapsed((value) => !value)}><text style={{ color: t.mutedFg }}>☰</text></div>
        </div>
        {!sidebarCollapsed && (
          <>
            <input value={taxpayerSearch} onChange={(event) => setTaxpayerSearch(event.value ?? '')} placeholder="Search taxpayer" style={{ height: 34, padding: 8, color: t.fg, backgroundColor: t.bg, borderWidth: 1, borderColor: t.input, borderRadius: 6 }} />
            <Button onClick={() => { setShowNewTaxpayer(true); setPage('taxpayer'); setTab('details') }}>+ New taxpayer</Button>
            <div testId="taxpayer-tree" style={{ display: 'flex', flexDirection: 'column', gap: 8, flexGrow: 1, overflow: 'scroll' }}>
              {filteredTaxpayers.map((item) => (
                <div key={item.tin9} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <text style={{ color: t.fg, fontSize: 12, fontWeight: 700 }}>{item.name || formatTin(item.tin9)}</text>
                  {item.branches.map((branchItem) => (
                    <div key={branchItem.code} style={{ display: 'flex', flexDirection: 'column', paddingLeft: 8, gap: 4 }}>
                      <div testId={`branch-${item.tin9}-${branchItem.code}`} onClick={() => chooseBranch(item.tin9, branchItem.code)} style={{ padding: 5, borderRadius: 5, backgroundColor: selectedBranchId === branchId(item.tin9, branchItem.code) ? t.secondary : t.chrome }}>
                        <text style={{ color: t.mutedFg, fontSize: 11 }}>⌄ {branchItem.code} · {branchItem.name}</text>
                      </div>
                      {branchItem.years.map((profile) => (
                        <div key={profile.id} testId={`year-${profile.year}-${profile.branch}`} onClick={() => chooseProfile(profile)} style={{ padding: 6, paddingLeft: 18, borderRadius: 5, backgroundColor: selectedProfile?.id === profile.id ? t.accent : t.chrome }}>
                          <text style={{ color: t.fg, fontSize: 11 }}>{profile.year}</text>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTopWidth: 1, borderColor: t.border, paddingTop: 8 }}>
          {navItems.map(([id, label]) => (
            <div key={id} testId={`nav-${id}`} onClick={() => setPage(id)} style={{ padding: 9, borderRadius: 6, backgroundColor: page === id ? t.secondary : t.chrome }}>
              <text style={{ color: t.fg, fontSize: 12 }}>{sidebarCollapsed ? label.slice(0, 1) : label}</text>
            </div>
          ))}
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
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        {sidebar()}
        <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, padding: 12, borderBottomWidth: 1, borderColor: t.border, backgroundColor: t.chrome }}>
            <div testId="notification-bell" onClick={() => setPage('logs')}><text style={{ color: t.fg, fontSize: 15 }}>♢</text></div>
            <div testId="theme-quick-toggle" onClick={() => setThemeMode((mode) => mode === 'light' ? 'dark' : 'light')}><text style={{ color: t.fg, fontSize: 13 }}>{themeMode === 'light' ? '☾' : '☀'}</text></div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minHeight: 0, padding: 20 }}>
            {mainContent()}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: 8, borderTopWidth: 1, borderColor: t.border, backgroundColor: t.chrome }}>
        <text style={{ color: t.mutedFg, fontSize: 10 }}>eBIRForms · prepare with confidence</text>
        <text style={{ color: t.mutedFg, fontSize: 10 }}>SFTP: {sftpMode} · Offline first</text>
      </div>
    </div>
  )
}

render(<><FontRegistration /><App /></>, { title: 'eBIRForms', width: 1440, height: 940 })
