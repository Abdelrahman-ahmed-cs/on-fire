// Near-real-time hotspots for every region (MENA + North America) from all four FIRMS NRT sources, cleaned,
// assigned to countries/provinces and grouped into fire events.
import fs from 'node:fs';
import path from 'node:path';
import { REGIONS, ISO_SET, countryByIso, regionOfIso } from './regions.js';
import { FIRMS_BASE, parseFirmsCsv, passesConfidence, isStaticLocation, fetchText } from './firms.js';
import { countryAt, geo, distanceKm, townsNear } from './geo.js';

const nearestTownName = (lat, lon) => {
  const t = townsNear(lat, lon, 50)[0];
  return t ? `near ${t.name}` : null;
};
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';

const SOURCES = ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT'];
const TTL = 20 * 60 * 1000;
const MASK_FILE = path.resolve(import.meta.dirname, '../../data/archive/static_mask.json');

let state = null; // { fires, events, fetchedAt, removedStatic }
let inflight = null;
const placeMemo = new Map();
// On Fire: last live result saved to disk, so a restart opens at once (then refreshes in the background).
const SNAPSHOT = path.resolve(import.meta.dirname, '../../data/cache/live-snapshot.json');
try {
  state = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const now = Date.now();
  for (const f of state.fires) { f.ageH = Math.max(0, (now - f.t) / 3600000); f.region ??= regionOfIso(f.iso); }
  for (const e of state.events) { if (e.last) e.lastAgeH = Math.max(0, (now - e.last) / 3600000); e.region ??= regionOfIso(e.iso); }
} catch { state = null; }
let staticMask = null;
let maskMtime = 0;

function loadMask() {
  try {
    const m = fs.statSync(MASK_FILE).mtimeMs;
    if (m !== maskMtime) {
      staticMask = new Set(JSON.parse(fs.readFileSync(MASK_FILE, 'utf8')));
      maskMtime = m;
    }
  } catch {
    /* mask not built yet */
  }
  return staticMask;
}

let provIndex;
function provinceIndex() {
  if (!provIndex) {
    provIndex = {};
    for (const f of geo().provinces.fc.features) (provIndex[f.properties.iso] ??= []).push({ f, bb: bbox(f) });
  }
  return provIndex;
}
function provinceFor(iso, lon, lat) {
  for (const { f, bb } of provinceIndex()[iso] ?? []) {
    if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    if (booleanPointInPolygon([lon, lat], f)) return f.properties;
  }
  return null;
}

async function fetchSource(key, source, bbox) {
  const { west, south, east, north } = bbox;
  const area = `${west},${south},${east},${north}`;
  const start = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  // API allows max 5 days per request: last 5 days + the 2 days before.
  const [a, b] = await Promise.all([
    fetchText(`${FIRMS_BASE}/api/area/csv/${key}/${source}/${area}/5`),
    fetchText(`${FIRMS_BASE}/api/area/csv/${key}/${source}/${area}/2/${start}`),
  ]);
  // A real answer is a CSV that starts with its header (even with no rows). Anything else
  // (quota or error text, an empty body) is a failure, never "no fires".
  for (const t of [a, b]) if (!t || !t.startsWith('latitude')) throw new Error(`FIRMS did not send data${t ? `: ${t.slice(0, 60).split(key).join('KEY').trim()}` : ''}`);
  return [...parseFirmsCsv(a, source), ...parseFirmsCsv(b, source)];
}

// Which satellites each FIRMS source delivers (to keep the last good data of a source that failed).
const SOURCE_SATS = { VIIRS_SNPP_NRT: ['S-NPP'], VIIRS_NOAA20_NRT: ['NOAA-20'], VIIRS_NOAA21_NRT: ['NOAA-21'], MODIS_NRT: ['Terra', 'Aqua'] };

async function refresh() {
  const key = process.env.FIRMS_MAP_KEY;
  const mask = loadMask();
  const jobs = SOURCES.flatMap((s) => Object.values(REGIONS).map((r) => ({ s, r })));
  const results = await Promise.allSettled(jobs.map(({ s, r }) => fetchSource(key, s, r.bbox)));
  const now = Date.now();
  const seen = new Set();
  const fires = [];
  let removedStatic = 0;
  let removedLowConf = 0;
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return console.error(`FIRMS ${jobs[i].s} (${jobs[i].r.id}) failed:`, r.reason?.message);
    for (const f of r.value) {
      const k = `${f.sat}|${f.lat}|${f.lon}|${f.date}|${f.time}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!passesConfidence(f)) {
        removedLowConf++;
        continue;
      }
      if (isStaticLocation(mask, f.lat, f.lon)) {
        removedStatic++;
        continue;
      }
      // On Fire: look up country/province once per ~1 km cell (hotspots cluster; this was the slow part).
      const ck = Math.round(f.lat * 100) * 100000 + Math.round(f.lon * 100);
      let hit = placeMemo.get(ck);
      if (!hit) {
        const cc = countryAt(f.lon, f.lat);
        hit = { c: cc, prov: cc && ISO_SET.has(cc.iso) ? provinceFor(cc.iso, f.lon, f.lat) : null };
        placeMemo.set(ck, hit);
      }
      const c = hit.c;
      if (!c || !ISO_SET.has(c.iso)) continue;
      const t = Date.parse(`${f.date}T${f.time.slice(0, 2)}:${f.time.slice(2)}:00Z`);
      const prov = hit.prov;
      fires.push({
        ...f,
        iso: c.iso,
        region: regionOfIso(c.iso),
        prov: prov?.id ?? null,
        provName: prov?.name ?? null,
        t,
        ageH: Math.max(0, (now - t) / 3600000),
      });
    }
  });
  // A source that failed this time keeps its detections from the last good fetch (7-day window),
  // so a busy or refused request never wipes a region's fires off the map.
  const failed = results.map((r, i) => (r.status === 'fulfilled' ? null : jobs[i])).filter(Boolean);
  if (failed.length && state?.fires?.length) {
    let carried = 0;
    for (const f of state.fires) {
      if (!failed.some(({ s, r }) => f.region === r.id && SOURCE_SATS[s]?.includes(f.sat))) continue;
      if (now - f.t > 7 * 86400000) continue;
      const k = `${f.sat}|${f.lat}|${f.lon}|${f.date}|${f.time}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const { id, event, ...rest } = f;
      fires.push({ ...rest, ageH: Math.max(0, (now - f.t) / 3600000) });
      carried++;
    }
    console.warn(`live: ${failed.length} FIRMS request(s) failed; kept ${carried} detections from the last good fetch`);
  }
  let kept = fires.sort((a, b) => b.t - a.t);
  kept.forEach((f, i) => (f.id = i));
  let events = clusterEvents(kept);
  // Gas flares / industrial heat not yet in the archive mask: a vegetation fire
  // moves, a flare stays within ~1 km for days.
  const persistent = new Set(events.filter((e) => e.days >= 3 && e.radiusKm <= 1.2).map((e) => e.id));
  if (persistent.size) {
    const before = kept.length;
    kept = kept.filter((f) => !persistent.has(f.event));
    removedStatic += before - kept.length;
    kept.forEach((f, i) => {
      f.id = i;
      delete f.event;
    });
    events = clusterEvents(kept);
  }
  // after a failed request, try again in 2 minutes instead of waiting the full 20
  state = { fires: kept, events, fetchedAt: now, retryAt: failed.length ? now + 2 * 60 * 1000 : null, removedStatic, removedLowConf };
  try { fs.writeFileSync(SNAPSHOT, JSON.stringify(state)); } catch { /* snapshot is optional */ }
  console.log(`live: ${kept.length} hotspots, ${events.length} events (removed ${removedStatic} static, ${removedLowConf} low-conf)`);
  return state;
}

export async function getLive() {
  if (state && Date.now() - state.fetchedAt < TTL && !(state.retryAt && Date.now() > state.retryAt)) return state;
  if (!inflight) inflight = refresh().finally(() => (inflight = null));
  if (state) return state; // serve stale while refreshing
  return inflight;
}

// ---------- fire events: hotspots within ~2 km of each other ----------
function clusterEvents(fires) {
  const parent = fires.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const grid = new Map();
  const G = 0.02;
  fires.forEach((f, i) => {
    const k = `${Math.floor(f.lat / G)}_${Math.floor(f.lon / G)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  fires.forEach((f, i) => {
    const gy = Math.floor(f.lat / G);
    const gx = Math.floor(f.lon / G);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const j of grid.get(`${gy + dy}_${gx + dx}`) ?? []) {
          if (j <= i) continue;
          if (distanceKm(f.lat, f.lon, fires[j].lat, fires[j].lon) <= 2) parent[find(i)] = find(j);
        }
  });
  const groups = new Map();
  fires.forEach((f, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(f);
  });
  const events = [];
  for (const members of groups.values()) {
    let lat = 0, lon = 0, frpSum = 0, frpMax = 0, first = Infinity, last = 0;
    const sats = new Set();
    for (const f of members) {
      lat += f.lat;
      lon += f.lon;
      frpSum += f.frp;
      frpMax = Math.max(frpMax, f.frp);
      first = Math.min(first, f.t);
      last = Math.max(last, f.t);
      sats.add(f.sat);
    }
    lat /= members.length;
    lon /= members.length;
    let radiusKm = 0;
    for (const f of members) radiusKm = Math.max(radiusKm, distanceKm(lat, lon, f.lat, f.lon));
    const days = new Set(members.map((f) => f.date)).size;
    const iso = members[0].iso;
    events.push({
      id: `E${members[0].id}`,
      lat, lon, iso,
      region: regionOfIso(iso),
      country: countryByIso[iso]?.name,
      prov: members.find((f) => f.prov)?.prov ?? null,
      provName: members.find((f) => f.provName)?.provName ?? nearestTownName(lat, lon),
      n: members.length,
      frpSum, frpMax,
      first, last,
      durationH: (last - first) / 3600000,
      lastAgeH: (Date.now() - last) / 3600000,
      days,
      radiusKm,
      sats: [...sats],
      fireIds: members.map((f) => f.id),
      footprintKm2: footprint(members),
    });
    for (const f of members) f.event = events[events.length - 1].id;
  }
  events.sort((a, b) => b.frpSum - a.frpSum);
  return events;
}

// Upper bound of the area covered by fire pixels (unique pixel footprints).
// VIIRS pixels are used when present (finer), otherwise MODIS.
function footprint(members) {
  const viirs = members.filter((f) => f.inst === 'VIIRS');
  const use = viirs.length ? viirs : members;
  const cell = viirs.length ? 0.0035 : 0.009;
  const seen = new Map();
  for (const f of use) {
    const k = `${Math.round(f.lat / cell)}_${Math.round(f.lon / cell)}`;
    seen.set(k, Math.max(seen.get(k) ?? 0, (f.scan || 0.375) * (f.track || 0.375)));
  }
  let a = 0;
  for (const v of seen.values()) a += v;
  return a;
}

// Compact column-oriented payload for the map (much smaller than GeoJSON).
export function firesPayload(fires) {
  return {
    cols: ['id', 'lat', 'lon', 'frp', 'ageH', 'sat', 'iso', 'event', 'dn', 'conf'],
    rows: fires.map((f) => [f.id, f.lat, f.lon, Math.round(f.frp * 10) / 10, Math.round(f.ageH * 10) / 10, f.sat, f.iso, f.event, f.dn, f.conf]),
  };
}

export function summarize(fires, events) {
  const bySat = {};
  const byCountry = {};
  const byProv = {};
  let frp = 0;
  for (const f of fires) {
    bySat[f.sat] = (bySat[f.sat] || 0) + 1;
    frp += f.frp;
    const c = (byCountry[f.iso] ??= { iso: f.iso, name: countryByIso[f.iso].name, n: 0, n24: 0, frp: 0, high: 0 });
    c.n++;
    if (f.ageH <= 24) c.n24++;
    c.frp += f.frp;
    if (f.frp >= 50) c.high++;
    if (f.prov) {
      const p = (byProv[f.prov] ??= { id: f.prov, iso: f.iso, name: f.provName, n: 0, n24: 0, ev: new Set() });
      p.n++;
      if (f.ageH <= 24) p.n24++;
      p.ev.add(f.event);
    }
  }
  const evCountry = {};
  for (const e of events) evCountry[e.iso] = (evCountry[e.iso] || 0) + 1;
  for (const c of Object.values(byCountry)) c.events = evCountry[c.iso] || 0;
  return {
    total: fires.length,
    last24: fires.filter((f) => f.ageH <= 24).length,
    frp,
    highIntensity: fires.filter((f) => f.frp >= 50).length,
    events: events.length,
    activeEvents: events.filter((e) => e.lastAgeH <= 24).length,
    bySat,
    countries: Object.values(byCountry).sort((a, b) => b.n - a.n),
    // states / provinces, used to split North America's three large countries on the region map
    provinces: Object.values(byProv).map(({ ev, ...p }) => ({ ...p, events: ev.size })).sort((a, b) => b.n - a.n),
  };
}
