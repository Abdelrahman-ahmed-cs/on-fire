// Downloads Natural Earth boundaries + populated places and produces compact
// GeoJSON for our regions (MENA + North America) files in data/geo/. Run once: `npm run setup:geo`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { ISO_SET, NE_CODE_ALIASES, countryByIso, REGIONS, inBbox } from '../lib/regions.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RAW = path.join(ROOT, 'data/raw');
const OUT = path.join(ROOT, 'data/geo');
fs.mkdirSync(RAW, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const SOURCES = {
  countries: `${NE}/ne_10m_admin_0_countries.geojson`,
  provinces: `${NE}/ne_10m_admin_1_states_provinces.geojson`,
  places: `${NE}/ne_10m_populated_places.geojson`,
};

async function download(name, url) {
  const file = path.join(RAW, `${name}.geojson`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  console.log(`Downloading ${name} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const isoOf = (p) => {
  for (const code of [p.ADM0_A3, p.adm0_a3, p.ISO_A3, p.iso_a3, p.ISO_A3_EH, p.SOV_A3, p.sov_a3]) {
    if (!code) continue;
    const c = NE_CODE_ALIASES[code] ?? code;
    if (ISO_SET.has(c)) return c;
  }
  return null;
};

const round = (v) => Math.round(v * 1e4) / 1e4;
function roundCoords(c) {
  return typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(roundCoords);
}

function simplify(inFile, outFile, pct) {
  const bin = path.join(ROOT, 'node_modules/mapshaper/bin/mapshaper');
  execFileSync(process.execPath, [bin, inFile, '-simplify', `${pct}%`, 'keep-shapes', '-clean', '-o', outFile, 'precision=0.0001', 'format=geojson'], { stdio: 'inherit' });
}

async function main() {
  const labels = [];
  const files = {};
  for (const [k, url] of Object.entries(SOURCES)) files[k] = await download(k, url);

  // Countries
  const countries = JSON.parse(fs.readFileSync(files.countries, 'utf8'));
  const cFeatures = countries.features
    .map((f) => {
      const iso = isoOf(f.properties);
      if (!iso) return null;
      if (f.properties.LABEL_X && f.properties.ADM0_A3 !== 'CYN') labels.push({ type: 'Feature', properties: { kind: 'country', iso, id: iso, name: countryByIso[iso].name }, geometry: { type: 'Point', coordinates: [f.properties.LABEL_X, f.properties.LABEL_Y] } });
      return { type: 'Feature', properties: { iso, name: countryByIso[iso].name }, geometry: f.geometry };
    })
    .filter(Boolean);
  const cTmp = path.join(RAW, 'mena_countries_full.geojson');
  fs.writeFileSync(cTmp, JSON.stringify({ type: 'FeatureCollection', features: cFeatures }));
  simplify(cTmp, path.join(OUT, 'countries.geojson'), 12);
  console.log(`countries: ${cFeatures.length} features`);

  // Provinces (admin-1)
  const provinces = JSON.parse(fs.readFileSync(files.provinces, 'utf8'));
  let pid = 0;
  // MENA provinces first, so their ids stay the same as before North America was added
  const menaFirst = (f) => (countryByIso[isoOf(f.properties)]?.region === 'MENA' ? 0 : 1);
  const pFeatures = provinces.features
    .filter((f) => isoOf(f.properties))
    .sort((a, b) => menaFirst(a) - menaFirst(b))
    .map((f) => {
      const iso = isoOf(f.properties);
      if (!iso) return null;
      const p = f.properties;
      const id = `${iso}-${pid++}`;
      if (p.longitude) labels.push({ type: 'Feature', properties: { kind: 'province', iso, id, name: p.name_en || p.name || 'Unknown' }, geometry: { type: 'Point', coordinates: [+p.longitude, +p.latitude] } });
      return {
        type: 'Feature',
        properties: { id, iso, name: p.name_en || p.name || p.woe_name || 'Unknown', type: p.type_en || p.type || '' },
        geometry: f.geometry,
      };
    })
    .filter(Boolean);
  const pTmp = path.join(RAW, 'mena_provinces_full.geojson');
  fs.writeFileSync(pTmp, JSON.stringify({ type: 'FeatureCollection', features: pFeatures }));
  simplify(pTmp, path.join(OUT, 'provinces.geojson'), 8);
  console.log(`provinces: ${pFeatures.length} features`);
  fs.writeFileSync(path.join(OUT, 'labels.geojson'), JSON.stringify({ type: 'FeatureCollection', features: labels }));
  console.log(`labels: ${labels.length}`);

  // Populated places
  const places = JSON.parse(fs.readFileSync(files.places, 'utf8'));
  const inRegion = (lat, lon) => Object.values(REGIONS).some((r) => inBbox(r.bbox, lat, lon));
  const plFeatures = places.features
    .filter((f) => {
      const [x, y] = f.geometry.coordinates;
      return inRegion(y, x);
    })
    .map((f) => {
      const p = f.properties;
      return {
        type: 'Feature',
        properties: {
          name: p.NAME_EN || p.NAME || p.name,
          iso: NE_CODE_ALIASES[p.ADM0_A3] ?? p.ADM0_A3,
          pop: Math.max(p.POP_MAX || 0, p.POP_MIN || 0),
          capital: p.FEATURECLA?.includes('capital') ? 1 : 0,
        },
        geometry: { type: 'Point', coordinates: roundCoords(f.geometry.coordinates) },
      };
    });
  fs.writeFileSync(path.join(OUT, 'places.geojson'), JSON.stringify({ type: 'FeatureCollection', features: plFeatures }));
  console.log(`places: ${plFeatures.length} features`);

  // GeoNames: every populated place with ≥1000 people (CC-BY 4.0, geonames.org)
  const txt = path.join(RAW, 'cities1000.txt');
  if (!fs.existsSync(txt)) {
    const zip = path.join(RAW, 'cities1000.zip');
    console.log('Downloading GeoNames cities1000 …');
    const res = await fetch('https://download.geonames.org/export/dump/cities1000.zip');
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    try {
      execSync(`tar -xf "${zip}" -C "${RAW}"`);
    } catch {
      execSync(`unzip -o "${zip}" -d "${RAW}"`);
    }
  }
  const towns = [];
  for (const line of fs.readFileSync(txt, 'utf8').split('\n')) {
    const c = line.split('\t');
    if (c.length < 15) continue;
    const lat = +c[4], lon = +c[5];
    if (!inRegion(lat, lon)) continue;
    towns.push([c[2] || c[1], +lat.toFixed(4), +lon.toFixed(4), +c[14] || 0, c[7]]);
  }
  fs.writeFileSync(path.join(OUT, 'towns.json'), JSON.stringify(towns));
  console.log(`towns: ${towns.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
