@echo off
setlocal
cd /d "%~dp0\.."
echo Working directory: %CD%

REM Clear skip flags that make electron/install.js exit without downloading
set ELECTRON_SKIP_BINARY_DOWNLOAD=
set npm_config_electron_skip_binary_download=

echo Electron-related env:
set | findstr /I ELECTRON

echo Removing old electron package...
if exist node_modules\electron rmdir /s /q node_modules\electron

echo Installing electron package...
call npm install electron --foreground-scripts
if errorlevel 1 (
  echo Direct install failed; trying mirror...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install electron --foreground-scripts
  if errorlevel 1 exit /b 1
)

echo Forcing binary download via ensure-electron...
call npm run ensure-electron
if errorlevel 1 (
  echo ensure-electron failed; retrying with mirror...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm run ensure-electron
  if errorlevel 1 exit /b 1
)

echo Running tests...
call npm test
if errorlevel 1 exit /b 1

echo Done. Electron is installed and tests passed.
