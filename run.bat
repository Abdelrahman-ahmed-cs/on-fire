@echo off
rem Starts On Fire at http://localhost:8000 (close the server window to stop it).
rem   8000  the app (Live fires, Forecast, History, AI risk, Truth vs Prediction)
rem   8001  On Fire Python server (Truth vs Prediction + Documentation pages, data API),
rem         started by the Node server.
rem The app code lives in .\web; web\start.cmd builds and runs it from a copy in
rem %ONFIRE_DATA%\web, outside OneDrive, where its node_modules are.
start "On Fire (8000 + 8001)" cmd /k ""%~dp0web\start.cmd""
timeout /t 8 >nul
start "" http://localhost:8000
