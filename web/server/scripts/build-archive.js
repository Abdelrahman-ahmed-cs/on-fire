// Builds the long-term MODIS + VIIRS hotspot record for every country (MENA + North America).
//
//  Phase 1  FIRMS yearly country archives (no key needed)
//           MODIS C6.1 2000-2024, VIIRS S-NPP 2012-2024
//  Phase 2  FIRMS area API for the years not yet in the country archive
//           (standard-processing "SP" data, then near-real-time "NRT")
//
// Raw hotspots are reduced on the fly to monthly / daily aggregates, a 0.25°
// climatology grid and a static-heat-source mask (gas flares etc.), so the
// multi-GB raw record never has to be stored. Every unit of work is cached in
// data/cache/archive so the script can be stopped and resumed.
//
//   npm run setup:archive                 all countries
//   npm run setup:archive -- DZA TUN      selected countries (phase 1 only)
//   npm run setup:archive -- --region NAM all North American countries + their recent years
//   npm run setup:archive -- --combine    rebuild outputs from the cache only
//
// Yearly country files already on disk (FIRMS_LOCAL, default C:/Users/User/onfire-data/firms,
// same names as on the FIRMS server) are read instead of downloaded.
import fs from 'node:fs';
import path from 'node:path';
import { COUNTRIES, REGIONS, ISO_SET, countriesIn, regionOfIso } from '../lib/regions.js';
import {
  FIRMS_BASE, parseFirmsCsv, passesConfidence, isStaticType, isStaticLocation,
  staticKey, cell01, cell025, dayOfYear, fetchText,
} from '../lib/firms.js';
import { countryAt } from '../lib/geo.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CACHE = path.join(ROOT, 'data/cache/archive');
const OUT = path.join(ROOT, 'data/archive');
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const KEY = process.env.FIRMS_MAP_KEY || readEnvKey();
function readEnvKey() {
  try {
    return fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/FIRMS_MAP_KEY=(\S+)/)?.[1];
  } catch {
    return undefined;
  }
}

const ARCHIVE_LAST_YEAR = 2024;
// North America: the 2025 yearly files are on disk already, so the area API is only needed from 2026.
const LAST_YEAR_BY_REGION = { MENA: ARCHIVE_LAST_YEAR, NAM: 2025 };
const API_PREFIX = { MENA: 'api_', NAM: 'apiNAM_' };
// If a near-real-time feed stops delivering (e.g. S-NPP returned 0 rows for North America from
// 2026-11-04), that sensor's record is cut at the start of that month, so the month is filled
// with MODIS × k by the harmonization instead of looking like a sudden drop.
const cutoffFile = (region) => path.join(ROOT, `data/cache/archive-cutoff-${region}.json`);
const readCutoff = (region) => { try { return JSON.parse(fs.readFileSync(cutoffFile(region), 'utf8')); } catch { return {}; } };
const LOCAL = process.env.FIRMS_LOCAL || 'C:/Users/User/onfire-data/firms';
function readLocal(dir, file) {
  const f = path.join(LOCAL, dir, file);
  try {
    return fs.statSync(f).size > 0 ? fs.readFileSync(f, 'utf8') : null;
  } catch {
    return null;
  }
}
const SENSORS = {
  M: { dir: 'modis', first: 2000, sp: 'MODIS_SP', nrt: 'MODIS_NRT' },
  V: { dir: 'viirs-snpp', first: 2012, sp: 'VIIRS_SNPP_SP', nrt: 'VIIRS_SNPP_NRT' },
};

// ---------- aggregation ----------
function newAgg() {
  return { monthly: {}, daily: {}, cellDays: new Set(), clim: new Set(), static: new Set(), rows: 0, kept: 0 };
}

function ingest(agg, f, sensor, staticMask) {
  agg.rows++;
  if (isStaticType(f.type)) {
    agg.static.add(staticKey(f.lat, f.lon));
    return;
  }
  if (f.type === null && isStaticLocation(staticMask, f.lat, f.lon)) return;
  if (!passesConfidence(f)) return;
  agg.kept++;
  const ym = f.date.slice(0, 7);
  const m = (agg.monthly[ym] ??= [0, 0, 0]);
  m[0]++;
  m[2] += f.frp;
  const cd = `${f.date}|${cell01(f.lat, f.lon)}`;
  if (!agg.cellDays.has(cd)) {
    agg.cellDays.add(cd);
    m[1]++;
  }
  const y = f.date.slice(0, 4);
  const d = (agg.daily[y] ??= new Array(366).fill(0));
  d[dayOfYear(f.date)]++;
  if (sensor === 'V') agg.clim.add(`${cell025(f.lat, f.lon)}|${+f.date.slice(5, 7) - 1}|${y}`);
}

const serialize = (agg) => ({
  monthly: Object.fromEntries(Object.entries(agg.monthly).map(([k, v]) => [k, [v[0], v[1], Math.round(v[2])]])),
  daily: agg.daily,
  clim: [...agg.clim],
  static: [...agg.static],
  rows: agg.rows,
  kept: agg.kept,
});

// ---------- phase 1: country archive ----------
async function phase1(country, sensorKey) {
  if (!country.firms) return;
  const s = SENSORS[sensorKey];
  const jobs = [];
  for (let y = s.first; y <= (LAST_YEAR_BY_REGION[country.region] ?? ARCHIVE_LAST_YEAR); y++) jobs.push(y);
  await pool(jobs, 2, async (year) => {
    const file = path.join(CACHE, `${country.iso}_${sensorKey}_${year}.json`);
    if (fs.existsSync(file)) return;
    const url = `${FIRMS_BASE}/data/country/${s.dir}/${year}/${s.dir}_${year}_${country.firms}.csv`;
    const text = readLocal(s.dir, `${s.dir}_${year}_${country.firms}.csv`) ?? (await fetchText(url));
    const agg = newAgg();
    if (text) for (const f of parseFirmsCsv(text)) ingest(agg, f, sensorKey, null);
    fs.writeFileSync(file, JSON.stringify({ ...serialize(agg), missing: !text }));
    console.log(`  ${country.iso} ${sensorKey} ${year}: ${text ? `${agg.rows} rows, ${agg.kept} vegetation` : 'no file'}`);
  });
}

// ---------- phase 2: area API for recent years ----------
let apiCalls = 0;
async function firmsApi(source, start, days, bbox) {
  if (++apiCalls % 25 === 0) {
    // Respect the 5000 transactions / 10 min quota.
    for (;;) {
      const st = JSON.parse(await fetchText(`${FIRMS_BASE}/mapserver/mapkey_status/?MAP_KEY=${KEY}`));
      if (st.current_transactions < 3500) break;
      console.log(`  quota ${st.current_transactions}/5000 – waiting 60 s`);
      await sleep(60000);
    }
  }
  const { west, south, east, north } = bbox;
  const url = `${FIRMS_BASE}/api/area/csv/${KEY}/${source}/${west},${south},${east},${north}/${days}/${start}`;
  const text = await fetchText(url);
  if (!text || text.startsWith('Invalid')) throw new Error(`${source} ${start}: ${text?.slice(0, 120)}`);
  return parseFirmsCsv(text, source);
}

async function phase2(staticMask, region = 'MENA') {
  if (!KEY) {
    console.warn('No FIRMS_MAP_KEY – skipping recent years.');
    return;
  }
  const avail = parseAvailability(await fetchText(`${FIRMS_BASE}/api/data_availability/csv/${KEY}/all`));
  const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const cutoff = {};
  for (const [sensorKey, s] of Object.entries(SENSORS)) {
    const spEnd = avail[s.sp]?.max ?? '1970-01-01';
    let firstEmpty = null;
    let d = `${LAST_YEAR_BY_REGION[region] + 1}-01-01`;
    while (d <= end) {
      const source = d <= spEnd ? s.sp : s.nrt;
      const limit = source === s.sp ? spEnd : end;
      const days = Math.min(5, daysBetween(d, limit) + 1);
      const file = path.join(CACHE, `${API_PREFIX[region]}${sensorKey}_${d}_${days}.json`);
      const isComplete = source === s.sp; // NRT chunks near "today" are refreshed on each run
      if (!(isComplete && fs.existsSync(file))) {
        const rows = await firmsApi(source, d, days, REGIONS[region].bbox);
        const aggs = {};
        for (const f of rows) {
          const c = countryAt(f.lon, f.lat);
          if (!c || !ISO_SET.has(c.iso) || regionOfIso(c.iso) !== region) continue;
          ingest((aggs[c.iso] ??= newAgg()), f, sensorKey, staticMask);
        }
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(aggs).map(([k, v]) => [k, serialize(v)]))));
        console.log(`  API ${source} ${d} +${days}d: ${rows.length} rows`);
        if (source === s.nrt) firstEmpty = rows.length ? null : firstEmpty ?? d;
        await sleep(1500);
      }
      d = addDays(d, days);
    }
    if (firstEmpty) {
      cutoff[sensorKey] = firstEmpty.slice(0, 7);
      console.log(`  ${s.nrt} delivered nothing from ${firstEmpty}: ${sensorKey} record cut from ${cutoff[sensorKey]}`);
    }
  }
  fs.writeFileSync(cutoffFile(region), JSON.stringify({ ...cutoff, checked: new Date().toISOString() }));
}

function parseAvailability(csv) {
  const out = {};
  for (const line of csv.trim().split('\n').slice(1)) {
    const [id, min, max] = line.split(',');
    out[id] = { min, max: max?.trim() };
  }
  return out;
}

// ---------- combine ----------
function mergeInto(target, part, sensorKey) {
  const t = (target.sensors[sensorKey] ??= { monthly: {}, daily: {} });
  for (const [ym, v] of Object.entries(part.monthly)) {
    const m = (t.monthly[ym] ??= [0, 0, 0]);
    m[0] += v[0];
    m[1] += v[1];
    m[2] += v[2];
  }
  for (const [y, arr] of Object.entries(part.daily)) {
    const d = (t.daily[y] ??= new Array(366).fill(0));
    arr.forEach((v, i) => (d[i] += v));
  }
  for (const k of part.clim) target._clim.add(k);
}

function combine(list = COUNTRIES) {
  const files = fs.readdirSync(CACHE);
  const apiParts = files.filter((f) => f.startsWith('api')).map((f) => ({ sensor: f.split('_')[1], data: JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')) }));
  for (const c of list) {
    const target = { iso: c.iso, name: c.name, sensors: {}, _clim: new Set() };
    for (const f of files.filter((f) => f.startsWith(`${c.iso}_`))) {
      const sensor = f.split('_')[1];
      mergeInto(target, JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')), sensor);
    }
    for (const p of apiParts) if (p.data[c.iso]) mergeInto(target, p.data[c.iso], p.sensor);
    if (!Object.keys(target.sensors).length) continue;
    const cut = readCutoff(c.region);
    for (const sk of Object.keys(SENSORS)) {
      const from = cut[sk];
      const t = target.sensors[sk];
      if (!from || !t) continue;
      for (const ym of Object.keys(t.monthly)) if (ym >= from) delete t.monthly[ym];
      const y = from.slice(0, 4);
      if (t.daily[y]) t.daily[y] = t.daily[y].map((v, i) => (i >= dayOfYear(`${from}-01`) ? 0 : v));
      if (sk === 'V') for (const k of [...target._clim]) { const [, m, yy] = k.split('|'); if (`${yy}-${String(+m + 1).padStart(2, '0')}` >= from) target._clim.delete(k); }
    }

    // climatology: for each 0.25° cell and calendar month, in how many years did VIIRS see fire?
    const clim = {};
    const years = new Set();
    for (const k of target._clim) {
      const [cell, m, y] = k.split('|');
      years.add(y);
      (clim[cell] ??= new Array(12).fill(0))[+m]++;
    }
    delete target._clim;
    target.clim = { years: years.size, cells: clim };
    target.updated = new Date().toISOString();
    fs.writeFileSync(path.join(OUT, `${c.iso}.json`), JSON.stringify(target));
    console.log(`combined ${c.iso}: ${Object.keys(target.sensors.M?.monthly ?? {}).length} MODIS months, ${Object.keys(target.sensors.V?.monthly ?? {}).length} VIIRS months, ${Object.keys(clim).length} clim cells`);
  }
}

function buildStaticMask() {
  const counts = new Map();
  for (const f of fs.readdirSync(CACHE)) {
    if (f.startsWith('api')) continue;
    for (const k of JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8')).static) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const keys = [...counts.keys()];
  fs.writeFileSync(path.join(OUT, 'static_mask.json'), JSON.stringify(keys));
  console.log(`static heat-source mask: ${keys.length} cells`);
  return new Set(keys);
}

// ---------- utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await fn(item);
      } catch (e) {
        console.error(`  ! ${e.message}`);
      }
    }
  }));
}

async function main() {
  if (process.argv.includes('--combine')) {
    // Rebuild data/archive from whatever is already cached (no downloads).
    combine();
    return;
  }
  const args = process.argv.slice(2);
  const ri = args.indexOf('--region');
  const region = ri >= 0 ? args[ri + 1].toUpperCase() : null;
  const only = args.filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1)).map((s) => s.toUpperCase());
  const list = region ? countriesIn(region) : only.length ? COUNTRIES.filter((c) => only.includes(c.iso)) : COUNTRIES;
  console.log(`Phase 1: FIRMS country archives for ${list.length} countries`);
  for (const c of list) {
    console.log(`${c.name}`);
    await phase1(c, 'M');
    await phase1(c, 'V');
  }
  const mask = buildStaticMask();
  if (region) {
    console.log(`Phase 2: recent years from the FIRMS area API (${region})`);
    await phase2(mask, region);
  } else if (!only.length) {
    console.log('Phase 2: recent years from the FIRMS area API');
    for (const r of Object.keys(REGIONS)) await phase2(mask, r);
  }
  combine(list);
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
