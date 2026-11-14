"""Step 0.5 — weather from NASA POWER (MERRA-2), aggregated to weeks.

One request per 1-degree point (centre of the cell) for 2001-2025 daily, four
variables. Each response is reduced to weekly values at once, so only small files
are kept. Resumable: points already saved are skipped. Verified 2026-11-13: one
point = ~2.8 s and ~280 KB; ~4,100 points are needed.

Weather is on a 1-degree grid (coarser than the 0.25-degree fire grid) to keep the
download feasible; MERRA-2's native grid is 0.5 x 0.625 degrees. This is a stated
limitation.

Week index: (date - 2001-01-01).days // 7   (same definition used by the model).

Output: WORK/weather/pt_{iy}_{ix}.parquet  then  WORK/weather_weekly.parquet
  columns: iy, ix (1-degree cell index = floor(lat), floor(lon)), week,
           tmax (mean of daily max, C), rh (mean %), wind (mean m/s), rain (sum mm)

Run: venv python pipeline/04_weather.py
"""
import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np
import pandas as pd
import requests
from config import WORK

OUTDIR = WORK / "weather"
OUTDIR.mkdir(exist_ok=True)
URL = ("https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,RH2M,WS10M,PRECTOTCORR"
       "&community=AG&longitude={lon}&latitude={lat}&start=20010101&end=20251231&format=CSV")
EPOCH = pd.Timestamp("2001-01-01")

cells = pd.read_parquet(WORK / "cell_month.parquet", columns=["lat", "lon"]).drop_duplicates()
pts = sorted(set(zip(np.floor(cells.lat).astype(int), np.floor(cells.lon).astype(int))))
todo = [(iy, ix) for iy, ix in pts if not (OUTDIR / f"pt_{iy}_{ix}.parquet").exists()]
print(f"points: {len(pts)} | to fetch: {len(todo)}", flush=True)

def fetch(p):
    iy, ix = p
    url = URL.format(lat=iy + 0.5, lon=ix + 0.5)
    for attempt in range(6):
        try:
            r = requests.get(url, timeout=120)
            if r.status_code == 200 and "-END HEADER-" in r.text:
                d = pd.read_csv(io.StringIO(r.text.split("-END HEADER-")[1]))
                d = d.replace(-999, np.nan)
                date = pd.to_datetime(d.YEAR.astype(str), format="%Y") + pd.to_timedelta(d.DOY - 1, unit="D")
                d["week"] = ((date - EPOCH).dt.days // 7).astype("int32")
                w = d.groupby("week").agg(tmax=("T2M_MAX", "mean"), rh=("RH2M", "mean"),
                                          wind=("WS10M", "mean"), rain=("PRECTOTCORR", "sum")).reset_index()
                w.insert(0, "ix", np.int16(ix)); w.insert(0, "iy", np.int16(iy))
                w = w.astype({"tmax": "float32", "rh": "float32", "wind": "float32", "rain": "float32"})
                w.to_parquet(OUTDIR / f"pt_{iy}_{ix}.parquet", index=False)
                return True
            if r.status_code == 422:      # point not valid (e.g. outside coverage)
                return False
        except Exception:
            pass
        time.sleep(3 * (attempt + 1))
    return False

ok = bad = 0
t0 = time.time()
with ThreadPoolExecutor(max_workers=5) as ex:
    for i, f in enumerate(as_completed([ex.submit(fetch, p) for p in todo]), 1):
        ok += f.result(); bad += not f.result()
        if i % 100 == 0:
            rate = i / (time.time() - t0)
            print(f"{i}/{len(todo)} ok={ok} failed={bad} eta={int((len(todo)-i)/rate/60)} min", flush=True)

files = list(OUTDIR.glob("pt_*.parquet"))
if files:
    pd.concat([pd.read_parquet(f) for f in files]).to_parquet(WORK / "weather_weekly.parquet", index=False)
print(f"WEATHER_DONE points saved: {len(files)} of {len(pts)} | failed this run: {bad}", flush=True)
sys.exit(0)
