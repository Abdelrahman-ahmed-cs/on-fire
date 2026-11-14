"""Fire context: wind, an estimated spread envelope, settlements in reach, air quality.

Everything here is DECISION SUPPORT and is labelled as an estimate in the app.

Spread envelope (deliberately simple and published, so it can be explained):
  * forward rate of spread ~ 10% of the 10 m open wind speed (Cruz & Alexander
    2019, a rule of thumb for dry fuels; it tends to the high side, which is the
    safe side for a warning);
  * ellipse length-to-breadth ratio LB = 1 + 0.0012 * U^2.154, U in km/h
    (Alexander 1985), capped at 8;
  * the fire is at one focus of the ellipse; wind = the strongest hour of the day.
It ignores terrain, fuel type, fuel moisture and suppression.

Wind and weather: Open-Meteo archive (ERA5-based). Air quality: Open-Meteo air
quality (CAMS), only available from August 2022. Settlements: GeoNames
cities500 (every place with 500+ people: cities, towns and villages).

Vegetation: NASA MODIS land cover (MCD12Q1, IGBP classes, 500 m, yearly), read
as a small image from NASA GIBS and decoded with GIBS's published colour key.
The year BEFORE the fire is used, so it shows what grew there before it burned.
"What is burning" = the class under each VIIRS detection inside the fire's box
from its start to the chosen day; "in its path" = classes inside the 6-hour
envelope.

Only coordinates and a date are sent to those services. Results are cached on
disk, so each fire-date is fetched once.
"""
import io
import json
import math
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
import requests
from shapely import contains_xy
from shapely.geometry import Point, Polygon

from config import WORK, PARQUET

CACHE = WORK / "cache"
CACHE.mkdir(exist_ok=True)
EVENT_DAYS = (WORK / "event_days.parquet").as_posix()
EVENTS = (WORK / "events.parquet").as_posix()
RAW_VIIRS = f"{PARQUET.as_posix()}/viirs-snpp/*.parquet"
HOURS = [2, 4, 6, 12]
CACHE_VERSION = 2                       # bump when the content of an answer changes (old cache files are ignored)

# MODIS IGBP land cover from NASA GIBS. Colour key verified 2026-11-13 from
# https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_IGBP_Land_Cover_Type.xml ; layer years 2001-2024.
GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
LC_LAYER = "MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual"
LC_YEARS = (2001, 2024)
IGBP = {(33, 138, 33): 1, (49, 204, 49): 2, (152, 204, 49): 3, (150, 250, 150): 4, (141, 186, 141): 5,
        (186, 141, 141): 6, (245, 222, 179): 7, (218, 235, 157): 8, (255, 213, 0): 9, (240, 185, 103): 10,
        (71, 131, 181): 11, (250, 239, 115): 12, (255, 0, 0): 13, (153, 147, 86): 14, (255, 255, 255): 15,
        (191, 191, 189): 16, (134, 202, 227): 17}
# IGBP classes -> plain groups shown in the app, with our own colours (data is never orange)
GROUPS = [("Forest", (1, 2, 3, 4, 5), "#2f9e5b"), ("Shrubland", (6, 7), "#9cc46a"),
          ("Savanna and open woodland", (8, 9), "#cfe08a"), ("Grassland", (10,), "#ece6a8"),
          ("Cropland and farm mosaic", (12, 14), "#f3d64e"), ("Wetland", (11,), "#4fa3c7"),
          ("Towns and built-up land", (13,), "#c77dff"), ("Bare ground", (16,), "#b9b4ac"),
          ("Water", (17,), "#6fb1ff"), ("Snow and ice", (15,), "#ffffff")]
PLANTS = {"Forest", "Shrubland", "Savanna and open woodland", "Grassland", "Cropland and farm mosaic", "Wetland"}
PX = 0.0045                             # degrees, about one 500 m MODIS pixel
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
compass = lambda deg: COMPASS[int(((deg % 360) + 22.5) // 45) % 8]
_places = None


def places():
    global _places
    if _places is None:
        p = WORK / "places.parquet"
        _places = pd.read_parquet(p) if p.exists() else pd.DataFrame(columns=["name", "country", "lat", "lon", "pop"])
    return _places


def km_offsets(lat0, lon0, lat, lon):
    return (lon - lon0) * 111.320 * math.cos(math.radians(lat0)), (lat - lat0) * 110.574      # east, north


def ellipse(lat0, lon0, wind_kmh, toward_deg, hours):
    head = max(0.10 * wind_kmh * hours, 0.3)                     # km; floor so calm days still draw something
    lb = min(1 + 0.0012 * wind_kmh ** 2.154, 8.0)
    e = math.sqrt(1 - 1 / lb ** 2)
    a = head / (1 + e); b = a / lb; c = a * e
    th = math.radians(toward_deg)
    pts = []
    for i in range(49):
        phi = 2 * math.pi * i / 48
        along, across = c + a * math.cos(phi), b * math.sin(phi)
        east = along * math.sin(th) + across * math.cos(th)
        north = along * math.cos(th) - across * math.sin(th)
        pts.append([round(lon0 + east / (111.320 * math.cos(math.radians(lat0))), 5), round(lat0 + north / 110.574, 5)])
    return {"hours": hours, "head_km": round(head, 1), "width_km": round(2 * b, 1), "polygon": pts}


def aqi_word(v):
    for lim, w in ((50, "Good"), (100, "Moderate"), (150, "Unhealthy for sensitive groups"), (200, "Unhealthy"),
                   (300, "Very unhealthy")):
        if v <= lim:
            return w
    return "Hazardous"


def land_cover(s, w, n, e, year):
    """IGBP class grid (0 = no data) for a lat/lon box. Returns grid, top latitude, left longitude, dy, dx."""
    step = max(PX, (n - s) / 1200, (e - w) / 1200)
    width, height = max(int(round((e - w) / step)), 1), max(int(round((n - s) / step)), 1)
    r = requests.get(GIBS_WMS, timeout=60, params={
        "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.3.0", "LAYERS": LC_LAYER, "STYLES": "",
        "CRS": "EPSG:4326", "BBOX": f"{s},{w},{n},{e}", "WIDTH": width, "HEIGHT": height,
        "FORMAT": "image/png", "TIME": f"{year}-01-01"})
    r.raise_for_status()
    from PIL import Image                 # pillow; imported here so the rest of the server runs without it
    rgb = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.int32)
    code = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
    grid = np.zeros(code.shape, np.int8)
    for (a, b, c), v in IGBP.items():
        grid[code == ((a << 16) | (b << 8) | c)] = v
    return grid, n, w, (n - s) / height, (e - w) / width


def shares(classes):
    """IGBP class values -> groups with their share in %, largest first."""
    classes = classes[classes > 0]
    out = []
    for label, ids, color in GROUPS:
        k = int(np.isin(classes, ids).sum())
        if k:
            out.append({"label": label, "share": round(100 * k / len(classes), 1), "color": color, "plants": label in PLANTS})
    return sorted(out, key=lambda g: -g["share"])


def vegetation(con, ev, date, zone6):
    """What is burning (land cover under each detection) and what lies inside the 6-hour envelope."""
    hs = con.execute(f"""SELECT lat, lon FROM read_parquet('{RAW_VIIRS}')
        WHERE type = 0 AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
          AND date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE) LIMIT 50000""",
        [float(ev.south), float(ev.north), float(ev.west), float(ev.east), str(ev.start)[:10], date]).df()
    lats, lons = list(hs.lat), list(hs.lon)
    if zone6:
        lons += [p[0] for p in zone6]; lats += [p[1] for p in zone6]
    if not lats:
        return None
    s, n, w, e = min(lats) - .03, max(lats) + .03, min(lons) - .03, max(lons) + .03
    year = min(max(int(date[:4]) - 1, LC_YEARS[0]), LC_YEARS[1])
    grid, top, left, dy, dx = land_cover(s, w, n, e, year)
    out = {"year": year, "source": "NASA MODIS land cover (MCD12Q1, 500 m), via NASA GIBS",
           "detections": int(len(hs)), "burning": [], "in_path_6h": []}
    if len(hs):
        r = np.clip(((top - hs.lat.to_numpy()) / dy).astype(int), 0, grid.shape[0] - 1)
        c = np.clip(((hs.lon.to_numpy() - left) / dx).astype(int), 0, grid.shape[1] - 1)
        out["burning"] = shares(grid[r, c])
    if zone6:
        yy, xx = np.mgrid[0:grid.shape[0], 0:grid.shape[1]]
        inside = contains_xy(Polygon(zone6), left + (xx + 0.5) * dx, top - (yy + 0.5) * dy)
        out["in_path_6h"] = shares(grid[inside])
    return out


def fire_context(event_id: int, date: str | None):
    con = duckdb.connect()
    ev = con.execute(f"SELECT * FROM read_parquet('{EVENTS}') WHERE event = ?", [event_id]).df()
    if ev.empty:
        return None
    ev = ev.iloc[0]
    days = con.execute(f"SELECT date, n, lat, lon FROM read_parquet('{EVENT_DAYS}') WHERE event = ? ORDER BY date",
                       [event_id]).df()
    days["date"] = days["date"].astype(str).str[:10]
    start, end = days.date.iloc[0], days.date.iloc[-1]
    date = min(max(date or end, start), end)
    row = days[days.date <= date].iloc[-1]                       # where the fire was burning on (or just before) that day
    lat0, lon0 = float(row.lat), float(row.lon)
    key = CACHE / f"ctx{CACHE_VERSION}_{event_id}_{date}.json"
    if key.exists():
        return json.loads(key.read_text())

    out = {"event": int(event_id), "date": date, "origin": [round(lat0, 4), round(lon0, 4)], "country": ev.country,
           "wind": None, "zones": [], "places": [], "exposure": [], "air": None, "vegetation": None,
           "people_near": None, "notes": []}
    # ---- wind ---------------------------------------------------------------
    try:
        r = requests.get("https://archive-api.open-meteo.com/v1/archive", timeout=40, params={
            "latitude": round(lat0, 3), "longitude": round(lon0, 3), "start_date": date, "end_date": date,
            "hourly": "wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m",
            "wind_speed_unit": "kmh", "timezone": "UTC"}).json()["hourly"]
        ws = [v if v is not None else -1 for v in r["wind_speed_10m"]]
        i = max(range(len(ws)), key=lambda k: ws[k])
        if ws[i] >= 0:
            frm = float(r["wind_direction_10m"][i])
            out["wind"] = {"speed_kmh": round(ws[i], 1), "from_deg": round(frm), "from": compass(frm),
                           "toward": compass(frm + 180), "hour_utc": r["time"][i][11:16],
                           "temp_c": r["temperature_2m"][i], "humidity_pct": r["relative_humidity_2m"][i],
                           "day_mean_kmh": round(sum(v for v in ws if v >= 0) / max(sum(v >= 0 for v in ws), 1), 1)}
    except Exception as e:                                        # noqa: BLE001
        out["notes"].append(f"Wind could not be loaded ({type(e).__name__}).")

    # ---- spread envelope, settlements, exposure ----------------------------
    if out["wind"]:
        w = out["wind"]
        out["zones"] = [ellipse(lat0, lon0, w["speed_kmh"], (w["from_deg"] + 180) % 360, h) for h in HOURS]
        polys = [(z["hours"], Polygon(z["polygon"])) for z in out["zones"]]
        reach = max(out["zones"][-1]["head_km"] * 1.3, 40)
        p = places()
        box = p[(abs(p.lat - lat0) < reach / 100) & (abs(p.lon - lon0) < reach / 70)]
        rows = []
        for pl in box.itertuples():
            east, north = km_offsets(lat0, lon0, pl.lat, pl.lon)
            dist = math.hypot(east, north)
            if dist > reach:
                continue
            zone = next((h for h, poly in polys if poly.contains(Point(pl.lon, pl.lat))), None)
            rows.append({"name": pl.name, "kind": getattr(pl, "kind", "town"), "pop": int(pl.pop), "dist_km": round(dist, 1),
                         "direction": compass(math.degrees(math.atan2(east, north))), "zone_hours": zone,
                         "lat": round(pl.lat, 4), "lon": round(pl.lon, 4)})
        rows.sort(key=lambda r_: (r_["zone_hours"] is None, r_["zone_hours"] or 0, r_["dist_km"]))
        out["places"] = rows[:40]
        near = lambda km: [r_ for r_ in rows if r_["dist_km"] <= km]
        out["people_near"] = {f"{km}km": {"places": len(near(km)), "villages": sum(r_["kind"] == "village" for r_ in near(km)),
                                          "people": int(sum(r_["pop"] for r_ in near(km)))} for km in (10, 25)}
        out["exposure"] = [{"hours": h, "places": sum(1 for r_ in rows if r_["zone_hours"] and r_["zone_hours"] <= h),
                            "villages": sum(1 for r_ in rows if r_["zone_hours"] and r_["zone_hours"] <= h and r_["kind"] == "village"),
                            "people": int(sum(r_["pop"] for r_ in rows if r_["zone_hours"] and r_["zone_hours"] <= h))}
                           for h in HOURS]
        out["within_km"] = round(reach)
        out["places_in_reach"] = len(rows)

    # ---- vegetation: what is burning, and what lies in the 6-hour path -------
    try:
        z6 = next((z["polygon"] for z in out["zones"] if z["hours"] == 6), None)
        out["vegetation"] = vegetation(con, ev, date, z6)
    except Exception as e:                                        # noqa: BLE001
        out["notes"].append(f"Land cover could not be loaded ({type(e).__name__}).")

    # ---- air quality (CAMS reanalysis starts August 2022) ---------------------
    if date >= "2022-08-01":
        try:
            a = requests.get("https://air-quality-api.open-meteo.com/v1/air-quality", timeout=40, params={
                "latitude": round(lat0, 3), "longitude": round(lon0, 3), "start_date": date, "end_date": date,
                "hourly": "pm2_5,us_aqi", "timezone": "UTC"}).json()["hourly"]
            pm = [v for v in a["pm2_5"] if v is not None]; aq = [v for v in a["us_aqi"] if v is not None]
            if pm and aq:
                out["air"] = {"pm25_max": round(max(pm), 1), "pm25_mean": round(sum(pm) / len(pm), 1),
                              "us_aqi_max": int(max(aq)), "category": aqi_word(max(aq)),
                              "safe_outdoors": max(aq) <= 100}
        except Exception as e:                                    # noqa: BLE001
            out["notes"].append(f"Air quality could not be loaded ({type(e).__name__}).")
    else:
        out["notes"].append("Air-quality data for this location starts in August 2022, so none is shown for this date.")

    if out["wind"] and out["vegetation"] is not None:             # cache only complete answers
        key.write_text(json.dumps(out))
    return out
