"""On Fire query service: serves the web app and answers area / date queries.

Run from the project root:
  C:\\Users\\User\\onfire-data\\venv\\Scripts\\python.exe -m uvicorn server.main:app --port 8000
Then open http://localhost:8000

Everything heavy is precomputed by pipeline/. This service only filters and sums.
Responses are cached in memory (same query -> no recomputation).
"""
import io
import json
import sys
from functools import lru_cache
from pathlib import Path

import duckdb
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from shapely.geometry import shape, Point
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
sys.path.insert(0, str(ROOT / "server"))
from config import PARQUET, WORK, OUT, REGIONS  # noqa: E402

app = FastAPI(title="On Fire")
CELLS = (WORK / "cell_month.parquet").as_posix()
EVENTS = (WORK / "events.parquet").as_posix()
EVENT_DAYS = (WORK / "event_days.parquet").as_posix()
FLARES = (WORK / "flare_cells.parquet").as_posix()
RAW = f"{PARQUET.as_posix()}/*/*.parquet"
MAX_CSV_ROWS = 500_000


def q(sql, params=None):
    return duckdb.connect().execute(sql, params or []).df()


def parse_bbox(bbox):
    try:
        w, s, e, n = [float(x) for x in bbox.split(",")]
    except Exception:
        raise HTTPException(400, "bbox must be west,south,east,north")
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise HTTPException(400, "bbox out of range")
    return w, s, e, n


def out_json(name):
    p = OUT / name
    if not p.exists():
        raise HTTPException(404, f"{name} has not been produced by the pipeline yet")
    # no-cache = the browser keeps a copy but checks it is still current, so re-running the pipeline shows at once
    return FileResponse(p, media_type="application/json", headers={"Cache-Control": "no-cache"})


# ---- precomputed files ------------------------------------------------------
@app.get("/api/meta")
def meta():
    m = json.loads((OUT / "harmonization_metrics.json").read_text())
    rng = q(f"SELECT min(year) y0, max(year*100+month) ym1 FROM read_parquet('{CELLS}')").iloc[0]
    return {"regions": REGIONS, "countries": m["countries"], "headline": m["headline"],
            "first_year": int(rng.y0), "last_year": int(rng.ym1) // 100, "last_month": int(rng.ym1) % 100,
            "has_events": Path(EVENTS).exists(), "has_risk": (OUT / "risk_metrics.json").exists()}


@app.get("/api/data/{name}")
def data(name: str):
    allowed = {"country_month.json", "harmonization_metrics.json", "flare_metrics.json", "flares.json",
               "flare_share.json", "events_summary.json", "risk_metrics.json", "backtests.json",
               "countries.geojson", "showcase.json", "risk_latest.json", "risk_country_month.json"}
    if name not in allowed:
        raise HTTPException(404, "unknown data file")
    return out_json(name)


# ---- calendar for a country, a box or a drawn polygon ------------------------
def calendar_rows(where, params, poly=None):
    df = q(f"""SELECT lat, lon, year, month, m_det, v_det, harmonized, h_lo, h_hi
               FROM read_parquet('{CELLS}') WHERE {where}""", params)
    if poly is not None and len(df):
        pp = prep(poly)
        cells = df[["lat", "lon"]].drop_duplicates()
        cells["inside"] = [pp.contains(Point(lo, la)) for la, lo in zip(cells.lat, cells.lon)]
        df = df.merge(cells[cells.inside], on=["lat", "lon"])
    g = df.groupby(["year", "month"]).agg(modis_raw=("m_det", "sum"), viirs_raw=("v_det", "sum"),
                                          harmonized=("harmonized", "sum"), lo=("h_lo", "sum"),
                                          hi=("h_hi", "sum")).round(1).reset_index()
    return {"cells": int(df[["lat", "lon"]].drop_duplicates().shape[0]), "rows": g.to_dict("records")}


@lru_cache(maxsize=256)
def _calendar_cached(country, bbox):
    if country:
        return calendar_rows("country = ?", [country])
    w, s, e, n = parse_bbox(bbox)
    return calendar_rows("lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?", [w, e, s, n])


@app.get("/api/calendar")
def calendar(country: str | None = None, bbox: str | None = None):
    if not country and not bbox:
        raise HTTPException(400, "give country or bbox")
    return _calendar_cached(country, bbox)


@app.post("/api/calendar")
def calendar_polygon(geometry: dict = Body(...)):
    try:
        poly = shape(geometry)
    except Exception:
        raise HTTPException(400, "body must be a GeoJSON geometry")
    w, s, e, n = poly.bounds
    return calendar_rows("lon BETWEEN ? AND ? AND lat BETWEEN ? AND ?", [w, e, s, n], poly)


@app.post("/api/past_fires")
def past_fires(body: dict = Body(...)):
    """Fire events of 2012-2025 (VIIRS S-NPP, grouped by 05_events.py) whose centre lies within
    radius_km of a point, with the footprint (km2 of touched 0.05 deg cells) of each, so a fire
    burning now can be ranked against the fires that burned here before."""
    try:
        lat, lon = float(body["lat"]), float(body["lon"])
        radius = max(5.0, min(100.0, float(body.get("radius_km", 50))))
    except Exception:
        raise HTTPException(400, "body must be {lat, lon, radius_km}")
    if not Path(EVENTS).exists():
        raise HTTPException(404, "events not built yet")
    dlat = radius / 111.0
    dlon = radius / (111.0 * max(0.2, abs(__import__('math').cos(__import__('math').radians(lat)))))
    df = q(f"""
        SELECT event, start, "end", days, n_det, footprint_km2, lat, lon,
               2 * 6371 * asin(sqrt(pow(sin(radians(lat - ?) / 2), 2) +
                   cos(radians(?)) * cos(radians(lat)) * pow(sin(radians(lon - ?) / 2), 2))) AS dist_km
        FROM read_parquet('{EVENTS}')
        WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?""",
           [lat, lat, lon, lat - dlat, lat + dlat, lon - dlon, lon + dlon])
    df = df[df.dist_km <= radius]
    for c in ("start", "end"):
        df[c] = df[c].astype(str).str[:10]
    top = df.sort_values("footprint_km2", ascending=False).head(5)
    return {
        "radius_km": radius, "n": int(len(df)),
        "footprints": sorted(round(float(x), 2) for x in df.footprint_km2),
        "years": sorted({int(s[:4]) for s in df.start}) if len(df) else [],
        "largest": top.round({"footprint_km2": 1, "dist_km": 1, "lat": 3, "lon": 3}).to_dict("records"),
    }


@app.post("/api/area_same_dates")
def area_same_dates(body: dict = Body(...)):
    """VIIRS S-NPP fire cell-days (0.1 deg cell x day, vegetation, confidence not low) inside a box
    for the same calendar dates (day 1 .. day_to of one month) in every VIIRS year 2012-2025.
    Same unit as the harmonized calendar from 2012 on, so 'this month so far' can be compared
    with the median of past years on equal dates. Cells are selected by their 0.25 deg centre,
    as in /api/calendar."""
    try:
        w, s, e, n = [float(x) for x in body["bbox"]]
        month, day_to = int(body["month"]), int(body["day_to"])
    except Exception:
        raise HTTPException(400, "body must be {bbox:[w,s,e,n], month, day_to}")
    if not (1 <= month <= 12 and 1 <= day_to <= 31 and w < e and s < n):
        raise HTTPException(400, "bad month, day or box")
    df = q(f"""
        SELECT year, count(DISTINCT (floor(lat / 0.1), floor(lon / 0.1), date)) v_cd
        FROM read_parquet('{RAW}')
        WHERE sensor = 'VIIRS' AND ok AND type = 0 AND month = ? AND day(date) <= ?
          AND year BETWEEN 2012 AND 2025
          AND (floor(lat / 0.25) + 0.5) * 0.25 BETWEEN ? AND ?
          AND (floor(lon / 0.25) + 0.5) * 0.25 BETWEEN ? AND ?
        GROUP BY year""", [month, day_to, s, n, w, e])
    got = dict(zip(df.year.astype(int), df.v_cd.astype(int)))
    return {"month": month, "day_to": day_to, "years": [{"year": y, "v_cd": got.get(y, 0)} for y in range(2012, 2026)]}


# ---- gridded values for one month (history slider / anomaly map) -------------
@lru_cache(maxsize=512)
def _cells_cached(year, month):
    df = q(f"""
        WITH base AS (SELECT lat, lon, year, harmonized FROM read_parquet('{CELLS}') WHERE month = ?),
        med AS (SELECT lat, lon, median(harmonized) med, count(*) n FROM base WHERE year <> ? GROUP BY 1, 2)
        SELECT b.lat, b.lon, round(b.harmonized, 1) v, round(coalesce(m.med, 0), 1) med
        FROM base b LEFT JOIN med m USING (lat, lon) WHERE b.year = ? AND b.harmonized >= 0.5
    """, [month, year, year])
    return {"lat": df.lat.tolist(), "lon": df.lon.tolist(), "v": df.v.tolist(), "med": df.med.tolist()}


@app.get("/api/cells")
def cells(year: int, month: int = Query(ge=1, le=12)):
    return JSONResponse(_cells_cached(year, month), headers={"Cache-Control": "public, max-age=86400"})


# ---- typical month: mean harmonized activity per cell over every full year -----
@lru_cache(maxsize=12)
def _climatology_cached(month):
    df = q(f"""
        WITH yrs AS (SELECT count(DISTINCT year) n FROM read_parquet('{CELLS}') WHERE month = ? AND year >= 2001)
        SELECT lat, lon, round(sum(harmonized) / any_value(yrs.n), 2) v,
               round(100.0 * count(*) FILTER (WHERE harmonized >= 1) / any_value(yrs.n), 0) burn_pct
        FROM read_parquet('{CELLS}'), yrs WHERE month = ? AND year >= 2001
        GROUP BY lat, lon HAVING sum(harmonized) / any_value(yrs.n) >= 0.3
    """, [month, month])
    return {"month": month, "lat": df.lat.tolist(), "lon": df.lon.tolist(), "v": df.v.tolist(),
            "burn_pct": df.burn_pct.astype(int).tolist()}


@app.get("/api/climatology")
def climatology(month: int = Query(ge=1, le=12)):
    """Typical fire locations for a calendar month: mean harmonized cell-days per year (2001 on),
    and the share of years in which the cell burned at least one cell-day that month."""
    return JSONResponse(_climatology_cached(month), headers={"Cache-Control": "public, max-age=86400"})


# ---- fire events -------------------------------------------------------------
@lru_cache(maxsize=512)
def _events_cached(date, window):
    df = q(f"""
        SELECT d.event, any_value(e.country) country, any_value(e.severity) severity,
               sum(d.n) n_window, sum(d.frp_sum) frp_window, max(d.frp_max) frp_max,
               sum(d.lat * d.n) / sum(d.n) lat, sum(d.lon * d.n) / sum(d.n) lon,
               any_value(e.start) start, any_value(e."end") "end", any_value(e.n_det) n_total,
               any_value(e.footprint_km2) footprint_km2, any_value(e.size_pct) size_pct
        FROM read_parquet('{EVENT_DAYS}') d JOIN read_parquet('{EVENTS}') e USING (event)
        WHERE d.date BETWEEN CAST(? AS DATE) - INTERVAL {int(window) - 1} DAY AND CAST(? AS DATE)
        GROUP BY d.event
    """, [date, date])
    for c in ("start", "end"):
        df[c] = df[c].astype(str).str[:10]
    df = df.round({"lat": 4, "lon": 4, "frp_window": 1, "frp_max": 1, "footprint_km2": 0, "size_pct": 1})
    by_country = df.groupby("country").agg(fires=("event", "count"),
                                           critical=("severity", lambda s: int((s == "critical").sum())),
                                           high=("severity", lambda s: int((s == "high").sum()))).reset_index()
    return {"date": date, "window_days": window, "total": int(len(df)),
            "critical": int((df.severity == "critical").sum()), "high": int((df.severity == "high").sum()),
            "by_country": by_country.sort_values("fires", ascending=False).to_dict("records"),
            "events": df.to_dict("records")}


@app.get("/api/events")
def events(date: str, window: int = Query(3, ge=1, le=14)):
    if not Path(EVENTS).exists():
        raise HTTPException(404, "events not built yet")
    return _events_cached(date, window)


@app.get("/api/event/{event_id}")
def event(event_id: int):
    e = q(f"SELECT * FROM read_parquet('{EVENTS}') WHERE event = ?", [event_id])
    if e.empty:
        raise HTTPException(404, "no such event")
    d = q(f"""SELECT date, n, cells, frp_sum, frp_max, lat, lon FROM read_parquet('{EVENT_DAYS}')
              WHERE event = ? ORDER BY date""", [event_id])
    row = json.loads(e.iloc[0].to_json(date_format="iso"))
    row["start"], row["end"] = row["start"][:10], row["end"][:10]
    d["date"] = d["date"].astype(str).str[:10]
    return {"event": row, "days": d.round(3).to_dict("records")}


@app.get("/api/fire_context/{event_id}")
def fire_ctx(event_id: int, date: str | None = None):
    from context import fire_context            # server/context.py (wind, spread estimate, settlements, air)
    out = fire_context(event_id, date)
    if out is None:
        raise HTTPException(404, "no such event")
    return out


# ---- raw hotspots for an area and date range (map points + CSV export) --------
def hotspots_df(bbox, start, end, sensor, include_static, limit, country=None):
    w, s, e, n = parse_bbox(bbox)
    cond = ["lon BETWEEN ? AND ?", "lat BETWEEN ? AND ?", "date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)",
            "year BETWEEN ? AND ?"]
    params = [w, e, s, n, start, end, int(start[:4]), int(end[:4])]
    if country:
        cond.append("country = ?"); params.append(country)
    if sensor in ("MODIS", "VIIRS"):
        cond.append("sensor = ?"); params.append(sensor)
    if not include_static:
        cond.append("type = 0")
    return q(f"""SELECT round(lat, 5) latitude, round(lon, 5) longitude, date AS acq_date,
                        lpad(CAST(hhmm AS VARCHAR), 4, '0') acq_time_utc, sensor, sat AS satellite,
                        conf AS confidence, frp, daynight, type, country
                 FROM read_parquet('{RAW}') WHERE {' AND '.join(cond)} ORDER BY date, hhmm LIMIT {int(limit)}""",
             params)


@app.get("/api/hotspots")
def hotspots(bbox: str, start: str, end: str, sensor: str = "all", include_static: bool = False,
             format: str = "json", country: str | None = None):
    if format == "csv":
        df = hotspots_df(bbox, start, end, sensor, include_static, MAX_CSV_ROWS, country)
        buf = io.StringIO(); df.to_csv(buf, index=False); buf.seek(0)
        name = f"onfire_hotspots_{start}_{end}.csv"
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{name}"'})
    df = hotspots_df(bbox, start, end, sensor, include_static, 20000)
    df["acq_date"] = df["acq_date"].astype(str).str[:10]
    return {"count": int(len(df)), "truncated": len(df) >= 20000, "rows": df.to_dict("records")}


# ---- the web app -------------------------------------------------------------
class AppFiles(StaticFiles):
    """App files are small; always revalidate so an updated file is picked up at once."""
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-cache"
        return r


app.mount("/", AppFiles(directory=str(ROOT / "app"), html=True), name="app")
