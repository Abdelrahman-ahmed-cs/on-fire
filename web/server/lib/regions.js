// Regions and countries shared by the pipeline and the API.
// `firms` is the country name used by FIRMS yearly country archive files.

export const MENA_BBOX = { west: -18, south: 8, east: 64, north: 43 };
// North America: Alaska's Aleutian tail past 180° is left out (no fire record there).
export const NAM_BBOX = { west: -180, south: 14, east: -52, north: 72 };

export const REGIONS = {
  MENA: { id: 'MENA', name: 'Middle East & North Africa', bbox: MENA_BBOX },
  NAM: { id: 'NAM', name: 'North America', bbox: NAM_BBOX },
};
export const REGION_IDS = Object.keys(REGIONS);
export const regionOf = (id) => REGIONS[String(id || '').toUpperCase()] ?? REGIONS.MENA;

export const COUNTRIES = [
  { iso: 'MAR', name: 'Morocco', firms: 'Morocco', region: 'MENA' },
  { iso: 'ESH', name: 'Western Sahara', firms: null, region: 'MENA' }, // FIRMS archive files include it under Morocco
  { iso: 'DZA', name: 'Algeria', firms: 'Algeria', region: 'MENA' },
  { iso: 'TUN', name: 'Tunisia', firms: 'Tunisia', region: 'MENA' },
  { iso: 'LBY', name: 'Libya', firms: 'Libya', region: 'MENA' },
  { iso: 'EGY', name: 'Egypt', firms: 'Egypt', region: 'MENA' },
  { iso: 'SDN', name: 'Sudan', firms: 'Sudan', region: 'MENA' },
  { iso: 'MRT', name: 'Mauritania', firms: 'Mauritania', region: 'MENA' },
  { iso: 'ISR', name: 'Israel', firms: 'Israel', region: 'MENA' },
  { iso: 'PSE', name: 'Palestine', firms: 'Palestine', region: 'MENA' },
  { iso: 'JOR', name: 'Jordan', firms: 'Jordan', region: 'MENA' },
  { iso: 'LBN', name: 'Lebanon', firms: 'Lebanon', region: 'MENA' },
  { iso: 'SYR', name: 'Syria', firms: 'Syria', region: 'MENA' },
  { iso: 'IRQ', name: 'Iraq', firms: 'Iraq', region: 'MENA' },
  { iso: 'IRN', name: 'Iran', firms: 'Iran', region: 'MENA' },
  { iso: 'TUR', name: 'Türkiye', firms: 'Turkey', region: 'MENA' },
  { iso: 'SAU', name: 'Saudi Arabia', firms: 'Saudi_Arabia', region: 'MENA' },
  { iso: 'YEM', name: 'Yemen', firms: 'Yemen', region: 'MENA' },
  { iso: 'OMN', name: 'Oman', firms: 'Oman', region: 'MENA' },
  { iso: 'ARE', name: 'United Arab Emirates', firms: 'United_Arab_Emirates', region: 'MENA' },
  { iso: 'QAT', name: 'Qatar', firms: 'Qatar', region: 'MENA' },
  { iso: 'BHR', name: 'Bahrain', firms: 'Bahrain', region: 'MENA' },
  { iso: 'KWT', name: 'Kuwait', firms: 'Kuwait', region: 'MENA' },
  { iso: 'CYP', name: 'Cyprus', firms: 'Cyprus', region: 'MENA' },
  { iso: 'USA', name: 'United States', firms: 'United_States', region: 'NAM' },
  { iso: 'CAN', name: 'Canada', firms: 'Canada', region: 'NAM' },
  { iso: 'MEX', name: 'Mexico', firms: 'Mexico', region: 'NAM' },
];

export const ISO_SET = new Set(COUNTRIES.map((c) => c.iso));
export const countryByIso = Object.fromEntries(COUNTRIES.map((c) => [c.iso, c]));
export const countriesIn = (region) => COUNTRIES.filter((c) => c.region === region);
export const regionOfIso = (iso) => countryByIso[iso]?.region ?? null;
export const inBbox = (b, lat, lon) => lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;

// Natural Earth uses a few non-ISO codes; map them onto our list.
export const NE_CODE_ALIASES = { SAH: 'ESH', PSX: 'PSE', CYN: 'CYP' };
