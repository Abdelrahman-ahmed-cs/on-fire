"""Step 0.5b — weekly weather EXTREMES from NASA POWER (MERRA-2), for risk version 3.

Weekly means hide the one extreme day that drives a fire (PLAN.md section 13).
This pulls, for the same 1-degree points as 04_weather.py, daily T2M_MAX and
WS10M_MAX and keeps per week:
  tmax_max  = hottest daily maximum temperature of the week (C)
  wind_max  = strongest daily maximum 10 m wind of the week (m/s)

Verified 2026-11-13: WS10M_MAX exists in POWER daily point data (AG community).
The existing weekly-mean files (work/weather/) are NOT touched.

Output: WORK/weather_ext/pt_{iy}_{ix}.parquet then WORK/weather_extremes.parquet
Resumable: points already saved are skipped.

Run: venv python pipeline/04b_weather_extremes.py
"""
import io
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np
import pandas as pd
import requests
from config import WORK

OUTDIR = WORK / "weather_ext"
OUTDIR.mkdir(exist_ok=True)
URL = ("https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,WS10M_MAX"
       "&community=AG&longitude={lon}&latitude={lat}&start=20010101&end=20251231&format=CSV")
EPOCH = pd.Timestamp("2001-01-01")

# exactly the points that 04_weather.py fetched
pts = sorted({tuple(int(v) for v in f.stem.split("_")[1:]) for f in (WORK / "weather").glob("pt_*.parquet")})
todo = [(iy, ix) for iy, ix in pts if not (OUTDIR / f"pt_{iy}_{ix}.parquet").exists()]
print(f"points: {len(pts)} | to fetch: {len(todo)}", flush=True)


def fetch(p):
    iy, ix = p
    url = URL.format(lat=iy + 0.5, lon=ix + 0.5)
    for attempt in range(6):
        try:
            r = requests.get(url, timeout=120)
            if r.status_code == 200 and "-END HEADER-" in r.text:
                d = pd.read_csv(io.StringIO(r.text.split("-END HEADER-")[1])).replace(-999, np.nan)
                date = pd.to_datetime(d.YEAR.astype(str), format="%Y") + pd.to_timedelta(d.DOY - 1, unit="D")
                d["week"] = ((date - EPOCH).dt.days // 7).astype("int32")
                w = d.groupby("week").agg(tmax_max=("T2M_MAX", "max"), wind_max=("WS10M_MAX", "max")).reset_index()
                w.insert(0, "ix", np.int16(ix)); w.insert(0, "iy", np.int16(iy))
                w = w.astype({"tmax_max": "float32", "wind_max": "float32"})
                w.to_parquet(OUTDIR / f"pt_{iy}_{ix}.parquet", index=False)
                return True
            if r.status_code == 422:
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
    pd.concat([pd.read_parquet(f) for f in files]).to_parquet(WORK / "weather_extremes.parquet", index=False)
print(f"EXTREMES_DONE points saved: {len(files)} of {len(pts)} | failed this run: {bad}", flush=True)
sys.exit(0)
