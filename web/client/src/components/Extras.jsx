import React, { useEffect, useState } from 'react';
import { Icon } from './icons.jsx';
import CalendarPanel from './CalendarPanel.jsx';
import { Section, Loading, Headline, Stat, ChartTip } from './ui.jsx';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, ReferenceLine } from 'recharts';
import { api, fmt, compact, SERIES, compassName, downloadFile, toCsv, fireAlertCap, fileStamp, slug, greatCircle, ago } from '../lib.js';

// ---------- download buttons (same pill buttons as the rest of the panel) ----------
export function DownloadButtons({ items }) {
  return (
    <div className="dl-row">
      {items.map((it) =>
        it.href ? (
          <a key={it.label} className="btn small" href={it.href} download>
            <Icon name={it.icon ?? 'download'} size={14} />
            {it.label}
          </a>
        ) : (
          <button key={it.label} className="btn small" onClick={it.onClick} disabled={it.disabled}>
            <Icon name={it.icon ?? 'download'} size={14} />
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

// Render an on-screen SVG chart to a PNG file (dark background, title on top).
export function svgToPng(svg, name, title) {
  if (!svg) return;
  const clone = svg.cloneNode(true);
  const src = svg.querySelectorAll('text');
  clone.querySelectorAll('text').forEach((t, i) => {
    const cs = getComputedStyle(src[i]);
    t.setAttribute('fill', cs.fill);
    t.setAttribute('font-size', cs.fontSize);
    t.setAttribute('font-weight', cs.fontWeight);
    t.setAttribute('font-family', 'Satoshi, Arial, sans-serif');
  });
  const vb = svg.viewBox.baseVal;
  const W = 1200, pad = 40, head = 70;
  const h = Math.round((vb.height / vb.width) * (W - pad * 2));
  clone.setAttribute('width', W - pad * 2);
  clone.setAttribute('height', h);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = h + head + pad;
    const g = c.getContext('2d');
    g.fillStyle = '#0e0e0f';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#ffffff';
    g.font = '700 24px Satoshi, Arial, sans-serif';
    g.fillText(title, pad, 44);
    g.fillStyle = '#6c6c72';
    g.font = '500 14px Satoshi, Arial, sans-serif';
    g.fillText('On Fire · MODIS + VIIRS harmonized record', pad, 64);
    g.drawImage(img, pad, head, W - pad * 2, h);
    c.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
}

// Live detections of a region (or one country) as CSV.
export function liveFiresCsv(live, iso) {
  const { cols, rows } = live.fires;
  const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
  const now = live.fetchedAt;
  const out = rows
    .filter((r) => !iso || r[ix.iso] === iso)
    .map((r) => [r[ix.lat], r[ix.lon], new Date(now - r[ix.ageH] * 3600000).toISOString().slice(0, 16).replace('T', ' '), r[ix.ageH], r[ix.sat], r[ix.frp], r[ix.conf], r[ix.dn], r[ix.iso], r[ix.event]]);
  return toCsv(['latitude', 'longitude', 'seen_utc_approx', 'hours_ago', 'satellite', 'frp_mw', 'confidence', 'day_night', 'country_iso', 'fire_id'], out);
}
export function liveEventsCsv(events) {
  return toCsv(
    ['fire_id', 'country', 'area', 'latitude', 'longitude', 'detections', 'fire_power_mw', 'strongest_pixel_mw', 'hours_since_last_seen', 'burning_hours', 'satellites'],
    events.map((e) => [e.id, e.country, e.provName ?? '', e.lat, e.lon, e.n, e.frpSum, e.frpMax, e.lastAgeH, e.durationH, e.sats.join(' ')]),
  );
}

export function LiveDownloads({ live, iso, events, name }) {
  if (!live?.fires) return null;
  return (
    <Section icon={<Icon name="download" size={15} />} title="Downloads" hint={`NASA FIRMS detections shown on the map for ${name}, as received ${ago((Date.now() - live.fetchedAt) / 3600000)}.`}>
      <DownloadButtons
        items={[
          { label: 'Detections (CSV)', icon: 'fileText', onClick: () => downloadFile(`onfire_live_${slug(name)}_${fileStamp()}.csv`, liveFiresCsv(live, iso)) },
          { label: 'Fire list (CSV)', icon: 'fileText', onClick: () => downloadFile(`onfire_fires_${slug(name)}_${fileStamp()}.csv`, liveEventsCsv(events ?? live.events)) },
        ]}
      />
    </Section>
  );
}

// ---------- alert brief (plain text, fixed template) ----------
export function fireAlertText(detail) {
  const e = detail.event;
  const sp = detail.spread;
  const inPath = (detail.threatened ?? []).filter((p) => p.level !== 'watch');
  const last = sp?.envelopes?.at(-1);
  const lines = [
    'ON FIRE · FIRE ALERT BRIEF',
    `Issued ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · valid 24 hours`,
    'Decision support for authorities. Modelled estimate, not a ground survey and not an evacuation order.',
    '',
    `WHERE   ${e.provName || 'Unnamed area'}, ${e.country} (${e.lat.toFixed(3)}, ${e.lon.toFixed(3)})`,
    `FIRE    Last seen ${ago(e.lastAgeH)} · ${e.n} detections · ${fmt(e.frpSum)} MW total fire power`,
    sp ? `WIND    ${fmt(sp.weatherNow.wind_speed_10m)} km/h toward the ${compassName(sp.windToward)}, gusts ${fmt(sp.weatherNow.wind_gusts_10m)} km/h` : 'WIND    Forecast unavailable',
    sp ? `SPREAD  Up to ${fmt(last?.headKm ?? 0, 1)} km in 24 h · fire weather ${sp.dangerMax24.label}` : 'SPREAD  Not estimated',
    '',
    inPath.length ? 'PLACES IN THE PATH' : 'No town is in the projected 24-hour path.',
    ...inPath.slice(0, 12).map((p) => `  - ${p.name}: ${fmt(p.distanceKm, 1)} km ${p.direction}${p.etaHours ? `, fire could arrive in ~${Math.round(p.etaHours)} h` : ', inside the 24-hour zone'}`),
    '',
    inPath.length ? 'ADVICE  Check on the ground. Prepare people in these places: move upwind, keep two ways out, follow official instructions.' : 'ADVICE  Keep monitoring the fire.',
    '',
    'Sources: NASA FIRMS (MODIS, VIIRS), Open-Meteo forecast, GeoNames / OpenStreetMap places.',
  ];
  return lines.join('\n') + '\n';
}

export function EventDownloads({ detail }) {
  const e = detail.event;
  const base = `onfire_fire_${slug(e.provName || e.country)}_${fileStamp()}`;
  return (
    <Section icon={<Icon name="download" size={15} />} title="Alert & data export" hint="For fire services and civil protection: a standard CAP 1.2 alert file, a one-page brief and the raw detections. Estimates, not orders.">
      <DownloadButtons
        items={[
          { label: 'Alert file (CAP)', icon: 'megaphone', onClick: () => downloadFile(`${base}.cap.xml`, fireAlertCap(detail), 'application/xml') },
          { label: 'Alert brief (TXT)', icon: 'fileText', onClick: () => downloadFile(`${base}.txt`, fireAlertText(detail), 'text/plain') },
          { label: 'Detections (CSV)', icon: 'fileText', onClick: () => downloadFile(`${base}_detections.csv`, toCsv(['date', 'time_utc', 'latitude', 'longitude', 'satellite', 'frp_mw', 'confidence', 'day_night'], detail.detections.map((d) => [d.date, `${d.time.slice(0, 2)}:${d.time.slice(2)}`, d.lat, d.lon, d.sat, d.frp, d.conf, d.dn]))) },
        ]}
      />
    </Section>
  );
}

// ---------- AI alerts export ----------
export function AiDownloads({ alerts, monthName, name }) {
  if (!alerts?.length) return null;
  return (
    <Section icon={<Icon name="download" size={15} />} title="Downloads" hint={`Every high-risk and red-alert area of about 50 km in ${name} for ${monthName}.`}>
      <DownloadButtons
        items={[
          {
            label: 'AI alerts (CSV)',
            icon: 'fileText',
            onClick: () =>
              downloadFile(
                `onfire_ai_alerts_${slug(name)}_${slug(monthName)}.csv`,
                toCsv(['level', 'chance_of_fire_pct', 'latitude', 'longitude', 'country', 'near', 'main_reasons'], alerts.map((a) => [a.level.label, Math.round(a.p * 100), a.lat, a.lon, a.country, a.place ?? '', a.reasons.map((r) => r.label).join('; ')])),
              ),
          },
        ]}
      />
    </Section>
  );
}

// ---------- fly between the two regions ----------
export function TravelButton({ to, side, onGo }) {
  return (
    <button className={`travel-btn ${side}`} onClick={onGo} title={`Fly to ${to.name}`}>
      <span className="travel-trail" aria-hidden />
      <span className="travel-ico"><Icon name="drone" size={18} /></span>
      <span className="travel-text">
        <small>Travel to</small>
        <b>{to.name}</b>
      </span>
      <Icon name={side === 'left' ? 'chevronLeft' : 'chevronRight'} size={16} className="travel-chev" />
    </button>
  );
}

export function TravelHud({ travel }) {
  const km = Math.round(greatCircle(travel.fromCenter, travel.to.globe, 8).km / 10) * 10;
  return (
    <div className="travel-hud" role="status">
      <span className="travel-hud-ico"><Icon name="drone" size={16} /></span>
      <span>Flying to <b>{travel.to.name}</b></span>
      <span className="travel-hud-km">{fmt(km)} km</span>
    </div>
  );
}

// ---------- fire warning card on the map (the "who it reaches first" view) ----------
export function FireWarning({ detail, onClose }) {
  const sp = detail?.spread;
  if (!sp) return null;
  const inPath = (detail.threatened ?? []).filter((p) => p.level !== 'watch');
  const first = [...inPath].sort((a, b) => (a.etaHours ?? 0) - (b.etaHours ?? 0))[0];
  if (!first) return null;
  return (
    <div className="fire-warning" role="alert">
      <div className="fw-top">
        <span className="fw-tag"><span className="fw-dot" />Fire warning</span>
        <button className="icon-btn" onClick={onClose} aria-label="Hide warning"><Icon name="x" size={13} /></button>
      </div>
      <div className="fw-place">{first.name}</div>
      <p>
        {first.etaHours ? <>Fire may arrive in <b>~{Math.round(first.etaHours)} h</b>.</> : <>Inside the area the fire could reach in <b>24 h</b>.</>} Wind toward the {compassName(sp.windToward)}.
        {inPath.length > 1 && <> {inPath.length - 1} more place{inPath.length === 2 ? '' : 's'} in the path.</>}
      </p>
      <div className="fw-advice">Move upwind · keep 2 ways out</div>
      <div className="fw-foot">Estimate for authorities · not an evacuation order</div>
    </div>
  );
}

// ---------- drawn area: 25-year calendar, this month vs past years, date range, exports ----------
const lat = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'N' : 'S'}`;
const lon = (v) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}`;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ymLabel = (ym) => `${MONTH_NAMES[+ym.slice(5) - 1].slice(0, 3)} ${ym.slice(0, 4)}`;
const FIRST_DAY = '2000-11-01';
const isoYesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// "This month so far" against the same calendar dates of every VIIRS year (2012-2025).
function ThisMonthCard({ tm }) {
  if (!tm) return null;
  const name = MONTH_NAMES[+tm.ym.slice(5) - 1];
  if (tm.unavailable) return <div className="notice tm-note">{tm.unavailable}</div>;
  const word = tm.median === 0 && tm.soFar === 0 ? 'no fire, as usual' : tm.soFar > tm.p75 ? 'busier than usual' : tm.soFar < tm.p25 ? 'quieter than usual' : 'about usual';
  const tone = tm.soFar > tm.p75 ? 'warn' : '';
  const data = [...tm.past.map((p) => ({ year: String(p.year), v: p.v_cd })), { year: tm.ym.slice(0, 4), v: tm.soFar, now: true }];
  return (
    <>
      <Headline icon="📅" tone={tone} title={`${name} 1–${tm.dayTo}: ${word}`}>
        <b>{fmt(tm.soFar)}</b> burning unit{tm.soFar === 1 ? "" : "s"} {tm.outage ? `on ${name} 1–${tm.dayTo}` : 'so far this month'}. On the same dates in 2012–2025 the median was <b>{fmt(tm.median, 0)}</b> (middle half {fmt(tm.p25, 0)}–{fmt(tm.p75, 0)}).
        {' '}This is the <b>{ordinal(tm.rank)}</b> busiest of {tm.years} years{tm.ratio !== null ? <>, {fmt(tm.ratio * 100)}% of the median</> : null}.
      </Headline>
      <div className="chart tm-chart" style={{ height: 120 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#232326" />
            <XAxis dataKey="year" tick={{ fill: '#6c6c72', fontSize: 10.5 }} axisLine={false} tickLine={false} interval={1} tickFormatter={(y) => `’${y.slice(2)}`} />
            <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={compact} />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTip formatLabel={(y) => `${name} 1–${tm.dayTo}, ${y}`} formatValue={(v) => `${fmt(v)} burning units`} />} />
            <ReferenceLine y={tm.median} stroke="#fff" strokeDasharray="3 3" />
            <Bar dataKey="v" name="Burning" radius={[4, 4, 0, 0]} maxBarSize={16}>
              {data.map((d) => <Cell key={d.year} fill={d.now ? '#ff6a1f' : '#5a3a22'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="hint tm-hint">Orange = {tm.ym.slice(0, 4)} (to {tm.until}). Dashed line = median of the same dates. VIIRS S-NPP years only, so no sensor conversion is involved.{tm.outage ? ` S-NPP has sent no data since ${tm.outage.lastDay}, so only days 1–${tm.dayTo} are compared.` : ''}</p>
    </>
  );
}
const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

// Statistics for any date range (whole months it touches) + CSV of the exact dates.
// Used by a drawn area and by a country / region (Seasonality tab).
//   csvHref(from, to) -> download link for every hotspot, or null when not offered
//   maxDays           -> longest range the hotspot file allows (whole countries)
export function RangeSection({ series, calendar, csvHref = null, csvNote = null, maxDays = null }) {
  const last = isoYesterday();
  const [from, setFrom] = useState('2025-01-01');
  const [to, setTo] = useState('2025-12-31');
  const ok = from && to && from <= to && from >= FIRST_DAY && to <= last;
  const mean = calendar.climatology.map((c) => c.mean);
  const months = ok ? series.filter((s) => s.ym >= from.slice(0, 7) && s.ym <= to.slice(0, 7)) : [];
  const total = months.reduce((a, s) => a + s.value, 0);
  const normal = months.reduce((a, s) => a + mean[+s.ym.slice(5) - 1], 0);
  const busiest = months.reduce((b, s) => (!b || s.value > b.value ? s : b), null);
  const covered = months.length && months.at(-1).ym >= to.slice(0, 7);
  const isModis = (src) => String(src).startsWith('MODIS');
  const hotM = months.reduce((a, s) => a + (s.modisCount ?? 0), 0);
  const hotV = months.reduce((a, s) => a + (s.viirsCount ?? 0), 0);
  const days = ok ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : 0;
  const tooLong = maxDays && days > maxDays;
  const data = months.map((m) => ({ ym: m.ym, v: m.value, src: m.source }));
  const csvName = `onfire_range_${from}_${to}`;
  return (
    <Section icon="🗓" title="Any date range" hint="Statistics use the whole months the range touches. The hotspot file uses the exact dates. Records start in November 2000 and run to yesterday.">
      <div className="range-row">
        <label>
          <small>From</small>
          <input type="date" className="dl-select date" value={from} min={FIRST_DAY} max={last} onChange={(ev) => setFrom(ev.target.value)} />
        </label>
        <label>
          <small>To</small>
          <input type="date" className="dl-select date" value={to} min={FIRST_DAY} max={last} onChange={(ev) => setTo(ev.target.value)} />
        </label>
      </div>
      {!ok ? (
        <p className="muted">Pick a start date before the end date, between 1 November 2000 and yesterday.</p>
      ) : (
        <>
          <div className="stats">
            <Stat icon="🔥" label="Burning in the range" value={fmt(total)} sub={`${months.length} month${months.length === 1 ? '' : 's'} · burning units`} />
            <Stat icon="📊" label="Compared to normal" value={normal > 0 ? `${fmt((total / normal) * 100)}%` : '—'} sub="of an average year's same months" tone={normal > 0 && total > normal * 1.25 ? 'hot' : ''} info="Normal = the average of each calendar month over all complete years since 2001." />
            <Stat icon="⛰" label="Busiest month" small value={busiest && busiest.value > 0 ? ymLabel(busiest.ym) : '—'} sub={busiest && busiest.value > 0 ? `${fmt(busiest.value)} burning units` : 'no fire'} />
            <Stat icon="🛰" label="Hotspots detected" small value={hotV || hotM ? fmt(hotV + hotM) : '—'} sub={[hotM ? `MODIS ${compact(hotM)}` : null, hotV ? `VIIRS ${compact(hotV)}` : null].filter(Boolean).join(' · ') || (covered ? 'none' : 'months after the record are not counted')} info="Raw satellite hotspots. The two sensors see the same fire very differently, so compare years with burning units, not with these counts." />
          </div>
          {data.length > 1 && (
            <div className="chart" style={{ height: 120 }}>
              <ResponsiveContainer>
                <BarChart data={data} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#232326" />
                  <XAxis dataKey="ym" tick={{ fill: '#6c6c72', fontSize: 10.5 }} axisLine={false} tickLine={false} minTickGap={18} tickFormatter={ymLabel} />
                  <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={compact} />
                  <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTip formatLabel={(ym) => ymLabel(ym)} formatValue={(v) => `${fmt(v)} burning units`} />} />
                  <Bar dataKey="v" name="Burning" radius={[3, 3, 0, 0]}>
                    {data.map((d) => <Cell key={d.ym} fill={isModis(d.src) ? SERIES.modis : SERIES.viirs} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <DownloadButtons
            items={[
              { label: 'Range summary (CSV)', icon: 'fileText', onClick: () => downloadFile(`${csvName}_monthly.csv`, toCsv(['year', 'month', 'harmonized_burning_units', 'normal_for_month', 'modis_hotspots', 'viirs_hotspots', 'source'], months.map((m) => [m.ym.slice(0, 4), +m.ym.slice(5), m.value, +mean[+m.ym.slice(5) - 1].toFixed(1), m.modisCount ?? '', m.viirsCount ?? '', m.source]))) },
              ...(csvHref && !tooLong ? [{ label: 'Every hotspot in the range (CSV)', icon: 'download', href: csvHref(from, to) }] : []),
            ]}
          />
          {csvHref && tooLong && <p className="hint dl-note">The hotspot file for a whole country covers at most {maxDays} days. Shorten the range, or draw a box with Area.</p>}
          {csvHref && !tooLong && csvNote && to >= '2026-01-01' && <p className="hint dl-note">{csvNote}</p>}
        </>
      )}
    </Section>
  );
}

export function AreaPanel({ area, onBack }) {
  const head = (
    <div className="event-head">
      <button className="btn ghost" onClick={onBack}><Icon name="chevronLeft" size={14} />Back</button>
      <div className="event-loc">
        <h1>Drawn area</h1>
        <p>{area.bbox ? `${lat(area.bbox[1])}–${lat(area.bbox[3])}, ${lon(area.bbox[0])}–${lon(area.bbox[2])}` : ''}{area.cells ? ` · ${fmt(area.cells)} grid squares of 25 km with fire` : ''}</p>
      </div>
    </div>
  );
  if (area.loading) return <div className="panel-body">{head}<Loading text="Adding up 25 years of satellite records for this area…" /></div>;
  if (area.error) return <div className="panel-body">{head}<div className={area.outside ? 'notice' : 'error'}>{area.error}</div></div>;
  const part = area.coverage && area.coverage.share < 0.95 && (
    <div className="notice tm-note">Only {fmt(area.coverage.share * 100)}% of the land in this box lies in the countries On Fire covers ({area.coverage.countries.join(', ')}). Fires in the rest of the box are not counted.</div>
  );
  if (!area.calendar) return <div className="panel-body">{head}{part}<div className="notice">No fires were recorded in this area since November 2000.</div></div>;
  const recentNote = area.recentLoading ? (
    <div className="notice tm-note"><span className="spinner" /> Adding 2026 from NASA FIRMS and comparing this month with past years…</div>
  ) : area.recentError ? (
    <div className="error tm-note">2026 could not be added: {area.recentError} The calendar below runs to December 2025.</div>
  ) : null;
  return (
    <div className="panel-body">
      {head}
      {part}
      {recentNote}
      <ThisMonthCard tm={area.thisMonth} />
      <CalendarPanel
        data={area}
        name="this area"
        range={{
          csvHref: (from, to) => `/api/area-hotspots.csv?bbox=${area.bbox.join(",")}&start=${from}&end=${to}`,
          csvNote: "Hotspots from 2026 are fetched from NASA FIRMS for this box, so a long 2026 range can take up to a minute.",
        }}
      />
      <p className="hint">
        2000–2025: On Fire's harmonized MODIS + VIIRS archive (25 km grid squares whose centre is in the box).
        {area.recent?.to ? ` 2026 to ${area.recent.to}: VIIRS S-NPP from NASA FIRMS (standard data, then near-real-time), counted the same way.` : ''}
        {area.recent?.outage ? ` VIIRS S-NPP has sent no data since ${area.recent.outage.lastDay} (NASA FIRMS), so the unfinished month after ${ymLabel(area.recent.lastMonth)} is left out rather than shown as a drop.` : ''}
      </p>
    </div>
  );
}

// ---------- type the corners of the box instead of dragging ----------
export function AreaCoords({ onSubmit, onCancel }) {
  const [v, setV] = useState({ n: '', s: '', w: '', e: '' });
  const [err, setErr] = useState(null);
  const num = (x) => (x.trim() === '' ? NaN : Number(x));
  const go = (ev) => {
    ev.preventDefault();
    const n = num(v.n), s = num(v.s), w = num(v.w), e = num(v.e);
    if (![n, s, w, e].every(Number.isFinite)) return setErr('Fill in all four numbers (decimal degrees).');
    if (n > 85 || s < -85 || w < -180 || e > 180) return setErr('Latitude must be between −85 and 85, longitude between −180 and 180.');
    if (n <= s) return setErr('North must be larger than South.');
    if (e <= w) return setErr('East must be larger than West (use minus for west of Greenwich).');
    if ((e - w) * (n - s) > 400) return setErr('That box is too large. Keep it under about 20° × 20°.');
    setErr(null);
    onSubmit({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  };
  const field = (k, label, ph) => (
    <label>
      <small>{label}</small>
      <input inputMode="decimal" className="dl-select coord" placeholder={ph} value={v[k]} onChange={(ev) => setV((o) => ({ ...o, [k]: ev.target.value }))} />
    </label>
  );
  return (
    <form className="coords-card" onSubmit={go}>
      <div className="coords-head">
        <b>Drag a box on the map</b>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Stop drawing"><Icon name="x" size={13} /></button>
      </div>
      <p>or type its corners in decimal degrees (minus = south / west):</p>
      <div className="coords-grid">
        {field('n', 'North (lat)', '36.5')}
        {field('s', 'South (lat)', '35.0')}
        {field('w', 'West (lon)', '3.0')}
        {field('e', 'East (lon)', '5.5')}
      </div>
      {err && <p className="coords-err">{err}</p>}
      <button type="submit" className="btn small primary">Show this area</button>
    </form>
  );
}

// ---------- a fire burning now vs the fires that burned here before (2012-2025) ----------
// never round a fire up to "bigger than 100%": 99.46 shows as 99.4
const pctText = (p) => (p >= 99 && p < 100 ? fmt(Math.floor(p * 10) / 10, 1) : fmt(Math.floor(p), 0));
const monYear = (d) => `${MONTH_NAMES[+d.slice(5, 7) - 1].slice(0, 3)} ${d.slice(0, 4)}`;
export function PastFires({ eventId }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let dead = false;
    setD(null);
    api(`/api/event/${eventId}/history`).then((j) => !dead && setD(j)).catch((e) => !dead && setD({ error: e.message }));
    return () => (dead = true);
  }, [eventId]);
  const hint = 'Fires that burned within 50 km in 2012–2025, sized the same way: the area of the 5 km squares touched by VIIRS detections (an upper bound).';
  let body;
  if (!d) body = <Loading text="Looking up 14 years of fires around this one…" />;
  else if (d.error) body = <p className="muted">{d.error}</p>;
  else if (!d.past.n) body = <p className="muted">No fire was recorded within {d.radiusKm} km since 2012. This is the first one here in the VIIRS record.</p>;
  else if (!d.cells) body = <p className="muted">{fmt(d.past.n)} fires burned within {d.radiusKm} km since 2012. This fire has not been seen by a VIIRS satellite yet, so it cannot be sized the same way.</p>;
  else
    body = (
      <>
        <div className="stats">
          <Stat icon="🔥" label="This fire so far" value={`${fmt(d.footprintKm2, d.footprintKm2 < 10 ? 1 : 0)} km²`} sub={`${fmt(d.cells)} squares · ${d.days < 1 ? 'under a day' : `${fmt(d.days, 1)} days`}`} />
          <Stat icon="📊" label="Bigger than" value={`${pctText(d.percentile)}%`} sub={`of ${fmt(d.past.n)} past fires here`} tone={d.percentile >= 90 ? 'hot' : ''} info={d.rank === 1 ? 'Larger than every fire recorded within 50 km since 2012.' : `Rank ${fmt(d.rank)} of ${fmt(d.past.n + 1)} by size.`} />
        </div>
        {d.past.largest?.length > 0 && (
          <table className="table small">
            <thead><tr><th>Largest fires here</th><th>Size</th><th>Lasted</th><th>Distance</th></tr></thead>
            <tbody>
              {d.past.largest.slice(0, 3).map((f) => (
                <tr key={f.event}>
                  <td>{monYear(f.start)}</td>
                  <td>{fmt(f.footprint_km2)} km²</td>
                  <td>{fmt(f.days)} day{f.days === 1 ? '' : 's'}</td>
                  <td>{fmt(f.dist_km)} km</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d.past.largest?.some((f) => f.days >= 30) && <p className="hint dl-note">Where burning goes on almost without a break (savanna, farmland), the satellite record joins neighbouring fires into one long event, so the largest "fires" here can be a whole burning season.</p>}
      </>
    );
  return (
    <Section icon="📈" title="Compared with past fires here" hint={hint}>
      {body}
    </Section>
  );
}
