"""Phase 4 — fire-risk model, baseline comparison, calibration, explanations, backtests.

Question the model answers: "will this 0.25 degree cell have at least one
(non-flare) VIIRS fire detection during week W?", predicted using only data
available before week W starts -- except, in version 3, WEATHER for week W.

FORECAST WEATHER (user decision 2026-11-13, PLAN.md section 13): version 3 also
sees the weather of week W itself, standing in for a 7-day weather forecast. In
this backtest it is the real weather, i.e. a PERFECT forecast, so every version-3
number is an upper bound and must be labelled "assumes a perfect 7-day weather
forecast". Fire data from week W or later is still never an input. Version 3's
inputs were fixed (from PLAN.md section 13, including the weekly hottest day and
windiest day) before it was scored on anything.

LEAKAGE RULES (checked by assertions below):
  * every FIRE / history feature for week W uses data from week W-1 or earlier
    (weeks) or from calendar months that ended before week W started (months);
    only the version-3 forecast-weather features (prefix fc_) use week W;
  * weather "normals" are computed from 2001-2018 only;
  * split by time: train 2012-03..2018, tune 2019-2020 (early stopping and
    probability calibration), then FROZEN; test 2021-2025 is only scored;
  * the three showcase fires (all 2021) were fixed before any model was trained;
  * gas flares / static sources are removed from the target.

Features: harmonized fire history (2000+, the reason harmonization matters),
recent fire in the cell and its neighbours, lagged weather (NASA POWER, 1 degree),
season and location. No land cover / NDVI (not downloaded; stated limitation).

Baseline: climatology = how often that cell burned in that week of the year in
2012-2020. The model has to beat it to be worth anything.

Outputs (OUT/): risk_metrics.json, backtests.json, risk_latest.json,
                risk_country_month.json ; model saved to WORK/risk_model.txt

Run: venv python pipeline/07_risk.py
"""
import json
import numpy as np
import pandas as pd
import duckdb
import lightgbm as lgb
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, roc_auc_score, brier_score_loss
from config import PARQUET, WORK, OUT, GRID

EPOCH = pd.Timestamp("2001-01-01")
week_of = lambda d: int((pd.Timestamp(d) - EPOCH).days // 7)
week_start = lambda w: EPOCH + pd.Timedelta(days=7 * int(w))
TRAIN = (week_of("2012-03-05"), week_of("2018-12-24"))
TUNE = (week_of("2019-01-07"), week_of("2020-12-21"))
TEST = (week_of("2021-01-04"), week_of("2025-12-22"))
NEG_KEEP_TRAIN, NEG_KEEP_TUNE = 0.08, 0.25
SHOWCASE = {
    "Dixie Fire, California": {"date": "2021-07-13", "lat": 40.0, "lon": -121.2, "country": "United States"},
    "Kabylie fires, Algeria": {"date": "2021-08-09", "lat": 36.7, "lon": 4.2, "country": "Algeria"},
    "Manavgat fire, Turkey": {"date": "2021-07-28", "lat": 36.9, "lon": 31.5, "country": "Turkey"},
}
rng = np.random.default_rng(7)
con = duckdb.connect()

# ---- cells -----------------------------------------------------------------
cmn = pd.read_parquet(WORK / "cell_month.parquet", columns=["country", "gy", "gx", "year", "month", "harmonized"])
top = cmn.groupby(["gy", "gx", "country"])["harmonized"].sum().reset_index().sort_values("harmonized")
cells = top.drop_duplicates(["gy", "gx"], keep="last")[["gy", "gx", "country"]].reset_index(drop=True)
cells["lat"] = (cells.gy + 0.5) * GRID
cells["lon"] = (cells.gx + 0.5) * GRID
N = len(cells)
cid = {(a, b): i for i, (a, b) in enumerate(zip(cells.gy, cells.gx))}
print("cells:", N, flush=True)

# ---- monthly harmonized history H[cell, month index] ------------------------
NM = 26 * 12
H = np.zeros((N, NM), np.float32)
hm = cmn.groupby(["gy", "gx", "year", "month"])["harmonized"].sum().reset_index()
ci = np.fromiter((cid[k] for k in zip(hm.gy, hm.gx)), np.int64, len(hm))
H[ci, ((hm.year - 2000) * 12 + hm.month - 1).to_numpy()] = hm.harmonized.to_numpy(np.float32)
# expanding climatology: mean of the same calendar month over all EARLIER years
Hy = H.reshape(N, 26, 12)
clim_prior = np.zeros_like(Hy)
clim_prior[:, 1:, :] = np.cumsum(Hy, axis=1)[:, :-1, :] / np.arange(1, 26)[None, :, None]
clim_prior = clim_prior.reshape(N, NM)

# ---- weekly VIIRS fire counts F[cell, week] (flares removed) ----------------
NW = TEST[1] + 1
wk = con.execute(f"""
    WITH f AS (SELECT cy, cx FROM read_parquet('{(WORK / 'flare_cells.parquet').as_posix()}') WHERE is_static)
    SELECT CAST(floor(lat/{GRID}) AS INTEGER) gy, CAST(floor(lon/{GRID}) AS INTEGER) gx,
           CAST(floor(date_diff('day', DATE '2001-01-01', date) / 7) AS INTEGER) AS "week", count(*) AS n
    FROM read_parquet('{PARQUET.as_posix()}/viirs-snpp/*.parquet') v
    ANTI JOIN f ON CAST(floor(v.lat/0.02) AS INTEGER) = f.cy AND CAST(floor(v.lon/0.02) AS INTEGER) = f.cx
    WHERE ok AND type = 0 GROUP BY 1, 2, 3
""").df()
wk = wk[wk.week < NW]
keep = np.fromiter(((a, b) in cid for a, b in zip(wk.gy, wk.gx)), bool, len(wk))
wk = wk[keep]
F = np.zeros((N, NW), np.float32)
F[np.fromiter((cid[k] for k in zip(wk.gy, wk.gx)), np.int64, len(wk)), wk.week.to_numpy()] = wk.n.to_numpy(np.float32)
Y = F > 0
print("positive cell-weeks:", int(Y.sum()), flush=True)

# ---- weather W[var][point, week] on the 1-degree grid -----------------------
wx = pd.read_parquet(WORK / "weather_weekly.parquet")
wx = wx[wx.week < NW]
pts = wx[["iy", "ix"]].drop_duplicates().reset_index(drop=True)
pid = {(a, b): i for i, (a, b) in enumerate(zip(pts.iy, pts.ix))}
pi = np.fromiter((pid[k] for k in zip(wx.iy, wx.ix)), np.int64, len(wx))
WX = {}
for v in ("tmax", "rh", "wind", "rain"):
    a = np.full((len(pts), NW), np.nan, np.float32)
    a[pi, wx.week.to_numpy()] = wx[v].to_numpy(np.float32)
    WX[v] = a
# weekly extremes (04b_weather_extremes.py): hottest daily max temperature, strongest daily max wind
ext = pd.read_parquet(WORK / "weather_extremes.parquet")
ext = ext[(ext.week < NW) & np.fromiter(((a, b) in pid for a, b in zip(ext.iy, ext.ix)), bool, len(ext))]
pe = np.fromiter((pid[k] for k in zip(ext.iy, ext.ix)), np.int64, len(ext))
for v in ("tmax_max", "wind_max"):
    a = np.full((len(pts), NW), np.nan, np.float32)
    a[pe, ext.week.to_numpy()] = ext[v].to_numpy(np.float32)
    WX[v] = a
print("weather points with extremes:", int(len(np.unique(pe))), "of", len(pts), flush=True)
cell_pt = np.fromiter((pid.get((int(np.floor(la)), int(np.floor(lo))), -1) for la, lo in zip(cells.lat, cells.lon)),
                      np.int64, N)
print("cells without a weather point:", int((cell_pt < 0).sum()), flush=True)
woy_all = np.array([min(week_start(w).dayofyear // 7, 51) for w in range(NW)])
# weather normals by week of year from 2001-2018 ONLY (no information from tune/test years)
norm_mask = np.arange(NW) <= TRAIN[1]
NORM = {}
for v in ("tmax", "rh"):
    n = np.full((len(pts), 52), np.nan, np.float32)
    for k in range(52):
        sel = norm_mask & (woy_all == k)
        n[:, k] = np.nanmean(WX[v][:, sel], axis=1)
    NORM[v] = n

# ---- version 2 additions: dryness and drought (same weather data, no new source) ----
es = 0.6108 * np.exp(17.27 * WX["tmax"] / (WX["tmax"] + 237.3))
WX["vpd"] = (es * (1 - WX["rh"] / 100)).astype(np.float32)            # vapour-pressure deficit, kPa
RC = np.concatenate([np.zeros((len(pts), 1), np.float32), np.nancumsum(WX["rain"], axis=1)], axis=1)
rain_sum = lambda w, k: RC[:, w] - RC[:, max(w - k, 0)]               # rain over the k weeks before week w
R26 = np.stack([rain_sum(w + 1, 26) for w in range(NW)], axis=1)      # 26 weeks ending with week w
for v, arr in (("vpd", WX["vpd"]), ("rain26", R26)):
    n = np.full((len(pts), 52), np.nan, np.float32)
    for k in range(52):
        n[:, k] = np.nanmean(arr[:, norm_mask & (woy_all == k)], axis=1)
    NORM[v] = n
# ---- version 3 additions: normals for the forecast-week weather (2001-2018 only) ----
WX["hdw"] = (WX["vpd"] * WX["wind"]).astype(np.float32)                # hot-dry-windy index
for v in ("wind", "rain", "hdw", "tmax_max", "wind_max"):
    n = np.full((len(pts), 52), np.nan, np.float32)
    for k in range(52):
        n[:, k] = np.nanmean(WX[v][:, norm_mask & (woy_all == k)], axis=1)
    NORM[v] = n
# months since the cell last burned (harmonized record), looking only backwards
idx = np.where(H > 0, np.arange(NM)[None, :], -1)
LAST = np.maximum.accumulate(idx, axis=1)                             # last burning month index <= m
annual_prior = clim_prior.reshape(N, 26, 12).sum(2)                   # mean yearly activity in earlier years

# ---- neighbour sums need a dense lat/lon grid -------------------------------
gy0, gx0 = cells.gy.min() - 1, cells.gx.min() - 1
GH, GW = cells.gy.max() - gy0 + 2, cells.gx.max() - gx0 + 2
ry, rx = (cells.gy - gy0).to_numpy(), (cells.gx - gx0).to_numpy()
def neighbours(vec, r=1):
    g = np.zeros((GH, GW), np.float32); g[ry, rx] = vec
    rr = range(-r, r + 1)
    s = sum(np.roll(np.roll(g, dy, 0), dx, 1) for dy in rr for dx in rr) - g
    return s[ry, rx]

FEATS = ["clim_month", "prev_year_month", "hist_last_month", "hist_last_3_months", "anomaly_last_month",
         "fire_last_week", "fire_2_weeks_ago", "fire_last_4_weeks", "neighbours_last_week", "neighbours_last_4_weeks",
         "tmax_last_week", "rh_last_week", "wind_last_week", "rain_last_week", "rain_last_4_weeks",
         "rain_last_12_weeks", "tmax_anomaly", "rh_anomaly", "season_sin", "season_cos", "lat", "lon",
         # version 2 (chosen on physical grounds, fixed before it was scored on anything):
         "vpd_last_week", "vpd_last_4_weeks", "vpd_anomaly", "tmax_4_week_anomaly", "rain_last_26_weeks",
         "rain_last_52_weeks", "rain_26_week_anomaly", "hot_dry_windy", "months_since_fire",
         "yearly_activity_before", "wider_area_fire_last_week",
         # version 3: weather FOR the predicted week (a forecast; in backtests the real weather = perfect forecast)
         "fc_tmax", "fc_rh", "fc_wind", "fc_rain", "fc_vpd", "fc_hot_dry_windy",
         "fc_tmax_anomaly", "fc_rh_anomaly", "fc_wind_anomaly", "fc_rain_anomaly", "fc_vpd_anomaly",
         "fc_hot_dry_windy_anomaly", "fc_hottest_day", "fc_windiest_day", "fc_hottest_day_anomaly",
         "fc_windiest_day_anomaly"]
V1 = list(range(22))                                  # the first version's features
V2 = list(range(33))
V3 = list(range(len(FEATS)))
FORECAST = set(range(33, len(FEATS)))                 # features that use weather of the target week
assert all(FEATS[i].startswith("fc_") for i in FORECAST) and not any(FEATS[i].startswith("fc_") for i in V2)
GROUP = {"Fire history (harmonized record)": FEATS[0:5] + ["months_since_fire", "yearly_activity_before"],
         "Recent fire in or near the cell": FEATS[5:10] + ["wider_area_fire_last_week"],
         "Temperature": ["tmax_last_week", "tmax_anomaly", "tmax_4_week_anomaly"],
         "Air dryness": ["rh_last_week", "rh_anomaly", "vpd_last_week", "vpd_last_4_weeks", "vpd_anomaly"],
         "Wind": ["wind_last_week", "hot_dry_windy"],
         "Rain and drought": ["rain_last_week", "rain_last_4_weeks", "rain_last_12_weeks", "rain_last_26_weeks",
                              "rain_last_52_weeks", "rain_26_week_anomaly"],
         "Season and location": ["season_sin", "season_cos", "lat", "lon"],
         "Forecast weather for the week": [FEATS[i] for i in sorted(FORECAST)]}
lat32, lon32 = cells.lat.to_numpy(np.float32), cells.lon.to_numpy(np.float32)
has_pt = cell_pt >= 0
cp = np.where(has_pt, cell_pt, 0)

def features(w):
    """Feature matrix for target week w. Everything indexed strictly before w."""
    d = week_start(w)
    mi = (d.year - 2000) * 12 + d.month - 1          # month containing the week start
    assert mi - 1 >= 0
    X = np.empty((N, len(FEATS)), np.float32)
    X[:, 0] = clim_prior[:, mi]                       # same calendar month, earlier years only
    X[:, 1] = H[:, mi - 12]
    X[:, 2] = H[:, mi - 1]                            # last fully finished month
    X[:, 3] = H[:, mi - 3:mi].sum(1)
    X[:, 4] = H[:, mi - 1] / (clim_prior[:, mi - 1] + 1)
    X[:, 5] = F[:, w - 1]; X[:, 6] = F[:, w - 2]; X[:, 7] = F[:, w - 4:w].sum(1)
    X[:, 8] = neighbours(F[:, w - 1]); X[:, 9] = neighbours(F[:, w - 4:w].sum(1))
    for j, v in ((10, "tmax"), (11, "rh"), (12, "wind"), (13, "rain")):
        X[:, j] = np.where(has_pt, WX[v][cp, w - 1], np.nan)
    X[:, 14] = np.where(has_pt, np.nansum(WX["rain"][cp, w - 4:w], 1), np.nan)
    X[:, 15] = np.where(has_pt, np.nansum(WX["rain"][cp, w - 12:w], 1), np.nan)
    k = woy_all[w - 1]
    X[:, 16] = X[:, 10] - np.where(has_pt, NORM["tmax"][cp, k], np.nan)
    X[:, 17] = X[:, 11] - np.where(has_pt, NORM["rh"][cp, k], np.nan)
    ang = 2 * np.pi * d.dayofyear / 365.25
    X[:, 18] = np.sin(ang); X[:, 19] = np.cos(ang); X[:, 20] = lat32; X[:, 21] = lon32
    nan = lambda a: np.where(has_pt, a, np.nan)
    X[:, 22] = nan(WX["vpd"][cp, w - 1])
    X[:, 23] = nan(np.nanmean(WX["vpd"][cp, w - 4:w], 1))
    X[:, 24] = X[:, 22] - nan(NORM["vpd"][cp, k])
    X[:, 25] = nan(np.nanmean(WX["tmax"][cp, w - 4:w], 1)) - nan(np.nanmean(NORM["tmax"][cp][:, [(k - j) % 52 for j in range(4)]], 1))
    X[:, 26] = nan(rain_sum(w, 26)[cp]); X[:, 27] = nan(rain_sum(w, 52)[cp])     # weeks w-26..w-1 and w-52..w-1
    X[:, 28] = X[:, 26] - nan(NORM["rain26"][cp, k])                              # normal for 26 weeks ending at week w-1
    X[:, 29] = X[:, 22] * X[:, 12]
    last = LAST[:, mi - 1]
    X[:, 30] = np.where(last >= 0, (mi - 1) - last, 400)
    X[:, 31] = annual_prior[:, mi // 12]
    X[:, 32] = neighbours(F[:, w - 1], 2)
    # version 3 only: WEATHER of week w itself (forecast). No fire data from week w is used anywhere.
    kw = woy_all[w]
    for j, v in enumerate(("tmax", "rh", "wind", "rain", "vpd", "hdw")):
        X[:, 33 + j] = nan(WX[v][cp, w])
        X[:, 39 + j] = X[:, 33 + j] - nan(NORM[v][cp, kw])
    X[:, 45] = nan(WX["tmax_max"][cp, w]); X[:, 46] = nan(WX["wind_max"][cp, w])
    X[:, 47] = X[:, 45] - nan(NORM["tmax_max"][cp, kw]); X[:, 48] = X[:, 46] - nan(NORM["wind_max"][cp, kw])
    return X

# ---- baseline: climatological frequency per cell and week of year, 2012-2020 -
pre = np.arange(NW)
pre_mask = (pre >= TRAIN[0]) & (pre <= TUNE[1])
BASE = np.zeros((N, 52), np.float32)
for k in range(52):
    near = pre_mask & np.isin(woy_all, [(k - 1) % 52, k, (k + 1) % 52])
    BASE[:, k] = Y[:, near].mean(1)

def collect(rng_weeks, neg_keep):
    Xs, ys, ws, wk_id, ci_ = [], [], [], [], []
    for w in range(rng_weeks[0], rng_weeks[1] + 1):
        X = features(w); y = Y[:, w]
        m = y | (rng.random(N) < neg_keep) if neg_keep < 1 else np.ones(N, bool)
        Xs.append(X[m]); ys.append(y[m]); ws.append(np.where(y[m], 1.0, 1.0 / neg_keep).astype(np.float32))
        wk_id.append(np.full(m.sum(), w, np.int32)); ci_.append(np.nonzero(m)[0].astype(np.int32))
    return np.vstack(Xs), np.concatenate(ys), np.concatenate(ws), np.concatenate(wk_id), np.concatenate(ci_)

print("building train / tune / test ...", flush=True)
Xtr, ytr, wtr, _, _ = collect(TRAIN, NEG_KEEP_TRAIN)
Xtu, ytu, wtu, _, _ = collect(TUNE, NEG_KEEP_TUNE)
print("train rows:", len(ytr), "tune rows:", len(ytu), flush=True)

PARAMS = dict(objective="binary", learning_rate=0.06, num_leaves=63, min_data_in_leaf=200, feature_fraction=0.8,
              bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0, verbose=-1, seed=7)


def fit(cols):
    names = [FEATS[i] for i in cols]
    m = lgb.train(PARAMS, lgb.Dataset(Xtr[:, cols], ytr, weight=wtr, feature_name=names), num_boost_round=1500,
                  valid_sets=[lgb.Dataset(Xtu[:, cols], ytu, weight=wtu, feature_name=names)],
                  callbacks=[lgb.early_stopping(60, verbose=False)])
    raw = m.predict(Xtu[:, cols])
    cal = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(raw, ytu, sample_weight=wtu)
    return m, cal, float(average_precision_score(ytu, raw, sample_weight=wtu))


FC_LABEL = "assumes a perfect 7-day weather forecast"
CANDIDATES = {"version 1 (history, recent fire, basic weather)": V1,
              "version 2 (adds dryness, drought, time since fire, wider area)": V2,
              "version 3 (adds forecast weather for the week)": V3}
USES_FC = {name: bool(set(cols) & FORECAST) for name, cols in CANDIDATES.items()}
fitted = {name: fit(cols) for name, cols in CANDIDATES.items()}
selection = {name: round(f[2], 4) for name, f in fitted.items()}
CHOSEN = max(selection, key=selection.get)             # decided on 2019-2020 only; 2021+ plays no part
# the best version WITHOUT forecast weather, chosen by the same rule, shown next to it as "no forecast"
NOFC = max((n for n in selection if not USES_FC[n]), key=selection.get)
print("tune-year PR-AUC:", selection, "| chosen:", CHOSEN, "| best without forecast:", NOFC, flush=True)
model, iso, _ = fitted[CHOSEN]
COLS = CANDIDATES[CHOSEN]
model.save_model(str(WORK / "risk_model.txt"))
predict_with = lambda name, X: fitted[name][1].predict(fitted[name][0].predict(X[:, CANDIDATES[name]]))
predict = lambda X: predict_with(CHOSEN, X)
del Xtr, Xtu
print("trees:", model.best_iteration, flush=True)

# ---- test: every cell, every week of 2021-2025, every version ----------------
PV = {name: np.zeros((N, TEST[1] - TEST[0] + 1), np.float32) for name in CANDIDATES}
for w in range(TEST[0], TEST[1] + 1):
    Xw = features(w)
    for name in CANDIDATES:
        PV[name][:, w - TEST[0]] = predict_with(name, Xw)
P = PV[CHOSEN]
Yt = Y[:, TEST[0]:TEST[1] + 1]
Bt = BASE[:, woy_all[TEST[0]:TEST[1] + 1]]
p, b, y = P.ravel(), Bt.ravel(), Yt.ravel()

def top_precision(score, y, frac=0.10):
    k = int(len(score) * frac); idx = np.argpartition(-score, k)[:k]
    return float(y[idx].mean()), float(y[idx].sum() / y.sum())

def summary(score):
    pr10, rc10 = top_precision(score, y)
    return {"pr_auc": round(float(average_precision_score(y, score)), 4),
            "roc_auc": round(float(roc_auc_score(y, score)), 4),
            "brier": round(float(brier_score_loss(y, score)), 5),
            "precision_top10pct": round(pr10, 4), "share_of_fires_in_top10pct": round(rc10, 4)}
m_versions = {name: summary(PV[name].ravel()) for name in CANDIDATES}
m_model, m_base = m_versions[CHOSEN], summary(b)
bins = np.array([0, .01, .02, .05, .1, .2, .3, .5, .7, .9, 1.0001])
calib = []
for lo, hi in zip(bins[:-1], bins[1:]):
    s = (p >= lo) & (p < hi)
    if s.sum():
        calib.append({"bin": f"{lo:.0%}-{min(hi, 1):.0%}", "predicted": round(float(p[s].mean()), 4),
                      "observed": round(float(y[s].mean()), 4), "cell_weeks": int(s.sum())})
by_year = {}
for yr in range(2021, 2026):
    cols = [i for i, w in enumerate(range(TEST[0], TEST[1] + 1)) if week_start(w).year == yr]
    yy, pp, bb = Yt[:, cols].ravel(), P[:, cols].ravel(), Bt[:, cols].ravel()
    by_year[yr] = {"model_pr_auc": round(float(average_precision_score(yy, pp)), 4),
                   "no_forecast_pr_auc": round(float(average_precision_score(yy, PV[NOFC][:, cols].ravel())), 4),
                   "baseline_pr_auc": round(float(average_precision_score(yy, bb)), 4)}

# ---- EVERY large fire in the test years (not three chosen ones) ---------------
# A "large fire" = an event rated critical: in the top 1% by size for its country.
# For each, look at the week it began and at the cells it burned in that week. The
# fire counts as "inside the top 10%" when at least half of those cells were among
# the highest-risk 10% of cells in its country that week. Same test for the baseline.
from scipy.stats import rankdata
from config import REGIONS
region_of = {c: r for r, cs in REGIONS.items() for c in cs}
ctry = cells.country.to_numpy()
c_idx = {c: np.nonzero(ctry == c)[0] for c in np.unique(ctry)}
_pc = {}


VK = {name: f"v{i}" for i, name in enumerate(CANDIDATES, 1)}      # short column keys per version
SCORES = {**{VK[n]: PV[n] for n in CANDIDATES}, "base": Bt}


def country_pct(w):
    """For week w: each cell's risk percentile among the cells of its own country, per version and baseline."""
    if w not in _pc:
        j = w - TEST[0]
        out = {k: np.zeros(N, np.float32) for k in SCORES}
        for idx in c_idx.values():
            for k, S in SCORES.items():
                out[k][idx] = rankdata(S[idx, j], method="max") / len(idx) * 100
        _pc[w] = out
    return _pc[w]


evs = pd.read_parquet(WORK / "events.parquet", columns=["event", "country", "start", "n_det", "severity"])
evs["wk0"] = (pd.to_datetime(evs.start) - EPOCH).dt.days // 7
big = evs[(evs.severity == "critical") & (evs.wk0 >= TEST[0]) & (evs.wk0 <= TEST[1])].copy()
edays = pd.read_parquet(WORK / "event_days.parquet", columns=["event", "date", "s", "nn", "w", "e", "lat", "lon"])
edays = edays[edays.event.isin(big.event)].merge(big[["event", "wk0"]], on="event")
edays = edays[(pd.to_datetime(edays.date) - EPOCH).dt.days // 7 == edays.wk0]
first = edays.groupby("event").agg(s=("s", "min"), n=("nn", "max"), w=("w", "min"), e=("e", "max"),
                                   lat=("lat", "mean"), lon=("lon", "mean"))
big = big.merge(first, left_on="event", right_index=True)
rows = []
for r in big.itertuples():
    gy0_, gy1_ = int(np.floor(r.s * 0.05 / GRID)), int(np.floor((r.n * 0.05 + 0.049) / GRID))
    gx0_, gx1_ = int(np.floor(r.w * 0.05 / GRID)), int(np.floor((r.e * 0.05 + 0.049) / GRID))
    ids = [cid[(a, b_)] for a in range(gy0_, gy1_ + 1) for b_ in range(gx0_, gx1_ + 1) if (a, b_) in cid]
    ids = [i for i in ids if Y[i, r.wk0]]
    if not ids:
        continue
    pc = country_pct(int(r.wk0))
    row = {"event": r.event, "country": r.country, "region": region_of.get(r.country, ""), "start": r.start,
           "n_det": r.n_det, "lat": r.lat, "lon": r.lon, "cells": len(ids),
           "dlat": (r.n - r.s + 1) * 0.05, "dlon": (r.e - r.w + 1) * 0.05}
    for k, pk in pc.items():
        row[f"pct_{k}"] = float(pk[ids].mean()); row[f"top_{k}"] = float((pk[ids] > 90).mean())
    rows.append(row)
lf = pd.DataFrame(rows)


def lf_summary(d, name=CHOSEN):
    k = VK[name]
    return {"fires": int(len(d)),
            "model_pct_inside_top10": round(float((d[f"top_{k}"] >= 0.5).mean() * 100), 1),
            "baseline_pct_inside_top10": round(float((d.top_base >= 0.5).mean() * 100), 1),
            "model_median_rank_pct": round(float(d[f"pct_{k}"].median()), 1),
            "baseline_median_rank_pct": round(float(d.pct_base.median()), 1),
            "model_pct_above_typical_cell": round(float((d[f"pct_{k}"] > 50).mean() * 100), 1)}


large_fires = {
    "definition": "Every fire event in 2021-2025 rated critical (top 1% by size for its country). For the week it "
                  "began, a fire is 'inside the top 10%' when at least half of the cells it burned that week were "
                  "among the highest-risk 10% of cells in its country. Rank = average risk percentile of those cells.",
    "all": lf_summary(lf), "by_region": {r: lf_summary(d) for r, d in lf.groupby("region") if r},
    "by_year": {int(y): lf_summary(d) for y, d in lf.groupby(pd.to_datetime(lf.start).dt.year)},
    "by_version": {n: {"all": lf_summary(lf, n), "by_region": {r: lf_summary(d, n) for r, d in lf.groupby("region") if r}}
                   for n in CANDIDATES},
}
print("LARGE FIRES by version:", json.dumps({n: v["all"] for n, v in large_fires["by_version"].items()}), flush=True)
print("LARGE FIRES:", json.dumps(large_fires["all"]), flush=True)
for r_, v_ in large_fires["by_region"].items():
    print("  ", r_, json.dumps(v_), flush=True)

# Showcase fires chosen by a RULE, not by result: the largest fire in each region in the test years.
RULE = {}
for reg, d in lf.groupby("region"):
    if not reg:
        continue
    t = d.sort_values("n_det", ascending=False).iloc[0]
    RULE[f"Largest fire in {reg}, {str(t.start)[:4]} ({t.country})"] = {
        "date": str(t.start)[:10], "lat": float(t.lat), "lon": float(t.lon), "country": t.country,
        "dlat": max(0.5, t.dlat / 2 + 0.3), "dlon": max(0.6, t.dlon / 2 + 0.3), "event": int(t.event),
        "group": "Chosen by rule: largest fire in its region, 2021-2025"}
ALLCASES = {**{k: {**v, "group": "Fixed before the model was trained"} for k, v in SHOWCASE.items()}, **RULE}

# global importance by group (mean absolute contribution on a test sample)
samp_w = rng.choice(np.arange(TEST[0], TEST[1] + 1), 12, replace=False)
contrib = np.vstack([model.predict(features(w)[rng.choice(N, 4000, replace=False)][:, COLS], pred_contrib=True) for w in samp_w])
POS = {FEATS[c]: j for j, c in enumerate(COLS)}        # feature name -> column in the chosen model
gcols = lambda fs: [POS[f] for f in fs if f in POS]
imp = {g: float(np.abs(contrib[:, gcols(fs)].sum(1)).mean()) for g, fs in GROUP.items() if gcols(fs)}
tot = sum(imp.values()); imp = {g: round(100 * v / tot, 1) for g, v in sorted(imp.items(), key=lambda kv: -kv[1])}

metrics = {
    "question": ("Will this 0.25 degree cell have at least one non-flare VIIRS fire detection in the week, "
                 "predicted from fire data available before the week starts and the weather forecast for the week?")
                if USES_FC[CHOSEN] else
                ("Will this 0.25 degree cell have at least one non-flare VIIRS fire detection in the week, "
                 "predicted from data available before the week starts?"),
    "forecast_assumption": "perfect" if USES_FC[CHOSEN] else None,
    "forecast_label": FC_LABEL,
    "chosen": CHOSEN, "chosen_uses_forecast_weather": USES_FC[CHOSEN], "no_forecast_version": NOFC,
    "versions": {n: {"uses_forecast_weather": USES_FC[n], "tune_pr_auc": selection[n], "test": m_versions[n],
                     "features": [FEATS[c] for c in CANDIDATES[n]]} for n in CANDIDATES},
    "split": {"train": "2012-03 to 2018", "tune": "2019-2020 (early stopping, calibration)", "test": "2021-2025 (scored only)"},
    "test_cell_weeks": int(len(y)), "test_fire_rate": round(float(y.mean()), 4),
    "model": m_model, "baseline_climatology": m_base,
    "lift_pr_auc": round(m_model["pr_auc"] / m_base["pr_auc"], 2),
    "by_year": by_year, "calibration": calib, "importance_pct": imp, "trees": int(model.best_iteration),
    "large_fires": large_fires,
    "features": [FEATS[c] for c in COLS],
    "model_selection": {"rule": "Three versions were trained on the same rows. The one with the highest score on "
                                "2019-2020 was chosen; 2021-2025 and the showcase fires played no part.",
                        "tune_years_pr_auc": selection, "chosen": CHOSEN,
                        "test_scores": m_versions,
                        "disclosure": "Version 1 was scored on the test years once before version 2 was built, and "
                                      "version 2 before version 3. Each new version's inputs were fixed before it was "
                                      "scored (version 3's from PLAN.md section 13, written before any version-3 run). "
                                      "Version 3 uses the weather of the predicted week; in these backtests that is the "
                                      "real weather, so each of its numbers " + FC_LABEL + " and is an upper bound."},
    "limits": (["Version 3 uses the real weather of the predicted week in place of a forecast, so its scores "
                + FC_LABEL + ". A real forecast is less accurate, so live results would be lower."]
               if USES_FC[CHOSEN] else []) +
              ["No land-cover or vegetation-greenness feature.", "Weather on a 1 degree grid.",
               "Predicts whether a cell burns, not where a fire starts or how far it spreads.",
               "Past fire is the strongest signal, so new fire in a never-burned place is poorly anticipated."],
}
(OUT / "risk_metrics.json").write_text(json.dumps(metrics, indent=1))
print(json.dumps({k: metrics[k] for k in ("model", "baseline_climatology", "lift_pr_auc", "importance_pct", "model_selection")}, indent=1), flush=True)
FC_SHOW = ("fc_tmax", "fc_hottest_day", "fc_rh", "fc_wind", "fc_windiest_day", "fc_rain")

# ---- explanations -----------------------------------------------------------
def explain(X_rows):
    c = model.predict(X_rows[:, COLS], pred_contrib=True)[:, :-1]
    out = []
    for r in c:
        g = {name: float(r[gcols(fs)].sum()) for name, fs in GROUP.items() if gcols(fs)}
        out.append(sorted(((k, round(v, 3)) for k, v in g.items()), key=lambda kv: -abs(kv[1])))
    return out

# ---- backtests: the three showcase fires ------------------------------------
backtests = {}
for name, s in ALLCASES.items():
    w = week_of(s["date"]); X = features(w); bs = BASE[:, woy_all[w]]
    prs = {n: predict_with(n, X) for n in CANDIDATES}; pr = prs[CHOSEN]
    actual = Y[:, w] | Y[:, w + 1]                      # burned in the target week or the next
    incountry = (cells.country == s["country"]).to_numpy()
    box = (np.abs(cells.lat - s["lat"]) <= 3) & (np.abs(cells.lon - s["lon"]) <= 4)
    near = ((np.abs(cells.lat - s["lat"]) <= s.get("dlat", 0.5)) & (np.abs(cells.lon - s["lon"]) <= s.get("dlon", 0.6))).to_numpy()
    fire_cells = near & actual
    def rank_pct(score):                               # percentile of the fire's cells among the country's cells
        return float(np.mean([(score[incountry] <= v).mean() for v in score[fire_cells]]) * 100) if fire_cells.any() else None
    def hit(score, frac=0.10):                         # share of the country's burning cells inside its top 10% risk
        thr = np.quantile(score[incountry], 1 - frac); a = actual & incountry
        return float((score[a] >= thr).mean() * 100) if a.any() else None
    j = np.nonzero(fire_cells)[0]
    main = int(j[np.argmax(pr[j])]) if len(j) else int(np.argmax(np.where(near, pr, -1)))
    def score(sc):
        return {"mean_risk_on_fire_cells_pct": round(float(sc[fire_cells].mean() * 100), 1) if fire_cells.any() else None,
                "risk_percentile_in_country": round(rank_pct(sc), 1) if fire_cells.any() else None,
                "country_burning_cells_caught_in_top10pct": round(hit(sc), 1)}
    xv = lambda f: None if np.isnan(X[main, FEATS.index(f)]) else round(float(X[main, FEATS.index(f)]), 1)
    backtests[name] = {
        "fire_start": s["date"], "country": s["country"], "centre": [s["lat"], s["lon"]],
        "group": s["group"], "event": s.get("event"),
        "prediction_for_week_starting": str(week_start(w).date()),
        "data_used_up_to": str((week_start(w) - pd.Timedelta(days=1)).date()),
        "uses_forecast_weather": USES_FC[CHOSEN],
        "forecast_note": ("Fire data up to the day before; weather for the week itself is the real weather, used as a "
                          "forecast (" + FC_LABEL + ").") if USES_FC[CHOSEN] else None,
        "fire_cells": int(fire_cells.sum()),
        "model": score(pr), "baseline": score(bs),
        "by_version": {n: score(prs[n]) for n in CANDIDATES},
        "why_main_cell": {"lat": float(cells.lat[main]), "lon": float(cells.lon[main]),
                          "risk_pct": round(float(pr[main] * 100), 1), "drivers": explain(X[[main]])[0],
                          "weather_last_week": {f: xv(f) for f in ("tmax_last_week", "tmax_anomaly", "rh_last_week",
                                                                   "wind_last_week", "rain_last_4_weeks")},
                          "weather_forecast_week": {f: xv(f) for f in FC_SHOW + ("fc_tmax_anomaly",)}},
        "cells": [{"lat": float(a), "lon": float(o), "risk": round(float(r), 3), "base": round(float(q), 3), "burned": bool(t)}
                  for a, o, r, q, t in zip(cells.lat[box], cells.lon[box], pr[box.to_numpy()], bs[box.to_numpy()], actual[box.to_numpy()])],
    }
    print(name, json.dumps({k: backtests[name][k] for k in ("fire_cells", "by_version", "baseline")}), flush=True)
(OUT / "backtests.json").write_text(json.dumps(backtests))

# ---- latest risk map + per-cell reasons -------------------------------------
wl = TEST[1]; Xl = features(wl); pl = predict(Xl)
sel = np.nonzero(pl >= 0.005)[0]
ex = explain(Xl[sel])
FC_IDX = [FEATS.index(f) for f in FC_SHOW]
rnd = lambda vals: [None if np.isnan(v) else round(float(v), 1) for v in vals]
latest = {"week_starting": str(week_start(wl).date()), "data_used_up_to": str((week_start(wl) - pd.Timedelta(days=1)).date()),
          "uses_forecast_weather": USES_FC[CHOSEN],
          "forecast_note": ("Weather for this week is the real weather from the archive, standing in for a forecast ("
                            + FC_LABEL + ").") if USES_FC[CHOSEN] else None,
          "fc_fields": list(FC_SHOW),
          "cells": [{"lat": float(cells.lat[i]), "lon": float(cells.lon[i]), "country": cells.country[i],
                     "risk": round(float(pl[i]), 3), "base": round(float(BASE[i, woy_all[wl]]), 3),
                     "why": e[:3],
                     "wx": rnd(Xl[i, [10, 11, 12, 14]]),
                     **({"fc": rnd(Xl[i, FC_IDX])} if USES_FC[CHOSEN] else {})}
                    for i, e in zip(sel, ex)]}
(OUT / "risk_latest.json").write_text(json.dumps(latest))

# ---- risk by country and calendar month (test years): predicted vs observed --
months = np.array([week_start(w).month for w in range(TEST[0], TEST[1] + 1)])
rows = []
for c in sorted(cells.country.unique()):
    m = (cells.country == c).to_numpy()
    for mo in range(1, 13):
        cols = months == mo
        rows.append({"country": c, "month": mo, "predicted": round(float(P[m][:, cols].mean()), 4),
                     "observed": round(float(Yt[m][:, cols].mean()), 4)})
(OUT / "risk_country_month.json").write_text(json.dumps(rows))
print("RISK_DONE", flush=True)
