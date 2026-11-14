// Geometry helpers: country / province lookup, distances, bearings.
import fs from 'node:fs';
import path from 'node:path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';

const GEO_DIR = path.resolve(import.meta.dirname, '../../data/geo');

function loadIndexed(file) {
  const fc = JSON.parse(fs.readFileSync(path.join(GEO_DIR, file), 'utf8'));
  return { fc, index: fc.features.map((f) => ({ f, bb: bbox(f) })) };
}

let cache;
export function geo() {
  if (!cache) {
    const countries = loadIndexed('countries.geojson');
    const provinces = loadIndexed('provinces.geojson');
    const places = JSON.parse(fs.readFileSync(path.join(GEO_DIR, 'places.geojson'), 'utf8'));
    cache = { countries, provinces, places };
  }
  return cache;
}

function lookup(index, lon, lat) {
  const pt = [lon, lat];
  for (const { f, bb } of index) {
    if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
    if (booleanPointInPolygon(pt, f)) return f.properties;
  }
  return null;
}

export const countryAt = (lon, lat) => lookup(geo().countries.index, lon, lat);
export const provinceAt = (lon, lat) => lookup(geo().provinces.index, lon, lat);

const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
// Move a point `km` along `bearing` degrees.
export function destination(lat, lon, km, bearing) {
  const d = km / R;
  const b = rad(bearing);
  const la1 = rad(lat);
  const lo1 = rad(lon);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
}
export const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

// ---------- GeoNames towns (population ≥ 1000), grid-indexed ----------
let townIndex;
function towns() {
  if (!townIndex) {
    townIndex = new Map();
    let rows = [];
    try {
      rows = JSON.parse(fs.readFileSync(path.join(GEO_DIR, 'towns.json'), 'utf8'));
    } catch {
      rows = geo().places.features.map((f) => [f.properties.name, f.geometry.coordinates[1], f.geometry.coordinates[0], f.properties.pop, 'PPL']);
    }
    for (const [name, lat, lon, pop, code] of rows) {
      const k = `${Math.floor(lat * 2)}_${Math.floor(lon * 2)}`;
      if (!townIndex.has(k)) townIndex.set(k, []);
      townIndex.get(k).push({ name, lat, lon, pop, kind: code === 'PPLC' || code === 'PPLA' || pop >= 100000 ? 'city' : pop >= 10000 ? 'town' : 'village', source: 'GeoNames' });
    }
  }
  return townIndex;
}

// Settlements within `km` of a point, nearest first.
export function townsNear(lat, lon, km, minPop = 0) {
  const idx = towns();
  const r = Math.ceil((km / 111) * 2) + 1;
  const cy = Math.floor(lat * 2);
  const cx = Math.floor(lon * 2);
  const out = [];
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++)
      for (const t of idx.get(`${y}_${x}`) ?? []) {
        if (t.pop < minPop) continue;
        const d = distanceKm(lat, lon, t.lat, t.lon);
        if (d <= km) out.push({ ...t, distanceKm: +d.toFixed(1), direction: compass(bearingDeg(lat, lon, t.lat, t.lon)) });
      }
  return out.sort((a, b) => a.distanceKm - b.distanceKm);
}
