# Putting On Fire online

One container on **Google Cloud Run** runs the whole app: the Node server on the public port and
On Fire's Python server inside, at 127.0.0.1:8001. Truth vs Prediction is reached through
`/truth/`. The free **GoDaddy domain** points at it. Docker is not needed on your PC: Google builds
the image.

## Files
| File | What it does |
|---|---|
| `stage.cmd` | Copies only what the running app reads into `C:\Users\User\onfire-data\deploy-context` (about 830 MB). Leaves out raw FIRMS CSVs, `.env` and node_modules. |
| `Dockerfile` | Builds the web client with Node 26, then runs on Python 3.12 plus Node. |
| `requirements-server.txt` | Only the Python packages the server imports. |
| `deploy.cmd` | Does everything: stage, turn on services, store the FIRMS key as a secret, build in the cloud, start the service. |

## One-time setup (you)
1. Claim the Google Cloud offer and create a project. Note its **project ID**.
2. Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install
3. In a new terminal, sign in:
   ```bash
   gcloud auth login
   ```

## Deploy (first time and every update)
From this project folder:
```bash
deploy\deploy.cmd YOUR-PROJECT-ID
```
At the end it prints the address, something like `https://onfire-xxxx.us-central1.run.app`.
The upload and build take 10–30 minutes. The FIRMS key is read from `.env` into Secret Manager
on every deploy. It is never printed and never goes into the image. If you get a new key, put it
in `.env` and deploy again.

Settings used: 2 CPU, 4 GB memory, **1 instance always on**, so judges never wait for a cold
start, and CPU always on, so live fires and the forecast refresh keep running in the background.
That costs money every hour, even with nobody visiting. Check the credit you got. After judging, run:
```bash
gcloud run services update onfire --region us-central1 --min-instances 0 --cpu-throttling
```

## Your domain (GoDaddy)
1. Claim the free domain from the GoDaddy offer.
2. Prove to Google that you own it. This opens a page with a TXT record to add in GoDaddy DNS:
   ```bash
   gcloud domains verify YOUR-DOMAIN.com
   ```
3. Map `www` to the app:
   ```bash
   gcloud beta run domain-mappings create --service onfire --domain www.YOUR-DOMAIN.com --region us-central1
   ```
   In GoDaddy DNS, add the record it prints: CNAME `www` → `ghs.googlehosted.com`.
4. In GoDaddy, set **Forwarding** for `YOUR-DOMAIN.com` → `https://www.YOUR-DOMAIN.com`.
5. The HTTPS certificate is created by Google. That takes 15 minutes to a few hours.

## Notes
- Live data, area caches and forecast caches written while running are lost when the instance
  restarts. The image ships with the latest snapshot, so the app opens with data at once and then
  refreshes.
- To update the hosted copy, run `deploy.cmd` again. Your PC copy is not affected.
