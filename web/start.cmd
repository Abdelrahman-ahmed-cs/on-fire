@echo off
rem Sync the On Fire web app to a working copy, build it, and run it on port 8000
rem (the Node server also starts On Fire's Python server on port 8001).
rem Data folder: ONFIRE_DATA if set; else C:\Users\User\onfire-data when it exists (the team's PC);
rem else the project's own localdata folder (a fresh PC after setup.bat).
if "%ONFIRE_DATA%"=="" if exist "C:\Users\User\onfire-data\work\cell_month.parquet" set "ONFIRE_DATA=C:\Users\User\onfire-data"
if "%ONFIRE_DATA%"=="" for %%i in ("%~dp0..\localdata") do set "ONFIRE_DATA=%%~fi"
rem Python: the data folder's venv if there is one, else the project's .venv made by setup.bat
if "%ONFIRE_PYTHON%"=="" if exist "%ONFIRE_DATA%\venv\Scripts\python.exe" set "ONFIRE_PYTHON=%ONFIRE_DATA%\venv\Scripts\python.exe"
if "%ONFIRE_PYTHON%"=="" for %%i in ("%~dp0..\.venv\Scripts\python.exe") do set "ONFIRE_PYTHON=%%~fi"
rem The project folder (Python server, Truth vs Prediction pages)
if "%ONFIRE_DIR%"=="" for %%i in ("%~dp0..") do set "ONFIRE_DIR=%%~fi"
robocopy "%~dp0." "%ONFIRE_DATA%\web" /E /XD node_modules dist /NFL /NDL /NJH /NJS /NP >nul
cd /d "%ONFIRE_DATA%\web"
if not exist node_modules call npm ci
call npm run build || exit /b 1
set API_PORT=8000
node --env-file="%~dp0..\.env" server/index.js
