$ErrorActionPreference = 'Stop'

$bunBin = Join-Path $env:USERPROFILE '.bun\bin'
$env:PATH = "$bunBin;$env:PATH"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $env:PATH = "$bunBin;$env:PATH"
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw 'Bun installation did not make bun available on PATH.'
}

Set-Location (Split-Path $PSScriptRoot -Parent)
git submodule update --init --recursive
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

bun install
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
