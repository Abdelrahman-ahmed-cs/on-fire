import React from 'react';
import { Icon, toIcon } from './icons.jsx';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, AreaChart, Area } from 'recharts';
import { Section, Loading, Badge, ChartTip, Details, Info } from './ui.jsx';
import { EventDownloads, PastFires } from './Extras.jsx';
import { fmt, compact, ago, utcTime, PLACE_STATUS, SERIES, compassName, eventStrength, STRENGTH_COLOR, speedWord } from '../lib.js';

function Fact({ icon, label, value, sub, color }) {
  return (
    <div className="fact">
      <span className="fact-icon" aria-hidden>{toIcon(icon, 15)}</span>
      <span className="fact-label">{label}</span>
      <b className="fact-value" style={color ? { color } : undefined}>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export default function EventPanel({ detail, onBack, onFocus }) {
  if (!detail) return <Loading text="Checking wind, spread, nearby towns and smoke…" />;
  if (detail.error)
    return (
      <div className="panel-body">
        <div className="error">{detail.error}</div>
        <button className="btn" onClick={onBack}><Icon name="chevronLeft" size={14} />Back</button>
      </div>
    );
  const { event: e, spread, threatened, surroundings: sur, population: pop, damage: dmg, air, smoke } = detail;
  const burning = e.lastAgeH <= 12;
  const wx = spread?.weatherNow;
  const wind72 = spread?.hourly?.map((h) => ({ t: h.t, wind: h.wind, gust: h.gust })) ?? [];
  const close = threatened.filter((p) => p.level !== 'watch' || p.distanceKm <= 10).slice(0, 12);
  const inPath = threatened.filter((p) => p.level !== 'watch');
  const nearest = [...threatened].sort((a, b) => a.distanceKm - b.distanceKm)[0];
  const vegetation = sur?.landcover?.filter((l) => l.vegetation) ?? [];
  const built = sur?.landcover?.filter((l) => !l.vegetation) ?? [];
  const strength = eventStrength(e.frpSum);
  const last = spread?.envelopes?.at(-1);
  const km24 = last?.headKm ?? 0;
  const dir = last && km24 > 0.05 ? last.dir : spread?.windToward;
  const duration = e.durationH < 1 ? 'just started' : e.durationH >= 48 ? `${Math.round(e.durationH / 24)} days` : `${Math.round(e.durationH)} hours`;

  return (
    <div className="panel-body event">
      <div className="event-head">
        <button className="btn ghost" onClick={onBack}><Icon name="chevronLeft" size={14} />Back</button>
        <div className="event-loc">
          <h1>Fire in {e.provName || 'unknown area'}, {e.country}</h1>
          <p>
            {e.lat.toFixed(3)}°, {e.lon.toFixed(3)}° · <button className="link" onClick={() => onFocus({ lat: e.lat, lon: e.lon, zoom: 12, t: Date.now() })}>zoom to fire</button>
          </p>
        </div>
      </div>

      {/* ---------- at a glance ---------- */}
      <div className={`glance ${inPath.length ? 'warn' : ''}`}>
        <div className="glance-top">
          <Badge color={burning ? '#ff2a2a' : '#6c6c72'}>{burning ? '● Burning now' : `Last seen ${ago(e.lastAgeH)}`}</Badge>
          <span className="strength" style={{ '--s': STRENGTH_COLOR[strength] }}>{strength} fire</span>
        </div>
        <p>
          This fire has been burning for <b>{duration}</b>.
          {spread && (
            <> The wind ({fmt(wx.wind_speed_10m)} km/h) is pushing it <b>{compassName(dir)}</b>. It is <b>{speedWord(km24)}</b>{km24 >= 0.1 ? <> and could spread up to <b>{fmt(km24, 1)} km</b> in the next 24 hours</> : null}.</>
          )}{' '}
          {inPath.length ? (
            <><b className="danger-text">{inPath.length} town{inPath.length === 1 ? ' is' : 's are'} in danger</b>; the closest is {inPath[0].name}, {fmt(inPath[0].distanceKm, 1)} km away.</>
          ) : nearest ? (
            <>No town is in its path. The nearest is {nearest.name}, {fmt(nearest.distanceKm, 1)} km {nearest.direction}.</>
          ) : null}{' '}
          {air?.category && <>Air at the fire is <b style={{ color: air.category.color }}>{air.category.label.toLowerCase()}</b>.</>}
        </p>
        <div className="facts">
          <Fact icon="🧭" label="Heading" value={dir !== undefined ? compassName(dir) : '—'} sub={km24 >= 0.1 ? `${fmt(km24, 1)} km / 24 h` : 'barely moving'} />
          <Fact icon="🌡" label="Fire weather" value={spread?.dangerMax24.label ?? '—'} color={spread?.dangerMax24.color} sub="next 24 h" />
          <Fact icon="🏘" label="Towns in danger" value={fmt(inPath.length)} sub={pop ? `${compact(pop.within10km)} people within 10 km` : ''} />
          <Fact icon="🌫" label="Smoke goes" value={smoke.plumeToward !== null ? compassName(smoke.plumeToward) : '—'} sub={smoke.plumeLengthKm6h ? `~${fmt(smoke.plumeLengthKm6h)} km in 6 h` : ''} />
        </div>
      </div>

      {/* ---------- how it compares with the fires that burned here before ---------- */}
      <PastFires eventId={e.id} />

      {/* ---------- where is it going ---------- */}
      <Section icon="🧭" title="Where is it going?" hint="The orange arrow and shaded rings on the map. Rings show how far it could spread after 3, 6, 12 and 24 hours if it keeps burning.">
        {spread ? (
          <>
            <div className="spread-steps">
              {spread.envelopes.map((env) => (
                <div key={env.hours} className="spread-step">
                  <small>in {env.label}</small>
                  <b>{env.headKm < 0.1 ? '< 0.1' : fmt(env.headKm, 1)} km</b>
                  <span>{compassName(env.dir)}</span>
                </div>
              ))}
            </div>
            <div className="danger-row">
              <div>
                <small>Fire weather now</small>
                <Badge color={spread.dangerNow.color}>{spread.dangerNow.label}</Badge>
              </div>
              <div>
                <small>Worst in next 24 h</small>
                <Badge color={spread.dangerMax24.color}>{spread.dangerMax24.label}</Badge>
              </div>
              <div className="wind-now">
                <span className="wind-dial big" style={{ '--rot': `${spread.windToward}deg` }}>↑</span>
                <span>
                  <b>{fmt(wx.wind_speed_10m)} km/h</b> wind
                  <br />
                  <small>gusts up to {fmt(wx.wind_gusts_10m)} km/h</small>
                </span>
              </div>
            </div>
            <div className="wx-row">
              <span><Icon name="thermo" size={13} className="inline-icon" /> {fmt(wx.temperature_2m, 1)} °C</span>
              <span><Icon name="drop" size={13} className="inline-icon" /> {fmt(wx.relative_humidity_2m)}% humidity</span>
              <span><Icon name="rain" size={13} className="inline-icon" /> {fmt(wx.precipitation, 1)} mm rain</span>
              <span><Icon name="calendar" size={13} className="inline-icon" /> burned in {fmt((spread.historicalFireFrequency?.p ?? 0) * 100)}% of past years this month</span>
            </div>
            <div className="chart-title">Wind for the next 3 days <Info text="Stronger wind = faster spread. Watch for gust peaks." /></div>
            <div className="legend-row">
              <span><i style={{ background: SERIES.modis }} />Wind speed</span>
              <span><i style={{ background: SERIES.viirs }} />Gusts</span>
            </div>
            <div className="chart" style={{ height: 120 }}>
              <ResponsiveContainer>
                <LineChart data={wind72} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#232326" />
                  <XAxis dataKey="t" tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} interval={11} tickFormatter={(t) => `${t.slice(8, 10)}/${t.slice(5, 7)} ${t.slice(11, 13)}h`} />
                  <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTip formatLabel={(t) => `${t.replace('T', ' ')} UTC`} formatValue={(v) => `${fmt(v)} km/h`} />} />
                  <Line dataKey="wind" name="Wind" stroke={SERIES.modis} dot={false} strokeWidth={2} />
                  <Line dataKey="gust" name="Gusts" stroke={SERIES.viirs} dot={false} strokeWidth={1.5} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        ) : (
          <p className="muted">Weather forecast unavailable right now ({detail.errors?.spread}).</p>
        )}
      </Section>

      {/* ---------- who is in danger ---------- */}
      <Section icon="🏘" title="Who is in danger?" hint={detail.surroundingsPending ? 'Towns from GeoNames. Adding small villages from OpenStreetMap…' : 'Towns and villages around the fire (OpenStreetMap + GeoNames). Coloured dots on the map.'}>
        {close.length ? (
          <table className="table">
            <thead>
              <tr><th>Place</th><th>Status</th><th>Distance</th><th>Fire could arrive</th></tr>
            </thead>
            <tbody>
              {close.map((p, i) => (
                <tr key={i}>
                  <td><b>{p.name}</b><small> · {p.kind ?? 'town'}{p.pop ? `, ${p.popEstimated ? '~' : ''}${compact(p.pop)} people` : ''}</small></td>
                  <td><Badge color={PLACE_STATUS[p.level].color}>{p.level === 'watch' && !p.downwind ? 'Nearby' : PLACE_STATUS[p.level].label}</Badge></td>
                  <td>{fmt(p.distanceKm, 1)} km {p.direction}</td>
                  <td>{p.etaHours ? `in ~${Math.round(p.etaHours)} h` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted"><Icon name="check" size={13} className="inline-icon" /> No towns within 10 km or downwind.</p>
        )}
      </Section>

      {/* ---------- damage ---------- */}
      <Section icon="📋" title="What has it damaged?" hint="Estimates from the satellite's heat measurements and map data, not a ground survey.">
        <div className="impact-grid">
          <div className="impact">
            <h3><Icon name="leaf" size={13} className="inline-icon" /> Plants & land</h3>
            <div className="impact-big">{fmt(dmg.footprintHa)} ha</div>
            <small>area touched by fire (at most) · about {fmt(dmg.footprintHa / 0.714)} football pitches</small>
            <ul>
              <li><b>{fmt(dmg.biomassBurnedT)} tonnes</b> of plants burned</li>
              {detail.surroundingsPending ? <li className="muted"><Icon name="clock" size={13} className="inline-icon" /> Loading land cover…</li> : vegetation.length ? <li>Land around it: <b>{vegetation.slice(0, 4).map((l) => l.label).join(', ')}</b></li> : <li>No mapped farmland or forest within 1.5 km</li>}
              {built.length > 0 && <li>Also nearby: {built.slice(0, 3).map((l) => l.label).join(', ')}</li>}
            </ul>
          </div>
          <div className="impact">
            <h3><Icon name="users" size={13} className="inline-icon" /> People & buildings</h3>
            <div className="impact-big">{pop ? compact(pop.within10km) : '—'}</div>
            <small>people live within 10 km</small>
            <ul>
              {pop && <li>{compact(pop.within5km)} within 5 km · {compact(pop.within20km)} within 20 km · {fmt(pop.settlementsWithin10km)} settlements within 10 km</li>}
              {sur && <li>Buildings within 1 km: <b>{fmt(sur.buildingsWithin1km)}</b></li>}
              {sur?.facilities?.length > 0 && <li>Schools / hospitals within 5 km: {sur.facilities.slice(0, 4).map((f) => `${f.name} (${f.distanceKm} km)`).join('; ')}</li>}
              {sur?.majorRoads?.length > 0 && <li>Roads nearby: {sur.majorRoads.slice(0, 4).join(', ')}</li>}
              {!sur && <li className="muted">{detail.surroundingsPending ? 'Loading buildings, schools and roads from OpenStreetMap…' : 'Detailed map data unavailable right now.'}</li>}
            </ul>
          </div>
          <div className="impact">
            <h3><Icon name="factory" size={13} className="inline-icon" /> Pollution released</h3>
            <div className="impact-big">{fmt(dmg.co2T)} t CO₂</div>
            <small>same as {fmt(dmg.carsPerYearEquivalent)} cars driving for a whole year</small>
            <ul>
              <li>Carbon monoxide {fmt(dmg.coT, 1)} t · fine particles (PM2.5) {fmt(dmg.pm25T, 2)} t · methane {fmt(dmg.ch4T, 2)} t</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ---------- smoke ---------- */}
      <Section icon="🌫" title="Smoke & air quality" hint="The grey wedge on the map. Air-quality forecast from Copernicus (CAMS).">
        {air ? (
          <>
            <div className="aq-row">
              <div className="aq-main" style={{ '--aq': air.category?.color }}>
                <b>{fmt(air.current.us_aqi)}</b>
                <small>air quality index at the fire</small>
                <span>{air.category?.label}</span>
              </div>
              <ul className="aq-list">
                <li>Fine particles PM2.5 <b>{fmt(air.current.pm2_5, 1)}</b> µg/m³</li>
                <li>PM10 <b>{fmt(air.current.pm10, 1)}</b> µg/m³</li>
                <li>Carbon monoxide <b>{fmt(air.current.carbon_monoxide)}</b> µg/m³</li>
                <li>Haze (aerosol depth) <b>{fmt(air.current.aerosol_optical_depth, 2)}</b></li>
              </ul>
            </div>
            {smoke.plumeToward !== null && (
              <p>
                Smoke is blowing <b>{compassName(smoke.plumeToward)}</b> and travels roughly <b>{fmt(smoke.plumeLengthKm6h)} km</b> in 6 hours.
              </p>
            )}
            {smoke.exposedPlaces.length > 0 && (
              <table className="table">
                <thead><tr><th>Town under the smoke</th><th>Distance</th><th>Air quality</th></tr></thead>
                <tbody>
                  {smoke.exposedPlaces.map((p, i) => (
                    <tr key={i}>
                      <td><b>{p.name}</b></td>
                      <td>{fmt(p.distanceKm, 1)} km {p.direction}</td>
                      <td>{p.category ? <Badge color={p.category.color}>{p.category.label} ({fmt(p.usAqi)})</Badge> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="chart-title">Fine particles (PM2.5) at the fire, next 2 days</div>
            <div className="chart" style={{ height: 100 }}>
              <ResponsiveContainer>
                <AreaChart data={air.hourly} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#232326" />
                  <XAxis dataKey="t" tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} interval={11} tickFormatter={(t) => `${t.slice(8, 10)}/${t.slice(5, 7)} ${t.slice(11, 13)}h`} />
                  <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTip formatLabel={(t) => `${t.replace('T', ' ')} UTC`} formatValue={(v) => `${fmt(v, 1)} µg/m³`} />} />
                  <Area dataKey="pm25" name="PM2.5" stroke="#b0a7ff" fill="#b0a7ff" fillOpacity={0.2} strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        ) : (
          <p className="muted">Air-quality forecast unavailable right now.</p>
        )}
      </Section>

      <EventDownloads detail={detail} />

      <Details title={`Satellite detections (${detail.detections.length}) & technical data`}>
        <p className="hint">
          {fmt(e.n)} detections by {e.sats.join(', ')} · first seen {utcTime(e.first)} · total fire power {fmt(e.frpSum)} MW (strongest pixel {fmt(e.frpMax)} MW) · fire radiative energy ≈ {fmt(dmg.fireRadiativeEnergyGJ)} GJ.
        </p>
        <p className="hint">{dmg.assumptions}</p>
        <table className="table small">
          <thead><tr><th>Time (UTC)</th><th>Satellite</th><th>Power</th><th>Confidence</th></tr></thead>
          <tbody>
            {detail.detections.slice(0, 200).map((d) => (
              <tr key={d.id}>
                <td>{d.date} {d.time.slice(0, 2)}:{d.time.slice(2)}</td>
                <td>{d.sat} {toIcon(d.dn === 'N' ? '🌙' : '☀️', 12)}</td>
                <td>{fmt(d.frp, 1)} MW</td>
                <td>{d.conf}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Details>
    </div>
  );
}
