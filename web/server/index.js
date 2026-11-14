import express from 'express';
import compression from 'compression';
import path from 'node:path';
import fs from 'node:fs';
import { getLive, firesPayload, summarize } from './lib/live.js';
import { harmonizeCountry, archiveAvailable, climProbabilityAt, climatologyGrid, climatologyGridAll, buildCalendar } from './lib/harmonize.js';
import { spreadForEvent, threatenedPlaces, riskGrid, gfdi, dangerClass } from './lib/risk.js';
import { emissions, surroundings, cachedSurroundings, populationExposure, aqiCategory } from './lib/impact.js';
import { pointWeather, airQuality, airQualityMany, windField } from './lib/weather.js';
import { geo, countryAt, provinceAt, townsNear, distanceKm } from './lib/geo.js';
import { predict as mlPredict, explainCell as mlExplain, startForecastRefresher } from './lib/ml.js';
import { countryByIso, COUNTRIES, REGIONS, ISO_SET, regionOf, regionOfIso } from './lib/regions.js';
import { landAt } from './lib/worldLand.js';
import { recentDetections, monthlyCellDays, cellDaysBetween, sensorLastDay, yesterday, RECENT_FROM } from './lib/areaRecent.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const app = express();
app.use(compression());
app.use(express.json({ limit: '200kb' }));
// no-cache = the browser keeps a copy but checks it is current (ETag), so rebuilt map shapes show at once
app.use('/geo', express.static(path.join(ROOT, 'data/geo'), { maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(req.originalUrl, e);
    res.status(e.status ?? 500).json({ error: e.message });
  });

// OSM villages + GeoNames towns, without counting the same settlement twice.
function mergePlaces(osm, gn) {
  const out = [...gn];
  for (const p of osm) if (!gn.some((g) => g.name.toLowerCase() === p.name.toLowerCase() || (distanceKm(g.lat, g.lon, p.lat, p.lon) < 1.5 && p.kind !== 'hamlet'))) out.push(p);
  return out;
}

const withinDays = (fires, days) => fires.filter((f) => f.ageH <= days * 24);
// ?region=MENA|NAM (default MENA); a point belongs to North America when it lies west of 30° W.
const regionParam = (req) => regionOf(req.query.region).id;
const regionAt = (lon) => (lon < -30 ? 'NAM' : 'MENA');
const compactEvent = (e) => ({ id: e.id, lat: e.lat, lon: e.lon, iso: e.iso, country: e.country, provName: e.provName, n: e.n, frpSum: Math.round(e.frpSum), frpMax: Math.round(e.frpMax), first: e.first, last: e.last, lastAgeH: +e.lastAgeH.toFixed(1), durationH: +e.durationH.toFixed(1), footprintKm2: +e.footprintKm2.toFixed(2), sats: e.sats });

app.get('/api/status', wrap(async (req, res) => {
  const live = await getLive();
  res.json({ archiveCountries: archiveAvailable(), liveFetchedAt: live.fetchedAt, hotspots: live.fires.length, countries: COUNTRIES, regions: Object.values(REGIONS).map(({ id, name, bbox }) => ({ id, name, bbox })) });
}));

// All hotspots of one region for the last N days + summary + events.
app.get('/api/live', wrap(async (req, res) => {
  const days = Math.min(7, Math.max(1, +req.query.days || 7));
  const region = regionParam(req);
  const live = await getLive();
  const fires = withinDays(live.fires, days).filter((f) => (f.region ?? regionOfIso(f.iso)) === region);
  const eventIds = new Set(fires.map((f) => f.event));
  const events = live.events.filter((e) => eventIds.has(e.id));
  res.json({
    fetchedAt: live.fetchedAt,
    days,
    region,
    removed: { staticSources: live.removedStatic, lowConfidence: live.removedLowConf },
    summary: summarize(fires, events),
    fires: firesPayload(fires),
    events: events.map(compactEvent),
  });
}));

app.get('/api/fire/:id', wrap(async (req, res) => {
  const live = await getLive();
  const f = live.fires.find((x) => x.id === +req.params.id);
  if (!f) return res.status(404).json({ error: 'Fire not found (data refreshed?)' });
  res.json({ ...f, country: countryByIso[f.iso]?.name });
}));

// Country dashboard: live stats, provinces, events, calendar.
app.get('/api/country/:iso', wrap(async (req, res) => {
  const iso = req.params.iso.toUpperCase();
  const days = Math.min(7, Math.max(1, +req.query.days || 7));
  const live = await getLive();
  const fires = withinDays(live.fires, days).filter((f) => f.iso === iso);
  const eventIds = new Set(fires.map((f) => f.event));
  const events = live.events.filter((e) => eventIds.has(e.id));
  const provinces = {};
  for (const f of fires) {
    if (!f.prov) continue;
    const p = (provinces[f.prov] ??= { id: f.prov, name: f.provName, n: 0, n24: 0, frp: 0 });
    p.n++;
    if (f.ageH <= 24) p.n24++;
    p.frp += f.frp;
  }
  const daily = {};
  for (const f of fires) daily[f.date] = (daily[f.date] || 0) + 1;
  res.json({
    iso,
    name: countryByIso[iso]?.name,
    days,
    summary: summarize(fires, events),
    provinces: Object.values(provinces).sort((a, b) => b.n - a.n).map((p) => ({ ...p, frp: Math.round(p.frp) })),
    daily: Object.entries(daily).sort().map(([date, n]) => ({ date, n })),
    events: events.slice(0, 100).map(compactEvent),
  });
}));

app.get('/api/harmonized/:iso', wrap(async (req, res) => {
  const h = harmonizeCountry(req.params.iso.toUpperCase());
  if (!h) return res.status(404).json({ error: 'Historical archive for this country is still being built. Run `npm run setup:archive`.' });
  res.json(h);
}));

// ---------- AI fire-danger model ----------
app.get('/api/ml/predict', wrap(async (req, res) => {
  const when = req.query.when === 'next' ? 'next' : 'current';
  const live = await getLive();
  const region = regionParam(req);
  const out = await mlPredict({ when, liveFires: live.fires, region });
  if (!out) return res.status(404).json({ error: `The AI model for ${REGIONS[region].name} is not trained yet. Run: npm run train:risk${region === 'MENA' ? '' : ' -- ' + region}` });
  const iso = req.query.iso?.toUpperCase();
  if (!iso) return res.json(out);
  res.json({ ...out, cells: out.cells.filter((c) => c[3] === iso), alerts: out.alerts.filter((a) => a.iso === iso), countries: out.countries.filter((c) => c.iso === iso) });
}));

app.get('/api/ml/cell', wrap(async (req, res) => {
  const live = await getLive();
  const lon = +req.query.lon;
  const out = await mlExplain({ lat: +req.query.lat, lon, when: req.query.when === 'next' ? 'next' : 'current', liveFires: live.fires, region: req.query.region ? regionParam(req) : regionAt(lon) });
  if (!out) return res.status(404).json({ error: 'The AI model is not trained yet.' });
  res.json(out);
}));

// Where fires usually happen in a given month (share of years with fire per 25 km cell).
app.get('/api/climgrid/:iso', wrap(async (req, res) => {
  const iso = req.params.iso.toUpperCase();
  const month = Math.min(11, Math.max(0, +(req.query.month ?? new Date().getUTCMonth())));
  const g = REGIONS[iso] ? climatologyGridAll(month, iso) : climatologyGrid(iso, month);
  if (!g) return res.status(404).json({ error: 'No history for this area yet' });
  res.json({ ...g, cells: g.cells.map((c) => [+c.lat.toFixed(3), +c.lon.toFixed(3), +c.p.toFixed(3)]) });
}));

// Per-country seasonal summary for the History map mode.
app.get('/api/history-overview', wrap(async (req, res) => {
  const region = req.query.region ? regionParam(req) : null;
  const out = [];
  for (const c of COUNTRIES) {
    if (region && c.region !== region) continue;
    const h = harmonizeCountry(c.iso);
    if (!h) continue;
    const cal = h.calendar;
    out.push({
      iso: c.iso,
      name: c.name,
      shares: cal.climatology.map((m) => m.share),
      peakMonth: cal.peakMonth,
      fireSeason: cal.fireSeason,
      criticalMonths: cal.criticalMonths,
      ytdRatio: cal.ytd.ratio,
      yearlyNormal: Math.round(cal.climatology.reduce((a, m) => a + m.mean, 0)),
    });
  }
  res.json(out);
}));

// Everything about one fire event: spread, danger, threatened places, damage, smoke.
app.get('/api/event/:id', wrap(async (req, res) => {
  const live = await getLive();
  const ev = live.events.find((e) => e.id === req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found (data refreshed?)' });
  // Fast path (~1 s): weather, spread, towns (GeoNames), air. OpenStreetMap details are
  // started in the background and fetched by the client from /api/event/:id/surroundings.
  const surr = cachedSurroundings(ev.lat, ev.lon);
  if (!surr) surroundings(ev.lat, ev.lon).catch(() => {});
  const [spreadR, aqR] = await Promise.allSettled([spreadForEvent(ev), airQuality(ev.lat, ev.lon)]);
  const spread = spreadR.status === 'fulfilled' ? spreadR.value : null;
  const aq = aqR.status === 'fulfilled' ? aqR.value : null;
  const threatened = spread ? threatenedPlaces(ev, spread, surr?.places ?? []) : [];
  // Air quality in the most exposed downwind settlements
  const exposed = threatened.filter((p) => p.smokeExposed).slice(0, 5);
  let exposedAq = [];
  try {
    exposedAq = await airQualityMany(exposed);
  } catch {
    /* optional */
  }
  const members = live.fires.filter((f) => f.event === ev.id).map((f) => ({ id: f.id, lat: f.lat, lon: f.lon, frp: f.frp, sat: f.sat, date: f.date, time: f.time, dn: f.dn, conf: f.conf, ageH: +f.ageH.toFixed(1) }));
  res.json({
    event: compactEvent(ev),
    detections: members,
    spread,
    threatened,
    surroundings: surr,
    surroundingsPending: !surr,
    population: populationExposure(mergePlaces(surr?.places ?? [], townsNear(ev.lat, ev.lon, 20))),
    damage: emissions(ev, live.fires),
    air: aq ? { ...aq, category: aqiCategory(aq.current.us_aqi) } : null,
    smoke: {
      plumeToward: spread?.windToward ?? null,
      plumeTowardCompass: spread?.windTowardCompass ?? null,
      plumeLengthKm6h: spread ? Math.round(spread.weatherNow.wind_speed_10m * 6) : null,
      exposedPlaces: exposed.map((p, i) => ({ name: p.name, distanceKm: p.distanceKm, direction: p.direction, pm25: exposedAq[i]?.pm2_5 ?? null, usAqi: exposedAq[i]?.us_aqi ?? null, category: aqiCategory(exposedAq[i]?.us_aqi) })),
    },
    errors: { spread: spreadR.reason?.message, air: aqR.reason?.message },
  });
}));

// How does this fire compare with the fires that burned here before (2012-2025)?
// Size is measured the way the archive measures past fires (pipeline/05_events.py): the area of the
// 0.05° cells touched by VIIRS vegetation detections. Total fire power is not compared, because more
// satellites fly today than in most past years.
const VIIRS_SATS = new Set(['S-NPP', 'NOAA-20', 'NOAA-21']);
app.get('/api/event/:id/history', wrap(async (req, res) => {
  const live = await getLive();
  const ev = live.events.find((e) => e.id === req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found (data refreshed?)' });
  const cells = new Set();
  for (const f of live.fires) if (f.event === ev.id && VIIRS_SATS.has(f.sat)) cells.add(`${Math.floor(f.lat / 0.05)}_${Math.floor(f.lon / 0.05)}`);
  const footprintKm2 = cells.size * (0.05 * 111) ** 2 * Math.cos((ev.lat * Math.PI) / 180);
  const radiusKm = 50;
  const r = await pyFetch(PY_API + '/api/past_fires', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lat: ev.lat, lon: ev.lon, radius_km: radiusKm }) });
  if (!r.ok) throw Object.assign(new Error('The history service is not answering (port 8001).'), { status: 502 });
  const past = await r.json();
  const larger = past.footprints.filter((x) => x > footprintKm2 + 1e-9).length;
  res.json({
    radiusKm,
    cells: cells.size,
    footprintKm2: +footprintKm2.toFixed(1),
    days: +(ev.durationH / 24).toFixed(1),
    past: { n: past.n, years: past.years.length ? [past.years[0], past.years.at(-1)] : null, largest: past.largest },
    // share of past fires here that were smaller than this one (only if it was seen by VIIRS)
    percentile: cells.size && past.n ? Math.floor((1000 * (past.n - larger)) / past.n) / 10 : null, // rounded down, never up
    rank: cells.size ? larger + 1 : null,
  });
}));

// Slow part of the fire details: OpenStreetMap villages, land cover, buildings, facilities.
app.get('/api/event/:id/surroundings', wrap(async (req, res) => {
  const live = await getLive();
  const ev = live.events.find((e) => e.id === req.params.id);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  try {
    const surr = await surroundings(ev.lat, ev.lon);
    let threatened = null;
    try {
      threatened = threatenedPlaces(ev, await spreadForEvent(ev), surr.places);
    } catch {
      /* weather unavailable: keep the fast list */
    }
    res.json({ surroundings: surr, threatened, population: populationExposure(mergePlaces(surr.places, townsNear(ev.lat, ev.lon, 20))) });
  } catch (e) {
    res.json({ surroundings: null, error: 'OpenStreetMap is busy right now' });
  }
}));

// Country-level risk: next-fire likelihood grid + spread of the main active fires.
app.get('/api/risk/:iso', wrap(async (req, res) => {
  const iso = req.params.iso.toUpperCase();
  const live = await getLive();
  const events = live.events.filter((e) => e.iso === iso);
  const grid = await riskGrid(iso, events);
  const active = events.filter((e) => e.lastAgeH <= 24).sort((a, b) => b.frpSum - a.frpSum).slice(0, 12);
  const spreads = [];
  for (const ev of active) {
    try {
      const s = await spreadForEvent(ev);
      const threatened = threatenedPlaces(ev, s).filter((p) => p.level !== 'watch' || p.downwind);
      spreads.push({ event: compactEvent(ev), danger: s.dangerMax24, fdiMax24: s.fdiMax24, windToward: s.windToward, windTowardCompass: s.windTowardCompass, windKmh: s.weatherNow.wind_speed_10m, envelopes: s.envelopes, threatened: threatened.slice(0, 6) });
    } catch (e) {
      console.error('spread', ev.id, e.message);
    }
  }
  // Name the highest-risk cells after their nearest town.
  const named = grid ? {
    ...grid,
    cells: grid.cells.map((c) => {
      if (c.score < 0.1) return c;
      const t = townsNear(c.lat, c.lon, 40, 5000)[0] ?? townsNear(c.lat, c.lon, 60)[0];
      return t ? { ...c, place: `near ${t.name}` } : c;
    }),
  } : null;
  res.json({ grid: named, spreads });
}));

app.get('/api/wind', wrap(async (req, res) => {
  // snap the box to whole degrees so nearby views share cached responses
  const [w, s, e, n] = String(req.query.bbox || '-18,8,64,43').split(',').map(Number).map((v, i) => (i < 2 ? Math.floor(v) : Math.ceil(v)));
  const nx = 9, ny = 6;
  const pts = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push({ lon: +(w + ((i + 0.5) * (e - w)) / nx).toFixed(2), lat: +(s + ((j + 0.5) * (n - s)) / ny).toFixed(2) });
  res.json(await windField(pts));
}));

// Click anywhere: conditions, fire danger and historical fire frequency at that spot.
app.get('/api/point', wrap(async (req, res) => {
  const lat = +req.query.lat;
  const lon = +req.query.lon;
  const c = countryAt(lon, lat);
  const p = c ? provinceAt(lon, lat) : null;
  const [wx, aq] = await Promise.allSettled([pointWeather(lat, lon), airQuality(lat, lon)]);
  const cur = wx.value?.current;
  const fdi = cur ? gfdi({ temp: cur.temperature_2m, rh: cur.relative_humidity_2m, wind: cur.wind_speed_10m }) : null;
  res.json({
    lat, lon,
    country: c, province: p,
    weather: cur ?? null,
    fdi: fdi !== null ? +fdi.toFixed(1) : null,
    danger: fdi !== null ? dangerClass(fdi) : null,
    air: aq.value ? { ...aq.value.current, category: aqiCategory(aq.value.current.us_aqi) } : null,
    history: c ? climProbabilityAt(c.iso, lat, lon, new Date().getUTCMonth()) : null,
  });
}));

// ---------- drawn area: 25-year calendar and hotspot CSV (On Fire's Python data service, port 8001) ----------
const PY_API = process.env.ONFIRE_PY_API ?? 'http://127.0.0.1:8001';
const AREA_MAX_DEG2 = 400; // keeps a query to a few seconds
const PY_DOWN = 'The history service is still starting or not running (port 8001). Try again in a few seconds.';
// The Python service starts a few seconds after this server: retry a refused connection for up to ~15 s.
async function pyFetch(url, opts) {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (i >= 10) throw Object.assign(new Error(PY_DOWN), { status: 503 });
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

function bboxOf(geom) {
  const pts = geom?.type === 'Polygon' ? geom.coordinates.flat() : [];
  if (pts.length < 4 || pts.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return null;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Share of the LAND in a box that lies in the countries On Fire covers (sampled on a grid of up to ~1,600 points).
function coverageOf([w, s, e, n]) {
  const step = Math.max(0.05, Math.sqrt(((e - w) * (n - s)) / 1600));
  let inside = 0, total = 0;
  const names = new Set();
  for (let y = s + step / 2; y < n; y += step)
    for (let x = w + step / 2; x < e; x += step) {
      const c = countryAt(x, y);
      if (c && ISO_SET.has(c.iso)) {
        total++;
        inside++;
        names.add(c.name);
      } else if (landAt(x, y)) total++; // land of a country On Fire does not cover; sea is ignored
    }
  return { share: total ? inside / total : 0, countries: [...names] };
}
const OUTSIDE = 'This box is outside the countries On Fire covers (Middle East & North Africa, North America), so there is no fire record for it. Draw it over a covered country.';

function readBox(req) {
  const geom = req.body?.geometry ?? req.body;
  const bb = bboxOf(geom);
  if (!bb) throw Object.assign(new Error('Send a GeoJSON polygon'), { status: 400 });
  if ((bb[2] - bb[0]) * (bb[3] - bb[1]) > AREA_MAX_DEG2) throw Object.assign(new Error('That area is too large. Draw a smaller box (up to about 20° × 20°).'), { status: 400 });
  return { geom, bb };
}

// 2000-2025 from the Python service, zero-filled from the first MODIS month (Nov 2000).
async function archiveSeries(geom) {
  const r = await pyFetch(PY_API + '/api/calendar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geom) });
  if (!r.ok) throw Object.assign(new Error('The history service is not answering (port 8001).'), { status: 502 });
  const j = await r.json();
  const byYm = new Map(j.rows.map((x) => [x.year + '-' + String(x.month).padStart(2, '0'), x]));
  const series = [];
  for (let y = 2000, m = 11; y <= 2025; m === 12 ? (y++, (m = 1)) : m++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const x = byYm.get(ym);
    // modisCount / viirsCount = hotspots detected (as in the country series); value = harmonized burning units
    series.push({ ym, value: x?.harmonized ?? 0, modisCount: x?.modis_raw ?? 0, viirsCount: y >= 2012 ? x?.viirs_raw ?? 0 : null, source: y >= 2012 ? 'VIIRS' : 'MODIS' });
  }
  return { cells: j.cells, series, any: j.rows.length > 0 };
}

app.post('/api/area-calendar', wrap(async (req, res) => {
  const { geom, bb } = readBox(req);
  const cov = coverageOf(bb);
  if (cov.share === 0) return res.status(422).json({ error: OUTSIDE, outside: true });
  const a = await archiveSeries(geom);
  res.json({
    bbox: bb.map((v) => +v.toFixed(3)),
    coverage: { share: +cov.share.toFixed(3), countries: cov.countries },
    cells: a.cells,
    archiveEnd: '2025-12',
    series: a.series,
    calendar: a.any ? buildCalendar(a.series, null, []) : null,
  });
}));

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// The months since the archive ends (2026) + this month so far against the same dates in 2012-2025.
app.post('/api/area-recent', wrap(async (req, res) => {
  const { geom, bb } = readBox(req);
  const today1 = yesterday();
  // S-NPP may stop sending (FIRMS listed VIIRS_SNPP_NRT up to 2026-11-02 while other satellites ran on):
  // days after its last day are unknown, not "no fire".
  const snppLast = (await sensorLastDay('VIIRS_SNPP')) ?? today1;
  const end = snppLast < today1 ? snppLast : today1;
  const outage = snppLast < today1 ? { lastDay: snppLast } : null;
  const [a, rows] = await Promise.all([archiveSeries(geom), recentDetections(bb, RECENT_FROM, end)]);
  const monthly = monthlyCellDays(rows);
  const series = [...a.series];
  const monthEnd = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5), 0)).toISOString().slice(0, 10);
  for (let d = RECENT_FROM; d.slice(0, 7) <= end.slice(0, 7); ) {
    const ym = d.slice(0, 7);
    // a month cut short by an outage would look like a collapse in fire: leave it out
    if (outage && monthEnd(ym) > end) break;
    const m = monthly[ym];
    series.push({ ym, value: m?.v_cd ?? 0, modisCount: null, viirsCount: m?.v_det ?? 0, source: 'VIIRS' });
    const [y, mo] = ym.split('-').map(Number);
    d = `${mo === 12 ? y + 1 : y}-${String(mo === 12 ? 1 : mo + 1).padStart(2, '0')}-01`;
  }

  // this month so far vs the same dates of every VIIRS year (only days the satellite sent data for)
  const ym = today1.slice(0, 7);
  const month = +ym.slice(5, 7);
  let thisMonth;
  if (end.slice(0, 7) !== ym) {
    thisMonth = { ym, unavailable: `The VIIRS S-NPP satellite has sent no data since ${end}, so this month cannot be compared with past years yet. Other satellites still see fires on the Live map.` };
  } else {
    const dayTo = +end.slice(8, 10);
    const r = await pyFetch(PY_API + '/api/area_same_dates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bbox: bb, month, day_to: dayTo }) });
    if (!r.ok) throw Object.assign(new Error('The history service is not answering (port 8001).'), { status: 502 });
    const past = (await r.json()).years;
    const now = cellDaysBetween(rows, `${ym}-01`, end);
    const vals = past.map((p) => p.v_cd).sort((x, y) => x - y);
    const median = quantile(vals, 0.5);
    thisMonth = {
      ym, month, dayTo, until: end, outage,
      soFar: now,
      past,
      median, p25: quantile(vals, 0.25), p75: quantile(vals, 0.75), max: vals.at(-1),
      rank: 1 + past.filter((p) => p.v_cd > now).length, // 1 = busiest of the 15 years
      years: past.length + 1,
      ratio: median > 0 ? +(now / median).toFixed(2) : null,
    };
  }
  res.json({
    bbox: bb.map((v) => +v.toFixed(3)),
    recent: { from: RECENT_FROM, to: series.at(-1).ym >= RECENT_FROM ? end : null, lastMonth: series.at(-1).ym, outage, detections: rows.length },
    series,
    calendar: series.some((x) => x.value > 0) ? buildCalendar(series, null, []) : null,
    thisMonth,
  });
}));

// Every satellite detection in a box for a date range, as CSV (MODIS + VIIRS S-NPP).
// 2000-2025 from the archive (Python service), 2026 to yesterday from NASA FIRMS, same columns and rules.
const VIIRS_CONF = { l: 15, n: 50, h: 90, low: 15, nominal: 50, high: 90 };
// The archive's country names differ in a few places (FIRMS files: Turkey, Israel stored as Palestine,
// Western Sahara inside Morocco); rows are always re-checked against On Fire's own country outline.
const PY_COUNTRY = { TUR: 'Turkey', ISR: 'Palestine', PSE: 'Palestine', ESH: 'Morocco' };
const SPLIT_ISO = new Set(['ISR', 'PSE', 'MAR', 'ESH']);
const COUNTRY_MAX_DAYS = 366;
// Box around a country's polygons on the side of the date line its largest polygon is on
// (the Aleutian islands east of 180° would otherwise stretch the United States box around the globe).
function countryBox(f) {
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const boxes = polys.map((p) => {
    const xs = p[0].map((c) => c[0]), ys = p[0].map((c) => c[1]);
    const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return { b, size: (b[2] - b[0]) * (b[3] - b[1]) };
  });
  const main = boxes.reduce((a, x) => (x.size > a.size ? x : a));
  const side = Math.sign((main.b[0] + main.b[2]) / 2) || 1;
  const keep = boxes.filter((x) => Math.sign((x.b[0] + x.b[2]) / 2) === side || Math.abs(x.b[0]) < 170).map((x) => x.b);
  return [Math.min(...keep.map((b) => b[0])), Math.min(...keep.map((b) => b[1])), Math.max(...keep.map((b) => b[2])), Math.max(...keep.map((b) => b[3]))];
}
const ARCHIVE_ROW_CAP = 500000; // the Python service stops a CSV at this many rows
app.get('/api/area-hotspots.csv', wrap(async (req, res) => {
  const iso = String(req.query.iso || '').toUpperCase() || null;
  let w, s, e, n;
  if (iso) {
    const cf = geo().countries.index.find((x) => x.f.properties.iso === iso);
    if (!cf || !ISO_SET.has(iso)) return res.status(400).json({ error: 'Unknown country' });
    [w, s, e, n] = countryBox(cf.f);
  } else {
    [w, s, e, n] = String(req.query.bbox || '').split(',').map(Number);
    if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n) return res.status(400).json({ error: 'bbox must be west,south,east,north' });
    if ((e - w) * (n - s) > AREA_MAX_DEG2) return res.status(400).json({ error: 'Area too large' });
  }
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
  const start = isDate(req.query.start) ? req.query.start : null;
  let end = isDate(req.query.end) ? req.query.end : null;
  if (!start || !end || start > end) return res.status(400).json({ error: 'start and end must be YYYY-MM-DD, start first' });
  if (end > yesterday()) end = yesterday();
  if (iso && (Date.parse(end) - Date.parse(start)) / 86400000 + 1 > COUNTRY_MAX_DAYS) return res.status(400).json({ error: 'For a whole country, download at most one year at a time.' });
  const header = 'latitude,longitude,acq_date,acq_time_utc,sensor,satellite,confidence,frp,daynight,type,country';
  const lines = [header];
  let capped = false;
  if (start <= '2025-12-31') {
    const qs = new URLSearchParams({ bbox: [w, s, e, n].map((v) => v.toFixed(4)).join(','), start, end: end < '2025-12-31' ? end : '2025-12-31', format: 'csv' });
    if (iso) qs.set('country', PY_COUNTRY[iso] ?? countryByIso[iso].name);
    const r = await pyFetch(PY_API + '/api/hotspots?' + qs);
    if (!r.ok) return res.status(502).json({ error: 'The history service is not answering (port 8001).' });
    let rows = (await r.text()).split(/\r?\n/).slice(1).filter(Boolean);
    capped = rows.length >= ARCHIVE_ROW_CAP;
    // only where the archive merges territories (Israel/Palestine, Morocco/Western Sahara) does a row need the outline check
    if (iso && SPLIT_ISO.has(iso)) rows = rows.filter((l) => {
      const [la, lo] = l.split(',');
      return countryAt(+lo, +la)?.iso === iso;
    });
    lines.push(...rows);
  }
  if (end >= RECENT_FROM) {
    const from = start > RECENT_FROM ? start : RECENT_FROM;
    const [v, m] = await Promise.all([
      recentDetections([w, s, e, n], from, end, { prefix: 'VIIRS_SNPP', csv: true, iso }),
      recentDetections([w, s, e, n], from, end, { prefix: 'MODIS', csv: true, iso }),
    ]);
    const all = [...v, ...m].sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
    for (const f of all) {
      const viirs = f.inst !== 'MODIS';
      const sat = viirs ? 'SNPP' : f.sat;
      const conf = viirs ? VIIRS_CONF[String(f.conf).toLowerCase()] ?? '' : f.conf;
      const country = /[",]/.test(f.country) ? `"${f.country}"` : f.country;
      lines.push([f.lat.toFixed(5), f.lon.toFixed(5), f.date, f.time, viirs ? 'VIIRS' : 'MODIS', sat, conf, f.frp, f.dn, f.type ?? '', country].join(','));
    }
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="onfire_hotspots_${iso ? iso + '_' : ''}${start}_${end}${capped ? '_first500000_archive_rows' : ''}.csv"`);
  res.send(lines.join('\n') + '\n');
}));

// Truth vs Prediction (On Fire's Python server) through this same port, so a hosted copy needs one
// public port only. /truth/* -> Python /*; the page also asks for /api/meta and /api/data/* by
// absolute path, which this server does not use itself.
const PASS_REQ = ['accept', 'if-none-match', 'if-modified-since'];
const PASS_RES = ['content-type', 'cache-control', 'etag', 'last-modified', 'content-disposition'];
const pyProxy = (strip) => async (req, res) => {
  const url = PY_API + (strip ? req.originalUrl.replace(/^\/truth/, '') : req.originalUrl);
  const headers = {};
  for (const h of PASS_REQ) if (req.get(h)) headers[h] = req.get(h);
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
    res.status(r.status);
    for (const h of PASS_RES) { const v = r.headers.get(h); if (v) res.setHeader(h, v); }
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(502).json({ error: PY_DOWN });
  }
};
app.get(/^\/truth$/, (req, res) => res.redirect(301, '/truth/'));
app.get(/^\/truth\//, pyProxy(true));
app.get('/api/meta', pyProxy(false));
app.get(/^\/api\/data\//, pyProxy(false));

// Production: serve the built frontend.
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

// On Fire: also start the Python server (Truth vs Prediction page + data API) on port 8001.
const PY = process.env.ONFIRE_PYTHON ?? 'C:\\Users\\User\\onfire-data\\venv\\Scripts\\python.exe';
const ONFIRE_DIR = process.env.ONFIRE_DIR ?? 'C:\\Users\\User\\OneDrive\\Desktop\\On Fire';
if (PY !== 'off' && fs.existsSync(PY)) {
  const { spawn } = await import('node:child_process');
  const py = spawn(PY, ['-m', 'uvicorn', 'server.main:app', '--port', '8001', '--app-dir', ONFIRE_DIR], { cwd: ONFIRE_DIR, stdio: 'inherit' });
  const stop = () => { try { py.kill(); } catch { /* already gone */ } };
  process.on('exit', stop);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop(); process.exit(0); });
}

const port = +process.env.API_PORT || +process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`API on http://localhost:${port}`);
  getLive().catch((e) => console.error('initial FIRMS fetch failed', e));
  startForecastRefresher();
});
