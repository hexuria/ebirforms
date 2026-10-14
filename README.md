# eBIRForms

Native desktop eBIRForms for preparing, validating, printing, and submitting
Philippine BIR returns. It uses GPUIX (React on GPUI) and runs with Bun.

## Getting started

```sh
git clone --recurse-submodules https://github.com/hexuria/ebirforms.git
cd ebirforms
```

On Windows, run `.\scripts\setup-windows.ps1` in PowerShell. On macOS or Linux,
run:

```sh
sh scripts/setup-unix.sh
```

Start the desktop app:

```sh
bun run dev
```

Build a release binary for the OS you are on:

```sh
bun run release            # apps/desktop/dist/ebirforms (ebirforms.exe on Windows)
apps/desktop/dist/ebirforms
```

The binary needs no Bun or Node install. It embeds GPUIX's native module and
the font, and reads the official forms and print sheets from the `vendor/`
folder the build puts beside it (about 85 MB); ship the two together, or point
`EBIRFORMS_VENDOR_DIR` elsewhere. Data goes to the usual app data folder unless
`EBIRFORMS_DATA_DIR` is set. Wrapping it in a `.app`, `.dmg` or installer
(cargo-packager) is not set up yet.

## SFTP environment

Copy `.env.example` to `.env` to configure direct SFTP submission. Only
`BIR_SFTP_LIVE=1` enables real submission; otherwise the app stays in dry-run
mode.

| Variable | Default | Description |
|---|---|---|
| `BIR_SFTP_LIVE` | empty | Only `1` enables live submission. |
| `BIR_SFTP_HOST` | empty | Live SFTP host; without it, live mode uses the dispatcher. |
| `BIR_SFTP_PORT` | `22` | Direct SFTP port, from 1 to 65535. |
| `BIR_SFTP_USERNAME` | empty | Required for direct live SFTP. |
| `BIR_SFTP_PASSWORD` | empty | Required for direct live SFTP. |
