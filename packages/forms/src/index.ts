import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Window } from 'happy-dom'

export interface CatalogEntry {
  code: string
  label: string
  htaFile: string
  printable: string | null
  frequency: ReturnFrequency
}

export type ReturnFrequency = 'monthly' | 'quarterly' | 'annual'

const frequencyOverrides: Record<string, ReturnFrequency> = {
  '0605': 'annual',
  '0619E': 'monthly',
  '1601C': 'monthly',
  '1601Cv2018': 'monthly',
  '2551Q': 'quarterly',
  '2551Qv2018': 'quarterly',
  '1600WP': 'monthly',
  '1606': 'annual',
  '1704': 'annual',
  '1706': 'annual',
  '1707': 'annual',
  '1707v2018': 'annual',
  '1707v2021': 'annual',
  '1800': 'annual',
  '1800v2018': 'annual',
  '1801': 'annual',
  '1801v2018': 'annual',
  '2000': 'monthly',
  '2000OT': 'annual',
  '2000OTv2018': 'annual',
  '2200A': 'monthly',
  '2200Av2020': 'monthly',
  '2200AN': 'monthly',
  '2200ANv2018': 'monthly',
  '2200Cv2018': 'monthly',
  '2200M': 'monthly',
  '2200Mv2018': 'monthly',
  '2200P': 'monthly',
  '2200Pv2020': 'monthly',
  '2200S': 'monthly',
  '2200T': 'monthly',
  '2200Tv2020': 'monthly',
  '2552': 'monthly',
  '2552v2018': 'monthly',
  '2553': 'monthly',
}

function returnFrequency(code: string, label: string): ReturnFrequency {
  const override = frequencyOverrides[code]
  if (override) return override
  if (/\bmonthly\b/i.test(label)) return 'monthly'
  if (/\bquarterly\b/i.test(label)) return 'quarterly'
  if (/\bannual\b/i.test(label)) return 'annual'
  throw new Error(`No filing frequency is defined for ${code}: ${label}`)
}

export const printableSlugByCode: Record<string, string> = {
  '0605': '0605-1999',
  '0619E': '0619e-2018',
  '0619F': '0619f-2018',
  '1600PTv2018': '1600-pt-2018',
  '1600VTv2018': '1600-vt-2018',
  '1600WP': '1600wp-2010',
  '1601FQ': '1601-fq-2020',
  '1601Cv2018': '1601c-2018',
  '1601EQ': '1601eq-2019',
  '1602Qv2018': '1602q-2019',
  '1603Qv2018': '1603q-2018',
  '1604C': '1604c-2018',
  '1604Ev2018': '1604e-2018',
  '1604F': '1604f-2018',
  '1606': '1606-2018',
  '1700v2018': '1700-2018',
  '1701v2018': '1701-2018',
  '1701A': '1701a-2018',
  '1701MS': '1701ms-2024',
  '1701Qv2018': '1701q-2018',
  '1702EXv2018C': '1702ex-2018',
  '1702MXv2018C': '1702mx-2018c',
  '1702Qv2018C': '1702q-2018',
  '1702RTv2018C': '1702rt-2018c',
  '1706': '1706-2018',
  '1707v2021': '1707-2021',
  '1707Av2021': '1707a-2021',
  '1800v2018': '1800-2018',
  '1801v2018': '1801-2018',
  '2000v2018': '2000-dst-2018',
  '2000OTv2018': '2000-ot-2018',
  '2200Av2020': '2200a-2020',
  '2200ANv2018': '2200an-2018',
  '2200Cv2018': '2200c-2018',
  '2200Mv2018': '2200m-2018',
  '2200Pv2020': '2200p-2020',
  '2200S': '2200s-2018',
  '2200Tv2020': '2200t-2022',
  '2550M': '2550m-2007',
  '2550Qv2024': '2550q-2024',
  '2551Qv2018': '2551q-2018',
  '2552v2018': '2552-2018',
  '2553': '2553-1999',
}

const repositoryRoot = resolve(import.meta.dir, '../../..')
const defaultPackageDir = join(repositoryRoot, 'vendor', 'buwiz-validation', 'package')
const defaultFrozenDir = join(
  repositoryRoot,
  'vendor',
  'buwiz-forms-html',
  'html-frozen',
)

export function loadCatalog(
  packageDir: string = defaultPackageDir,
  frozenDir: string = defaultFrozenDir,
): CatalogEntry[] {
  const resolvedPackageDir = resolve(packageDir)
  const resolvedFrozenDir = resolve(frozenDir)
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
    } as any,
  })
  try {
    window.document.write(
      readFileSync(join(resolvedPackageDir, 'BIRForms.hta'), 'utf8').replace(/^\uFEFF/, ''),
    )
    const select = window.document.querySelector('#formType') as any
    if (!select) {
      throw new Error('Official BIRForms.hta does not contain #formType.')
    }
    return (Array.from(select.options) as any[])
      .filter((option) => option.value !== '0')
      .map((option) => {
        const slug = printableSlugByCode[option.value]
        const printable = slug ? join(resolvedFrozenDir, slug) : null
        return {
          code: option.value,
          label: option.textContent?.trim() ?? '',
          htaFile: join('forms', `BIR-Form${option.value}.hta`),
          printable: printable && existsSync(printable) ? printable : null,
          frequency: returnFrequency(option.value, option.textContent?.trim() ?? ''),
        }
      })
  } finally {
    void window.happyDOM.close()
  }
}
