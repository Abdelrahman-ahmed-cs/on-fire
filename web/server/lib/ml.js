// Live AI fire-danger prediction: loads the trained model and predicts, for every
// 0.5° cell (~50 km), the chance that fire will be detected there this month or next month.
import fs from 'node:fs';
import path from 'node:path';
import { explain } from './gbm.js';
import { FEATURES, GROUPS, vector, monthSin, monthCos } from './riskFeatures.js';
import { countryByIso, REGIONS, regionOfIso } from './regions.js';
import { townsNear } from './geo.js';

// One model per region: MENA in data/ml/, other regions in data/ml/<REGION>/.
const ML_DIR = path.resolve(import.meta.dirname, '../../data/ml');
const dirOf = (r) => (r === 'MENA' ? ML_DIR : path.join(ML_DIR, r));
const fcCacheOf = (r) => path.resolve(import.meta.dirname, `../../data/cache/ml-forecast${r === 'MENA' ? '' : `-${r}`}.json`);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// RED ALERT = fire is very likely AND this month's weather makes it worse than usual
// (heatwave, drought, dry fuel or wind push the chance up). Places that burn every
// season anyway (e.g. routine crop burning) stay "High" unless the weather adds danger.
export const LEVELS = [
  { min: 0.75, key: 'red', label: 'Red alert', color: '#ff1a1a' },
  { min: 0.5, key: 'high', label: 'High', color: '#ff7a00' },
  { min: 0.2, key: 'moderate', label: 'Moderate', color: '#ffc233' },
  { min: 0, key: 'low', label: 'Low', color: '#8ac926' },
];
const WEATHER_GROUPS = ['heat', 'dryness', 'fuel', 'wind'];
export const WEATHER_BOOST = 0.4; // log-odds pushed up by weather needed for a red alert
export function levelOf(p, weatherBoost = 0) {
  if (p >= LEVELS[0].min && weatherBoost >= WEATHER_BOOST) return LEVELS[0];
  return LEVELS.slice(1).find((l) => p >= l.min);
}
function weatherBoostOf(contrib) {
  let s = 0;
  for (const g of WEATHER_GROUPS) for (const f of GROUPS[g].features) s += contrib[f] ?? 0;
  return s;
}

// Emergency numbers we are confident about (fire / civil protection). Others: local emergency number.
const EMERGENCY = { USA: '911', CAN: '911', MEX: '911', DZA: '14', MAR: '15', TUN: '198', EGY: '180', TUR: '112', SAU: '998', ARE: '997', JOR: '911', LBN: '125', IRN: '125', SYR: '113', ISR: '102', KWT: '112', QAT: '999', BHR: '999', OMN: '9999', CYP: '112', IRQ: '115' };

const stores = {};
function load(region = 'MENA') {
  const mf = path.join(dirOf(region), 'model.json');
  const sf = path.join(dirOf(region), 'serving.json');
  if (!fs.existsSync(mf) || !fs.existsSync(sf)) return null;
  const mtime = fs.statSync(mf).mtimeMs;
  const store = stores[region];
  if (store && store.mtime === mtime) return store;
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
  const cells = new Map(s.cells.map((c) => [c.k, c]));
  return (stores[region] = { mtime, meta: m, model: m.model, serving: s, cells, cache: new Map(), region });
}

export const mlAvailable = (region = 'MENA') => !!load(region);

// ---------- weather for the target month ----------
function anomaly(c, v, s) {
  const lastM = s.lastPower % 12;
  const last = c.recent[v]?.[6];
  const clim = c.clim[v]?.[lastM];
  return last !== null && last !== undefined && clim !== null && clim !== undefined ? last - clim : 0;
}
// monthly value for index idx: actual NASA POWER if available, else normal ± current anomaly
function monthVal(c, v, idx, s, persist = 0.5) {
  const off = idx - (s.lastPower - 6);
  if (off >= 0 && off < 7 && c.recent[v]?.[off] !== null && c.recent[v]?.[off] !== undefined) return c.recent[v][off];
  const base = c.clim[v]?.[((idx % 12) + 12) % 12];
  if (base === null || base === undefined) return NaN;
  return base + persist * anomaly(c, v, s);
}

// Open-Meteo 16-day forecast on a 1° grid for fire-prone cells (cached 12 h on disk).
// Open-Meteo counts every location, with a per-minute limit, so the grid is refreshed
// slowly in the background (every 12 h) and predictions use the latest cached copy.
let fcRefreshing = false;
const REFRESH_H = { MENA: 12, NAM: 24 };
function readForecastCache(maxAgeH = 36, region = 'MENA') {
  try {
    const cached = JSON.parse(fs.readFileSync(fcCacheOf(region), 'utf8'));
    if (Date.now() - cached.t < maxAgeH * 3600 * 1000) return cached;
  } catch {
    /* no cache */
  }
  return null;
}
export function startForecastRefresher() {
  // regions one after the other, so Open-Meteo's per-minute limit is respected
  const tick = async () => {
    if (fcRefreshing) return;
    fcRefreshing = true;
    try {
      for (const region of Object.keys(REGIONS)) {
        const st = load(region);
        // North America needs ~2,500 locations per refresh, so it refreshes once a day (Open-Meteo: 10,000 a day)
        if (!st || readForecastCache(REFRESH_H[region] ?? 12, region)) continue;
        try {
          await forecastGrid(st.serving.cells.filter((c) => c.fire.some(Boolean)), region);
          st.cache.clear(); // re-score with the fresh forecast
          console.log(`AI: weather forecast grid refreshed (${region})`);
        } catch (e) {
          console.error(`AI forecast refresh failed (${region}):`, e.message);
        }
      }
    } finally {
      fcRefreshing = false;
    }
  };
  setTimeout(tick, 5000);
  setInterval(tick, 30 * 60 * 1000);
}

async function forecastGrid(cellsList, region = 'MENA') {
  const keys = [...new Set(cellsList.map((c) => `${Math.floor(c.lat)}_${Math.floor(c.lon)}`))];
  const grid = {};
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100).map((k) => k.split('_').map(Number));
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${batch.map(([a]) => a + 0.5).join(',')}&longitude=${batch.map(([, b]) => b + 0.5).join(',')}&daily=temperature_2m_max,precipitation_sum,relative_humidity_2m_mean,wind_speed_10m_mean&forecast_days=14&timezone=UTC`;
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(url);
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 65000)); // minute limit: wait and retry
    }
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    await new Promise((r) => setTimeout(r, 15000)); // stay under ~400 locations per minute
    const j = await res.json();
    (Array.isArray(j) ? j : [j]).forEach((r, k) => {
      const d = r.daily;
      const avg = (a) => a.filter((x) => x !== null).reduce((s, x) => s + x, 0) / Math.max(1, a.filter((x) => x !== null).length);
      grid[`${batch[k][0]}_${batch[k][1]}`] = { tmax: avg(d.temperature_2m_max), rain: avg(d.precipitation_sum), rh: avg(d.relative_humidity_2m_mean), wind: avg(d.wind_speed_10m_mean) / 3.6 };
    });
  }
  fs.writeFileSync(fcCacheOf(region), JSON.stringify({ t: Date.now(), grid }));
  return grid;
}

// ---------- features for live prediction ----------
function fireBit(c, s, y, m, liveBits) {
  if (m < 0) { y -= 1; m += 12; }
  const yi = y - s.Y0;
  if (liveBits?.has(`${c.k}|${y}|${m}`)) return 1;
  return yi >= 0 && yi < c.fire.length ? (c.fire[yi] >> m) & 1 : 0;
}
function histFreq(c, s, y, m) {
  const yrs = y - s.Y0;
  let n = 0;
  for (let yi = 0; yi < yrs && yi < c.fire.length; yi++) n += (c.fire[yi] >> m) & 1;
  return { freq: yrs > 0 ? n / yrs : NaN, n, yrs };
}

function features(c, y, m, s, cells, fc, liveBits) {
  const idx = (y - s.Y0) * 12 + m;
  const h = histFreq(c, s, y, m);
  let any = 0;
  for (let yi = 0; yi < y - s.Y0 && yi < c.fire.length; yi++) if (c.fire[yi]) any++;
  let ns = 0, nn = 0;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dy && !dx) continue;
      const nb = cells.get(`${c.cy + dy}_${c.cx + dx}`);
      if (nb) { ns += histFreq(nb, s, y, m).freq; nn++; }
    }
  let tmax = monthVal(c, 'tmax', idx, s), rain = monthVal(c, 'rain', idx, s, 0), rh = monthVal(c, 'rh', idx, s), wind = monthVal(c, 'wind', idx, s, 0);
  const f = fc?.[`${Math.floor(c.lat)}_${Math.floor(c.lon)}`];
  if (f) ({ tmax, rain, rh, wind } = f);
  const soil = Math.min(1, Math.max(0, monthVal(c, 'soil', idx, s, 0.7)));
  const mean = (from, to) => {
    let t = 0, n = 0;
    for (let i = from; i <= to; i++) {
      const v = monthVal(c, 'rain', i, s, 0);
      if (Number.isFinite(v)) { t += v; n++; }
    }
    return n ? t / n : NaN;
  };
  const raw = {
    hist_freq: h.freq,
    hist_any: y - s.Y0 > 0 ? any / (y - s.Y0) : NaN,
    neigh_freq: nn ? ns / nn : NaN,
    last_year: fireBit(c, s, y - 1, m, liveBits),
    prev_month: fireBit(c, s, y, m - 1, liveBits),
    tmax,
    tmax_anom: tmax - c.clim.tmax[m],
    rain, rh, wind,
    soil_wet: soil,
    rain_prev3: mean(idx - 3, idx - 1),
    rain_prev6: mean(idx - 6, idx - 1),
    soil_prev: Math.min(1, Math.max(0, monthVal(c, 'soil', idx - 1, s, 0.7))),
    elev: c.elev, lat: c.lat, lon: c.lon, m_sin: monthSin(m), m_cos: monthCos(m),
  };
  return { x: vector(raw), raw, hist: h };
}

// ---------- plain-language reasons & advice ----------
function reasonsFor(contrib, raw, hist, m) {
  const g = Object.fromEntries(Object.entries(GROUPS).map(([k, d]) => [k, d.features.reduce((s, f) => s + (contrib[f] ?? 0), 0)]));
  const txt = {
    history: `Burned in ${hist.n} of the last ${hist.yrs} ${MONTHS[m]}s${raw.prev_month ? ', and fire was already seen here last month' : ''}`,
    heat: raw.tmax_anom > 1.5 ? `Heatwave: ${raw.tmax.toFixed(0)} °C daily highs, ${raw.tmax_anom.toFixed(1)} °C above normal` : `Hot: ${raw.tmax.toFixed(0)} °C average daily high`,
    dryness: [raw.rain_prev3 < 0.3 ? 'almost no rain for 3 months' : raw.rain_prev3 < 1 ? 'little rain lately' : null, raw.soil_wet < 0.3 ? 'very dry soil' : null, raw.rh < 35 ? `dry air (${raw.rh.toFixed(0)} % humidity)` : null].filter(Boolean).join(', ') || 'Dry conditions',
    fuel: `Rain in the past 6 months (${raw.rain_prev6.toFixed(1)} mm/day) grew grass that is now dry fuel`,
    wind: `Windy: ${(raw.wind * 3.6).toFixed(0)} km/h average`,
    place: `${MONTHS[m]} is fire season for this type of landscape`,
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const up = Object.entries(g).filter(([, v]) => v > 0.1).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => ({ key: k, label: GROUPS[k].label, text: cap(txt[k]), weight: +v.toFixed(2) }));
  const down = Object.entries(g).filter(([, v]) => v < -0.3).sort((a, b) => a[1] - b[1]).slice(0, 2).map(([k, v]) => ({ key: k, label: GROUPS[k].label, weight: +v.toFixed(2) }));
  return { reasons: up, lowering: down, groups: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, +v.toFixed(3)])) };
}

export function adviceFor({ level, reasons, iso, popNearby, m }) {
  const keys = new Set(reasons.map((r) => r.key));
  const out = [];
  const urgent = level.key === 'red' || level.key === 'high';
  if (urgent) {
    out.push({ who: 'Authorities', icon: '📢', title: 'Warn early', text: `Send an early warning to local councils, farmers and residents (SMS, radio, ${regionOfIso(iso) === 'MENA' ? 'mosques/community channels' : 'emergency alert apps and community channels'}). Put civil protection and forest services on standby.` });
    out.push({ who: 'Authorities', icon: '🚒', title: 'Pre-position crews', text: 'Station fire crews and water tankers near the highest-risk areas, check water points, and run lookout or drone patrols during the hottest hours (12:00–18:00).' });
  }
  if (keys.has('history') || keys.has('place'))
    out.push({ who: 'Farmers', icon: '🌾', title: 'Stop seasonal burning', text: `Many fires here in ${MONTHS[m]} are started on purpose (crop stubble, pasture, rubbish). Avoid burning this month: plough, mulch or bale the residues instead. If burning is unavoidable, get a permit, burn small patches early in the morning with no wind, and keep water ready.` });
  if (keys.has('dryness') || keys.has('heat'))
    out.push({ who: 'Everyone', icon: '🪓', title: 'Cut firebreaks, clear dry grass', text: 'Clear 10–20 m firebreaks around villages, fields and forest edges. Remove dry grass along roads and under power lines. Avoid machinery that makes sparks (welding, grinders, harvesters without spark guards) in dry fields during the heat of the day.' });
  if (keys.has('fuel'))
    out.push({ who: 'Land managers', icon: '🐐', title: 'Reduce the fuel', text: 'The rainy months grew a lot of grass that is now drying. Graze, mow or cut it, especially next to houses, roads and forests.' });
  if (keys.has('wind'))
    out.push({ who: 'Everyone', icon: '💨', title: 'No open fire in the wind', text: 'Strong wind makes small fires spread fast. Ban barbecues, fireworks, sky lanterns and rubbish burning on windy days.' });
  if (popNearby > 5000)
    out.push({ who: 'Residents', icon: '🏠', title: 'Protect homes', text: 'Keep 30 m around houses free of dry grass and wood piles, keep hoses and buckets ready, and know two ways out of your area. People with asthma should have masks (N95/FFP2) ready in case of smoke.' });
  out.push({ who: 'Everyone', icon: '☎️', title: 'If you see smoke or fire', text: `Do not try to fight a large fire. Move away upwind and to the sides, never uphill in front of it. Call ${EMERGENCY[iso] ? `${EMERGENCY[iso]} (fire / civil protection)` : 'your local emergency number'} and give the exact location.` });
  return out;
}

// ---------- prediction ----------
export async function predict({ when = 'current', liveFires = [], region = 'MENA' } = {}) {
  const st = load(region);
  if (!st) return null;
  const now = new Date();
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  if (when === 'next') { m += 1; if (m > 11) { m = 0; y += 1; } }
  const key = `${y}-${m}`;
  const hit = st.cache.get(key);
  if (hit && Date.now() - hit.t < 3 * 3600 * 1000) return hit.v;

  const s = st.serving;
  // fires detected since the model was trained (so "fire last month" is up to date)
  const liveBits = new Set();
  for (const f of liveFires) liveBits.add(`${Math.floor(f.lat * 2)}_${Math.floor(f.lon * 2)}|${+f.date.slice(0, 4)}|${+f.date.slice(5, 7) - 1}`);

  let fc = null;
  let weatherSource = 'NASA POWER normals + current anomaly (persistence)';
  if (when === 'current') {
    const cached = readForecastCache(36, region);
    if (cached) {
      fc = cached.grid;
      weatherSource = `14-day Open-Meteo forecast (updated ${new Date(cached.t).toISOString().slice(0, 16).replace('T', ' ')} UTC) + NASA POWER`;
    }
  }

  const cells = [];
  for (const c of s.cells) {
    const { x, raw, hist } = features(c, y, m, s, st.cells, c.fire.some(Boolean) ? fc : null, liveBits);
    const ex = explain(st.model, x);
    const wb = weatherBoostOf(ex.contrib);
    cells.push({ c, p: ex.p, x, raw, hist, contrib: ex.contrib, wb, level: levelOf(ex.p, wb) });
  }
  const summary = {};
  for (const { c, p, level: l } of cells) {
    const t = (summary[c.iso] ??= { iso: c.iso, name: countryByIso[c.iso]?.name, red: 0, high: 0, moderate: 0, cells: 0, maxP: 0, sumP: 0 });
    t.cells++;
    t.sumP += p;
    t.maxP = Math.max(t.maxP, p);
    if (l.key === 'red') t.red++;
    else if (l.key === 'high') t.high++;
    else if (l.key === 'moderate') t.moderate++;
  }
  // Alert markers: highest-risk cells, at least ~80 km apart so the map stays readable
  const rank = { red: 3, high: 2, moderate: 1, low: 0 };
  const sorted = cells.filter((q) => q.level.key === 'red' || q.level.key === 'high').sort((a, b) => rank[b.level.key] - rank[a.level.key] || b.p - a.p);
  const alerts = [];
  for (const q of sorted) {
    if (alerts.length >= 60) break;
    if (alerts.some((a) => Math.abs(a.lat - q.c.lat) < 0.75 && Math.abs(a.lon - q.c.lon) < 0.75)) continue;
    const why = reasonsFor(q.contrib, q.raw, q.hist, m);
    const town = townsNear(q.c.lat, q.c.lon, 45, 5000)[0] ?? townsNear(q.c.lat, q.c.lon, 60)[0];
    alerts.push({
      lat: q.c.lat, lon: q.c.lon, p: +q.p.toFixed(3), level: q.level, weatherBoost: +q.wb.toFixed(2), iso: q.c.iso, country: countryByIso[q.c.iso]?.name,
      place: town ? town.name : null,
      reasons: why.reasons,
    });
  }
  const v = {
    target: { year: y, month: m, monthName: MONTHS[m], when },
    region,
    weatherSource,
    model: { trainedAt: st.meta.trainedAt, metrics: st.meta.metrics, groupImportance: st.meta.permImportance ?? st.meta.groupImportance, importanceKind: st.meta.permImportance ? 'permutation' : 'gain', data: st.meta.data, groups: Object.fromEntries(Object.entries(GROUPS).map(([k, d]) => [k, d.label])) },
    levels: LEVELS,
    cells: cells.filter((q) => q.p >= 0.03).map((q) => [q.c.lat, q.c.lon, +q.p.toFixed(3), q.c.iso, q.level.key === 'red' ? 1 : 0]),
    alerts,
    countries: Object.values(summary).map((t) => ({ ...t, meanP: +(t.sumP / t.cells).toFixed(3), maxP: +t.maxP.toFixed(3), sumP: undefined })).sort((a, b) => b.red - a.red || b.high - a.high || b.maxP - a.maxP),
    generated: new Date().toISOString(),
  };
  st.cache.set(key, { t: Date.now(), v, cells });
  return v;
}

// Full explanation + advice for the cell nearest to a point.
export async function explainCell({ lat, lon, when = 'current', liveFires = [], region = 'MENA' }) {
  const st = load(region);
  if (!st) return null;
  await predict({ when, liveFires, region });
  const now = new Date();
  let m = now.getUTCMonth();
  if (when === 'next') m = (m + 1) % 12;
  const hit = [...st.cache.values()].find((e) => e.v.target.when === when && e.v.target.month === m);
  if (!hit) return null;
  let best = null, bd = Infinity;
  for (const q of hit.cells) {
    const d = (q.c.lat - lat) ** 2 + (q.c.lon - lon) ** 2;
    if (d < bd) { bd = d; best = q; }
  }
  if (!best || bd > 1) return { error: `No prediction for this location (outside ${REGIONS[region].name} land)` };
  const why = reasonsFor(best.contrib, best.raw, best.hist, m);
  const level = best.level;
  const towns = townsNear(best.c.lat, best.c.lon, 30);
  const popNearby = towns.reduce((s, t) => s + (t.pop || 0), 0);
  return {
    lat: best.c.lat, lon: best.c.lon, iso: best.c.iso, country: countryByIso[best.c.iso]?.name,
    place: towns.find((t) => t.pop >= 5000)?.name ?? towns[0]?.name ?? null,
    p: +best.p.toFixed(3), level, weatherBoost: +best.wb.toFixed(2), target: hit.v.target,
    reasons: why.reasons, lowering: why.lowering, groups: why.groups,
    conditions: {
      tmax: +best.raw.tmax.toFixed(1), tmaxAnom: +best.raw.tmax_anom.toFixed(1), rainMmDay: +best.raw.rain.toFixed(2), rain3m: +best.raw.rain_prev3.toFixed(2),
      rh: +best.raw.rh.toFixed(0), windKmh: +(best.raw.wind * 3.6).toFixed(0), soilWet: +best.raw.soil_wet.toFixed(2), histYears: best.hist.n, histOf: best.hist.yrs,
    },
    popNearby,
    townsNearby: towns.slice(0, 5).map((t) => ({ name: t.name, pop: t.pop, distanceKm: t.distanceKm })),
    advice: adviceFor({ level, reasons: why.reasons, iso: best.c.iso, popNearby, m }),
  };
}
