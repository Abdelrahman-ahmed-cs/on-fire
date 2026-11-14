// Open-Meteo weather + air quality (free, no key), with a small in-memory cache.
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TTL = 30 * 60 * 1000;
const cache = new Map();

// Open-Meteo's free tier counts every location in a request (600/min, 10k/day),
// so responses are cached and a stale copy is served if the limit is hit.
async function cachedJson(url, ttl = TTL) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const res = await fetch(url);
  if (!res.ok) {
    if (hit) return hit.v;
    throw new Error(res.status === 429 ? 'Weather service busy (rate limit), try again in a minute' : `Open-Meteo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const v = await res.json();
  cache.set(url, { t: Date.now(), v });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return v;
}

const r2 = (v) => Math.round(v * 100) / 100;

const HOURLY = 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,vapour_pressure_deficit';

// Detailed forecast for one point (current + 72 h hourly).
export async function pointWeather(lat, lon) {
  const url = `${FORECAST}?latitude=${r2(lat)}&longitude=${r2(lon)}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation&hourly=${HOURLY}&forecast_hours=72&wind_speed_unit=kmh&timezone=UTC`;
  const j = await cachedJson(url);
  const h = j.hourly;
  return {
    current: j.current,
    hourly: h.time.map((t, i) => ({
      t,
      temp: h.temperature_2m[i],
      rh: h.relative_humidity_2m[i],
      wind: h.wind_speed_10m[i],
      dir: h.wind_direction_10m[i],
      gust: h.wind_gusts_10m[i],
      rain: h.precipitation[i],
      vpd: h.vapour_pressure_deficit[i],
    })),
  };
}

// Daily fire-weather drivers for many points (batched, ≤100 per request).
export async function gridWeather(points, days = 3) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    const url = `${FORECAST}?latitude=${batch.map((p) => r2(p.lat)).join(',')}&longitude=${batch.map((p) => r2(p.lon)).join(',')}&daily=temperature_2m_max,relative_humidity_2m_min,wind_speed_10m_max,wind_direction_10m_dominant,precipitation_sum&forecast_days=${days}&wind_speed_unit=kmh&timezone=UTC`;
    const j = await cachedJson(url, 3 * 3600 * 1000);
    const arr = Array.isArray(j) ? j : [j];
    arr.forEach((r) => out.push(r.daily));
  }
  return out;
}

// Current wind for a coarse grid (for wind arrows on the map).
export async function windField(points) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    const url = `${FORECAST}?latitude=${batch.map((p) => r2(p.lat)).join(',')}&longitude=${batch.map((p) => r2(p.lon)).join(',')}&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kmh`;
    const j = await cachedJson(url, 60 * 60 * 1000);
    (Array.isArray(j) ? j : [j]).forEach((r, k) => out.push({ ...batch[k], speed: r.current.wind_speed_10m, dir: r.current.wind_direction_10m }));
  }
  return out;
}

export async function airQuality(lat, lon) {
  const url = `${AIR}?latitude=${r2(lat)}&longitude=${r2(lon)}&current=pm2_5,pm10,carbon_monoxide,nitrogen_dioxide,aerosol_optical_depth,dust,us_aqi,european_aqi&hourly=pm2_5,carbon_monoxide&forecast_hours=48&timezone=UTC`;
  const j = await cachedJson(url);
  return {
    current: j.current,
    hourly: j.hourly.time.map((t, i) => ({ t, pm25: j.hourly.pm2_5[i], co: j.hourly.carbon_monoxide[i] })),
  };
}

export async function airQualityMany(points) {
  if (!points.length) return [];
  const url = `${AIR}?latitude=${points.map((p) => r2(p.lat)).join(',')}&longitude=${points.map((p) => r2(p.lon)).join(',')}&current=pm2_5,us_aqi`;
  const j = await cachedJson(url);
  return (Array.isArray(j) ? j : [j]).map((r) => r.current);
}
