import React from 'react';
import { Icon, toIcon } from './icons.jsx';
import { Section, Loading, Badge, Stat, Headline, Details, Info } from './ui.jsx';
import { fmt, DANGER_LEVELS, PLACE_STATUS, MONTHS_LONG, compassName, speedWord, listJoin } from '../lib.js';

export default function RiskPanel({ risk, loading, onEvent, name }) {
  if (loading || !risk) return <Loading text="Checking the wind forecast and fire paths…" />;
  if (risk.error) return <div className="notice">{risk.error}</div>;
  const spreads = risk.spreads ?? [];
  const places = spreads
    .flatMap((s) => s.threatened.filter((p) => p.level !== 'watch').map((p) => ({ ...p, ev: s.event })))
    .sort((a, b) => (a.level === b.level ? a.distanceKm - b.distanceKm : a.level === 'danger' ? -1 : 1));
  const hot = [...(risk.grid?.cells ?? [])].sort((a, b) => b.score - a.score).slice(0, 8);
  const worst = spreads.reduce((a, s) => (s.danger.level > (a?.level ?? -1) ? s.danger : a), null);
  const month = MONTHS_LONG[risk.grid?.month ?? new Date().getUTCMonth()];
  const likelyAreas = hot.filter((c) => c.score >= 0.25 && c.place).slice(0, 3).map((c) => c.place.replace('near ', ''));

  return (
    <>
      <Headline icon={places.length ? '⚠️' : '🧭'} tone={places.length ? 'warn' : ''} title={places.length ? `${places.length} town${places.length === 1 ? '' : 's'} could be reached by fire or smoke` : 'No towns in the path of fires right now'}>
        {spreads.length ? <>We projected the {spreads.length} largest active fire{spreads.length === 1 ? '' : 's'} using the wind forecast. </> : 'No fires burned here in the last 24 hours. '}
        {likelyAreas.length ? <>New fires are most likely around <b>{listJoin(likelyAreas)}</b> in the next 3 days.</> : null}
      </Headline>

      <div className="stats">
        <Stat icon="🌡" label="Fire weather" value={worst ? worst.label : '—'} sub="worst in the next 24 h" tone="hot" info="How easily fires start and spread, from heat, dryness and wind (McArthur Fire Danger Index)." />
        <Stat icon="🏘" label="Towns at risk" value={fmt(places.length)} sub="in path or close downwind" />
        <Stat icon="🚒" label="Fires tracked" value={fmt(spreads.length)} sub="largest active fires" />
        <Stat icon="🎯" label="High-chance areas" value={fmt(risk.grid?.cells?.filter((c) => c.score >= 0.3).length)} sub="for new fires, next 3 days" />
      </div>

      <Section icon="🏘" title="Towns in danger" hint="Towns inside the area a fire could reach within 24 h, or close downwind. Click a row to open that fire.">
        {places.length ? (
          <table className="table">
            <thead>
              <tr><th>Town</th><th>Status</th><th>Distance</th><th>Fire could arrive</th></tr>
            </thead>
            <tbody>
              {places.slice(0, 20).map((p, i) => (
                <tr key={i} onClick={() => onEvent(p.ev.id, p.ev.iso)} className="clickable">
                  <td><b>{p.name}</b>{p.pop ? <small> · {fmt(p.pop)} people</small> : null}</td>
                  <td><Badge color={PLACE_STATUS[p.level].color}>{PLACE_STATUS[p.level].label}</Badge></td>
                  <td>{fmt(p.distanceKm, 1)} km {p.direction}</td>
                  <td>{p.etaHours ? `in ~${Math.round(p.etaHours)} h` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted"><Icon name="check" size={13} className="inline-icon" /> No mapped town is inside a projected fire path right now.</p>
        )}
      </Section>

      <Section icon="➡️" title="Where are the fires heading?" hint="On the map: the orange arrow shows direction, the shaded area shows how far the fire could spread in 24 h, and the grey wedge shows the smoke.">
        <div className="events">
          {spreads.map((s) => {
            const last = s.envelopes.at(-1);
            const km = last?.headKm ?? 0;
            return (
              <button key={s.event.id} className="event-row" onClick={() => onEvent(s.event.id, s.event.iso)}>
                <span className="wind-dial" style={{ '--rot': `${last && km > 0.05 ? last.dir : s.windToward}deg` }} aria-hidden>↑</span>
                <span className="event-main">
                  <span className="event-title">{s.event.provName || 'Unknown area'}</span>
                  <span className="event-sub">
                    {speedWord(km)} toward the {compassName(last && km > 0.05 ? last.dir : s.windToward)} · up to {fmt(km, 1)} km in 24 h · wind {fmt(s.windKmh)} km/h
                  </span>
                </span>
                <Badge color={s.danger.color}>{s.danger.label}</Badge>
              </button>
            );
          })}
          {!spreads.length && <p className="muted">No fires burned in {name} in the last 24 hours.</p>}
        </div>
      </Section>

      <Section icon="🎯" title="Where could new fires start?" hint={`The glowing area on the map. Based on how often each place burned in ${month} over the last ${risk.grid?.climYears ?? '—'} years, plus the weather forecast (heat, dryness, wind, rain) and nearby active fires.`}>
        <table className="table">
          <thead>
            <tr><th>Area</th><th>Chance</th><th>Why</th></tr>
          </thead>
          <tbody>
            {hot.map((c, i) => (
              <tr key={i}>
                <td><b>{c.place ?? `${c.lat.toFixed(1)}°, ${c.lon.toFixed(1)}°`}</b></td>
                <td><b>{c.score >= 0.5 ? 'High' : c.score >= 0.25 ? 'Medium' : 'Low'}</b> <small>{fmt(c.score * 100)}%</small></td>
                <td className="why">
                  burned {fmt(c.hist * 100)}% of past {month}s{c.danger && c.danger !== 'unknown' ? ` · ${c.danger.toLowerCase()} fire weather` : ''}{c.near > 0.2 ? ' · active fire nearby' : ''}{c.rain > 5 ? ` · ${fmt(c.rain)} mm rain expected` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {risk.grid && !risk.grid.weatherAvailable && <p className="hint">Weather forecast temporarily unavailable. The chances use history and nearby fires only.</p>}
      </Section>

      <Details title="How is this forecast made?">
        <p className="hint">
          <b>Spread:</b> the McArthur grassland model gives a speed from temperature, humidity and wind. We move the fire hour by hour with the wind forecast. It is slower at night and slower where vegetation is sparse, and the area it could reach is an ellipse stretched by the wind. This shows what <i>could</i> happen if the fire keeps burning, not a certainty.
        </p>
        <p className="hint"><b>Fire weather scale</b> <Info text="McArthur Grassland Fire Danger Index categories" /></p>
        <div className="danger-scale">
          {DANGER_LEVELS.map((d) => <Badge key={d.label} color={d.color}>{d.label}</Badge>)}
        </div>
      </Details>
    </>
  );
}
