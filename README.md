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
