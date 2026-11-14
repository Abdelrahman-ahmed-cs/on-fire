// 2026 for a drawn box: the long record (Python service) ends 2025-12-31, so the months since then
// are counted here from NASA FIRMS, in the SAME unit as the harmonized calendar from 2012 on:
// VIIRS S-NPP fire cell-days = distinct (0.1° cell, day) with a vegetation detection whose
// confidence is not "low", counted for 0.25° cells whose centre lies in the box (as /api/calendar).
//  - Standard-processing data (VIIRS_SNPP_SP) is used where FIRMS has it, near-real-time (NRT) after.
//  - NRT has no "type" flag, so persistent heat sources are removed with the static heat mask
//    built from the archive (gas flares, industry), the same rule the archive builder uses.
//  - If S-NPP stopped delivering for a region (data/cache/archive-cutoff-<REGION>.json), months
//    from that cutoff are left out instead of showing a false drop.
import fs from 'node:fs';
import path from 'node:path';
import { FIRMS_BASE, parseFirmsCsv, passesConfidence, isStaticType, isStaticLocation, cell01, fetchText } from './firms.js';
import { countryAt } from './geo.js';
import { ISO_SET } from './regions.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
export const RECENT_FROM = '2026-01-01';
const CHUNK_DAYS = 5; // FIRMS area API limit per request
const CONCURRENCY = 8;
const NRT_TTL = 3 * 3600 * 1000;

let mask = null;
function staticMask() {
  if (!mask) {
    try {
      mask = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/archive/static_mask.json'), 'utf8')));
    } catch {
      mask = new Set();
    }
  }
  return mask;
}

export function cutoffFor(region) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, `data/cache/archive-cutoff-${region}.json`), 'utf8')).V ?? null;
  } catch {
    return null;
  }
}

// Last date FIRMS holds for each dataset, e.g. VIIRS_SNPP_NRT ended 2026-11-02 when S-NPP stopped sending.
let avail = { t: 0, max: {} };
async function availability(key) {
  if (Date.now() - avail.t < 3 * 3600 * 1000) return avail.max;
  const csv = await fetchText(`${FIRMS_BASE}/api/data_availability/csv/${key}/all`);
  const max = {};
  for (const line of csv?.trim().split('\n').slice(1) ?? []) {
    const [id, , last] = line.split(',');
    max[id] = last?.trim();
  }
  avail = { t: Date.now(), max };
  return max;
}
// Last day with data for a sensor (standard or near-real-time), so an outage is never read as "no fire".
export async function sensorLastDay(prefix = 'VIIRS_SNPP') {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return null;
  try {
    const m = await availability(key);
    return [m[`${prefix}_NRT`], m[`${prefix}_SP`]].filter(Boolean).sort().at(-1) ?? null;
  } catch {
    return null;
  }
}

// SP chunks never change: keep them on disk so a box opens fast the second time.
const DISK = path.join(ROOT, 'data/cache/area');
fs.mkdirSync(DISK, { recursive: true });
const diskName = (k) => path.join(DISK, k.replace(/[^A-Za-z0-9.,_-]+/g, '_') + '.json');
const PACK = ['lat', 'lon', 'date', 'time', 'sat', 'inst', 'conf', 'frp', 'dn', 'type'];

const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
export const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// The FIRMS request box covers every 0.25° cell whose centre is in the drawn box.
function requestBox([w, s, e, n]) {
  return [Math.floor(w * 4) / 4, Math.floor(s * 4) / 4, Math.ceil(e * 4) / 4, Math.ceil(n * 4) / 4].map((v) => Math.max(-180, Math.min(180, v)));
}
const centreIn = ([w, s, e, n], lat, lon) => {
  const cy = (Math.floor(lat * 4) + 0.5) / 4, cx = (Math.floor(lon * 4) + 0.5) / 4;
  return cy >= s && cy <= n && cx >= w && cx <= e;
};

// chunk cache: SP chunks never change, NRT chunks are refreshed after a few hours
const chunks = new Map();
function remember(k, v) {
  chunks.set(k, v);
  if (chunks.size > 3000) chunks.delete(chunks.keys().next().value);
}

// place = a request box [w,s,e,n] (FIRMS area API) or an ISO3 code (FIRMS country API)
async function fetchChunk(key, source, rb, start, days) {
  const where = typeof rb === 'string' ? `country/csv/${key}/${source}/${rb}` : `area/csv/${key}/${source}/${rb.join(',')}`;
  const k = `${source}|${typeof rb === 'string' ? rb : rb.join(',')}|${start}|${days}`;
  const hit = chunks.get(k);
  const sp = source.endsWith('_SP');
  if (hit && (sp || Date.now() - hit.t < NRT_TTL)) return hit.rows;
  if (sp) {
    try {
      const rows = JSON.parse(fs.readFileSync(diskName(k), 'utf8')).map((r) => Object.fromEntries(PACK.map((p, i) => [p, r[i]])));
      remember(k, { t: Date.now(), rows });
      return rows;
    } catch {
      /* not cached yet */
    }
  }
  const text = await fetchText(`${FIRMS_BASE}/api/${where}/${days}/${start}`);
  if (text && /^Invalid|exceeded/i.test(text)) throw new Error('NASA FIRMS refused the request (quota or key)');
  const rows = text ? parseFirmsCsv(text, source) : [];
  remember(k, { t: Date.now(), rows });
  if (sp) fs.writeFile(diskName(k), JSON.stringify(rows.map((r) => PACK.map((p) => r[p]))), () => {});
  return rows;
}

// Detections in the box between start and end (inclusive), 2026 on.
//  Calendar use (default): VIIRS S-NPP, vegetation only, confidence not low, 0.25° cell centre in the box.
//  CSV use ({ csv: true }): the sensor asked for, every confidence, the point itself in the box,
//  static heat sources removed, i.e. the same rules as the 2000-2025 CSV.
//  Country use ({ csv: true, iso }): FIRMS country API, rows kept when they fall in that country.
export async function recentDetections(bbox, start = RECENT_FROM, end = yesterday(), { prefix = 'VIIRS_SNPP', csv = false, iso = null } = {}) {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) throw Object.assign(new Error('No NASA FIRMS key configured, so 2026 cannot be added.'), { status: 503 });
  if (start < RECENT_FROM) start = RECENT_FROM;
  if (end > yesterday()) end = yesterday();
  // (FIRMS rejects its country endpoint with "Invalid API call", so countries use the area endpoint
  // over the country's box and keep only rows inside the country outline.)
  const rb = requestBox(bbox);
  let sp, last;
  try {
    const m = await availability(key);
    sp = m[`${prefix}_SP`] ?? '1970-01-01';
    last = [m[`${prefix}_NRT`], sp].filter(Boolean).sort().at(-1);
  } catch {
    throw Object.assign(new Error('NASA FIRMS is not answering right now. Try again in a minute.'), { status: 503 });
  }
  if (last && end > last) end = last; // nothing exists after the sensor's last day
  if (start > end) return [];
  const jobs = [];
  for (let d = start; d <= end; ) {
    const source = d <= sp ? `${prefix}_SP` : `${prefix}_NRT`;
    const limit = source.endsWith('_SP') && sp < end ? sp : end;
    const days = Math.min(CHUNK_DAYS, daysBetween(d, limit) + 1);
    jobs.push({ source, d, days });
    d = addDays(d, days);
  }
  const out = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const j = jobs[i];
      try {
        out[i] = await fetchChunk(key, j.source, rb, j.d, j.days);
      } catch (e) {
        // never pass on the raw error: the request URL contains the key
        throw Object.assign(new Error(/refused/.test(e.message) ? e.message : 'NASA FIRMS is not answering right now. Try again in a minute.'), { status: 503 });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  const m = staticMask();
  const rows = [];
  for (const f of out.flat()) {
    const inside = csv ? f.lon >= bbox[0] && f.lon <= bbox[2] && f.lat >= bbox[1] && f.lat <= bbox[3] : centreIn(bbox, f.lat, f.lon);
    if (f.date < start || f.date > end || !inside) continue;
    if (isStaticType(f.type) || (f.type === null && isStaticLocation(m, f.lat, f.lon)) || (!csv && !passesConfidence(f))) continue;
    const c = countryAt(f.lon, f.lat);
    if (!c || !ISO_SET.has(c.iso) || (iso && c.iso !== iso)) continue;
    rows.push({ ...f, country: c.name, source: `${prefix}_${f.type === null ? 'NRT' : 'SP'}` });
  }
  return rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// Monthly VIIRS detections and fire cell-days from those rows.
export function monthlyCellDays(rows) {
  const by = {};
  const seen = new Set();
  for (const f of rows) {
    const ym = f.date.slice(0, 7);
    const o = (by[ym] ??= { ym, v_det: 0, v_cd: 0 });
    o.v_det++;
    const k = `${f.date}|${cell01(f.lat, f.lon)}`;
    if (!seen.has(k)) {
      seen.add(k);
      o.v_cd++;
    }
  }
  return by;
}

export function cellDaysBetween(rows, from, to) {
  const seen = new Set();
  for (const f of rows) if (f.date >= from && f.date <= to) seen.add(`${f.date}|${cell01(f.lat, f.lon)}`);
  return seen.size;
}
