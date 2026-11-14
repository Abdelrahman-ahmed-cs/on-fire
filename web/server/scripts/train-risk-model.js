// Trains the AI fire-danger model.
//
//   npm run train:risk              Middle East & North Africa → data/ml/
//   npm run train:risk -- NAM       North America → data/ml/NAM/
//
// Data
//   • Labels  – harmonized archive: did VIIRS see a vegetation fire in a 0.5° cell in a month? (2012 → today)
//   • Weather – NASA POWER monthly: max temperature, rain, humidity, wind, root-zone soil wetness, elevation
//   • History – how often the cell (and its neighbours) burned in the same month in previous years
//
// Validation: the model is trained on 2013–2022 and tested on 2023 → today (years it never saw),
// then re-trained on everything for live use. Outputs data/ml/model.json + data/ml/serving.json.
import fs from 'node:fs';
import path from 'node:path';
import { countryAt } from '../lib/geo.js';
import { REGIONS, ISO_SET, regionOfIso } from '../lib/regions.js';
import { trainGBM, predictProba, explain, auc } from '../lib/gbm.js';
import { levelOf } from '../lib/ml.js';
import { FEATURES, GROUPS, vector, monthSin, monthCos } from '../lib/riskFeatures.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CACHE = path.join(ROOT, 'data/cache/power');
const ARCHIVE_CACHE = path.join(ROOT, 'data/cache/archive');
const REGION = (process.argv[2] || 'MENA').toUpperCase();
if (!REGIONS[REGION]) throw new Error(`Unknown region ${REGION}`);
const BBOX = REGIONS[REGION].bbox;
const inRegion = (iso) => ISO_SET.has(iso) && regionOfIso(iso) === REGION;
// each region has its own model; MENA keeps the original location
const OUT = REGION === 'MENA' ? path.join(ROOT, 'data/ml') : path.join(ROOT, 'data/ml', REGION);
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const POWER = 'https://power.larc.nasa.gov/api/temporal/monthly/regional';
const PARAMS = { T2M_MAX: 'tmax', PRECTOTCORR: 'rain', RH2M: 'rh', WS10M: 'wind', GWETROOT: 'soil' };
const Y0 = 2012;
const Y1 = new Date().getUTCFullYear();
const NM = (Y1 - Y0 + 1) * 12;
const mi = (y, m) => (y - Y0) * 12 + m;
const TEST_FROM = 2023;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. NASA POWER monthly weather ----------
async function fetchTile(param, lonMin, lonMax, latMin, latMax) {
  const file = path.join(CACHE, `${param}_${lonMin}_${latMin}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const end of [Y1, Y1 - 1]) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const url = `${POWER}?parameters=${param}&community=AG&longitude-min=${lonMin}&longitude-max=${lonMax}&latitude-min=${latMin}&latitude-max=${latMax}&start=${Y0}&end=${end}&format=JSON`;
        const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (res.status === 422) break; // try previous end year
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const pts = [], vals = [];
        for (const f of j.features ?? []) {
          const [lon, lat, elev] = f.geometry.coordinates;
          const series = f.properties.parameter[param];
          const arr = new Array(NM).fill(null);
          for (const [k, v] of Object.entries(series)) {
            const y = +k.slice(0, 4), m = +k.slice(4) - 1;
            if (m > 11 || y < Y0 || y > Y1 || v === -999) continue;
            arr[mi(y, m)] = v;
          }
          pts.push([lat, lon, elev]);
          vals.push(arr);
        }
        const out = { pts, vals };
        fs.writeFileSync(file, JSON.stringify(out));
        return out;
      } catch (e) {
        log(`  retry ${param} ${lonMin},${latMin}: ${e.message}`);
        await sleep(3000 * (attempt + 1));
      }
    }
  }
  throw new Error(`POWER tile failed ${param} ${lonMin},${latMin}`);
}

async function loadWeather() {
  const { west, south, east, north } = BBOX;
  const tiles = [];
  // skip tiles with no land cell of the region (open ocean): they would never be used
  const hasLand = (lo0, lo1, la0, la1) => {
    for (let la = la0 + 0.25; la < la1; la += 0.5) for (let lo = lo0 + 0.25; lo < lo1; lo += 0.5) { const c = countryAt(lo, la); if (c && inRegion(c.iso)) return true; }
    return false;
  };
  for (let lon = west; lon < east; lon += 10) for (let lat = south; lat < north; lat += 10) {
    const t = [lon, Math.min(lon + 10, east), lat, Math.min(lat + 10, north)];
    if (REGION === 'MENA' || hasLand(...t)) tiles.push(t);
  }
  const jobs = [];
  for (const p of Object.keys(PARAMS)) for (const t of tiles) jobs.push([p, ...t]);
  log(`NASA POWER: ${jobs.length} regional requests (cached after the first run)`);
  const weather = new Map(); // key → {lat, lon, elev, tmax, rain, …}
  let done = 0;
  const queue = [...jobs];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const [p, lonMin, lonMax, latMin, latMax] = queue.shift();
      const tile = await fetchTile(p, lonMin, lonMax, latMin, latMax);
      tile.pts.forEach(([lat, lon, elev], i) => {
        const key = pkey(lat, lon);
        if (!weather.has(key)) weather.set(key, { lat, lon, elev });
        weather.get(key)[PARAMS[p]] = tile.vals[i];
      });
      if (++done % 20 === 0) log(`  ${done}/${jobs.length}`);
    }
  }));
  return weather;
}
const pkey = (lat, lon) => `${Math.round(lat / 0.5)}_${Math.round(lon / 0.625)}`;

// ---------- 2. model cells (0.5°, on land in the region) ----------
function buildCells(weather) {
  const { west, south, east, north } = BBOX;
  const cells = new Map();
  for (let cy = Math.floor(south * 2); cy < north * 2; cy++)
    for (let cx = Math.floor(west * 2); cx < east * 2; cx++) {
      const lat = (cy + 0.5) / 2, lon = (cx + 0.5) / 2;
      const c = countryAt(lon, lat);
      if (!c || !inRegion(c.iso)) continue;
      const w = weather.get(pkey(lat, lon));
      if (!w?.tmax) continue;
      cells.set(`${cy}_${cx}`, { k: `${cy}_${cx}`, cy, cx, lat, lon, iso: c.iso, w, fire: new Uint8Array(NM) });
    }
  return cells;
}

// ---------- 3. labels: VIIRS fire presence per cell-month ----------
function loadLabels(cells) {
  let lastIdx = 0;
  const add = (key) => {
    const [c025, m, y] = key.split('|');
    const [a, b] = c025.split('_').map(Number);
    const cell = cells.get(`${Math.floor(a / 2)}_${Math.floor(b / 2)}`);
    const idx = mi(+y, +m);
    if (!cell || idx < 0 || idx >= NM) return;
    cell.fire[idx] = 1;
    lastIdx = Math.max(lastIdx, idx);
  };
  for (const f of fs.readdirSync(ARCHIVE_CACHE)) {
    const full = path.join(ARCHIVE_CACHE, f);
    if (/^[A-Z]{3}_V_\d{4}\.json$/.test(f)) JSON.parse(fs.readFileSync(full, 'utf8')).clim.forEach(add);
    else if (/^api(NAM)?_V_/.test(f)) for (const part of Object.values(JSON.parse(fs.readFileSync(full, 'utf8')))) part.clim.forEach(add);
  }
  return lastIdx;
}

// ---------- 4. features ----------
function prepare(cells, lastPower) {
  for (const c of cells.values()) {
    // climatology of every weather variable per calendar month (years with data)
    c.clim = {};
    for (const v of Object.values(PARAMS)) {
      c.clim[v] = Array.from({ length: 12 }, (_, m) => {
        let s = 0, n = 0;
        for (let y = Y0; y <= Y1; y++) {
          const val = c.w[v]?.[mi(y, m)];
          if (val !== null && val !== undefined && mi(y, m) <= lastPower) { s += val; n++; }
        }
        return n ? s / n : null;
      });
    }
    // cumulative history: years before y with fire in month m / in any month
    const ny = Y1 - Y0 + 1;
    c.cumM = new Uint8Array((ny + 1) * 12);
    c.cumAny = new Uint8Array(ny + 1);
    for (let yi = 0; yi < ny; yi++) {
      let any = 0;
      for (let m = 0; m < 12; m++) {
        c.cumM[(yi + 1) * 12 + m] = c.cumM[yi * 12 + m] + c.fire[yi * 12 + m];
        any |= c.fire[yi * 12 + m];
      }
      c.cumAny[yi + 1] = c.cumAny[yi] + any;
    }
    c.everBurned = c.cumAny[ny] > 0;
  }
}

const val = (arr, idx) => (arr && idx >= 0 && arr[idx] !== null && arr[idx] !== undefined ? arr[idx] : NaN);
const mean = (arr, from, to) => {
  let s = 0, n = 0;
  for (let i = from; i <= to; i++) {
    const v = val(arr, i);
    if (Number.isFinite(v)) { s += v; n++; }
  }
  return n ? s / n : NaN;
};

export function histFreq(c, y, m) {
  const yrs = y - Y0;
  return yrs > 0 ? c.cumM[yrs * 12 + m] / yrs : NaN;
}

function featuresFor(c, y, m, cells) {
  const idx = mi(y, m);
  const yrs = y - Y0;
  let ns = 0, nn = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dy && !dx) continue;
      const n = cells.get(`${c.cy + dy}_${c.cx + dx}`);
      if (n) { ns += histFreq(n, y, m); nn++; }
    }
  const tmax = val(c.w.tmax, idx);
  return vector({
    hist_freq: histFreq(c, y, m),
    hist_any: yrs > 0 ? c.cumAny[yrs] / yrs : NaN,
    neigh_freq: nn ? ns / nn : NaN,
    last_year: idx - 12 >= 0 ? c.fire[idx - 12] : NaN,
    prev_month: idx - 1 >= 0 ? c.fire[idx - 1] : NaN,
    tmax,
    tmax_anom: tmax - c.clim.tmax[m],
    rain: val(c.w.rain, idx),
    rh: val(c.w.rh, idx),
    wind: val(c.w.wind, idx),
    soil_wet: val(c.w.soil, idx),
    rain_prev3: mean(c.w.rain, idx - 3, idx - 1),
    rain_prev6: mean(c.w.rain, idx - 6, idx - 1),
    soil_prev: val(c.w.soil, idx - 1),
    elev: c.w.elev,
    lat: c.lat,
    lon: c.lon,
    m_sin: monthSin(m),
    m_cos: monthCos(m),
  });
}

// ---------- 5. evaluation helpers ----------
const WEATHER_FEATURES = ['heat', 'dryness', 'fuel', 'wind'].flatMap((g) => GROUPS[g].features);
function evaluate(model, rows) {
  const ex = rows.map((r) => explain(model, r.x));
  const p = ex.map((e) => e.p);
  const lv = ex.map((e) => levelOf(e.p, WEATHER_FEATURES.reduce((s, f) => s + e.contrib[f], 0)).key);
  const y = rows.map((r) => r.y);
  const hist = rows.map((r) => r.x[0]); // history-only baseline
  const brier = p.reduce((s, v, i) => s + (v - y[i]) ** 2, 0) / p.length;
  const band = (keys) => {
    const sel = lv.map((k, i) => [k, y[i]]).filter(([k]) => keys.includes(k));
    return { n: sel.length, burned: sel.filter(([, l]) => l).length };
  };
  const red = band(['red']), high = band(['red', 'high']);
  const positives = y.filter(Boolean).length;
  const caught = lv.filter((k, i) => y[i] && (k === 'red' || k === 'high')).length;
  const low = band(['low']);
  return {
    samples: rows.length,
    fireRate: +(positives / rows.length).toFixed(4),
    auc: +auc(p, y).toFixed(3),
    aucHistoryOnly: +auc(hist.map((v) => (Number.isFinite(v) ? v : 0)), y).toFixed(3),
    brier: +brier.toFixed(4),
    redAlert: { flagged: red.n, burned: red.burned, precision: red.n ? +(red.burned / red.n).toFixed(3) : null },
    highOrAbove: { flagged: high.n, burned: high.burned, precision: high.n ? +(high.burned / high.n).toFixed(3) : null },
    recallHigh: positives ? +(caught / positives).toFixed(3) : null,
    lowAreasBurned: low.n ? +(low.burned / low.n).toFixed(3) : null,
  };
}

// ---------- main ----------
async function main() {
  const weather = await loadWeather();
  if (process.env.WEATHER_ONLY) return log('weather cached, stopping (WEATHER_ONLY)');
  let lastPower = 0;
  for (const w of weather.values()) for (let i = NM - 1; i >= 0; i--) if (w.tmax?.[i] !== null && w.tmax?.[i] !== undefined) { lastPower = Math.max(lastPower, i); break; }
  const cells = buildCells(weather);
  const lastLabel = loadLabels(cells);
  prepare(cells, lastPower);
  const curIdx = mi(Y1, new Date().getUTCMonth());
  const lastTrain = Math.min(lastPower, curIdx - 1);
  log(`${cells.size} land cells · POWER data to ${ymOf(lastPower)} · fire labels to ${ymOf(lastLabel)} · training to ${ymOf(lastTrain)}`);

  // rows (never-burned desert cells are down-sampled and up-weighted)
  const KEEP = 0.08;
  const train = [], test = [], all = [];
  for (const c of cells.values()) {
    for (let y = Y0 + 1; y <= Y1; y++)
      for (let m = 0; m < 12; m++) {
        const idx = mi(y, m);
        if (idx > lastTrain) break;
        let w = 1;
        if (!c.everBurned) {
          if (Math.random() > KEEP) continue;
          w = 1 / KEEP;
        }
        const row = { x: featuresFor(c, y, m, cells), y: c.fire[idx], w };
        all.push(row);
        (y >= TEST_FROM ? test : train).push(row);
      }
  }
  log(`rows: ${train.length} train (2013–${TEST_FROM - 1}), ${test.length} test (${TEST_FROM}–${ymOf(lastTrain)})`);

  const opts = { nTrees: 180, depth: 5, lr: 0.08, subsample: 0.6, log };
  log('Training validation model…');
  const valModel = trainGBM(train.map((r) => r.x), train.map((r) => r.y), train.map((r) => r.w), FEATURES, opts);
  const metrics = evaluate(valModel, test);
  log('Held-out test:', JSON.stringify(metrics));

  // Permutation importance: how much test AUC drops when one group of inputs is scrambled.
  const sample = test.filter(() => Math.random() < 0.4);
  const ys = sample.map((r) => r.y);
  const baseAuc = auc(sample.map((r) => predictProba(valModel, r.x)), ys);
  const permImportance = {};
  for (const [g, d] of Object.entries(GROUPS)) {
    const idxs = d.features.map((f) => FEATURES.indexOf(f));
    const order = sample.map((_, i) => i).sort(() => Math.random() - 0.5);
    const scores = sample.map((r, i) => {
      const x = Float64Array.from(r.x);
      for (const k of idxs) x[k] = sample[order[i]].x[k];
      return predictProba(valModel, x);
    });
    permImportance[g] = +Math.max(0, baseAuc - auc(scores, ys)).toFixed(4);
  }
  log('Permutation importance (AUC drop):', JSON.stringify(permImportance));

  log('Training final model on all years…');
  const model = trainGBM(all.map((r) => r.x), all.map((r) => r.y), all.map((r) => r.w), FEATURES, opts);
  const groupImportance = Object.fromEntries(Object.entries(GROUPS).map(([g, d]) => [g, +d.features.reduce((s, f) => s + (model.importance[f] ?? 0), 0).toFixed(3)]));

  fs.writeFileSync(path.join(OUT, 'model.json'), JSON.stringify({
    trainedAt: new Date().toISOString(),
    data: { region: REGION, cells: cells.size, from: `${Y0 + 1}-01`, to: ymOf(lastTrain), testFrom: `${TEST_FROM}-01`, rows: all.length, weather: 'NASA POWER monthly (MERRA-2)', labels: 'NASA FIRMS VIIRS S-NPP (harmonized archive)' },
    metrics,
    groupImportance,
    permImportance,
    model,
  }));

  // compact per-cell data for live prediction
  const serving = {
    Y0, lastPower, lastLabel,
    cells: [...cells.values()].map((c) => ({
      k: c.k, cy: c.cy, cx: c.cx, lat: c.lat, lon: c.lon, iso: c.iso, elev: c.w.elev,
      clim: Object.fromEntries(Object.entries(c.clim).map(([k, v]) => [k, v.map((x) => (x === null ? null : +x.toFixed(2)))])),
      recent: Object.fromEntries(Object.values(PARAMS).map((v) => [v, Array.from({ length: 7 }, (_, i) => { const x = val(c.w[v], lastPower - 6 + i); return Number.isFinite(x) ? +x.toFixed(2) : null; })])),
      fire: Array.from({ length: Y1 - Y0 + 1 }, (_, yi) => { let mask = 0; for (let m = 0; m < 12; m++) if (c.fire[yi * 12 + m]) mask |= 1 << m; return mask; }),
    })),
  };
  fs.writeFileSync(path.join(OUT, 'serving.json'), JSON.stringify(serving));
  log(`Saved ${path.relative(ROOT, OUT)}/model.json and serving.json (${serving.cells.length} cells)`);
}

function ymOf(idx) {
  return `${Y0 + Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
