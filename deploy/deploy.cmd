@echo off
rem Puts On Fire online on Google Cloud Run (first time and every update).
rem Usage:  deploy\deploy.cmd YOUR-PROJECT-ID
rem Needs:  the Google Cloud CLI, signed in (gcloud auth login). Docker is NOT needed:
rem         the image is built by Google Cloud Build from the uploaded folder.
setlocal
if "%~1"=="" (echo Usage: deploy\deploy.cmd YOUR-PROJECT-ID & exit /b 1)
set "P=%~1"
if "%REGION%"=="" set REGION=us-central1
if "%ONFIRE_DATA%"=="" set ONFIRE_DATA=C:\Users\User\onfire-data
set "CTX=%ONFIRE_DATA%\deploy-context"
set "IMG=%REGION%-docker.pkg.dev/%P%/onfire/onfire"
set "ENVFILE=%~dp0..\.env"

where gcloud >nul 2>nul || (echo Install the Google Cloud CLI first: https://cloud.google.com/sdk/docs/install & exit /b 1)

echo [1/6] Making the upload folder
call "%~dp0stage.cmd" || exit /b 1

echo [2/6] Project %P%, turning on Cloud Run, Cloud Build, Artifact Registry, Secret Manager
call gcloud config set project %P% --quiet || exit /b 1
call gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com || exit /b 1
call gcloud artifacts repositories describe onfire --location=%REGION% >nul 2>nul
if errorlevel 1 call gcloud artifacts repositories create onfire --repository-format=docker --location=%REGION% || exit /b 1

echo [3/6] FIRMS key into Secret Manager (read from .env on every deploy, never printed, never in the image)
set "KEY="
for /f "usebackq tokens=1,* delims==" %%a in ("%ENVFILE%") do if "%%a"=="FIRMS_MAP_KEY" set "KEY=%%b"
if not defined KEY (echo FIRMS_MAP_KEY not found in %ENVFILE% & exit /b 1)
call gcloud secrets describe firms-key >nul 2>nul
if not errorlevel 1 goto haveSecret
<nul set /p "=%KEY%" | call gcloud secrets create firms-key --replication-policy=automatic --data-file=- >nul || exit /b 1
goto secretDone
:haveSecret
rem a new key in .env (for example a regenerated one) becomes a new secret version
set "OLD="
for /f "usebackq delims=" %%k in (`gcloud secrets versions access latest --secret^=firms-key 2^>nul`) do set "OLD=%%k"
if not "%OLD%"=="%KEY%" (
  echo The key in .env changed - storing the new one.
  <nul set /p "=%KEY%" | call gcloud secrets versions add firms-key --data-file=- >nul || exit /b 1
)
:secretDone
set "KEY=" & set "OLD="
for /f "usebackq" %%n in (`gcloud projects describe %P% --format^="value(projectNumber)"`) do set "PN=%%n"
call gcloud secrets add-iam-policy-binding firms-key --member=serviceAccount:%PN%-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor >nul || exit /b 1

echo [4/6] Uploading and building the image (about 1.3 GB upload, 10-30 min)
call gcloud builds submit "%CTX%" --tag %IMG% --timeout=3600s --machine-type=e2-highcpu-8 || exit /b 1

echo [5/6] Starting the service
rem 1 instance always on (no cold start for judges), CPU always on so live fires and the forecast refresh run in the background.
call gcloud run deploy onfire --image %IMG% --region %REGION% --allow-unauthenticated ^
  --port 8080 --cpu 2 --memory 4Gi --min-instances 1 --max-instances 2 --no-cpu-throttling --cpu-boost ^
  --timeout 300 --set-secrets FIRMS_MAP_KEY=firms-key:latest || exit /b 1

echo [6/6] Done. On Fire is online at:
call gcloud run services describe onfire --region %REGION% --format="value(status.url)"
