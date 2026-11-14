# On Fire

**NASA Space Apps Challenge 2026 — Harmonization of MODIS and VIIRS Hot Spots**

Twenty-five years of satellite fire detections come from two sensors that count
fire differently. On Fire turns them into one consistent record and builds a
burning-activity calendar, a fire map and a risk model on top of it, for North
America, North Africa and the Middle East (25 countries).

Every number below is produced by the scripts in `pipeline/` and stored in
`pipeline/out/`. None is typed in by hand.

## What it shows

Both regions (Middle East & North Africa, North America) are on one map; a switch in the top bar
picks which one the side panel describes, and a "Travel to" button flies between them.

| Page | What you can do |
|---|---|
| **Live fires** | NASA FIRMS detections from five satellites (refreshed every 20 minutes), grouped into fires, gas flares removed; countries and US states / Canadian provinces / Mexican states coloured by activity. Click a fire: spread rings for +3/+6/+12/+24 h, the first town it could reach and when, a warning card, smoke, air quality, people nearby, emissions, **how big it is compared with the fires that burned within 50 km in 2012–2025**, and a CAP alert file. |
| **Forecast** | For a country: projected spread of the main fires from the wind forecast, smoke plumes, towns at risk, and a 3-day ignition-likelihood glow. |
| **History** | Where fires usually burn in each month, from 25 years of harmonized records, with a month player. |
| **AI risk** | The model's chance of fire per ~50 km cell this month or next, red alerts, and the reasons behind any cell. |
| **Truth vs Prediction** | Six past fires replayed: the frozen model's risk map before each fire against what burned. |

The side panel's **Seasonality** tab is the burning-activity calendar for the region or a country:
25 years month by month (amount or anomaly), a normal year, fire season, busiest years and months,
this month against the historical **median**, **any date range** with statistics, and downloads
(calendar CSV/PNG, every hotspot for a country and date range as CSV). The **Area** button draws a
box (or takes typed latitude/longitude corners) and gives that area the same calendar, extended to
2026 from NASA FIRMS, with "this month so far vs the same dates in 2012–2025". **Methodology** shows
the harmonization proof for the place.

## Results

**Harmonization** (scored on 2014, 2017, 2020 and 2023, which were never used for fitting or for choosing the method):

- Disagreement between MODIS-derived and VIIRS monthly country totals: **144.1% → 30.3%**.
- At the 2012 sensor switch, measured against MODIS alone: the harmonized series is off by a factor of 1.25; a naive switch of sensor is off by 6.5.
- Weakest for very small or flare-dominated countries (Bahrain 69%, Cyprus 56%, Qatar 54%).

**Gas flares.** In Qatar 93.7% of VIIRS detections are static industrial sources; Libya 83.9%, Iraq 82.2%, Iran 80.8%, Algeria 80.5%. Our behaviour-based detector agrees with NASA's static-source flag with 96.2% precision and 97.0% recall by detections (by location its recall is only 26.7%: small, occasional sources are missed).

**Risk model** (trained to 2018, tuned on 2019–2020, frozen, scored on 2021–2025):

Three versions were trained; the one with the best 2019–2020 score is used. That is **version 3, which also uses the weather of the predicted week as a 7-day forecast. In these backtests the real weather stands in for the forecast, so every version-3 number assumes a perfect 7-day weather forecast** and is an upper bound. The best version without forecast weather (version 2) is shown next to it.

| 2021–2025, never used to choose | Version 3 (assumes a perfect 7-day weather forecast) | Version 2 (no forecast) | Baseline |
|---|---|---|---|
| Large fires (8,728) begun inside the country's top 10% of risk | **59.2%** | 58.4% | 47.8% |
| Precision-recall score | 0.569 | 0.550 | 0.441 |
| Burning cell-weeks inside the top 10% of risk | 65.0% | 63.5% | 55.6% |
| ROC-AUC | 0.924 | 0.919 | 0.859 |

- Three fires fixed before training (version 3, assumes a perfect 7-day weather forecast; version 2 in brackets): Kabylie 2021 flagged, 97.7th percentile (97.3); Dixie 2021 raised but not flagged, 72.5th (66.5); **Manavgat 2021 still not anticipated, 54.4th (46.3), even with perfect forecast weather**. Three more chosen by rule (largest per region): Canada 2023 flagged; Iraq 2025 raised; Sudan 2025 no better than baseline. All six are shown in the app.

## Method in brief

1. **Vegetation fires only.** Detections NASA marks as static sources, volcanoes or offshore are removed.
2. **Count active cell-days, not pixels.** A VIIRS pixel is about seven times smaller than a MODIS pixel, so the same fire yields many more VIIRS detections. Both sensors are reduced to the number of 0.1° cells burning each day.
3. **Calibrate MODIS to VIIRS on the overlap (2012 onward)**, per country and season: a power law where MODIS saw fire, plus a small-fire background where it saw none.
4. **One series:** VIIRS from 2012, calibrated MODIS before, with an uncertainty band from held-out residuals.

Fire events are connected groups of detections in space and time. Severity is a fire's size percentile within its own country. The risk model is LightGBM on 0.25° cells per week; every fire input comes from before the week being predicted, and version 3 adds that week's weather (mean and extreme day) as a forecast.

## Limits

- Harmonized values before 2012 are estimates (typically within 0.58×–1.51× for a country-month).
- Satellites miss fires under cloud and between overpasses; "area touched" is an upper bound, not burned area.
- The risk model ranks places; it does not predict where a fire starts. Most of its skill comes from fire history. Weather is on a coarse 1° grid.
- The spread envelope is a rule-of-thumb estimate that ignores terrain, vegetation and firefighting. Places under 500 people and people living outside named places are not counted. "What is burning" uses 500 m MODIS land cover from the year before the fire, so small fields and villages can be missed. Air quality is only available from August 2022.
- The app is decision support. It drafts alert text; it never sends anything and never issues evacuation orders.
- Live fires, the forecast and 2026 in the calendars need a NASA FIRMS map key (`FIRMS_MAP_KEY` in `.env`; a free key is included for judging).
- VIIRS S-NPP has sent no data since 2 November 2026 (NASA FIRMS data-availability list). The app does not count those days as "no fire": unfinished months are left out of drawn-area calendars, and the country/region records fill November 2026 with calibrated MODIS.
- Coverage is the Middle East & North Africa and North America. A drawn box outside these countries is refused with a message.
- Past fires used for comparison are connected groups of VIIRS detections; where burning is almost continuous (savanna, farmland) one "fire" can be a whole season.

## Run it

**Quick start (Windows):** install [Node.js](https://nodejs.org) (LTS) and
[Python](https://www.python.org/downloads/) 3.11 or newer (tick "Add python.exe to PATH"), download
this repository, then double-click **`setup.bat`**. The first run installs the Python server packages
into `.venv`, downloads the 25-year fire record (about 660 MB, from this repository's Releases) into
`localdata`, builds the app and opens http://localhost:8000. Later runs just start it. Needs an
internet connection and about 3 GB of free disk.

### Developer setup (rebuilding the data)

Requirements: Windows, Python 3.12, Node.js (tested with 26), about 4 GB of free disk for data.

A NASA FIRMS map key is **included** in `.env` so the app runs as downloaded (live fires, the
forecast and 2026 in the calendars use it). It is a free key for open data, published on purpose
for judging. If it stops working (shared quota), get your own free key at
https://firms.modaps.eosdis.nasa.gov/api/map_key/ and replace the value in `.env`.

```
python -m venv C:\Users\User\onfire-data\venv
C:\Users\User\onfire-data\venv\Scripts\pip install -r requirements.txt
run.bat
```

`run.bat` calls `web\start.cmd`, which copies `web/` to `%ONFIRE_DATA%\web` (default
`C:\Users\User\onfire-data\web`), installs its packages, builds the client with Vite and starts the
Node server on port 8000; Node starts the Python server (FastAPI) on 127.0.0.1:8001 and passes
`/truth/` through to it. Open http://localhost:8000. Hosting on Google Cloud Run: see `deploy/README.md`.

### Rebuild the data from scratch

The raw data (about 3 GB) is not in this repository. To rebuild everything:

| Step | Command (run from `pipeline/` with the venv's Python) | Time |
|---|---|---|
| Download the FIRMS archive | `bash ../scripts/download_firms.sh` | depends on connection |
| Convert to Parquet | `01_ingest.py` | ~5 min |
| Harmonize and validate | `02_harmonize.py` | ~3 min |
| Detect gas flares | `03_flares.py` | ~2 min |
| Download weather | `04_weather.py` | ~40 min |
| Group fire events | `05_events.py` | ~12 min |
| Country boundaries | `06_boundaries.py` (needs Natural Earth 50m countries in the work folder) | seconds |
| Weekly weather extremes for risk version 3 | `04b_weather_extremes.py` | ~30 min |
| Train and score the risk model | `07_risk.py` | ~20 min |
| Villages, towns and cities | `08_places.py` (needs GeoNames `cities500.txt` in `work/geonames/`) | seconds |

## Data sources

- **NASA FIRMS** active-fire archive: MODIS Collection 6.1 (Terra, Aqua) and VIIRS S-NPP 375 m, 2000–2025.
- **NASA POWER** (MERRA-2) weekly weather for the risk model. **NASA GIBS** basemaps.
- Open-Meteo (ERA5 wind, CAMS air quality) for a selected fire. Esri World Imagery for the zoomed view.
- Natural Earth boundaries. GeoNames cities500: every place with 500+ people (CC BY 4.0).
- **NASA MODIS land cover** (MCD12Q1, IGBP classes, 500 m) via NASA GIBS, read per opened fire for "what is burning".

## Project layout

```
web/        the app: React + Vite client (web/client), Node/Express server (web/server),
            its data (web/data: harmonized archive, map shapes, AI model)
app/        Truth vs Prediction and Documentation pages (plain JS), served by the Python server
server/     FastAPI service: area calendars, hotspot queries, past fires, Truth vs Prediction data
pipeline/   numbered scripts that build everything; results in pipeline/out/
deploy/     container build and (optional) Google Cloud Run deployment
scripts/    data download
requirements.txt   Python packages for the pipeline and the Python server
run.bat     starts the app on Windows (http://localhost:8000)
```

## Use of AI (Super Intelligence) — disclosure

- **Code and documentation:** written with the help of **Claude (Anthropic), through Claude Code**,
  as a coding assistant directed and reviewed by the team: the web app, the servers, the data
  pipeline and the documentation (including this README and the project-page texts). The working
  notes of that collaboration (plan and build log) are kept by the team and available on request.
- **Numbers:** every metric in the app and in this README is produced by the project's own scripts
  from NASA data and saved in `pipeline/out/`; none is typed in by hand.
- **Machine learning in the product:** two gradient-boosted decision-tree models trained on NASA
  FIRMS and NASA POWER data: LightGBM in `pipeline/07_risk.py` (Truth vs Prediction) and a small
  JavaScript implementation in `web/server/lib/gbm.js`, trained by
  `web/server/scripts/train-risk-model.js` (AI risk page). Neither is a language model.
- **No AI service at run time:** the app calls no AI or language-model API; alert texts are fixed
  English templates filled with computed numbers.
- No NASA logos or branding are used.

Not affiliated with NASA. NASA data is used under its open data policy.
