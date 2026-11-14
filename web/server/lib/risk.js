// Fire danger, spread projection and "where is the next fire likely" grid.
//
// Spread: McArthur Mk5 Grassland Fire Danger Index (Noble et al. 1980) gives a
// head-fire rate of spread ROS ≈ 0.13·GFDI km/h. The fire's shape follows the
// wind with a length-to-breadth ratio LB = 1 + 0.0012·U^2.154 (Alexander 1985).
// We step hour-by-hour through the Open-Meteo forecast, moving the head fire
// downwind, damped at night and by a fuel factor for sparse arid vegetation.
// The result is a *potential* spread envelope if the fire keeps burning.
import { geo, distanceKm, bearingDeg, destination, compass, townsNear } from './geo.js';
import { pointWeather, gridWeather } from './weather.js';
import { climatologyGrid, climProbabilityAt } from './harmonize.js';
import bbox from '@turf/bbox';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

export function gfdi({ temp, rh, wind, curing = 85 }) {
  const v = 2 * Math.exp(-23.6 + 5.01 * Math.log(curing) + 0.0281 * temp - 0.226 * Math.sqrt(Math.max(rh, 1)) + 0.633 * Math.sqrt(Math.max(wind, 0)));
  return Math.max(0, v);
}

export function dangerClass(fdi) {
  if (fdi >= 100) return { level: 5, label: 'Catastrophic', color: '#7f0000' };
  if (fdi >= 75) return { level: 4, label: 'Extreme', color: '#c1121f' };
  if (fdi >= 50) return { level: 3, label: 'Severe', color: '#e85d04' };
  if (fdi >= 25) return { level: 2, label: 'Very high', color: '#f48c06' };
  if (fdi >= 12) return { level: 1, label: 'High', color: '#ffba08' };
  return { level: 0, label: 'Low–moderate', color: '#8ac926' };
}

const lengthToBreadth = (u) => Math.min(8, 1 + 0.0012 * Math.pow(Math.max(u, 0), 2.154));

// Diurnal activity (UTC hour → local solar hour via longitude): fires spread most in the afternoon.
function diurnal(tIso, lon) {
  const h = (new Date(tIso + 'Z').getUTCHours() + lon / 15 + 24) % 24;
  if (h >= 11 && h <= 18) return 1;
  if (h >= 8 && h < 11) return 0.6;
  if (h > 18 && h <= 21) return 0.5;
  return 0.2;
}

// Arid fuels (most of MENA) are discontinuous: scale spread by historical fire frequency of the place.
function fuelFactor(pClim) {
  if (pClim === null || pClim === undefined) return 0.5;
  return Math.min(1, 0.25 + pClim * 1.5);
}

function ellipse(originLat, originLon, headKm, dirDeg, lb, steps = 48) {
  const backKm = headKm / (lb * 1.8 + 1);
  const a = (headKm + backKm) / 2;
  const b = a / lb;
  const centerOffset = headKm - a;
  const [cx, cy] = destination(originLat, originLon, centerOffset, dirDeg);
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * 2 * Math.PI;
    const x = a * Math.cos(th); // along wind
    const y = b * Math.sin(th); // across wind
    const dist = Math.hypot(x, y);
    const ang = dirDeg + (Math.atan2(y, x) * 180) / Math.PI;
    ring.push(destination(cy, cx, dist, ang));
  }
  return ring;
}

// Projects potential spread of one fire event for the next 24 h.
export async function spreadForEvent(ev) {
  const wx = await pointWeather(ev.lat, ev.lon);
  const clim = climProbabilityAt(ev.iso, ev.lat, ev.lon, new Date().getUTCMonth());
  const fuel = fuelFactor(clim?.p);
  const hours = wx.hourly.filter((h) => Date.parse(h.t + 'Z') >= Date.now() - 3600000).slice(0, 24);
  let x = 0, y = 0; // km east / north of origin
  let maxFdi = 0;
  const track = [];
  const envelopes = [];
  const marks = { 3: '3 h', 6: '6 h', 12: '12 h', 24: '24 h' };
  hours.forEach((h, i) => {
    const fdi = gfdi(h);
    maxFdi = Math.max(maxFdi, fdi);
    const ros = Math.min(8, 0.13 * fdi) * diurnal(h.t, ev.lon) * fuel; // km/h
    const toward = (h.dir + 180) % 360;
    x += ros * Math.sin((toward * Math.PI) / 180);
    y += ros * Math.cos((toward * Math.PI) / 180);
    const headKm = Math.hypot(x, y);
    const dir = (Math.atan2(x, y) * 180) / Math.PI;
    track.push({ t: h.t, fdi: +fdi.toFixed(1), ros: +ros.toFixed(2), wind: h.wind, dir: h.dir, toward, headKm: +headKm.toFixed(2) });
    const hr = i + 1;
    if (marks[hr]) {
      const avgWind = hours.slice(0, hr).reduce((a, q) => a + q.wind, 0) / hr;
      envelopes.push({ hours: hr, label: marks[hr], headKm, dir: (dir + 360) % 360, lb: lengthToBreadth(avgWind), ring: ellipse(ev.lat, ev.lon, Math.max(headKm, 0.3), (dir + 360) % 360, lengthToBreadth(avgWind)) });
    }
  });
  const now = wx.current;
  const nowFdi = gfdi({ temp: now.temperature_2m, rh: now.relative_humidity_2m, wind: now.wind_speed_10m });
  return {
    weatherNow: now,
    hourly: wx.hourly,
    fdiNow: +nowFdi.toFixed(1),
    dangerNow: dangerClass(nowFdi),
    fdiMax24: +maxFdi.toFixed(1),
    dangerMax24: dangerClass(maxFdi),
    fuelFactor: +fuel.toFixed(2),
    historicalFireFrequency: clim,
    windToward: (now.wind_direction_10m + 180) % 360,
    windTowardCompass: compass((now.wind_direction_10m + 180) % 360),
    track,
    envelopes: envelopes.map((e) => ({ ...e, headKm: +e.headKm.toFixed(2), dir: +e.dir.toFixed(0), lb: +e.lb.toFixed(2) })),
  };
}

// 'Bostancı' (OSM) and 'Bostanci' (GeoNames) are the same village
const normName = (n) => n.toLowerCase().replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ`'’ʼ-]/g, '').replace(/\s+/g, ' ').trim();

// Places threatened by a spread projection: inside an envelope or downwind within 30 km.
export function threatenedPlaces(ev, spread, extraPlaces = []) {
  const all = [...extraPlaces, ...townsNear(ev.lat, ev.lon, 60)];
  const dir = spread.envelopes.at(-1)?.dir ?? spread.windToward;
  const env24 = spread.envelopes.at(-1);
  const poly = env24 ? { type: 'Feature', geometry: { type: 'Polygon', coordinates: [env24.ring] } } : null;
  const avgRos = spread.track.length ? spread.track.reduce((a, t) => a + t.ros, 0) / spread.track.length : 0;
  const out = [];
  const kept = [];
  for (const p of all) {
    const d = distanceKm(ev.lat, ev.lon, p.lat, p.lon);
    if (d > 60) continue;
    // same settlement from OSM and GeoNames: keep the first (OSM has local detail)
    const name = normName(p.name);
    if (kept.some((q) => q.name === name && distanceKm(q.lat, q.lon, p.lat, p.lon) < 4)) continue;
    kept.push({ name, lat: p.lat, lon: p.lon });
    const b = bearingDeg(ev.lat, ev.lon, p.lat, p.lon);
    const off = Math.abs(((b - dir + 540) % 360) - 180);
    const inside = poly ? booleanPointInPolygon([p.lon, p.lat], poly) : false;
    const downwind = off <= 35;
    let level = 'watch';
    if (inside) level = 'danger';
    else if (downwind && d <= 15) level = 'warning';
    else if (downwind && d <= 30) level = 'watch';
    else if (d > 10) continue;
    out.push({
      ...p,
      distanceKm: +d.toFixed(1),
      bearing: Math.round(b),
      direction: compass(b),
      downwind,
      level,
      etaHours: downwind && avgRos > 0.05 ? +(d / avgRos).toFixed(1) : null,
      smokeExposed: off <= 45 && d <= 50,
    });
  }
  const rank = { danger: 0, warning: 1, watch: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.distanceKm - b.distanceKm);
}

// ---------- next-fire likelihood grid for a country ----------
const riskCache = new Map();
export async function riskGrid(iso, liveEvents) {
  const hit = riskCache.get(iso);
  if (hit && Date.now() - hit.t < 60 * 60 * 1000) return withActive(hit.v, liveEvents);
  const month = new Date().getUTCMonth();
  const clim = climatologyGrid(iso, month);
  const feature = geo().countries.fc.features.filter((f) => f.properties.iso === iso);
  if (!feature.length) return null;
  const [w, s, e, n] = bbox({ type: 'FeatureCollection', features: feature });
  // large countries use coarser cells so the weather request stays within Open-Meteo's limits
  // (600 locations a minute): United States and Canada 2°, Mexico 1°, every MENA country 0.5° as before
  const area = (e - w) * (n - s);
  const STEP = area > 2000 ? 2 : area > 600 ? 1 : 0.5;
  // historical frequency aggregated to 0.5° (max of the 0.25° sub-cells)
  const hist = new Map();
  for (const c of clim?.cells ?? []) {
    const k = `${Math.floor(c.lat / STEP)}_${Math.floor(c.lon / STEP)}`;
    hist.set(k, Math.max(hist.get(k) ?? 0, c.p));
  }
  const cells = [];
  for (let lat = Math.floor(s / STEP) * STEP; lat < n; lat += STEP)
    for (let lon = Math.floor(w / STEP) * STEP; lon < e; lon += STEP) {
      const clat = lat + STEP / 2;
      const clon = lon + STEP / 2;
      const k = `${Math.floor(clat / STEP)}_${Math.floor(clon / STEP)}`;
      const p = hist.get(k) ?? 0;
      const nearFire = liveEvents.some((ev) => Math.abs(ev.lat - clat) < 0.6 && Math.abs(ev.lon - clon) < 0.6);
      // skip places that essentially never burn (desert) unless a fire is close
      if (p < 0.08 && !nearFire) continue;
      if (!feature.some((f) => booleanPointInPolygon([clon, clat], f))) continue;
      cells.push({ lat: clat, lon: clon, hist: p });
    }
  let wx = [];
  let weatherAvailable = true;
  try {
    wx = await gridWeather(cells, 3);
  } catch (e) {
    weatherAvailable = false; // fall back to history + proximity only
    console.error('risk grid weather:', e.message);
  }
  cells.forEach((c, i) => {
    const d = wx[i];
    let maxFdi = 0;
    let rain = 0;
    for (let k = 0; k < (d?.time?.length ?? 0); k++) {
      maxFdi = Math.max(maxFdi, gfdi({ temp: d.temperature_2m_max[k], rh: d.relative_humidity_2m_min[k], wind: d.wind_speed_10m_max[k] }));
      rain += d.precipitation_sum[k] || 0;
    }
    c.fdi = +maxFdi.toFixed(1);
    c.rainMm = +rain.toFixed(1);
    c.windDir = d?.wind_direction_10m_dominant?.[0] ?? null;
    c.danger = d ? dangerClass(maxFdi).label : 'unknown';
    if (!d) c.fdi = 12.5; // neutral weather factor when the forecast is unavailable
  });
  const v = { iso, month, climYears: clim?.years ?? 0, step: STEP, cells, weatherAvailable, generated: new Date().toISOString() };
  if (weatherAvailable) riskCache.set(iso, { t: Date.now(), v });
  return withActive(v, liveEvents);
}

// Combine historical likelihood, weather danger and proximity/downwind of active fires.
function withActive(base, liveEvents) {
  const active = liveEvents.filter((e) => e.lastAgeH <= 48);
  const cells = base.cells.map((c) => {
    const weather = Math.min(1.6, 0.4 + c.fdi / 25) * (c.rainMm > 5 ? 0.4 : 1);
    let near = 0;
    for (const ev of active) {
      const d = distanceKm(c.lat, c.lon, ev.lat, ev.lon);
      if (d > 120) continue;
      let f = Math.exp(-d / 35);
      if (c.windDir !== null && d > 5) {
        const toward = (c.windDir + 180) % 360;
        const off = Math.abs(((bearingDeg(ev.lat, ev.lon, c.lat, c.lon) - toward + 540) % 360) - 180);
        if (off < 45) f *= 1.5;
      }
      near = Math.max(near, Math.min(1, f));
    }
    const score = 1 - (1 - Math.min(0.95, c.hist * weather)) * (1 - 0.7 * near);
    return { ...c, near: +near.toFixed(2), score: +score.toFixed(3) };
  });
  return { ...base, cells: cells.filter((c) => c.score > 0.02) };
}
