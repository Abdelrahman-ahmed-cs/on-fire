@echo off
rem Makes the folder that is uploaded for hosting: %ONFIRE_DATA%\deploy-context (outside OneDrive).
rem It holds only what the running app reads: no raw FIRMS CSVs, no .env, no node_modules.
setlocal
if "%ONFIRE_DATA%"=="" set ONFIRE_DATA=C:\Users\User\onfire-data
set "SRC=%~dp0.."
set "OUT=%ONFIRE_DATA%\deploy-context"
set "WD=%ONFIRE_DATA%\web\data"
set RC=/NFL /NDL /NJH /NJS /NP /R:1 /W:1

echo Making %OUT% ...
if exist "%OUT%\Dockerfile" rmdir /s /q "%OUT%"
if exist "%OUT%" (echo %OUT% exists but is not a deploy folder - move it away first. & exit /b 1)
mkdir "%OUT%"
copy /y "%~dp0Dockerfile" "%OUT%\" >nul
copy /y "%~dp0.dockerignore" "%OUT%\" >nul
copy /y "%~dp0.gcloudignore" "%OUT%\" >nul

rem On Fire's Python server + Truth vs Prediction / Documentation pages
robocopy "%SRC%\app" "%OUT%\onfire\app" /E %RC%
if errorlevel 8 goto fail
robocopy "%SRC%\server" "%OUT%\onfire\server" *.py %RC%
if errorlevel 8 goto fail
robocopy "%SRC%\pipeline" "%OUT%\onfire\pipeline" *.py %RC%
if errorlevel 8 goto fail
robocopy "%SRC%\pipeline\out" "%OUT%\onfire\pipeline\out" /E %RC%
if errorlevel 8 goto fail
copy /y "%~dp0requirements-server.txt" "%OUT%\onfire\" >nul

rem Web app: code from this folder, data from the runtime copy (it holds the caches)
robocopy "%SRC%\web" "%OUT%\web" /E /XD node_modules dist data /XF start.cmd %RC%
if errorlevel 8 goto fail
robocopy "%WD%" "%OUT%\web\data" /E /XD "%WD%\raw" "%WD%\cache\power" "%WD%\cache\archive" /XF *.log %RC%
if errorlevel 8 goto fail

rem Python data: the tables the server queries + raw detections (hotspot CSV, fire context)
robocopy "%ONFIRE_DATA%\work" "%OUT%\data\work" cell_month.parquet events.parquet event_days.parquet flare_cells.parquet places.parquet %RC%
if errorlevel 8 goto fail
robocopy "%ONFIRE_DATA%\work\cache" "%OUT%\data\work\cache" /E %RC%
if errorlevel 8 goto fail
robocopy "%ONFIRE_DATA%\parquet" "%OUT%\data\parquet" /E %RC%
if errorlevel 8 goto fail

rem Check that the files the app cannot start without are there
for %%f in (
  "web\package-lock.json" "web\client\index.html" "web\data\geo" "web\data\archive" "web\data\ml"
  "web\data\world" "web\data\cache\live-snapshot.json" "onfire\server\main.py" "onfire\pipeline\config.py"
  "onfire\pipeline\out\harmonization_metrics.json" "onfire\app\index.html"
  "data\work\cell_month.parquet" "data\work\events.parquet" "data\parquet\viirs-snpp"
) do if not exist "%OUT%\%%~f" (echo MISSING: %%~f & exit /b 1)
if exist "%OUT%\web\.env" (echo A .env file was copied - stopping. & exit /b 1)

for /f "usebackq" %%s in (`powershell -NoProfile -Command "[math]::Round((Get-ChildItem -LiteralPath '%OUT%' -Recurse -File | Measure-Object Length -Sum).Sum/1MB)"`) do echo Ready: %OUT% (%%s MB)
exit /b 0

:fail
echo Copy failed (robocopy error). Nothing was uploaded.
exit /b 1
