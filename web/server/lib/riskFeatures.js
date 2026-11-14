// Features for the fire-danger model. One sample = one 0.5° cell (~50 km) × one month.
// Shared by training (scripts/train-risk-model.js) and live prediction (lib/ml.js).

export const FEATURES = [
  // history (the strongest signal: fire regimes repeat)
  'hist_freq',      // share of previous years with fire in this cell in this calendar month
  'hist_any',       // share of previous years with any fire in this cell
  'neigh_freq',     // same as hist_freq, averaged over the 8 neighbouring cells
  'last_year',      // fire in this cell-month last year (0/1)
  'prev_month',     // fire in this cell in the previous month (0/1)
  // weather of the month (NASA POWER / forecast)
  'tmax',           // mean daily maximum temperature (°C)
  'tmax_anom',      // tmax minus the normal for this cell and month (heatwave signal)
  'rain',           // precipitation (mm/day)
  'rh',             // relative humidity (%)
  'wind',           // wind speed at 10 m (m/s)
  'soil_wet',       // root-zone soil wetness (0 dry – 1 saturated)
  // fuel & drought build-up
  'rain_prev3',     // mean precipitation of the 3 previous months (drought)
  'rain_prev6',     // mean precipitation of the 6 previous months (grass growth → fuel)
  'soil_prev',      // soil wetness of the previous month
  // place & season
  'elev', 'lat', 'lon', 'm_sin', 'm_cos',
];

export const FEATURE_INDEX = Object.fromEntries(FEATURES.map((f, i) => [f, i]));

// Plain-language groups used to explain predictions and importance.
export const GROUPS = {
  history: { label: 'Fire history of the place', features: ['hist_freq', 'hist_any', 'neigh_freq', 'last_year', 'prev_month'] },
  heat: { label: 'Heat & heatwaves', features: ['tmax', 'tmax_anom'] },
  dryness: { label: 'Dryness (rain, humidity, soil)', features: ['rain', 'rh', 'soil_wet', 'rain_prev3', 'soil_prev'] },
  fuel: { label: 'Grass/fuel grown by past rain', features: ['rain_prev6'] },
  wind: { label: 'Wind', features: ['wind'] },
  place: { label: 'Season, landscape & location', features: ['elev', 'lat', 'lon', 'm_sin', 'm_cos'] },
};

export function vector(o) {
  const x = new Float64Array(FEATURES.length);
  FEATURES.forEach((f, i) => (x[i] = o[f] ?? NaN));
  return x;
}

export const monthSin = (m) => Math.sin((2 * Math.PI * m) / 12);
export const monthCos = (m) => Math.cos((2 * Math.PI * m) / 12);
