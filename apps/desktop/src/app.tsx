import { useState } from 'react'
import { render } from '@gpuix/react'
import { describeSftpConfig, loadSftpConfig } from '@ebirforms/core'

const sections = [
  { id: 'profiles', title: 'Profiles', placeholder: 'Your taxpayer profiles will appear here.' },
  { id: 'library', title: 'Library', placeholder: 'Choose the forms for each tax year.' },
  { id: 'jobs', title: 'Jobs', placeholder: 'Submission and print jobs will appear here.' },
  { id: 'logs', title: 'Logs', placeholder: 'Application activity will appear here.' },
] as const

type Section = (typeof sections)[number]

function App() {
  const [selectedSection, setSelectedSection] = useState<Section>(sections[0])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: '#14171d',
      }}
    >
      <div style={{ display: 'flex', flexGrow: 1 }}>
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
              onClick={() => setSelectedSection(section)}
              style={{
                padding: 12,
                borderRadius: 6,
                cursor: 'pointer',
                backgroundColor: selectedSection.id === section.id ? '#303744' : '#1b1f27',
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
            gap: 12,
            padding: 32,
          }}
        >
          <text style={{ color: '#f4f5f7', fontSize: 28 }}>{selectedSection.title}</text>
          <text style={{ color: '#aab2bf' }}>{selectedSection.placeholder}</text>
        </div>
      </div>
      <div
        style={{
          height: 42,
          padding: 12,
          backgroundColor: '#1b1f27',
        }}
      >
        <text style={{ color: '#aab2bf', fontSize: 12 }}>
          {describeSftpConfig(loadSftpConfig())}
        </text>
      </div>
    </div>
  )
}

render(<App />, {
  title: 'eBIRForms',
  width: 960,
  height: 640,
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
