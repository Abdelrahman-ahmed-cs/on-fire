"""Steps 1.2-1.4 — harmonize MODIS and VIIRS into one series, with held-out proof.

Method (kept simple on purpose so it can be explained to judges):
  1. Vegetation fires only (type == 0), quality-filtered rows only (ok).
  2. Spatial normalisation: instead of counting detections (VIIRS pixels are ~7x
     smaller, so one fire gives many more of them), count ACTIVE CELL-DAYS: the
     number of distinct (fine grid cell, day) pairs with at least one detection.
  3. Calibration of MODIS cell-days (M) to VIIRS cell-days (V) on overlap years.
     Candidate models, all per country x season:
       ratio      V = k * M                      (optionally k refined per cell)
       power+bg   V = a * M^b where M > 0        (big fires are seen well by both
                  V = background(cell, season)    sensors, small ones only by VIIRS,
                      where M = 0                 so the relation is not linear; the
                                                  background is the small-fire rate
                                                  MODIS misses entirely)
     Terra-only versions are fitted separately for months before Aqua existed.
  4. Proof: models are fitted WITHOUT the held-out years and scored only on them.
     The model is CHOSEN on inner-validation years taken from the fit years, so
     held-out years play no part in any choice. All variants are reported.
  5. Independent check: MODIS alone is one consistent sensor across 2012, so the
     change from 2009-2011 to 2012-2014 in the harmonized series should match the
     change seen by MODIS alone. A naive sensor switch fails this badly.
  6. Final product: VIIRS where it exists (2012+), calibrated MODIS before that,
     with an uncertainty band from held-out residuals. Final models are refitted
     on all overlap years (the validation numbers come from the held-out fit).

Tables are zero-filled (every active cell x every month), so months where one
sensor saw nothing are scored too. Only countries with BOTH sensors ingested are
processed.

Outputs:
  WORK/cell_month.parquet               country x 0.25 cell x year x month (non-zero rows)
  OUT/harmonization_metrics.json        headline number + ablation table + checks
  OUT/country_month.json                series for the app

Run: venv python pipeline/02_harmonize.py
"""
import json
import numpy as np
import pandas as pd
import duckdb
from sklearn.linear_model import PoissonRegressor
from config import PARQUET, WORK, OUT, GRID

HELD_OUT = [2014, 2017, 2020, 2023]          # never used for fitting or choosing
INNER_VAL = [2013, 2016, 2019, 2022]         # fit years used only to choose the variant
OVERLAP = list(range(2012, 2026))
FINE_OPTIONS = [0.05, 0.1]                   # candidate fine grids for cell-days
SHRINK_M = 20.0                              # prior strength (MODIS cell-days) for ratio model
BG_PRIOR_MONTHS = 6.0                        # prior strength (months) for background rate
SEASON_OF = {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
             6: "JJA", 7: "JJA", 8: "JJA", 9: "SON", 10: "SON", 11: "SON"}
KEY_G = ["country", "season"]
KEY_C = ["country", "gy", "gx", "season"]

con = duckdb.connect()
src = f"read_parquet('{PARQUET.as_posix()}/*/*.parquet')"

# ---- which countries are complete for both sensors -------------------------
cov = con.execute(f"SELECT country, sensor, count(DISTINCT year) ny FROM {src} GROUP BY 1,2") \
         .df().pivot(index="country", columns="sensor", values="ny").fillna(0)
for s in ("MODIS", "VIIRS"):
    if s not in cov:
        cov[s] = 0
# A year with zero detections has no file on the server, so allow some missing years.
ready = sorted(cov[(cov["MODIS"] >= 20) & (cov["VIIRS"] >= 12)].index)
print("countries ready for harmonization:", ready)
if not ready:
    raise SystemExit("no country has both sensors yet")
ready_sql = ",".join("'" + c.replace("'", "''") + "'" for c in ready)
last_ym = con.execute(f"SELECT max(year*100+month) FROM {src} WHERE sensor='VIIRS'").fetchone()[0]

# ---- cell-month table, zero-filled ----------------------------------------
def cell_month(fine):
    d = con.execute(f"""
        WITH d AS (
          SELECT country, year, month, sensor, sat, date,
                 CAST(floor(lat/{GRID}) AS INTEGER) AS gy, CAST(floor(lon/{GRID}) AS INTEGER) AS gx,
                 CAST(floor(lat/{fine}) AS INTEGER) AS fy, CAST(floor(lon/{fine}) AS INTEGER) AS fx, frp
          FROM {src} WHERE ok AND type = 0 AND country IN ({ready_sql})
        )
        SELECT country, gy, gx, year, month,
          count(*) FILTER (sensor='MODIS') AS m_det,
          count(*) FILTER (sensor='VIIRS') AS v_det,
          count(DISTINCT (fy,fx,date)) FILTER (sensor='MODIS') AS m_cd,
          count(DISTINCT (fy,fx,date)) FILTER (sat='Terra') AS t_cd,
          count(DISTINCT (fy,fx,date)) FILTER (sensor='VIIRS') AS v_cd,
          coalesce(sum(frp) FILTER (sensor='MODIS'),0) AS m_frp,
          coalesce(sum(frp) FILTER (sensor='VIIRS'),0) AS v_frp
        FROM d GROUP BY ALL
    """).df()
    cells = d[["country", "gy", "gx"]].drop_duplicates()
    months = pd.DataFrame([(y, m) for y in range(2000, 2026) for m in range(1, 13)
                           if 200011 <= y * 100 + m <= last_ym], columns=["year", "month"])
    full = cells.merge(months, how="cross").merge(d, on=["country", "gy", "gx", "year", "month"], how="left")
    num = ["m_det", "v_det", "m_cd", "t_cd", "v_cd", "m_frp", "v_frp"]
    full[num] = full[num].fillna(0)
    full["season"] = full["month"].map(SEASON_OF)
    return full

# ---- models ----------------------------------------------------------------
def fit_ratio(train, mcol, shrink):
    g_all = train["v_cd"].sum() / max(train[mcol].sum(), 1)
    grp = train.groupby(KEY_G)[[mcol, "v_cd"]].sum()
    grp["k_g"] = (grp["v_cd"] + SHRINK_M * g_all) / (grp[mcol] + SHRINK_M)
    cell = train.groupby(KEY_C)[[mcol, "v_cd"]].sum().reset_index().merge(grp["k_g"].reset_index(), on=KEY_G)
    cell["k"] = (cell["v_cd"] + SHRINK_M * cell["k_g"]) / (cell[mcol] + SHRINK_M) if shrink else cell["k_g"]
    return ("ratio", g_all, grp["k_g"].reset_index(), cell[KEY_C + ["k"]])

def fit_power(train, mcol):
    pos = train[train[mcol] > 0]
    def glm(d):
        if len(d) < 50 or d["v_cd"].sum() == 0:
            return None
        r = PoissonRegressor(alpha=0, max_iter=1000).fit(np.log(d[[mcol]].to_numpy()), d["v_cd"].to_numpy())
        return float(r.intercept_), float(r.coef_[0])
    g_all = glm(pos) or (0.0, 1.0)
    by_country = {c: glm(d) or g_all for c, d in pos.groupby("country")}
    rows = []
    for c in train["country"].unique():
        for s in ("DJF", "MAM", "JJA", "SON"):
            p = glm(pos[(pos.country == c) & (pos.season == s)]) or by_country.get(c, g_all)
            rows.append((c, s, p[0], p[1]))
    params = pd.DataFrame(rows, columns=KEY_G + ["a", "b"])
    # background: mean VIIRS cell-days in months where MODIS saw nothing
    z = train[train[mcol] == 0]
    bg_g = z.groupby(KEY_G)["v_cd"].mean().rename("bg_g").reset_index()
    bg_c = z.groupby(KEY_C)["v_cd"].agg(["sum", "count"]).reset_index().merge(bg_g, on=KEY_G)
    bg_c["bg"] = (bg_c["sum"] + BG_PRIOR_MONTHS * bg_c["bg_g"]) / (bg_c["count"] + BG_PRIOR_MONTHS)
    return ("power", params, bg_g, bg_c[KEY_C + ["bg"]])

def predict(model, df, mcol):
    m = df[mcol].to_numpy()
    if model[0] == "ratio":
        _, g_all, grp, cell = model
        x = df[KEY_C].merge(cell, on=KEY_C, how="left").merge(grp, on=KEY_G, how="left")
        return m * x["k"].fillna(x["k_g"]).fillna(g_all).to_numpy()
    _, params, bg_g, bg_c = model
    x = df[KEY_C].merge(params, on=KEY_G, how="left").merge(bg_c, on=KEY_C, how="left") \
                 .merge(bg_g, on=KEY_G, how="left")
    bg = x["bg"].fillna(x["bg_g"]).fillna(0).to_numpy()
    with np.errstate(divide="ignore"):
        fire = np.exp(x["a"].fillna(0).to_numpy() + x["b"].fillna(1).to_numpy() * np.log(np.maximum(m, 1e-9)))
    return np.where(m > 0, fire, bg)

VARIANTS = {
    "country-season factor": lambda tr, mcol: fit_ratio(tr, mcol, False),
    "country-season factor + per-cell refinement": lambda tr, mcol: fit_ratio(tr, mcol, True),
    "power law + small-fire background": fit_power,
}

def score(df, pred, truth):
    """Agreement between a MODIS-derived series and VIIRS on country-month totals."""
    cm = df.assign(p=pred, t=df[truth]).groupby(["country", "year", "month"])[["p", "t"]].sum()
    cm = cm[(cm.p + cm.t) > 0]
    both = cm[(cm.p > 0) & (cm.t > 0)]
    return {
        "disagreement_pct": round(float((2 * (cm.p - cm.t).abs() / (cm.p + cm.t)).mean() * 100), 1),
        "bias_pct": round(float((cm.p.sum() / cm.t.sum() - 1) * 100), 1),
        "median_ratio": round(float((both.p / both.t).median()), 3),
        "log_corr": round(float(np.corrcoef(np.log1p(cm.p), np.log1p(cm.t))[0, 1]), 3),
        "country_months": int(len(cm)),
    }

def split(df):
    o = df[df.year.isin(OVERLAP)]
    return o, o[~o.year.isin(HELD_OUT)], o[o.year.isin(HELD_OUT)]

# ---- ablation --------------------------------------------------------------
tables = {f: cell_month(f) for f in FINE_OPTIONS}
print("rows per table:", {f: len(t) for f, t in tables.items()})
ablation = []
_, tr0, te0 = split(tables[FINE_OPTIONS[0]])
raw_score = score(te0, te0["m_det"].to_numpy(), "v_det")
ablation.append({"variant": "raw detection counts (no harmonization)", **raw_score})
ablation.append({"variant": "raw detections x one global factor",
                 **score(te0, te0["m_det"].to_numpy() * tr0.v_det.sum() / tr0.m_det.sum(), "v_det")})
best = None
for fine, df in tables.items():
    _, tr, te = split(df)
    ablation.append({"variant": f"cell-days {fine} deg, uncalibrated", **score(te, te["m_cd"].to_numpy(), "v_cd")})
    tr_in, va_in = tr[~tr.year.isin(INNER_VAL)], tr[tr.year.isin(INNER_VAL)]
    for vname, fit in VARIANTS.items():
        s = score(te, predict(fit(tr, "m_cd"), te, "m_cd"), "v_cd")
        sel = score(va_in, predict(fit(tr_in, "m_cd"), va_in, "m_cd"), "v_cd")["disagreement_pct"]
        name = f"cell-days {fine} deg + {vname}"
        ablation.append({"variant": name, **s, "inner_validation_disagreement_pct": sel})
        if best is None or sel < best[0]:
            best = (sel, fine, vname, name, s)
for a in ablation:
    print(a)
_, FINE, VNAME, best_name, best_score = best
FIT = VARIANTS[VNAME]
print("chosen (on inner validation):", best_name)

# ---- final product with the chosen variant --------------------------------
df = tables[FINE].copy()
o, tr, te = split(df)
m_val = FIT(tr, "m_cd")
te_pred = predict(m_val, te, "m_cd")

cm = te.assign(p=te_pred).groupby(["country", "year", "month"])[["p", "v_cd"]].sum()
cm = cm[(cm.p > 0) & (cm.v_cd > 0)]
band_lo, band_hi = [float(x) for x in np.quantile(cm.v_cd / cm.p, [0.1, 0.9])]

per_country = {}
for c in ready:
    mask = (te.country == c).to_numpy()
    per_country[c] = {"before": score(te[mask], te.loc[mask, "m_det"].to_numpy(), "v_det"),
                      "after": score(te[mask], te_pred[mask], "v_cd")}

h_modis = predict(FIT(o, "m_cd"), df, "m_cd")          # MODIS (Terra+Aqua) -> VIIRS units
h_terra = predict(FIT(o, "t_cd"), df, "t_cd")          # Terra only -> VIIRS units
ym = (df.year * 100 + df.month).to_numpy()
terra_only = ym < 200207                               # Aqua data starts July 2002
viirs_era = (df.year >= 2012).to_numpy()
df["harmonized"] = np.where(viirs_era, df.v_cd, np.where(terra_only, h_terra, h_modis))
df["h_modis_all_years"] = h_modis                      # calibrated MODIS for every year (for the lab chart)
df["source"] = np.where(viirs_era, "VIIRS", np.where(terra_only, "MODIS Terra (calibrated)", "MODIS (calibrated)"))
df["h_lo"] = np.where(viirs_era, df.harmonized, df.harmonized * band_lo)
df["h_hi"] = np.where(viirs_era, df.harmonized, df.harmonized * band_hi)
df["lat"] = (df.gy + 0.5) * GRID
df["lon"] = (df.gx + 0.5) * GRID

# ---- independent check at the 2012 sensor switch --------------------------
yr = df.groupby(["country", "year"]).agg(m_det=("m_det", "sum"), v_det=("v_det", "sum"),
                                         m_cd=("m_cd", "sum"), h=("harmonized", "sum")).reset_index()
def change(s):                                         # mean 2012-2014 / mean 2009-2011
    s = s.set_index("year").iloc[:, 0]
    return float(s.loc[2012:2014].mean() / max(s.loc[2009:2011].mean(), 1e-9))
switch = {}
for c, g in yr.groupby("country"):
    naive = g.assign(x=np.where(g.year >= 2012, g.v_det, g.m_det))
    switch[c] = {"modis_only_reference": round(change(g[["year", "m_cd"]]), 2),
                 "harmonized": round(change(g[["year", "h"]]), 2),
                 "naive_sensor_switch": round(change(naive[["year", "x"]]), 2)}
err_h = float(np.mean([abs(np.log(v["harmonized"] / v["modis_only_reference"])) for v in switch.values()]))
err_n = float(np.mean([abs(np.log(v["naive_sensor_switch"] / v["modis_only_reference"])) for v in switch.values()]))

metrics = {
    "headline": {
        "text": f"Harmonization cut MODIS-VIIRS disagreement from {raw_score['disagreement_pct']}% "
                f"to {best_score['disagreement_pct']}% on held-out years",
        "before_pct": raw_score["disagreement_pct"], "after_pct": best_score["disagreement_pct"],
    },
    "definition": "Symmetric mean absolute % difference between the MODIS-derived and VIIRS "
                  "country-month totals, vegetation fires only, on years never used for fitting.",
    "variant_selection": f"chosen on inner-validation years {INNER_VAL} within the fit years; "
                         "held-out years were not used for any choice",
    "held_out_years": HELD_OUT, "fit_years": [y for y in OVERLAP if y not in HELD_OUT],
    "countries": ready, "chosen_variant": best_name, "fine_grid_deg": FINE,
    "ablation": ablation, "per_country": per_country,
    "uncertainty_band_p10_p90": [round(band_lo, 3), round(band_hi, 3)],
    "sensor_switch_check": {
        "note": "change in mean yearly total from 2009-2011 to 2012-2014. MODIS alone is a "
                "consistent sensor, so a good harmonized series should show the same change.",
        "by_country": switch,
        "mean_factor_error_harmonized": round(float(np.exp(err_h)), 2),
        "mean_factor_error_naive_switch": round(float(np.exp(err_n)), 2),
    },
}
(OUT / "harmonization_metrics.json").write_text(json.dumps(metrics, indent=2))

keep = df[(df.m_det > 0) | (df.v_det > 0) | (df.harmonized > 0.01)]
keep.to_parquet(WORK / "cell_month.parquet", index=False)
cmo = df.groupby(["country", "year", "month"]).agg(
    modis_raw=("m_det", "sum"), viirs_raw=("v_det", "sum"), harmonized=("harmonized", "sum"),
    modis_calibrated=("h_modis_all_years", "sum"), lo=("h_lo", "sum"), hi=("h_hi", "sum"),
    frp_modis=("m_frp", "sum"), frp_viirs=("v_frp", "sum")).round(1).reset_index()
(OUT / "country_month.json").write_text(cmo.to_json(orient="records"))

print(json.dumps(metrics["headline"], indent=2))
for c, v in per_country.items():
    print(c, v["before"]["disagreement_pct"], "->", v["after"]["disagreement_pct"], "| bias", v["after"]["bias_pct"])
print("sensor switch check:", json.dumps(metrics["sensor_switch_check"], indent=1))
print("rows kept:", len(keep), "| band:", round(band_lo, 3), round(band_hi, 3))
