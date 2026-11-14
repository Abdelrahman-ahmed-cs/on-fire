// MODIS ↔ VIIRS harmonisation and the burning-activity calendar.
//
// Method
//  1. Both sensors are reduced to the same unit: "fire cell-days" – the number
//     of (day, 0.1° grid cell) pairs with at least one vegetation hotspot, after
//     a common confidence filter and removal of static heat sources (gas flares,
//     industry, volcanoes). Counting cells instead of pixels removes most of the
//     1 km vs 375 m pixel-size effect.
//  2. During the overlap period (VIIRS S-NPP 2012 → today, MODIS still flying)
//     we regress monthly VIIRS on MODIS through the origin, per calendar month
//     where the data allow (seasonal fuel / fire-size differences), otherwise
//     for the whole country, otherwise for the whole region.
//  3. The harmonised record is VIIRS where it exists and MODIS × k before 2012,
//     i.e. everything is expressed in "VIIRS-equivalent fire cell-days".
import fs from 'node:fs';
import path from 'node:path';
import { COUNTRIES, countryByIso, REGIONS, regionOfIso, countriesIn } from './regions.js';

const DIR = path.resolve(import.meta.dirname, '../../data/archive');
const OVERLAP_START = '2012-02';
const MIN_SEASONAL = 40; // MODIS cell-days needed in a calendar month to fit its own ratio
const MIN_COUNTRY = 60;

let cache = { mtime: 0, data: null };

function loadAll() {
  let latest = 0;
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^[A-Z]{3}\.json$/.test(f)) : [];
  for (const f of files) latest = Math.max(latest, fs.statSync(path.join(DIR, f)).mtimeMs);
  if (cache.data && latest === cache.mtime) return cache.data;
  const raw = {};
  for (const f of files) raw[f.slice(0, 3)] = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  cache = { mtime: latest, data: { raw, results: {} } };
  // each region falls back on its own fit (MENA's stays as it was before North America was added)
  cache.data.regionFits = Object.fromEntries(Object.keys(REGIONS).map((r) => [r, fitRatio(Object.values(raw).filter((a) => regionOfIso(a.iso) === r))]));
  return cache.data;
}

export const archiveAvailable = () => Object.keys(loadAll().raw);

// ---------- ratio fitting ----------
function overlapPairs(archives, month = null) {
  const pairs = [];
  const lastV = lastMonth(archives, 'V');
  const lastM = lastMonth(archives, 'M');
  const end = lastV < lastM ? lastV : lastM;
  for (const a of archives) {
    const M = a.sensors.M?.monthly ?? {};
    const V = a.sensors.V?.monthly ?? {};
    for (const ym of monthsBetween(OVERLAP_START, end)) {
      if (month !== null && +ym.slice(5) - 1 !== month) continue;
      const m = M[ym]?.[1] ?? 0;
      const v = V[ym]?.[1] ?? 0;
      if (m === 0 && v === 0) continue;
      pairs.push({ ym, iso: a.iso, m, v });
    }
  }
  return pairs;
}

function regress(pairs) {
  let smv = 0, smm = 0, sm = 0, sv = 0;
  for (const p of pairs) {
    smv += p.m * p.v;
    smm += p.m * p.m;
    sm += p.m;
    sv += p.v;
  }
  if (!smm) return null;
  const k = smv / smm;
  // R² of the through-origin fit relative to the mean model
  const mean = sv / pairs.length;
  let ssRes = 0, ssTot = 0;
  for (const p of pairs) {
    ssRes += (p.v - k * p.m) ** 2;
    ssTot += (p.v - mean) ** 2;
  }
  return { k, r2: ssTot ? 1 - ssRes / ssTot : 0, n: pairs.length, sumM: sm, sumV: sv };
}

function fitRatio(archives) {
  const all = regress(overlapPairs(archives));
  const seasonal = Array.from({ length: 12 }, (_, m) => {
    const fit = regress(overlapPairs(archives, m));
    return fit && fit.sumM >= MIN_SEASONAL ? fit : null;
  });
  return { all, seasonal };
}

// ---------- per-country harmonisation ----------
export function harmonizeCountry(iso) {
  const store = loadAll();
  if (REGIONS[iso]) return harmonizeRegion(store, iso);
  const a = store.raw[iso];
  if (!a) return null;
  if (store.results[iso]) return store.results[iso];

  const own = fitRatio([a]);
  const region = store.regionFits[regionOfIso(iso)] ?? store.regionFits.MENA;
  const useCountry = own.all && own.all.sumM >= MIN_COUNTRY;
  const kByMonth = Array.from({ length: 12 }, (_, m) => {
    if (useCountry && own.seasonal[m]) return { k: own.seasonal[m].k, level: 'country-month' };
    if (useCountry) return { k: own.all.k, level: 'country' };
    if (region.seasonal[m]) return { k: region.seasonal[m].k, level: 'region-month' };
    return { k: region.all?.k ?? 1, level: 'region' };
  });

  const M = a.sensors.M?.monthly ?? {};
  const V = a.sensors.V?.monthly ?? {};
  const first = '2000-11';
  const last = [lastMonth([a], 'V'), lastMonth([a], 'M')].sort().pop();
  const lastV = lastMonth([a], 'V');
  const series = monthsBetween(first, last).map((ym) => {
    const m = M[ym] ?? [0, 0, 0];
    const vEra = ym >= OVERLAP_START && ym <= lastV;
    const v = V[ym];
    const k = kByMonth[+ym.slice(5) - 1].k;
    const hasV = vEra;
    return {
      ym,
      modis: m[1],
      viirs: vEra ? v?.[1] ?? 0 : null,
      modisCount: m[0],
      viirsCount: vEra ? v?.[0] ?? 0 : null,
      modisScaled: +(m[1] * k).toFixed(1),
      value: hasV ? v?.[1] ?? 0 : +(m[1] * k).toFixed(1),
      source: hasV ? 'VIIRS' : 'MODIS×k',
      frp: hasV ? v?.[2] ?? 0 : m[2],
    };
  });

  const overlap = overlapPairs([a]);
  const annualOverlap = {};
  for (const p of overlap) {
    const y = p.ym.slice(0, 4);
    const o = (annualOverlap[y] ??= { year: +y, modis: 0, viirs: 0, predicted: 0, months: 0 });
    o.modis += p.m;
    o.viirs += p.v;
    o.predicted += p.m * kByMonth[+p.ym.slice(5) - 1].k;
    o.months++;
  }
  const modelFit = validate(overlap, kByMonth, Object.values(annualOverlap));
  const result = {
    iso,
    name: countryByIso[iso]?.name ?? iso,
    method: {
      unit: 'VIIRS-equivalent fire cell-days (days × 0.1° cells with ≥1 vegetation hotspot)',
      fit: useCountry ? own.all : region.all,
      fitLevel: useCountry ? 'country' : 'region (too few country fires for a stable fit)',
      modelFit,
      kByMonth,
      overlapStart: OVERLAP_START,
    },
    scatter: overlap.map((p) => ({ ym: p.ym, modis: p.m, viirs: p.v })),
    annualOverlap: Object.values(annualOverlap).map((o) => ({ ...o, ratio: o.modis ? +(o.viirs / o.modis).toFixed(2) : null })),
    series,
    calendar: buildCalendar(series, a),
    updated: a.updated,
  };
  store.results[iso] = result;
  return result;
}

function harmonizeRegion(store, rid = 'MENA') {
  if (store.results[rid]) return store.results[rid];
  const parts = countriesIn(rid).map((c) => harmonizeCountry(c.iso)).filter(Boolean);
  if (!parts.length) return null;
  const byYm = new Map();
  for (const p of parts)
    for (const s of p.series) {
      const t = byYm.get(s.ym) ?? { ym: s.ym, modis: 0, viirs: 0, modisCount: 0, viirsCount: 0, modisScaled: 0, value: 0, frp: 0, source: s.source };
      t.modis += s.modis;
      t.viirs = s.viirs === null ? null : (t.viirs ?? 0) + s.viirs;
      t.modisCount += s.modisCount;
      t.viirsCount = s.viirsCount === null ? null : (t.viirsCount ?? 0) + s.viirsCount;
      t.modisScaled += s.modisScaled;
      t.value += s.value;
      t.frp += s.frp;
      byYm.set(s.ym, t);
    }
  const series = [...byYm.values()].sort((a, b) => a.ym.localeCompare(b.ym)).map((s) => ({ ...s, value: +s.value.toFixed(1), modisScaled: +s.modisScaled.toFixed(1) }));
  const raws = Object.values(store.raw).filter((a) => regionOfIso(a.iso) === rid);
  const lastV = lastMonth(raws, 'V');
  const scatter = overlapPairs(raws);
  const merged = {};
  for (const p of scatter) {
    const t = (merged[p.ym] ??= { ym: p.ym, modis: 0, viirs: 0 });
    t.modis += p.m;
    t.viirs += p.v;
  }
  const annual = {};
  for (const p of Object.values(merged)) {
    const o = (annual[p.ym.slice(0, 4)] ??= { year: +p.ym.slice(0, 4), modis: 0, viirs: 0 });
    o.modis += p.modis;
    o.viirs += p.viirs;
  }
  const result = {
    iso: rid,
    name: REGIONS[rid].name,
    method: {
      unit: 'VIIRS-equivalent fire cell-days (days × 0.1° cells with ≥1 vegetation hotspot)',
      fit: regress(Object.values(merged).map((p) => ({ m: p.modis, v: p.viirs }))),
      fitLevel: 'sum of per-country harmonised records',
      modelFit: validate(
        series.filter((s) => s.viirs !== null && s.ym <= lastV && (s.viirs > 0 || s.modis > 0)).map((s) => ({ ym: s.ym, m: s.modisScaled, v: s.viirs })),
        Array.from({ length: 12 }, () => ({ k: 1 })),
        Object.values(series.filter((s) => s.viirs !== null && s.ym <= lastV).reduce((acc, s) => {
          const y = (acc[s.ym.slice(0, 4)] ??= { predicted: 0, viirs: 0, months: 0 });
          y.predicted += s.modisScaled;
          y.viirs += s.viirs;
          y.months++;
          return acc;
        }, {})),
      ),
      kByMonth: store.regionFits[rid].seasonal.map((f) => ({ k: f?.k ?? store.regionFits[rid].all?.k, level: f ? 'region-month' : 'region' })),
      overlapStart: OVERLAP_START,
    },
    scatter: Object.values(merged),
    annualOverlap: Object.values(annual).map((o) => ({ ...o, ratio: o.modis ? +(o.viirs / o.modis).toFixed(2) : null })),
    series,
    calendar: buildCalendar(series, null, raws),
  };
  store.results[rid] = result;
  return result;
}

// How well does the seasonal model (MODIS × k_month) reproduce observed VIIRS?
// Monthly R² plus the mean absolute error of annual totals over complete overlap years.
function validate(pairs, kByMonth, annual) {
  if (!pairs.length) return null;
  const mean = pairs.reduce((s, p) => s + p.v, 0) / pairs.length;
  let ssRes = 0, ssTot = 0;
  for (const p of pairs) {
    ssRes += (p.v - kByMonth[+p.ym.slice(5) - 1].k * p.m) ** 2;
    ssTot += (p.v - mean) ** 2;
  }
  const full = annual.filter((y) => y.months === 12 && y.viirs > 0);
  const annualErrorPct = full.length ? (full.reduce((s, y) => s + Math.abs(y.predicted - y.viirs) / y.viirs, 0) / full.length) * 100 : null;
  return { r2: ssTot ? +(1 - ssRes / ssTot).toFixed(3) : null, annualErrorPct: annualErrorPct === null ? null : +annualErrorPct.toFixed(1), years: full.length };
}

// ---------- calendar, climatology, anomalies, critical periods ----------
export function buildCalendar(series, archive, archivesForWeekly) {
  const now = new Date();
  const curYm = now.toISOString().slice(0, 7);
  const years = [...new Set(series.map((s) => +s.ym.slice(0, 4)))].sort();
  const grid = {};
  const src = Object.fromEntries(series.map((s) => [s.ym, s.source]));
  for (const s of series) (grid[s.ym.slice(0, 4)] ??= new Array(12).fill(null))[+s.ym.slice(5) - 1] = s.value;

  // Baseline = complete years only (2001 … last full year)
  const fullYears = years.filter((y) => y >= 2001 && grid[y] && grid[y].every((v) => v !== null) && `${y}-12` < curYm);
  const clim = Array.from({ length: 12 }, (_, m) => {
    const vals = fullYears.map((y) => grid[y][m]);
    const mean = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1));
    const sorted = [...vals].sort((a, b) => a - b);
    return { month: m, mean, sd, median: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted[sorted.length - 1] ?? 0 };
  });
  const annualMean = clim.reduce((a, c) => a + c.mean, 0);

  const cells = [];
  for (const y of years)
    for (let m = 0; m < 12; m++) {
      const v = grid[y]?.[m];
      if (v === null || v === undefined) continue;
      const c = clim[m];
      cells.push({ year: y, month: m, value: v, source: src[`${y}-${String(m + 1).padStart(2, '0')}`], z: c.sd > 0 ? +((v - c.mean) / c.sd).toFixed(2) : 0, ratio: c.mean > 0 ? +(v / c.mean).toFixed(2) : null });
    }

  // Critical period: months whose normal activity is ≥1.5× the average month,
  // plus the smallest set of months holding ≥75 % of the yearly total ("fire season").
  const shares = clim.map((c) => (annualMean ? c.mean / annualMean : 0));
  const critical = shares.map((s, m) => ({ m, s })).filter((x) => x.s >= 1.5 / 12).map((x) => x.m);
  const ranked = shares.map((s, m) => ({ m, s })).sort((a, b) => b.s - a.s);
  const season = [];
  let acc = 0;
  for (const r of ranked) {
    if (acc >= 0.75) break;
    season.push(r.m);
    acc += r.s;
  }
  season.sort((a, b) => a - b);

  const annual = years.map((y) => ({ year: y, total: +(grid[y] ?? []).reduce((a, v) => a + (v ?? 0), 0).toFixed(1), complete: fullYears.includes(y) }));
  const trend = linearTrend(annual.filter((a) => a.complete));

  // Weekly climatology from daily VIIRS counts (2012+), for a finer calendar.
  const weekly = weeklyClimatology(archive ? [archive] : archivesForWeekly ?? []);

  // Current year so far vs normal
  const thisYear = now.getUTCFullYear();
  const curMonth = now.getUTCMonth();
  const ytdMonths = Array.from({ length: curMonth + 1 }, (_, m) => m).filter((m) => grid[thisYear]?.[m] !== null && grid[thisYear]?.[m] !== undefined);
  const ytd = ytdMonths.reduce((a, m) => a + grid[thisYear][m], 0);
  // the current month is incomplete (data through yesterday): compare with the same fraction of a normal month
  const daysIn = new Date(Date.UTC(thisYear, curMonth + 1, 0)).getUTCDate();
  const curFrac = Math.max(0, now.getUTCDate() - 1) / daysIn;
  const ytdNormal = ytdMonths.reduce((a, m) => a + clim[m].mean * (m === curMonth ? curFrac : 1), 0);

  return {
    years,
    baselineYears: fullYears.length ? [fullYears[0], fullYears[fullYears.length - 1]] : null,
    cells,
    climatology: clim.map((c, m) => ({ ...c, share: +(shares[m] * 100).toFixed(1) })),
    criticalMonths: critical,
    fireSeason: season,
    peakMonth: ranked[0]?.m ?? null,
    annual,
    trend,
    weekly,
    ytd: { year: thisYear, months: ytdMonths.length, value: +ytd.toFixed(1), normal: +ytdNormal.toFixed(1), ratio: ytdNormal ? +(ytd / ytdNormal).toFixed(2) : null },
  };
}

function linearTrend(points) {
  const n = points.length;
  if (n < 5) return null;
  const mx = points.reduce((a, p) => a + p.year, 0) / n;
  const my = points.reduce((a, p) => a + p.total, 0) / n;
  let sxy = 0, sxx = 0;
  for (const p of points) {
    sxy += (p.year - mx) * (p.total - my);
    sxx += (p.year - mx) ** 2;
  }
  const slope = sxy / sxx;
  return { slopePerYear: +slope.toFixed(2), pctPerYear: my ? +((slope / my) * 100).toFixed(2) : 0, years: [points[0].year, points[n - 1].year] };
}

function weeklyClimatology(archives) {
  const weeks = new Array(53).fill(0);
  const years = new Set();
  for (const a of archives) {
    for (const [y, days] of Object.entries(a.sensors.V?.daily ?? {})) {
      if (+y < 2013 || +y >= new Date().getUTCFullYear()) continue;
      years.add(y);
      days.forEach((v, d) => (weeks[Math.min(52, Math.floor(d / 7))] += v));
    }
  }
  const n = years.size || 1;
  return { years: years.size, meanDetections: weeks.map((w) => +(w / n).toFixed(1)) };
}

// ---------- climatology grid (historical fire frequency per 0.25° cell) ----------
export function climatologyGrid(iso, month) {
  const a = loadAll().raw[iso];
  if (!a?.clim) return null;
  const years = a.clim.years || 1;
  const cells = [];
  for (const [key, arr] of Object.entries(a.clim.cells)) {
    const [y, x] = key.split('_').map(Number);
    const v = arr[month];
    if (v > 0) cells.push({ lat: (y + 0.5) / 4, lon: (x + 0.5) / 4, p: v / years, years: v });
  }
  return { years, month, cells };
}

// Region-wide version: all of a region's countries' cells for one month.
export function climatologyGridAll(month, region = 'MENA') {
  const cells = [];
  let years = 0;
  for (const iso of Object.keys(loadAll().raw).filter((i) => regionOfIso(i) === region)) {
    const g = climatologyGrid(iso, month);
    if (!g) continue;
    years = Math.max(years, g.years);
    cells.push(...g.cells);
  }
  return { years, month, cells };
}

export function climProbabilityAt(iso, lat, lon, month) {
  const a = loadAll().raw[iso];
  if (!a?.clim) return null;
  const arr = a.clim.cells[`${Math.floor(lat * 4)}_${Math.floor(lon * 4)}`];
  return { p: arr ? arr[month] / (a.clim.years || 1) : 0, years: a.clim.years, byMonth: arr ? arr.map((v) => v / (a.clim.years || 1)) : new Array(12).fill(0) };
}

// ---------- utils ----------
function lastMonth(archives, s) {
  let last = '0000-00';
  for (const a of archives) for (const ym of Object.keys(a.sensors[s]?.monthly ?? {})) if (ym > last) last = ym;
  return last;
}
function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  while (y < by || (y === by && m <= bm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
