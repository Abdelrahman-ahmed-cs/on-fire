// Impact / damage estimates for a fire event.
//
//  • Settlements, buildings, roads and land cover around the fire: OpenStreetMap (Overpass API)
//  • Biomass burned from Fire Radiative Energy: 0.368 kg per MJ (Wooster et al. 2005)
//  • Emission factors, savanna & grassland (Andreae 2019), g per kg dry matter:
//      CO2 1660, CO 69, PM2.5 7.5, CH4 2.7
//  • Smoke exposure: Open-Meteo CAMS air-quality forecast
import { distanceKm, bearingDeg, compass } from './geo.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const UA = 'OnFire/1.0 (NASA Space Apps Challenge 2026; wildfire research app)';
const cache = new Map();

const EF = { co2: 1660, co: 69, pm25: 7.5, ch4: 2.7 }; // g/kg DM
const COMBUSTION = 0.368; // kg DM per MJ FRE
const HOURS_PER_DETECTION = 1; // effective burn duration represented by one satellite snapshot

export function emissions(event, fires) {
  const members = fires.filter((f) => f.event === event.id);
  const viirs = members.filter((f) => f.inst === 'VIIRS');
  // Avoid double counting the same fire seen by several satellites at once:
  // use one sensor family (VIIRS if available), then average across satellites.
  const use = viirs.length ? viirs : members;
  const sats = new Set(use.map((f) => f.sat)).size || 1;
  const frpMW = use.reduce((a, f) => a + f.frp, 0) / sats;
  const freMJ = frpMW * 3600 * HOURS_PER_DETECTION;
  const biomassT = (freMJ * COMBUSTION) / 1000;
  const t = (ef) => (biomassT * ef) / 1000;
  return {
    frpSumMW: +frpMW.toFixed(1),
    fireRadiativeEnergyGJ: +(freMJ / 1000).toFixed(1),
    biomassBurnedT: +biomassT.toFixed(1),
    co2T: +t(EF.co2).toFixed(1),
    coT: +t(EF.co).toFixed(2),
    pm25T: +t(EF.pm25).toFixed(3),
    ch4T: +t(EF.ch4).toFixed(3),
    carsPerYearEquivalent: +(t(EF.co2) / 4.6).toFixed(1), // US EPA: 4.6 t CO2 / passenger car / yr
    footprintKm2: +event.footprintKm2.toFixed(2),
    footprintHa: Math.round(event.footprintKm2 * 100),
    assumptions: `FRE ≈ ΣFRP × ${HOURS_PER_DETECTION} h per detection; ${COMBUSTION} kg/MJ (Wooster 2005); savanna/grassland emission factors (Andreae 2019). Footprint = unique ${viirs.length ? 'VIIRS 375 m' : 'MODIS 1 km'} pixel areas (upper bound of burned area).`,
  };
}

const LANDCOVER_LABELS = {
  forest: 'Forest', wood: 'Woodland', scrub: 'Shrubland / scrub', heath: 'Heath', grassland: 'Grassland', meadow: 'Meadow',
  farmland: 'Cropland', farmyard: 'Farmyard', orchard: 'Orchard', vineyard: 'Vineyard', plantation: 'Plantation',
  residential: 'Residential area', industrial: 'Industrial area', commercial: 'Commercial area', wetland: 'Wetland',
  sand: 'Sand / desert', bare_rock: 'Bare rock', desert: 'Desert', water: 'Water', reservoir: 'Reservoir',
  greenhouse_horticulture: 'Greenhouses', allotments: 'Gardens', cemetery: 'Cemetery', quarry: 'Quarry', military: 'Military area',
};
const VEGETATION = new Set(['forest', 'wood', 'scrub', 'heath', 'grassland', 'meadow', 'farmland', 'orchard', 'vineyard', 'plantation', 'wetland', 'greenhouse_horticulture', 'allotments']);
const TYPICAL_POP = { city: 100000, town: 15000, village: 1500, hamlet: 150, isolated_dwelling: 10 };

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// Settlements within 20 km, buildings within 1 km, land cover & roads within 1.5 km.
// Overpass is slow (5-20 s): callers can peek at the cache and start the query
// in the background, then fetch the result separately.
const inflight = new Map();
const keyOf = (lat, lon) => `${lat.toFixed(3)}_${lon.toFixed(3)}`;
export function cachedSurroundings(lat, lon) {
  const hit = cache.get(keyOf(lat, lon));
  return hit && Date.now() - hit.t < 6 * 3600 * 1000 ? hit.v : null;
}
export function surroundings(lat, lon) {
  const key = keyOf(lat, lon);
  const hit = cachedSurroundings(lat, lon);
  if (hit) return Promise.resolve(hit);
  if (!inflight.has(key)) inflight.set(key, fetchSurroundings(lat, lon).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function fetchSurroundings(lat, lon) {
  const key = keyOf(lat, lon);
  const q = `[out:json][timeout:25];
node(around:20000,${lat},${lon})[place~"^(city|town|village|hamlet)$"]->.p;
.p out tags center;
(way(around:1500,${lat},${lon})[landuse];way(around:1500,${lat},${lon})[natural];relation(around:1500,${lat},${lon})[landuse];)->.l;
.l out tags;
way(around:1000,${lat},${lon})[building]->.b;
.b out count;
way(around:1500,${lat},${lon})[highway~"^(motorway|trunk|primary|secondary|tertiary)$"]->.r;
.r out tags;
(node(around:5000,${lat},${lon})[amenity~"^(school|hospital|clinic|fire_station)$"];way(around:5000,${lat},${lon})[amenity~"^(school|hospital|clinic|fire_station)$"];)->.a;
.a out tags center;`;
  const j = await overpass(q);
  const places = [];
  const landcover = {};
  const roads = new Set();
  const facilities = [];
  let buildings = 0;
  for (const el of j.elements) {
    const t = el.tags ?? {};
    if (el.type === 'count') {
      buildings = +(el.tags?.ways ?? el.tags?.total ?? 0);
      continue;
    }
    if (t.place && el.lat) {
      const pop = +String(t.population ?? '').replace(/[^\d]/g, '') || null;
      places.push({
        name: t['name:en'] || t.name || t['name:ar'] || `Unnamed ${t.place}`,
        nameLocal: t.name,
        kind: t.place,
        pop: pop ?? TYPICAL_POP[t.place],
        popEstimated: !pop,
        lat: el.lat,
        lon: el.lon,
        distanceKm: +distanceKm(lat, lon, el.lat, el.lon).toFixed(1),
        direction: compass(bearingDeg(lat, lon, el.lat, el.lon)),
        source: 'OpenStreetMap',
      });
      continue;
    }
    if (t.amenity && (el.lat || el.center)) {
      const p = el.center ?? el;
      facilities.push({ type: t.amenity, name: t['name:en'] || t.name || t.amenity, distanceKm: +distanceKm(lat, lon, p.lat, p.lon).toFixed(1) });
      continue;
    }
    if (t.highway) {
      roads.add(t.ref || t['name:en'] || t.name || t.highway);
      continue;
    }
    const lc = t.landuse || t.natural;
    if (lc && LANDCOVER_LABELS[lc]) {
      const label = LANDCOVER_LABELS[t.landuse === 'orchard' && t.trees ? 'orchard' : lc] + (t.trees || t.crop ? ` (${t.trees || t.crop})` : '');
      landcover[label] = (landcover[label] || 0) + 1;
    }
  }
  places.sort((a, b) => a.distanceKm - b.distanceKm);
  const v = {
    places,
    landcover: Object.entries(landcover).map(([label, n]) => ({ label, n, vegetation: [...VEGETATION].some((k) => label.startsWith(LANDCOVER_LABELS[k])) })).sort((a, b) => b.n - a.n),
    buildingsWithin1km: buildings,
    majorRoads: [...roads].slice(0, 8),
    facilities: facilities.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 10),
  };
  cache.set(key, { t: Date.now(), v });
  return v;
}

export function populationExposure(places) {
  const within = (km) => places.filter((p) => p.distanceKm <= km).reduce((a, p) => a + (p.pop || 0), 0);
  return { within5km: within(5), within10km: within(10), within20km: within(20), settlementsWithin10km: places.filter((p) => p.distanceKm <= 10).length };
}

export function aqiCategory(usAqi) {
  if (usAqi === null || usAqi === undefined) return null;
  if (usAqi <= 50) return { label: 'Good', color: '#00e400' };
  if (usAqi <= 100) return { label: 'Moderate', color: '#ffff00' };
  if (usAqi <= 150) return { label: 'Unhealthy for sensitive groups', color: '#ff7e00' };
  if (usAqi <= 200) return { label: 'Unhealthy', color: '#ff0000' };
  if (usAqi <= 300) return { label: 'Very unhealthy', color: '#8f3f97' };
  return { label: 'Hazardous', color: '#7e0023' };
}
