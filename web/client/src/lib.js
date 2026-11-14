// Shared helpers: API access, formatting, colour scales.

export async function api(path) {
  const res = await fetch(path);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

// The regions the app covers. bounds = flat-map view, globe = 3D globe centre.
export const REGIONS = [
  { id: 'MENA', name: 'Middle East & North Africa', short: 'Middle East & Africa', countries: 24, bounds: [[-18, 8], [64, 43]], globe: [24, 26] },
  { id: 'NAM', name: 'North America', short: 'North America', countries: 3, bounds: [[-168, 14], [-52, 72]], globe: [-100, 45] },
];
export const regionById = (id) => REGIONS.find((r) => r.id === id) ?? REGIONS[0];
const NAM_ISOS = new Set(['USA', 'CAN', 'MEX']);
export const regionOfIso = (iso) => (NAM_ISOS.has(iso) ? 'NAM' : 'MENA');

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const nf = new Intl.NumberFormat('en-US');
export const fmt = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : nf.format(+(+v).toFixed(d)));
export function compact(v) {
  if (v === null || v === undefined) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return Math.round(v / 1e3) + 'k';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return fmt(v, a < 10 && v % 1 ? 1 : 0);
}
export function ago(hours) {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min ago`;
  if (hours < 48) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
export const utcTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

// Chart series (categorical, dark-mode steps of the reference palette, fixed order)
export const SERIES = { modis: '#3987e5', viirs: '#d95926', scaled: '#199e70' };

// Sequential fire-activity ramp (single orange hue, light → dark on a dark surface: brighter = more)
export const ACTIVITY_RAMP = ['#4a2a12', '#7a3b10', '#a8500f', '#d06a14', '#ec8a2c', '#f8ad5c', '#ffd39a'];
export function activityColor(v, max) {
  if (!v || v <= 0 || !max) return '#23262d';
  const t = Math.log1p(v) / Math.log1p(max);
  return ACTIVITY_RAMP[Math.min(ACTIVITY_RAMP.length - 1, Math.floor(t * ACTIVITY_RAMP.length))];
}

// Diverging anomaly scale: blue (below normal) ↔ gray ↔ red (above normal)
const DIV_NEG = ['#104281', '#1c5cab', '#3987e5', '#86b6ef'];
const DIV_POS = ['#f0a3a3', '#e66767', '#d03b3b', '#8f1d1d'];
export function anomalyColor(z) {
  if (z === null || z === undefined) return '#23262d';
  if (Math.abs(z) < 0.5) return '#383835';
  const i = Math.min(3, Math.floor((Math.abs(z) - 0.5) / 0.75));
  return z > 0 ? DIV_POS[i] : DIV_NEG[3 - i];
}

// Fire intensity (FRP, MW) classes used on the map and legend
export const FRP_CLASSES = [
  { min: 0, color: '#ffe066', label: '< 5 MW' },
  { min: 5, color: '#ffb000', label: '5–15' },
  { min: 15, color: '#ff7a00', label: '15–40' },
  { min: 40, color: '#ff3b1f', label: '40–100' },
  { min: 100, color: '#d6004c', label: '≥ 100 MW' },
];

export const DANGER_LEVELS = [
  { label: 'Low–moderate', color: '#8ac926' },
  { label: 'High', color: '#ffba08' },
  { label: 'Very high', color: '#f48c06' },
  { label: 'Severe', color: '#e85d04' },
  { label: 'Extreme', color: '#c1121f' },
  { label: 'Catastrophic', color: '#7f0000' },
];

export const LEVEL_STYLE = {
  danger: { color: '#ff3b3b', label: 'In spread zone' },
  warning: { color: '#ff9f1c', label: 'Downwind < 15 km' },
  watch: { color: '#ffd166', label: 'Watch' },
};

export const RISK_RAMP = [
  [0.05, '#fff3b0'],
  [0.15, '#ffd166'],
  [0.3, '#f8961e'],
  [0.5, '#f3722c'],
  [0.7, '#d62828'],
];

export function compassName(deg) {
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(deg / 45) % 8];
}

// Same tint the map uses for country / province activity (opacity grows with activity).
export function tintColor(v, max, maxOpacity = 0.5) {
  if (!v || !max) return 'rgba(255,74,28,0.04)';
  const a = 0.04 + (maxOpacity - 0.04) * Math.sqrt(v / max);
  return `rgba(255,74,28,${Math.min(1, a * 1.6).toFixed(2)})`;
}

export function quantileColor(v, breaks) {
  if (!v || v <= 0) return '#23262d';
  let i = 0;
  while (i < breaks.length && v > breaks[i]) i++;
  return ACTIVITY_RAMP[i];
}

// ---------- plain-language helpers ----------

// Fire strength from Fire Radiative Power (MW)
export const STRENGTH = [
  { min: 0, word: 'Small', r: 3 },
  { min: 5, word: 'Medium', r: 5 },
  { min: 20, word: 'Large', r: 7 },
  { min: 50, word: 'Very large', r: 9 },
  { min: 100, word: 'Extreme', r: 11 },
];
export const strengthWord = (frp) => [...STRENGTH].reverse().find((s) => frp >= s.min)?.word ?? 'Small';
// Event strength uses the total power of all its detections
export const eventStrength = (frpSum) => (frpSum >= 1000 ? 'Extreme' : frpSum >= 300 ? 'Very large' : frpSum >= 100 ? 'Large' : frpSum >= 25 ? 'Medium' : 'Small');
export const STRENGTH_COLOR = { Small: '#ffd166', Medium: '#ffb000', Large: '#ff7a00', 'Very large': '#ff3b1f', Extreme: '#d6004c' };

// Fire age classes (map colour)
export const AGE = [
  { max: 6, color: '#ff2a2a', label: 'Burning now', sub: 'seen in last 6 h' },
  { max: 24, color: '#ff9f1c', label: 'Today', sub: '6–24 h ago' },
  { max: 1e9, color: '#9c6b43', label: 'Earlier', sub: 'up to 7 days ago' },
];

export function speedWord(kmPerDay) {
  if (kmPerDay < 1) return 'barely moving';
  if (kmPerDay < 5) return 'moving slowly';
  if (kmPerDay < 20) return 'spreading';
  return 'spreading fast';
}

export function listJoin(items) {
  const a = items.filter(Boolean);
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

export function normalWord(ratio) {
  if (ratio === null || ratio === undefined) return null;
  if (ratio >= 1.5) return { word: 'much busier than normal', tone: 'up' };
  if (ratio >= 1.15) return { word: 'busier than normal', tone: 'up' };
  if (ratio > 0.85) return { word: 'about normal', tone: '' };
  if (ratio > 0.5) return { word: 'quieter than normal', tone: 'down' };
  return { word: 'much quieter than normal', tone: 'down' };
}

export const PLACE_STATUS = {
  danger: { color: '#ff3b3b', label: 'In the fire path', icon: '⛔' },
  warning: { color: '#ff9f1c', label: 'Close & downwind', icon: '⚠️' },
  watch: { color: '#ffd166', label: 'Keep watching', icon: '👁' },
};

// Great-circle destination (lon, lat) – same as the server helper
export function destination(lat, lon, km, bearing) {
  const R = 6371;
  const d = km / R;
  const b = (bearing * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
  const lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
}

// ---------- downloads ----------
export function downloadFile(name, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const csvCell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
export const fileStamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
export const slug = (s) => String(s ?? 'area').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---------- great-circle path (the flight between regions) ----------
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
export function greatCircle([lon1, lat1], [lon2, lat2], n = 160) {
  const p1 = [Math.cos(rad(lat1)) * Math.cos(rad(lon1)), Math.cos(rad(lat1)) * Math.sin(rad(lon1)), Math.sin(rad(lat1))];
  const p2 = [Math.cos(rad(lat2)) * Math.cos(rad(lon2)), Math.cos(rad(lat2)) * Math.sin(rad(lon2)), Math.sin(rad(lat2))];
  const d = Math.acos(Math.min(1, p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const a = Math.sin((1 - f) * d) / Math.sin(d), b = Math.sin(f * d) / Math.sin(d);
    const x = a * p1[0] + b * p2[0], y = a * p1[1] + b * p2[1], z = a * p1[2] + b * p2[2];
    out.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  return { points: out, km: d * 6371 };
}
export function bearingDeg([lon1, lat1], [lon2, lat2]) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// ---------- alert file for one fire (CAP 1.2, fixed English template) ----------
// Decision support for authorities: scope Restricted, certainty Possible, never an evacuation order.
const xml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function fireAlertCap(detail) {
  const e = detail.event;
  const sp = detail.spread;
  const inPath = (detail.threatened ?? []).filter((p) => p.level !== 'watch');
  const now = new Date();
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const expires = new Date(now.getTime() + 24 * 3600 * 1000);
  const severity = inPath.some((p) => p.level === 'danger') ? 'Severe' : inPath.length ? 'Moderate' : 'Minor';
  const last = sp?.envelopes?.at(-1);
  const ring = last?.ring ?? null;
  const towns = inPath.slice(0, 8).map((p) => `${p.name} (${fmt(p.distanceKm, 1)} km ${p.direction}${p.etaHours ? `, fire could arrive in ~${Math.round(p.etaHours)} h` : ''})`);
  const desc = [
    `Satellite-detected fire in ${e.provName || 'an unnamed area'}, ${e.country}, at ${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}.`,
    `Last seen ${ago(e.lastAgeH)}; ${e.n} detections; total fire power ${fmt(e.frpSum)} MW.`,
    sp ? `Wind ${fmt(sp.weatherNow.wind_speed_10m)} km/h toward the ${compassName(sp.windToward)}. Estimated spread up to ${fmt(last?.headKm ?? 0, 1)} km in 24 hours. Fire weather (next 24 h): ${sp.dangerMax24.label}.` : 'Weather forecast unavailable; spread not estimated.',
    towns.length ? `Places in the projected path: ${towns.join('; ')}.` : 'No town in the projected 24-hour path.',
  ].join(' ');
  const instruction = inPath.length
    ? 'Check the fire on the ground. Prepare people in the listed places: move upwind, keep two ways out, follow official instructions.'
    : 'Monitor the fire. No town is in its projected path at the moment.';
  const polygon = ring ? `\n      <polygon>${xml(ring.map(([lo, la]) => `${la.toFixed(4)},${lo.toFixed(4)}`).join(' '))}</polygon>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>onfire-${xml(e.id)}-${now.getTime()}</identifier>
  <sender>onfire@localhost</sender>
  <sent>${iso(now)}</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Restricted</scope>
  <restriction>Decision support for fire and civil-protection authorities. Not a public evacuation order.</restriction>
  <note>Modelled estimate from NASA FIRMS detections and forecast weather. Not a ground survey.</note>
  <info>
    <language>en</language>
    <category>Fire</category>
    <event>Wildfire</event>
    <responseType>Monitor</responseType>
    <urgency>${inPath.length ? 'Expected' : 'Future'}</urgency>
    <severity>${severity}</severity>
    <certainty>Possible</certainty>
    <effective>${iso(now)}</effective>
    <expires>${iso(expires)}</expires>
    <senderName>On Fire</senderName>
    <headline>${xml(`Fire near ${e.provName || e.country}, ${e.country}${inPath.length ? `: ${inPath.length} place${inPath.length === 1 ? '' : 's'} in its path` : ''}`)}</headline>
    <description>${xml(desc)}</description>
    <instruction>${xml(instruction)}</instruction>
    <area>
      <areaDesc>${xml(`Area the fire could reach within 24 hours, ${e.provName ? `${e.provName}, ` : ''}${e.country}`)}</areaDesc>${polygon}
      <circle>${e.lat.toFixed(4)},${e.lon.toFixed(4)} ${fmt(Math.max(1, last?.headKm ?? 1), 1).replace(/,/g, '')}</circle>
    </area>
  </info>
</alert>
`;
}
