import React from 'react';
import { Stat, Section, Loading, Bar, Headline, Details } from './ui.jsx';
import { fmt, compact, ago, tintColor, listJoin } from '../lib.js';
import EventList from './EventList.jsx';
import HeroCard from './HeroCard.jsx';
import SeasonStrip from './SeasonStrip.jsx';

const SAT_ORDER = ['S-NPP', 'NOAA-20', 'NOAA-21', 'Terra', 'Aqua'];

export default function RegionPanel({ live, error, days, onCountry, onEvent, harmonized, countryTotal = 24 }) {
  if (error) return <div className="error">Could not load live fires: {error}</div>;
  if (!live) return <Loading text="Fetching live fires from NASA satellites…" />;
  const s = live.summary;
  const maxN = Math.max(1, ...s.countries.map((c) => c.n));
  const satMax = Math.max(1, ...Object.values(s.bySat));
  const top = s.countries.slice(0, 3).map((c) => c.name);
  const period = days === 1 ? 'the last 24 hours' : days === 2 ? 'the last 48 hours' : 'the last 7 days';

  return (
    <>
      <HeroCard
        chip={`Live · ${period}`}
        sats={Object.entries(s.bySat)}
        slides={[
          { label: 'Burning right now', value: fmt(s.activeEvents), sub: <>Most activity in <b>{listJoin(top)}</b></> },
          { label: `Fires in ${period.replace('the ', '')}`, value: fmt(s.events), sub: `across ${s.countries.length} countries` },
          { label: 'Very strong detections', value: fmt(s.highIntensity), sub: 'fire power of 50 MW or more' },
          { label: 'Countries with fires', value: fmt(s.countries.length), sub: `of ${countryTotal} in the region` },
        ]}
        action={live.events[0] && { label: `Fly to the biggest fire · ${live.events[0].country}`, icon: 'target', onClick: () => onEvent(live.events[0].id, live.events[0].iso) }}
      />

      {harmonized && !harmonized.error && <SeasonStrip calendar={harmonized.calendar} />}

      <Section icon="🗺" title="Where is it burning?" hint="Click a country to zoom in on the map.">
        <div className="rank">
          <div className="rank-head"><span /><span>Country</span><span /><span>fires</span><span>detections today</span></div>
          {s.countries.map((c) => (
            <button key={c.iso} className="rank-row" onClick={() => onCountry(c.iso, c.name)}>
              <span className="swatch" style={{ background: tintColor(c.n, maxN) }} />
              <span className="rank-name">{c.name}</span>
              <Bar value={c.n} max={maxN} />
              <span className="rank-num">{fmt(c.events)}</span>
              <span className="rank-sub">{fmt(c.n24)}</span>
            </button>
          ))}
          {!s.countries.length && <p className="muted">No fires detected in this period.</p>}
        </div>
      </Section>

      <Section icon="🚒" title="Biggest fires right now" hint="Click one to see where it’s heading and who is in danger.">
        <EventList events={live.events.slice(0, 10)} onEvent={onEvent} showCountry />
      </Section>

      <Details title="About this data (satellites, filtering, update time)">
        <p className="hint">Fires are detected by 5 NASA/NOAA satellites. Each pass sees heat from fires as small as a few hundred square metres.</p>
        <div className="sats">
          {SAT_ORDER.filter((k) => s.bySat[k]).map((k) => (
            <div key={k} className="sat-row">
              <span className="sat-name">{k}</span>
              <span className="sat-inst">{k === 'Terra' || k === 'Aqua' ? 'MODIS · 1 km' : 'VIIRS · 375 m'}</span>
              <Bar value={s.bySat[k]} max={satMax} color={k === 'Terra' || k === 'Aqua' ? '#3987e5' : '#d95926'} />
              <span className="rank-num">{fmt(s.bySat[k])}</span>
            </div>
          ))}
        </div>
        <p className="hint">
          {fmt(s.total)} detections in {period}, total fire power {fmt(s.frp / 1000, 1)} GW. Removed: {fmt(live.removed.staticSources)} gas flares / industrial heat and {fmt(live.removed.lowConfidence)} uncertain detections. Updated {ago((Date.now() - live.fetchedAt) / 3600000)}.
        </p>
      </Details>
    </>
  );
}
