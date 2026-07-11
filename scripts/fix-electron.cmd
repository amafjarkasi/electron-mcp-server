@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."
echo Working directory: %CD%

set ELECTRON_SKIP_BINARY_DOWNLOAD=
set npm_config_electron_skip_binary_download=

echo Removing old electron package...
if exist node_modules\electron rmdir /s /q node_modules\electron

echo Installing electron package...
call npm install electron --foreground-scripts
if errorlevel 1 (
  echo Direct install failed; trying mirror...
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  call npm install electron --foreground-scripts
  if errorlevel 1 (
    echo npm install electron failed
    exit /b 1
  )
)

echo Forcing binary download via node scripts\ensure-electron.mjs ...
node "%~dp0ensure-electron.mjs"
set ENSURE_EXIT=%ERRORLEVEL%
echo ensure-electron exit code: %ENSURE_EXIT%
if not "%ENSURE_EXIT%"=="0" (
  echo ensure-electron failed; clearing cache and retrying with mirror...
  if exist "%LOCALAPPDATA%\electron\Cache" rmdir /s /q "%LOCALAPPDATA%\electron\Cache"
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  node "%~dp0ensure-electron.mjs"
  set ENSURE_EXIT=%ERRORLEVEL%
  echo ensure-electron retry exit code: %ENSURE_EXIT%
  if not "%ENSURE_EXIT%"=="0" (
    echo ensure-electron failed again
    exit /b 1
  )
)

if not exist "node_modules\electron\path.txt" (
  echo path.txt still missing after ensure-electron
  echo Listing dist:
  dir /b "node_modules\electron\dist" 2>nul
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo electron.exe still missing after ensure-electron
  echo path.txt content:
  type "node_modules\electron\path.txt"
  echo Listing dist:
  dir /b "node_modules\electron\dist" 2>nul
  exit /b 1
)

echo Electron binary OK.
type "node_modules\electron\path.txt"
echo Running tests...
call npm test
if errorlevel 1 exit /b 1

echo Done. Electron is installed and tests passed.
exit /b 0
