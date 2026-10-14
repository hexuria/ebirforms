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
packages/runtime    official HTA runtime: happy-dom sandbox running BIR's own JS (compute, validate, saveXML)
packages/print      fill frozen HTML, render pages, print
packages/submit     XML serializer, LZ + AES payload, dispatcher, SFTP upload
vendor/             submodules (official package, frozen HTML)
```

### Domain model

```
Taxpayer      TIN, registered name, type, birth date
 +- Branch    branch code, name, RDO, address, ZIP, phone, email
     +- TaxYearProfile   year; owns the selected form library
         +- Draft        one return per form and period, with field values/status
```

A TIN can have many branches; branch facts inherit field-by-field from branch
`00000` until overridden. Each branch can have many tax years; a form only
appears in a year's library after the user picks it. Draft periods are
`YYYY-MM`, `YYYY-Qn`, or `YYYY`, and the unique key is
`(profile_id, form_code, period)`.

### Official runtime engine (requirements 5, 9 and parity)

Every draft is backed by a live instance of the official form HTA running in a
happy-dom sandbox under Bun, with BIR's own JavaScript. The GPUIX editor is a
native view over that instance: typing a value sets the DOM element by its
official id (`frm1601c:txtTax14`) and fires its official `onblur`/`onchange`
handlers. Computed fields come back from BIR's own code, and save and submit
call the official `saveXML()` with an ActiveX shim that captures the file
writes. Parity comes from running BIR's code, not from re-implementing it.

Shims the sandbox needs (all verified in a spike):
`alert`/`confirm` capture, `ActiveXObject` (`Scripting.FileSystemObject`
writes captured), string-callback `setTimeout`/`setInterval`, and compiling
inline `on*` attributes into listeners, since happy-dom does not evaluate them.
Spike result: on 1601C, `txtTax14 = 1000` plus blur gives `txtTax22 = 1,000.00`
through the official handlers.

Validation shows every error at once instead of BIR's first-alert-only flow:

1. At build time, parse each form's `validate()` /
   `initialValidateBeforeSave()` and blur handlers (Babel AST) into an ordered
   list of guard clauses: condition, message, referenced field ids.
2. At run time, evaluate every guard against the instance and attach its
   message to the first field it references.
3. Parity oracle (tests): the unmodified official function must alert exactly
   our first error, for every fixture.

Every field reserves one line under it for its error, so showing or clearing
an error never moves the layout.

REA covers what the static repos can't: `inspect-web-page` against the live
download page, and `analyze-javascript-application` over the shared `js/`
libraries. HTA inline scripts are exported to `.js` files first, because REA
parses only JavaScript files. CDP endpoints must be given as `127.0.0.1`, not
`localhost`.

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

- [x] **P0 Bootstrap.** ([PR #3](https://github.com/hexuria/ebirforms/pull/3)) Bun workspace, submodules, idempotent
  `scripts/setup-*`, CI on Windows/Linux/macOS (typecheck + `bun test`), app
  window with an empty shell.
  *Gate:* CI green; window opens on Windows (screenshot).
- [x] **P1 Reverse-engineering inventory.** ([PR #4](https://github.com/hexuria/ebirforms/pull/4)) Confirm the latest version on
  bir.gov.ph with REA; REA JS analysis of the package; generated form catalog
  (79 active forms in the official `formType` list, 43 with printable sheets) and
  per-form field models taken from the official `frmMain.elements`
  serialization order (ids, types, maxlength, options, item labels).
  *Gate:* 79 active forms, printable mappings, and documented
  rules-vs-official `knownDifferences` verified against each HTA.
- [x] **P2 Profiles and library.** ([PR #5](https://github.com/hexuria/ebirforms/pull/5)) Taxpayer, branch, tax year, form picker,
  library, SQLite store, logger, job queue.
  *Gate:* unit tests; UI walkthrough creating `123-456-788` branches `00000`
  and `00002` with different years and different libraries.
- [x] **P3 Validation engine.** ([PR #6](https://github.com/hexuria/ebirforms/pull/6)) Sandbox, guard extraction, inline errors with
  reserved lines.
  *Gate:* parity oracle passes for 1601C, 2551Q, 0619E; GPUIX automation test
  proves no layout shift when errors appear.
- [~] **P4 Form editor.** Branch-owned taxpayer facts, period-aware selected
  form library, light/dark GPUIX shell, and generated editors for the first
  forms (1601C, 2551Q, 0619E) bound to the official runtime instance.
  *Gate:* filled fixtures compute the same totals as the official HTA.
- [ ] **P5 Print preview and print.**
  *Gate:* filled values visible on rendered pages; PDF printed via the OS
  dialog.
- [ ] **P6 Submission.** Official `saveXML()` output captured through the
  shim, LZ + AES payload, queue job, dry run, local SFTP server test, env
  control.
  *Gate:* round-trip decrypt of our payload equals the official
  serialization; dry run never opens a socket.
- [ ] **P7 All forms.** Extend P3 to P6 to every form in the catalog; parity
  sweep report.
- [ ] **P8 Packaging.** `bun build --compile` plus installers per OS.

## Open questions

- First forms: starting with 1601C, 2551Q and 0619E.
- Print preview uses rendered page images (GPUIX has no web view).

## Evidence

- REA `inspect-web-page` on https://www.bir.gov.ph/ebirforms shows the
  download link "Offline eBIRForms Package v7.9.6.2.1" (installer SHA-256
  `e34979cf...cb96b6`, the same as the `buwiz-validation` manifest). Latest
  confirmed.

## Change log

- Initial plan.
- Switched validation, compute and serialization to the official runtime
  engine (spike verified). Confirmed v7.9.6.2.1 is still the latest via REA.
  P1 counts corrected (79 active forms; 0620, 1621, 1709 and 2550DS are
  commented out in `BIRForms.hta`, and 1709 has no HTA).
- P0 gate passed. P1 started. Field-set gaps explained: 1601C `txtRDOCode` is
  built in a `$(document).ready` handler (the sandbox must fire ready), and
  2551Q's rules list `txtEmail` twice (serialized twice). The P1 field model is
  therefore the captured official `saveXML()` output.
- P1 slice in #4: `openOfficialForm` runs official compute/validate/saveXML. Rules-vs-official
  diffs are explicit (`merged` txtAddress2, `absent` commented 2551Q txtEmail, `moved` 2551Q RDO).
  Open takes ~2.4-3.1 s (ready wait capped at 3 s); optimize in P3 if the editor needs it.
- P2 slice in #5: SQLite store (TIN9 -> branch -> year profiles, selected-only library),
  queue with backoff/dead-letter/crash recovery, redacting JSONL logger with live stream, GPUIX
  screens; reserved error rows verified pixel-stable. Note: this VM has live `BIR_SFTP_*` set,
  so tests and dev launches must keep stripping `BIR_SFTP_LIVE` until P6 adds an explicit guard.
- P3 slice in #6: `validate()` = official first alert (Validate-button onclick + focus capture)
  + acorn guard extraction for all errors; random-fill oracle 50/50 per form.
  Remaining known coverage gap: 1601C loop-contained schedule guards (:3035-3108).
- P4: load local non-VBScript scripts from each target HTA in document order,
  capture sandbox errors, and derive field labels/items from preceding row/cell
  text. Eventful `computeSchedule1()` uses global `d` and
  `d.getElementById('tblSched1a').rows.length` (`BIR-Form1601Cv2018.hta:3550`);
  the element is a `<tbody>` (`:1246`). The official shell supplies `d=document`
  (`BIRForms.hta:123`), so the sandbox mirrors that alias and polyfills the
  missing `HTMLTableSectionElement.rows` property in happy-dom 21.0.1 (its
  declaration exposes only `insertRow`/`deleteRow`). RDO options are read by
  the official `loadXMLrdo()` through `Scripting.FileSystemObject`; the runtime
  provides a read-only package-confined file shim so `xml/rdo.xml` is available
  without editing vendor files. `getReqWithheldCompute`
  has no definition in the package and is
  referenced only by disabled 2551Q rate fields (:1974-2085), so read-only
  fields are not included in the eventful fill oracle. Drafts use schema v3;
  new-draft prefill and reopening use `FormInstance.set()` before saving values.
- The P4 redesign replaces the unmerged P4 draft-only v3 migration with one
  consolidated v3 migration from main's v2 schema. It promotes taxpayer and
  branch facts out of year profiles, copies the latest profile facts into
  those shared records, and creates period-unique drafts. The intermediate
  P4 v3 draft schema never shipped, so no v3-to-v4 migration is needed.
- Filing frequency is read from the active official catalog labels, with
  explicit overrides for forms whose labels do not name a period. Runtime
  field snapshots carry the nearest official `Part I`, `Part II`, etc. heading
  so the editor follows the form's structure rather than item numbering.
- P4 scratch walkthrough data is seeded by `scripts/seed-p4.ts`; it uses
  `EBIRFORMS_DATA_DIR`, a generated second test TIN, and no live SFTP setting.
  Bricolage Grotesque and its OFL license are bundled for the native GPUIX font
  registration API, with a system-font fallback when the renderer lacks it.
