@echo off
rem ===========================================================================
rem  On Fire - one-click setup and start (Windows). Double-click this file.
rem  Needs: Node.js (LTS) and Python 3.11 or newer, and an internet connection.
rem  First run: installs the server packages, downloads the 25-year fire record
rem  (about 660 MB) into .\localdata, builds the app and opens it in the browser.
rem  Later runs: just start the app.
rem ===========================================================================
setlocal
cd /d "%~dp0"
set "DATA_URL=https://github.com/Abdelrahman-ahmed-cs/on-fire/releases/download/data-v1/onfire-data.zip"
echo.
echo  On Fire - setup
echo  ---------------

rem ---- 1. Node.js ----
where node >nul 2>nul
if errorlevel 1 goto noNode
for /f "delims=" %%v in ('node -v') do echo  Node.js %%v found

rem ---- 2. Python 3.11+ ----
set "PYEXE="
py -3.12 -c "import sys" >nul 2>nul
if not errorlevel 1 set "PYEXE=py -3.12"
if defined PYEXE goto havePython
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if not errorlevel 1 set "PYEXE=python"
if not defined PYEXE goto noPython
:havePython
echo  Python found: %PYEXE%

rem ---- 3. Python packages, in .venv inside this folder ----
if exist ".venv\Scripts\python.exe" goto venvReady
echo  Creating the Python environment ...
%PYEXE% -m venv .venv
if errorlevel 1 goto fail
:venvReady
echo  Installing the Python server packages, first time only ...
".venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r deploy\requirements-server.txt
if errorlevel 1 goto fail

rem ---- 4. The 25-year fire record ----
if exist "localdata\work\cell_month.parquet" goto dataReady
if exist "onfire-data.zip" goto unzip
echo  Downloading the 25-year fire record, about 660 MB ...
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%DATA_URL%' -OutFile 'onfire-data.zip'"
if errorlevel 1 goto fail
:unzip
echo  Unpacking the fire record ...
if not exist "localdata" mkdir "localdata"
tar -xf "onfire-data.zip" -C "localdata"
if errorlevel 1 powershell -NoProfile -Command "Expand-Archive -LiteralPath 'onfire-data.zip' -DestinationPath 'localdata' -Force"
if not exist "localdata\work\cell_month.parquet" goto fail
del "onfire-data.zip"
:dataReady
echo  Fire record ready.
rem (used by the automated test: install only, do not open windows)
if "%ONFIRE_SETUP_ONLY%"=="1" exit /b 0

rem ---- 5. Start ----
echo  Starting On Fire in a new window. The first start builds the app, 1 to 3 minutes ...
start "On Fire (close this window to stop)" cmd /k ""%~dp0web\start.cmd""
powershell -NoProfile -Command "for ($i = 0; $i -lt 150; $i++) { try { Invoke-WebRequest -Uri 'http://localhost:8000/' -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { Start-Sleep -Seconds 2 } }; exit 1"
if errorlevel 1 (
  echo  The app did not answer yet. Look at the On Fire window for messages, then open http://localhost:8000
) else (
  echo  On Fire is running at http://localhost:8000
  start "" http://localhost:8000
)
echo.
pause
exit /b 0

:noNode
echo  Node.js is not installed. Install the LTS version from https://nodejs.org and run setup.bat again.
pause
exit /b 1
:noPython
echo  Python 3.11 or newer is not installed. Install it from https://www.python.org/downloads/
echo  and tick "Add python.exe to PATH", then run setup.bat again.
pause
exit /b 1
:fail
echo  Setup stopped because of the error above. Check the internet connection and run setup.bat again.
pause
exit /b 1
