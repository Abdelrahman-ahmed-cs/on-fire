// FIRMS CSV parsing + normalisation shared by the archive pipeline and live API.

export const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov';

// Parse a FIRMS CSV (MODIS or VIIRS flavour) into normalised hotspot records.
export function parseFirmsCsv(text, source = '') {
  const lines = text.split('\n');
  const header = lines[0]?.trim().split(',') ?? [];
  if (!header.includes('latitude')) return [];
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 10) continue;
    const c = line.split(',');
    const inst = (c[idx.instrument] || '').trim() || (source.startsWith('MODIS') ? 'MODIS' : 'VIIRS');
    const rawConf = c[idx.confidence]?.trim();
    out.push({
      lat: +c[idx.latitude],
      lon: +c[idx.longitude],
      date: c[idx.acq_date],
      time: (c[idx.acq_time] || '').trim().padStart(4, '0'),
      sat: normSat(c[idx.satellite], inst),
      inst,
      conf: inst === 'MODIS' ? +rawConf : rawConf, // MODIS 0-100, VIIRS l/n/h
      frp: +c[idx.frp] || 0,
      dn: (c[idx.daynight] || '').trim(),
      type: idx.type !== undefined ? +c[idx.type] : null, // 0 veg fire, 1 volcano, 2 static land, 3 offshore
      scan: +c[idx.scan] || null,
      track: +c[idx.track] || null,
      bright: +(c[idx.brightness] ?? c[idx.bright_ti4]) || null,
    });
  }
  return out;
}

function normSat(s, inst) {
  s = (s || '').trim();
  if (inst === 'MODIS') return s === 'T' || s === 'Terra' ? 'Terra' : 'Aqua';
  if (s === 'N' || s === 'Suomi NPP' || s === '1') return 'S-NPP';
  if (s === 'N20' || s === '20' || s === 'NOAA-20') return 'NOAA-20';
  if (s === 'N21' || s === '21' || s === 'NOAA-21') return 'NOAA-21';
  return s || 'VIIRS';
}

// Common confidence filter so both sensors are thresholded comparably:
// MODIS >= 30% (nominal+high), VIIRS nominal/high (drop "low").
export function passesConfidence(f) {
  if (f.inst === 'MODIS') return f.conf >= 30;
  return f.conf !== 'l' && f.conf !== 'low';
}

export const isStaticType = (t) => t === 1 || t === 2 || t === 3;

// ~1 km cells used to remember persistent non-vegetation heat sources (gas flares, industry).
export const staticKey = (lat, lon) => `${Math.round(lat * 100)}_${Math.round(lon * 100)}`;

export function isStaticLocation(mask, lat, lon) {
  if (!mask) return false;
  const y = Math.round(lat * 100);
  const x = Math.round(lon * 100);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (mask.has(`${y + dy}_${x + dx}`)) return true;
  return false;
}

// 0.1° cells used for the "cell-day" harmonisation metric.
export const cell01 = (lat, lon) => `${Math.floor(lat * 10)}_${Math.floor(lon * 10)}`;
// 0.25° cells used for climatology / risk grids.
export const cell025 = (lat, lon) => `${Math.floor(lat * 4)}_${Math.floor(lon * 4)}`;

export function dayOfYear(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000);
}

export async function fetchText(url, { retries = 3 } = {}) {
  for (let a = 0; ; a++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) }); // a stalled request must not block the app
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (a >= retries) throw new Error(`${url}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (a + 1)));
    }
  }
}
