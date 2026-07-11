# Fix Electron binary install on Windows for this repo.
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File .\scripts\fix-electron.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host "Working directory: $(Get-Location)"

Remove-Item Env:ELECTRON_SKIP_BINARY_DOWNLOAD -ErrorAction SilentlyContinue
Remove-Item Env:npm_config_electron_skip_binary_download -ErrorAction SilentlyContinue

Write-Host "Removing old electron package..."
Remove-Item -Recurse -Force .\node_modules\electron -ErrorAction SilentlyContinue

Write-Host "Installing electron with foreground scripts..."
npm install electron --foreground-scripts
if ($LASTEXITCODE -ne 0) {
  Write-Host "Direct install failed; trying China mirror..."
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  npm install electron --foreground-scripts
  if ($LASTEXITCODE -ne 0) {
    throw "npm install electron failed"
  }
}

Write-Host "Running ensure-electron..."
npm run ensure-electron
if ($LASTEXITCODE -ne 0) {
  throw "ensure-electron failed"
}

Write-Host "Running tests..."
npm test
if ($LASTEXITCODE -ne 0) {
  throw "npm test failed"
}

Write-Host "Done. Electron is installed and tests passed."
