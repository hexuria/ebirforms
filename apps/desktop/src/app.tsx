import { useEffect, useMemo, useState } from 'react'
import { join } from 'node:path'
import { render } from '@gpuix/react'
import {
  dataDir,
  describeSftpConfig,
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
import { loadCatalog, type CatalogEntry } from '@ebirforms/forms'

const store = openStore(join(dataDir(), 'ebirforms.sqlite'))
const logger: Logger = store.logger
const queue = new JobQueue(store)
const catalog = loadCatalog()

const sections = [
  { id: 'profiles', title: 'Profiles' },
  { id: 'library', title: 'Library' },
  { id: 'jobs', title: 'Jobs' },
  { id: 'logs', title: 'Logs' },
] as const

type SectionId = (typeof sections)[number]['id']
type ProfileForm = {
  tin: string
  branch: string
  year: string
  registeredName: string
  rdo: string
}
type ProfileFieldName = keyof ProfileForm
type ProfileErrors = Partial<Record<ProfileFieldName, string>>
type LogFilter = LogLevel | 'all'

const initialProfiles = store.listTaxpayers()

function allProfiles(taxpayers: TaxpayerTree[]): Profile[] {
  return taxpayers.flatMap((taxpayer) =>
    taxpayer.branches.flatMap((branch) => branch.years),
  )
}

function tinBaseLabel(tin9: string): string {
  return `${tin9.slice(0, 3)}-${tin9.slice(3, 6)}-${tin9.slice(6)}`
}

function ActionButton({
  children,
  onClick,
  testId,
  disabled = false,
}: {
  children: string
  onClick: () => void
  testId: string
  disabled?: boolean
}) {
  return (
    <div
      testId={testId}
      onClick={() => {
        if (!disabled) {
          onClick()
        }
      }}
      style={{
        alignSelf: 'start',
        padding: 10,
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        backgroundColor: '#3b82f6',
        hover: { backgroundColor: '#2563eb' },
      }}
    >
      <text style={{ color: '#ffffff', fontSize: 13 }}>{children}</text>
    </div>
  )
}

function ProfileField({
  label,
  field,
  value,
  error,
  placeholder,
  onChange,
}: {
  label: string
  field: ProfileFieldName
  value: string
  error: string
  placeholder?: string
  onChange: (field: ProfileFieldName, value: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <text style={{ color: '#c8d0dc', fontSize: 13 }}>{label}</text>
      <input
        testId={`profile-${field}`}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(field, event.value ?? '')}
        style={{
          height: 34,
          padding: 8,
          color: '#f4f5f7',
          backgroundColor: '#10141a',
          borderWidth: 1,
          borderColor: '#3b414d',
          borderRadius: 5,
        }}
      />
      <div
        testId={`profile-${field}-validation`}
        style={{ height: 18, minHeight: 18 }}
      >
        <text style={{ color: error ? '#f87171' : '#aab2bf', fontSize: 12 }}>{error}</text>
      </div>
    </div>
  )
}

function CheckboxRow({
  entry,
  checked,
  disabled = false,
  testId,
  onClick,
}: {
  entry: CatalogEntry
  checked: boolean
  disabled?: boolean
  testId: string
  onClick: () => void
}) {
  return (
    <div
      testId={testId}
      onClick={() => {
        if (!disabled) {
          onClick()
        }
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: 4,
        minWidth: 0,
        cursor: disabled ? 'default' : 'pointer',
        backgroundColor: '#202631',
        hover: { backgroundColor: disabled ? '#202631' : '#2b3340' },
      }}
    >
      <div
        testId={`${testId}-indicator`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          minWidth: 18,
          height: 18,
          flexShrink: 0,
          borderWidth: 1,
          borderColor: checked ? '#60a5fa' : '#707987',
          borderRadius: 3,
          backgroundColor: checked ? '#2563eb' : '#14171d',
        }}
      >
        <text style={{ color: '#ffffff', fontSize: 13 }}>{checked ? '✓' : ''}</text>
      </div>
      <text
        style={{
          color: '#e3e6eb',
          fontSize: 13,
          flexGrow: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
      >
        {entry.label}
      </text>
      <text
        style={{
          color: '#9ca7b7',
          fontSize: 12,
          width: 120,
          minWidth: 120,
          flexShrink: 0,
          textAlign: 'right',
          whiteSpace: 'nowrap',
        }}
      >
        {entry.code}
      </text>
    </div>
  )
}

function App() {
  const [selectedSection, setSelectedSection] = useState<SectionId>('profiles')
  const [profiles, setProfiles] = useState(initialProfiles)
  const [selectedProfileId, setSelectedProfileId] = useState(
    allProfiles(initialProfiles)[0]?.id,
  )
  const [profileForm, setProfileForm] = useState<ProfileForm>({
    tin: '',
    branch: '00000',
    year: '',
    registeredName: '',
    rdo: '',
  })
  const [profileErrors, setProfileErrors] = useState<ProfileErrors>({})
  const [profileStatus, setProfileStatus] = useState('')
  const [library, setLibrary] = useState<LibraryEntry[]>(() => {
    const profileId = allProfiles(initialProfiles)[0]?.id
    return profileId ? store.listLibrary(profileId) : []
  })
  const [search, setSearch] = useState('')
  const [pendingCodes, setPendingCodes] = useState<string[]>([])
  const [jobs, setJobs] = useState<Job[]>(() => queue.list())
  const [logs, setLogs] = useState<LogEntry[]>(() => logger.getEntries())
  const [logFilter, setLogFilter] = useState<LogFilter>('all')

  useEffect(() => queue.onChange(setJobs), [])
  useEffect(
    () =>
      logger.subscribe((entry) =>
        setLogs((current) => [...current.slice(-999), entry]),
      ),
    [],
  )

  const filteredCatalog = useMemo(() => {
    const query = search.trim().toLowerCase()
    return catalog.filter(
      (entry) =>
        !query ||
        entry.code.toLowerCase().includes(query) ||
        entry.label.toLowerCase().includes(query),
    )
  }, [search])
  const selectedProfile = allProfiles(profiles).find(
    (profile) => profile.id === selectedProfileId,
  )

  function selectProfile(profile: Profile) {
    setSelectedProfileId(profile.id)
    setLibrary(store.listLibrary(profile.id))
    setPendingCodes([])
  }

  function updateProfileField(field: ProfileFieldName, value: string) {
    setProfileForm((current) => ({ ...current, [field]: value }))
    setProfileErrors((current) => ({ ...current, [field]: '' }))
    setProfileStatus('')
  }

  function saveProfile() {
    const errors: ProfileErrors = {}
    let parsedTin: ReturnType<typeof parseTin> | undefined
    try {
      parsedTin = parseTin(profileForm.tin)
    } catch (error) {
      errors.tin = error instanceof Error ? error.message : String(error)
    }
    if (!/^\d{5}$/.test(profileForm.branch)) {
      errors.branch = 'Branch code must contain exactly 5 digits.'
    }
    if (!/^\d{4}$/.test(profileForm.year) || !Number.isInteger(Number(profileForm.year))) {
      errors.year = 'Enter a 4-digit tax year.'
    }
    if (Object.values(errors).some(Boolean)) {
      setProfileErrors(errors)
      setProfileStatus('')
      logger.log('warn', 'profiles', 'Profile validation failed', {
        fields: Object.keys(errors),
      })
      return
    }

    const branch =
      parsedTin && parsedTin.branch !== '00000' && profileForm.branch === '00000'
        ? parsedTin.branch
        : profileForm.branch
    try {
      const profile = store.createProfile({
        tin: profileForm.tin,
        branch,
        year: Number(profileForm.year),
        registeredName: profileForm.registeredName,
        rdo: profileForm.rdo,
      })
      const nextProfiles = store.listTaxpayers()
      setProfiles(nextProfiles)
      selectProfile(profile)
      setProfileErrors({})
      setProfileStatus(`Saved ${formatTin(profile.tin9, profile.branch)} · ${profile.year}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProfileErrors((current) => ({ ...current, year: message }))
      setProfileStatus('')
    }
  }

  function togglePendingCode(code: string) {
    if (library.some((entry) => entry.formCode === code)) {
      return
    }
    setPendingCodes((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    )
  }

  function addSelectedForms() {
    if (!selectedProfileId || pendingCodes.length === 0) {
      return
    }
    store.addForms(selectedProfileId, pendingCodes)
    setLibrary(store.listLibrary(selectedProfileId))
    setPendingCodes([])
  }

  function removeLibraryForm(code: string) {
    if (!selectedProfileId) {
      return
    }
    store.removeForm(selectedProfileId, code)
    setLibrary(store.listLibrary(selectedProfileId))
  }

  const displayedLogs =
    logFilter === 'all' ? logs : logs.filter((entry) => entry.level === logFilter)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: '#14171d',
      }}
    >
      <div style={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            width: 220,
            padding: 20,
            backgroundColor: '#1b1f27',
          }}
        >
          <text style={{ color: '#f4f5f7', fontSize: 20, padding: 8 }}>eBIRForms</text>
          {sections.map((section) => (
            <div
              key={section.id}
              testId={`nav-${section.id}`}
              onClick={() => setSelectedSection(section.id)}
              style={{
                padding: 12,
                borderRadius: 6,
                cursor: 'pointer',
                backgroundColor:
                  selectedSection === section.id ? '#303744' : '#1b1f27',
                hover: { backgroundColor: '#303744' },
              }}
            >
              <text style={{ color: '#e3e6eb' }}>{section.title}</text>
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flexGrow: 1,
            minWidth: 0,
            gap: 16,
            padding: 28,
          }}
        >
          {selectedSection === 'profiles' && (
            <>
              <text style={{ color: '#f4f5f7', fontSize: 28 }}>Profiles</text>
              <div style={{ display: 'flex', flexGrow: 1, gap: 24, minHeight: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                    width: 300,
                    minHeight: 0,
                  }}
                >
                  <text style={{ color: '#d6dbe4', fontSize: 16 }}>Taxpayer profiles</text>
                  <div
                    testId="profile-tree"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      flexGrow: 1,
                      overflow: 'scroll',
                    }}
                  >
                    {profiles.length === 0 && (
                      <text style={{ color: '#9ca7b7', fontSize: 13 }}>
                        No taxpayer profiles yet.
                      </text>
                    )}
                    {profiles.map((taxpayer) => (
                      <div
                        key={taxpayer.tin9}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          padding: 12,
                          borderRadius: 8,
                          backgroundColor: '#1b1f27',
                        }}
                      >
                        <text style={{ color: '#f4f5f7', fontSize: 14 }}>
                          {tinBaseLabel(taxpayer.tin9)}
                        </text>
                        {taxpayer.branches.map((branch) => (
                          <div
                            key={`${taxpayer.tin9}-${branch.code}`}
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 5,
                              paddingLeft: 10,
                            }}
                          >
                            <text style={{ color: '#9ca7b7', fontSize: 12 }}>
                              Branch {branch.code}
                            </text>
                            {branch.years.map((profile) => (
                              <div
                                key={profile.id}
                                testId={`profile-item-${profile.year}-${profile.branch}`}
                                onClick={() => selectProfile(profile)}
                                style={{
                                  padding: 7,
                                  borderRadius: 5,
                                  cursor: 'pointer',
                                  backgroundColor:
                                    selectedProfileId === profile.id ? '#303744' : '#202631',
                                }}
                              >
                                <text style={{ color: '#e3e6eb', fontSize: 12 }}>
                                  {profile.registeredName
                                    ? `${profile.year} · ${profile.registeredName}`
                                    : String(profile.year)}
                                </text>
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    flexGrow: 1,
                    gap: 12,
                    padding: 20,
                    borderRadius: 10,
                    backgroundColor: '#1b1f27',
                  }}
                >
                  <text style={{ color: '#f4f5f7', fontSize: 18 }}>New profile</text>
                  <ProfileField
                    label="TIN"
                    field="tin"
                    value={profileForm.tin}
                    error={profileErrors.tin ?? ''}
                    placeholder="123-456-788"
                    onChange={updateProfileField}
                  />
                  <ProfileField
                    label="Branch"
                    field="branch"
                    value={profileForm.branch}
                    error={profileErrors.branch ?? ''}
                    onChange={updateProfileField}
                  />
                  <ProfileField
                    label="Year"
                    field="year"
                    value={profileForm.year}
                    error={profileErrors.year ?? ''}
                    placeholder="2025"
                    onChange={updateProfileField}
                  />
                  <ProfileField
                    label="Registered name"
                    field="registeredName"
                    value={profileForm.registeredName}
                    error={profileErrors.registeredName ?? ''}
                    onChange={updateProfileField}
                  />
                  <ProfileField
                    label="RDO"
                    field="rdo"
                    value={profileForm.rdo}
                    error={profileErrors.rdo ?? ''}
                    placeholder="e.g. 039"
                    onChange={updateProfileField}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <ActionButton testId="profile-save" onClick={saveProfile}>
                      Save
                    </ActionButton>
                    <text testId="profile-status" style={{ color: '#aab2bf', fontSize: 12 }}>
                      {profileStatus}
                    </text>
                  </div>
                </div>
              </div>
            </>
          )}
          {selectedSection === 'library' && (
            <>
              <text style={{ color: '#f4f5f7', fontSize: 28 }}>Library</text>
              <text style={{ color: '#9ca7b7', fontSize: 13 }}>
                {selectedProfile
                  ? `${formatTin(selectedProfile.tin9, selectedProfile.branch)} · ${selectedProfile.year}`
                  : 'Select a profile to manage its forms.'}
              </text>
              {selectedProfile && (
                <div style={{ display: 'flex', flexGrow: 1, gap: 20, minHeight: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      flexGrow: 1,
                      gap: 10,
                      minWidth: 0,
                    }}
                  >
                    <text style={{ color: '#d6dbe4', fontSize: 17 }}>Form picker</text>
                    <input
                      testId="library-search"
                      value={search}
                      placeholder="Search forms by code or name"
                      onChange={(event) => setSearch(event.value ?? '')}
                      style={{
                        height: 34,
                        padding: 8,
                        flexShrink: 0,
                        color: '#f4f5f7',
                        backgroundColor: '#10141a',
                        borderWidth: 1,
                        borderColor: '#3b414d',
                        borderRadius: 5,
                      }}
                    />
                    {pendingCodes.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <text style={{ color: '#9ca7b7', fontSize: 12 }}>Selected to add</text>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {pendingCodes.map((code) => {
                            const entry = catalog.find((item) => item.code === code)
                            return entry ? (
                              <CheckboxRow
                                key={code}
                                entry={entry}
                                checked
                                testId={`picker-selected-${code}`}
                                onClick={() => togglePendingCode(code)}
                              />
                            ) : null
                          })}
                        </div>
                      </div>
                    )}
                    <div
                      testId="catalog-picker"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        flexGrow: 1,
                        minHeight: 0,
                        overflow: 'scroll',
                        backgroundColor: '#1b1f27',
                        borderRadius: 8,
                        padding: 8,
                      }}
                    >
                      {filteredCatalog.map((entry) => {
                        const inLibrary = library.some(
                          (item) => item.formCode === entry.code,
                        )
                        return (
                          <CheckboxRow
                            key={entry.code}
                            entry={entry}
                            checked={inLibrary || pendingCodes.includes(entry.code)}
                            disabled={inLibrary}
                            testId={`picker-option-${entry.code}`}
                            onClick={() => togglePendingCode(entry.code)}
                          />
                        )
                      })}
                      {filteredCatalog.length === 0 && (
                        <text style={{ color: '#9ca7b7', fontSize: 13, padding: 10 }}>
                          No forms match this search.
                        </text>
                      )}
                    </div>
                    <ActionButton
                      testId="library-add-selected"
                      onClick={addSelectedForms}
                      disabled={pendingCodes.length === 0}
                    >
                      Add selected
                    </ActionButton>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                      width: 300,
                      minWidth: 300,
                      flexShrink: 0,
                      minHeight: 0,
                    }}
                  >
                    <text style={{ color: '#d6dbe4', fontSize: 17 }}>Selected library</text>
                    <div
                      testId="library-list"
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        flexGrow: 1,
                        overflow: 'scroll',
                      }}
                    >
                      {library.length === 0 && (
                        <text style={{ color: '#9ca7b7', fontSize: 13 }}>
                          No forms added for this profile.
                        </text>
                      )}
                      {library.map((entry) => (
                        <div
                          key={entry.formCode}
                          testId={`library-form-${entry.formCode}`}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 8,
                            padding: 10,
                            borderRadius: 7,
                            backgroundColor: '#1b1f27',
                          }}
                        >
                          <text
                            style={{
                              color: '#e3e6eb',
                              fontSize: 13,
                              flexGrow: 1,
                              minWidth: 0,
                              whiteSpace: 'nowrap',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {entry.label}
                          </text>
                          <text
                            style={{
                              color: '#9ca7b7',
                              fontSize: 11,
                              width: 100,
                              minWidth: 100,
                              flexShrink: 0,
                              textAlign: 'right',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {entry.formCode}
                          </text>
                          <div
                            testId={`library-remove-${entry.formCode}`}
                            onClick={() => removeLibraryForm(entry.formCode)}
                            style={{
                              padding: 6,
                              borderRadius: 4,
                              cursor: 'pointer',
                              backgroundColor: '#303744',
                            }}
                          >
                            <text style={{ color: '#fca5a5', fontSize: 11 }}>Remove</text>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          {selectedSection === 'jobs' && (
            <>
              <text style={{ color: '#f4f5f7', fontSize: 28 }}>Jobs</text>
              <div
                testId="jobs-list"
                style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'scroll' }}
              >
                {jobs.length === 0 && (
                  <text style={{ color: '#9ca7b7', fontSize: 13 }}>No jobs yet.</text>
                )}
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    testId={`job-${job.id}`}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 5,
                      padding: 12,
                      borderRadius: 8,
                      backgroundColor: '#1b1f27',
                    }}
                  >
                    <text style={{ color: '#e3e6eb', fontSize: 14 }}>
                      {`${job.kind} · ${job.state}`}
                    </text>
                    <text style={{ color: '#9ca7b7', fontSize: 12 }}>
                      Attempts: {job.attempts}/{job.maxAttempts}
                    </text>
                    <text style={{ color: '#fca5a5', fontSize: 12 }}>
                      {job.lastError ?? ''}
                    </text>
                  </div>
                ))}
              </div>
            </>
          )}
          {selectedSection === 'logs' && (
            <>
              <text style={{ color: '#f4f5f7', fontSize: 28 }}>Logs</text>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['all', 'debug', 'info', 'warn', 'error'] as const).map((level) => (
                  <div
                    key={level}
                    testId={`log-filter-${level}`}
                    onClick={() => setLogFilter(level)}
                    style={{
                      padding: 8,
                      borderRadius: 5,
                      cursor: 'pointer',
                      backgroundColor: logFilter === level ? '#303744' : '#1b1f27',
                    }}
                  >
                    <text style={{ color: '#e3e6eb', fontSize: 12 }}>{level}</text>
                  </div>
                ))}
              </div>
              <div
                testId="logs-list"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 7,
                  flexGrow: 1,
                  minHeight: 0,
                  overflow: 'scroll',
                }}
              >
                {displayedLogs.length === 0 && (
                  <text style={{ color: '#9ca7b7', fontSize: 13 }}>No log entries.</text>
                )}
                {displayedLogs
                  .slice(-50)
                  .reverse()
                  .map((entry, index) => (
                    <div
                      key={`${entry.ts}-${index}`}
                      testId={`log-entry-${index}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        padding: 10,
                        borderRadius: 7,
                        backgroundColor: '#1b1f27',
                      }}
                    >
                      <text style={{ color: '#e3e6eb', fontSize: 13 }}>
                        {`${entry.level.toUpperCase()} · ${entry.scope} · ${entry.msg}`}
                      </text>
                      <text style={{ color: '#9ca7b7', fontSize: 11 }}>{entry.ts}</text>
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div style={{ height: 42, padding: 12, backgroundColor: '#1b1f27' }}>
        <text style={{ color: '#aab2bf', fontSize: 12 }}>
          {describeSftpConfig(loadSftpConfig())}
        </text>
      </div>
    </div>
  )
}

render(<App />, {
  title: 'eBIRForms',
  width: 1200,
  height: 850,
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
