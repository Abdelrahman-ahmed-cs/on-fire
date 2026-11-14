"""Phase 3 — group hotspots into fire events.

A hotspot is one pixel; a fire is many pixels over several days. Counting pixels
as "fires" is wrong, so detections are grouped:
  - VIIRS, quality-filtered, vegetation fires only (type 0), and not inside a
    static-source cell found by 03_flares.py.
  - Each detection goes to a 0.05 degree cell on its day ("cell-day").
  - Two cell-days belong to the same fire if they touch (8 neighbours) and are at
    most 2 days apart. Connected groups are fire events.

Severity is relative to the local norm: an event's size percentile among all
events in the same country (2012-2025).
  critical >= 99th percentile, high >= 90th, moderate >= 50th, else low.

Outputs:
  WORK/events.parquet       one row per event
  WORK/event_days.parquet   one row per event per day (for growth charts / replay)
  OUT/events_summary.json   counts and size thresholds per country

Run: venv python pipeline/05_events.py
"""
import json
import numpy as np
import pandas as pd
import duckdb
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from config import PARQUET, WORK, OUT

CELL = 0.05
FLARE_CELL = 0.02
MAX_GAP_DAYS = 2
con = duckdb.connect()
src = f"read_parquet('{PARQUET.as_posix()}/viirs-snpp/*.parquet')"
flares = (WORK / "flare_cells.parquet").as_posix()

cd = con.execute(f"""
    WITH f AS (SELECT cy, cx FROM read_parquet('{flares}') WHERE is_static),
    d AS (
      SELECT v.*, CAST(floor(lat/{FLARE_CELL}) AS INTEGER) fcy, CAST(floor(lon/{FLARE_CELL}) AS INTEGER) fcx
      FROM {src} v WHERE ok AND type = 0
    )
    SELECT CAST(floor(lat/{CELL}) AS INTEGER) AS cy, CAST(floor(lon/{CELL}) AS INTEGER) AS cx,
           date, mode(country) AS country, count(*) AS n,
           sum(frp) AS frp_sum, max(frp) AS frp_max, sum(lat) AS slat, sum(lon) AS slon,
           sum(CASE WHEN daynight='N' THEN 1 ELSE 0 END) AS n_night
    FROM d ANTI JOIN f ON d.fcy = f.cy AND d.fcx = f.cx
    GROUP BY 1, 2, 3
""").df()
print("cell-days:", len(cd), flush=True)

day = (pd.to_datetime(cd["date"]) - pd.Timestamp("2012-01-01")).dt.days.to_numpy().astype(np.int64)
cy = cd["cy"].to_numpy().astype(np.int64) + 4000      # shift to positive
cx = cd["cx"].to_numpy().astype(np.int64) + 8000
K = 20000
key = (day * K + cy) * K + cx
order = np.argsort(key)
skey = key[order]
rows, cols = [], []
for dt in range(0, MAX_GAP_DAYS + 1):
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dt == 0 and (dy, dx) <= (0, 0):
                continue                      # half neighbourhood, no self links
            nk = ((day + dt) * K + cy + dy) * K + cx + dx
            pos = np.searchsorted(skey, nk)
            pos[pos == len(skey)] = 0
            hit = skey[pos] == nk
            rows.append(np.nonzero(hit)[0]); cols.append(order[pos[hit]])
r, c = np.concatenate(rows), np.concatenate(cols)
n_nodes = len(cd)
_, label = connected_components(coo_matrix((np.ones(len(r), np.int8), (r, c)), shape=(n_nodes, n_nodes)),
                                directed=False)
cd["event"] = label
print("events:", label.max() + 1, flush=True)

ed = cd.groupby(["event", "date"]).agg(n=("n", "sum"), cells=("n", "size"), frp_sum=("frp_sum", "sum"),
                                       frp_max=("frp_max", "max"), slat=("slat", "sum"), slon=("slon", "sum"),
                                       s=("cy", "min"), nn=("cy", "max"), w=("cx", "min"), e=("cx", "max")).reset_index()
ed["lat"] = ed.slat / ed.n
ed["lon"] = ed.slon / ed.n

ev = cd.groupby("event").agg(country=("country", lambda s: s.mode().iat[0]), start=("date", "min"),
                             end=("date", "max"), n_det=("n", "sum"), cell_days=("n", "size"),
                             frp_sum=("frp_sum", "sum"), frp_max=("frp_max", "max"),
                             slat=("slat", "sum"), slon=("slon", "sum"), n_night=("n_night", "sum"),
                             south=("cy", "min"), north=("cy", "max"), west=("cx", "min"), east=("cx", "max"))
ev["cells"] = cd.groupby("event").apply(lambda g: len(set(zip(g.cy, g.cx))), include_groups=False)
ev["lat"] = ev.slat / ev.n_det
ev["lon"] = ev.slon / ev.n_det
ev["days"] = (pd.to_datetime(ev.end) - pd.to_datetime(ev.start)).dt.days + 1
ev["south"] = ev.south * CELL; ev["north"] = (ev.north + 1) * CELL
ev["west"] = ev.west * CELL;   ev["east"] = (ev.east + 1) * CELL
# footprint estimate: touched 0.05 deg cells (each ~ 5.5 km x 5.5 km * cos(lat)); an upper bound on burned area
ev["footprint_km2"] = ev.cells * (CELL * 111.0) ** 2 * np.cos(np.radians(ev.lat))
ev["size_pct"] = ev.groupby("country")["n_det"].rank(pct=True) * 100
ev["severity"] = pd.cut(ev.size_pct, [-1, 50, 90, 99, 101], labels=["low", "moderate", "high", "critical"]).astype(str)
ev = ev.drop(columns=["slat", "slon"]).reset_index()
ev.to_parquet(WORK / "events.parquet", index=False)
ed.drop(columns=["slat", "slon"]).merge(ev[["event", "country", "severity"]], on="event") \
  .to_parquet(WORK / "event_days.parquet", index=False)

summary = {}
for ctry, g in ev.groupby("country"):
    summary[ctry] = {"events": int(len(g)),
                     "high_min_detections": int(g.n_det.quantile(0.90)),
                     "critical_min_detections": int(g.n_det.quantile(0.99)),
                     "largest_detections": int(g.n_det.max())}
(OUT / "events_summary.json").write_text(json.dumps(summary, indent=1))
print(ev.sort_values("n_det", ascending=False).head(12)[
    ["event", "country", "start", "end", "days", "n_det", "cells", "footprint_km2", "lat", "lon", "severity"]
].to_string(index=False))
showcase = []
for name, (la, lo, y, m, peak) in {"Dixie Fire, California": (40.0, -121.2, 2021, 7, "2021-08-06"),
                                   "Kabylie fires, Algeria": (36.7, 4.2, 2021, 8, "2021-08-10"),
                                   "Manavgat fire, Turkey": (36.9, 31.5, 2021, 7, "2021-07-30")}.items():
    g = ev[(abs(ev.lat - la) < 0.8) & (abs(ev.lon - lo) < 0.8) & (pd.to_datetime(ev.start).dt.year == y)
           & (pd.to_datetime(ev.end).dt.month >= m)].sort_values("n_det", ascending=False).head(1)
    print(name, g[["event", "country", "start", "end", "n_det", "footprint_km2", "severity"]].to_dict("records"))
    if len(g):
        showcase.append({"name": name, "event": int(g.event.iat[0]), "date": peak})
(OUT / "showcase.json").write_text(json.dumps(showcase, indent=1))   # event ids change if this script is re-run
