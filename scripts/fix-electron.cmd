@echo off
setlocal
cd /d "%~dp0\.."
echo Working directory: %CD%

set ELECTRON_SKIP_BINARY_DOWNLOAD=
set npm_config_electron_skip_binary_download=

echo Removing old electron package...
if exist node_modules\electron rmdir /s /q node_modules\electron

echo Installing electron with foreground scripts...
call npm install electron --foreground-scripts
if errorlevel 1 (
  echo Direct install failed; trying mirror...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install electron --foreground-scripts
  if errorlevel 1 exit /b 1
)

echo Running ensure-electron...
call npm run ensure-electron
if errorlevel 1 exit /b 1

echo Running tests...
call npm test
if errorlevel 1 exit /b 1

echo Done. Electron is installed and tests passed.
