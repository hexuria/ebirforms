# eBIRForms desktop app: living plan

This plan changes as we build. Each phase ends with a verification gate; the
next phase starts only after the gate passes. Progress is tracked in
[issue #1](https://github.com/hexuria/ebirforms/issues/1); update this file and its checkboxes in the
same PR as the work.

## Goal

A native desktop app, built with [GPUIX](https://github.com/remorses/gpuix)
(React on Zed's GPUI, run by Bun), that prepares, validates, prints and submits
BIR returns with 100% behavioural parity with the official Offline eBIRForms
package (currently **v7.9.6.2.1**, the newest zip on `bir-cdn.bir.gov.ph`).

## Inputs we build on

| Source | What we take | How it is pinned |
|---|---|---|
| [hexuria/buwiz-validation](https://github.com/hexuria/buwiz-validation) | Byte-exact official package: 84 form HTAs with their `validate()`, blur/compute handlers, `js/`, `xml/` reference tables, `index/forms.json` | git submodule at tag `v7.9.6.2.1` |
| [hexuria/buwiz-forms-html](https://github.com/hexuria/buwiz-forms-html) | `html-frozen/`: 43 printable sheets + `keys/*.json` serialized-key lists + `name-gaps.json` | git submodule at tag `v1-frozen` |
| [hexuria/rea](https://github.com/hexuria/rea) | REA CLI/MCP (`bunx rea-agents@latest`) for reverse engineering: `analyze-javascript-application` over the HTA scripts, `capture-browser-scenario` / `capture-web-screenshot` for bir.gov.ph | evidence JSON committed under `evidence/rea/` |
| [hexuria/buwiz-forms](https://github.com/hexuria/buwiz-forms) | Reference only: already reverse-engineered IAF crypto (`bir-core/src/crypto.rs`), dispatcher + SFTP flow (`transport.rs`), official XML (`official_xml.rs`), per-form rule research (`rules/forms/*`) | ported to TypeScript, cited per function |

## Architecture

Bun workspace, TypeScript everywhere, one process.

```
apps/desktop        GPUIX React UI
packages/core       SQLite (bun:sqlite) store, domain model, env config, logger, job queue
packages/forms      form catalog + per-form field model generated from the official HTAs
packages/validation official-runtime validator (happy-dom sandbox running BIR's own JS)
packages/print      fill frozen HTML, render pages, print
packages/submit     XML serializer, LZ + AES payload, dispatcher, SFTP upload
vendor/             submodules (official package, frozen HTML)
```

### Domain model

```
Taxpayer      tin9 (999-999-999, check digit validated like the official profile)
 +- Branch    branch code, 5 digits, default "00000"
     +- TaxYearProfile   year + registered name, RDO, address, ZIP, line of business,
         |               contact, email (the official profile fields, per year)
         +- Library      only the forms the user picked for that year
             +- Draft    one return: form code, period, field values, status
```

A TIN can have many branches; each branch can have many tax years; a form only
appears in a year's library after the user picks it.

### Validation (requirements 5 and 9)

The official forms are HTML apps whose `validate()` is a chain of
`if (cond) { alert(msg); return; }` guards. We run BIR's own JavaScript in a
happy-dom sandbox (verified: `BIR-Form1601Cv2018.hta` loads under Bun and its
`validate()` returns the exact official alerts). To show every error at once
instead of BIR's first-alert-only behaviour:

1. At build time, parse each form's `validate()` and blur handlers (Babel AST,
   cross-checked with REA's JavaScript application graph) into an ordered list
   of guard clauses: condition, message, referenced field ids.
2. At run time, evaluate every guard against the current values in the
   sandbox and attach its message to the first field it references.
3. Parity oracle (tests): running the unmodified official `validate()` must
   alert exactly our first error, for every fixture.

Every field reserves one line under it for its error, so showing or clearing
an error never moves the layout.

### Submission and environment (requirement 6)

| Env | Behaviour |
|---|---|
| `BIR_SFTP_LIVE` unset or not `1` | Dry run: payload is built and written to the outbox; nothing leaves the machine |
| `BIR_SFTP_LIVE=1` + `BIR_SFTP_HOST`, `BIR_SFTP_PORT`, `BIR_SFTP_USERNAME`, `BIR_SFTP_PASSWORD` | Upload to that host |
| `BIR_SFTP_LIVE=1`, no host | Ask the official dispatcher for the endpoint (as `ebfSFTP.exe` does) |

Tests and demos never set `BIR_SFTP_LIVE` and only use test TIN
`123-456-788-00000` (branch `00002` for a second branch).

### Jobs and logs (requirements 7 and 8)

- Job queue: a SQLite `jobs` table (kind, payload, state, attempts, run_after,
  last_error) with an in-process worker, exponential backoff, and recovery of
  jobs left `running` after a crash. Submit, print render and validation
  sweeps run as jobs.
- Logging: structured JSON lines to a rotating file in the app data dir, plus
  an in-memory ring buffer streamed to a Logs panel and the job detail view.
  Every job writes its log lines with its job id.

### Print (requirements 4 and 10)

GPUIX has no web view, so: fill the frozen sheet by its `name=` stamps, render
it with headless Edge/Chrome (CDP `Page.printToPDF` + page screenshots), show
the page images in an in-app Print Preview, and send the PDF to the OS print
dialog from a Print button.

## Phases and gates

Status: `[ ]` todo, `[~]` in progress, `[x]` done (gate passed).

- [ ] **P0 Bootstrap.** Bun workspace, submodules, idempotent
  `scripts/setup-*`, CI on Windows/Linux/macOS (typecheck + `bun test`), app
  window with an empty shell.
  *Gate:* CI green; window opens on Windows (screenshot).
- [ ] **P1 Reverse-engineering inventory.** Confirm the latest version on
  bir.gov.ph with REA; REA JS analysis of the package; generated form catalog
  (84 HTAs, 43 printable) and per-form field models (ids, types, maxlength,
  options, item labels).
  *Gate:* field counts match `buwiz-forms/rules/forms/*/fields.json` for
  1601C, 2551Q, 0619E; REA evidence committed.
- [ ] **P2 Profiles and library.** Taxpayer, branch, tax year, form picker,
  library, SQLite store, logger, job queue.
  *Gate:* unit tests; UI walkthrough creating `123-456-788` branches `00000`
  and `00002` with different years and different libraries.
- [ ] **P3 Validation engine.** Sandbox, guard extraction, inline errors with
  reserved lines.
  *Gate:* parity oracle passes for 1601C, 2551Q, 0619E; GPUIX automation test
  proves no layout shift when errors appear.
- [ ] **P4 Form editor.** Generated editor for the first forms (1601C, 2551Q,
  0619E), compute handlers from the official JS, drafts.
  *Gate:* filled fixtures compute the same totals as the official HTA.
- [ ] **P5 Print preview and print.**
  *Gate:* filled values visible on rendered pages; PDF printed via the OS
  dialog.
- [ ] **P6 Submission.** Official XML, LZ + AES payload, queue job, dry run,
  local SFTP server test, env control.
  *Gate:* round-trip decrypt of our payload equals the official
  serialization; dry run never opens a socket.
- [ ] **P7 All forms.** Extend P3 to P6 to every form in the catalog; parity
  sweep report.
- [ ] **P8 Packaging.** `bun build --compile` plus installers per OS.

## Open questions

- First forms: starting with 1601C, 2551Q and 0619E.
- Print preview uses rendered page images (GPUIX has no web view).

## Change log

- Initial plan.
