"""Phase 2 — gas flares and other static heat sources.

Why: the archive has NASA's `type` flag (2 = static land source, 3 = offshore), but
near-real-time data does not. This detector finds static sources from behaviour
alone, so it can be applied to live data, and is validated against NASA's flag.

Detector (VIIRS only, quality-filtered, ignores the `type` column):
  A ~2 km cell is a static source if it was active in at least P of the months
  and in at least Y different years, and at least N of its detections were at night.
  Real vegetation fires do not return to the same 2 km spot month after month.
  P, Y, N are tuned on half the cells (random split) and scored on the other half.

Truth label: a cell is static if most of its detections carry NASA type 2 or 3.
Note for honesty: NASA's flag is itself built from persistence, so agreement is
expected; the value here is having it for live data and showing the flare story.

Outputs:
  WORK/flare_cells.parquet     every candidate cell with features and both labels
  OUT/flare_metrics.json       precision / recall on test cells, chosen thresholds
  OUT/flares.json              flare cells for the map
  OUT/flare_share.json         per country: share of detections that are static sources

Run: venv python pipeline/03_flares.py
"""
import json
import numpy as np
import duckdb
from config import PARQUET, WORK, OUT

CELL = 0.02
con = duckdb.connect()
src = f"read_parquet('{PARQUET.as_posix()}/viirs-snpp/*.parquet')"

cells = con.execute(f"""
    WITH d AS (
      SELECT country, CAST(floor(lat/{CELL}) AS INTEGER) cy, CAST(floor(lon/{CELL}) AS INTEGER) cx,
             year, month, daynight, type, frp
      FROM {src} WHERE ok
    )
    SELECT cy, cx, mode(country) AS country, count(*) AS n,
           count(DISTINCT year*100+month) AS months_active,
           count(DISTINCT year) AS years_active,
           avg(CASE WHEN daynight='N' THEN 1.0 ELSE 0.0 END) AS night_frac,
           avg(CASE WHEN type IN (2,3) THEN 1.0 ELSE 0.0 END) AS nasa_static_frac,
           avg(frp) AS mean_frp
    FROM d GROUP BY cy, cx
""").df()
n_months = con.execute(f"SELECT count(DISTINCT year*100+month) FROM {src}").fetchone()[0]
cells["persistence"] = cells["months_active"] / n_months
cells["truth"] = cells["nasa_static_frac"] > 0.5
cells["lat"] = (cells.cy + 0.5) * CELL
cells["lon"] = (cells.cx + 0.5) * CELL
rng = np.random.default_rng(42)
cells["tune"] = rng.random(len(cells)) < 0.5
print("cells:", len(cells), "| months in record:", n_months, "| NASA-static cells:", int(cells.truth.sum()))

def prf(d, pred):
    """Precision/recall weighted by detections (what matters for fire counts)."""
    w = d["n"].to_numpy(); t = d["truth"].to_numpy(); p = pred.to_numpy()
    tp, fp, fn = (w * (p & t)).sum(), (w * (p & ~t)).sum(), (w * (~p & t)).sum()
    pr, rc = tp / max(tp + fp, 1), tp / max(tp + fn, 1)
    return float(pr), float(rc), float(2 * pr * rc / max(pr + rc, 1e-9))

def rule(d, p, y, nf):
    return (d.persistence >= p) & (d.years_active >= y) & (d.night_frac >= nf)

tune, test = cells[cells.tune], cells[~cells.tune]
best = None
for p in (0.05, 0.08, 0.1, 0.15, 0.2, 0.3):
    for y in (3, 5, 8):
        for nf in (0.0, 0.2, 0.35, 0.5):
            f1 = prf(tune, rule(tune, p, y, nf))[2]
            if best is None or f1 > best[0]:
                best = (f1, p, y, nf)
_, P, Y, NF = best
cells["is_static"] = rule(cells, P, Y, NF)
pr, rc, f1 = prf(test, rule(test, P, Y, NF))
# cell-level (unweighted) scores too
tt, pp = test.truth.to_numpy(), rule(test, P, Y, NF).to_numpy()
cell_pr = float((tt & pp).sum() / max(pp.sum(), 1)); cell_rc = float((tt & pp).sum() / max(tt.sum(), 1))

by_country = {}
for c, d in test.groupby("country"):
    if d.truth.sum() >= 20:
        a, b, _ = prf(d, rule(d, P, Y, NF))
        by_country[c] = {"precision": round(a, 3), "recall": round(b, 3), "static_cells": int(d.truth.sum())}

metrics = {
    "rule": f"active in >= {P:.0%} of months, in >= {Y} different years, night share >= {NF:.0%}",
    "thresholds": {"persistence": P, "min_years": Y, "min_night_frac": NF, "cell_deg": CELL},
    "tuned_on": "random half of cells", "scored_on": "the other half",
    "detection_weighted": {"precision": round(pr, 3), "recall": round(rc, 3), "f1": round(f1, 3)},
    "cell_level": {"precision": round(cell_pr, 3), "recall": round(cell_rc, 3)},
    "test_cells": int(len(test)), "test_static_cells": int(test.truth.sum()),
    "by_country_test": by_country,
    "caveat": "NASA's static-source flag is itself persistence-based, so agreement is expected. "
              "The detector's value is that it needs no flag and so works on live data.",
}
(OUT / "flare_metrics.json").write_text(json.dumps(metrics, indent=2))
cells.to_parquet(WORK / "flare_cells.parquet", index=False)

fl = cells[cells.is_static | cells.truth][["lat", "lon", "country", "n", "months_active", "night_frac",
                                           "mean_frp", "is_static", "truth"]].copy()
fl = fl.round({"lat": 3, "lon": 3, "night_frac": 2, "mean_frp": 1}).rename(columns={"truth": "nasa_static"})
(OUT / "flares.json").write_text(fl.to_json(orient="records"))

# per-country share of detections that are static sources (the regional story)
share = con.execute(f"""
    SELECT country, count(*) AS detections,
           sum(CASE WHEN type IN (2,3) THEN 1 ELSE 0 END) AS nasa_static
    FROM {src} WHERE ok GROUP BY 1
""").df().merge(cells[cells.is_static].groupby("country")["n"].sum().rename("detected_static").reset_index(),
                on="country", how="left").fillna(0)
share["nasa_static_pct"] = (100 * share.nasa_static / share.detections).round(1)
share["detected_static_pct"] = (100 * share.detected_static / share.detections).round(1)
share = share.sort_values("nasa_static_pct", ascending=False)
(OUT / "flare_share.json").write_text(share.to_json(orient="records"))

print(json.dumps({k: metrics[k] for k in ("rule", "detection_weighted", "cell_level")}, indent=1))
print(share.head(12).to_string(index=False))
print("flare cells exported:", len(fl))
