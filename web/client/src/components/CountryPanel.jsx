import React from 'react';
import { BarChart, Bar as RBar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Stat, Section, Loading, Bar, ChartTip, Headline, Alert } from './ui.jsx';
import { fmt, tintColor } from '../lib.js';
import EventList from './EventList.jsx';
import SeasonStrip from './SeasonStrip.jsx';

export default function CountryPanel({ data, days, onEvent, harmonized, risk, onTab }) {
  if (!data) return <Loading text="Loading country…" />;
  const s = data.summary;
  const maxP = Math.max(1, ...data.provinces.map((p) => p.n));
  const threatened = risk?.spreads?.flatMap((sp) => sp.threatened.filter((p) => p.level !== 'watch')) ?? [];
  const worst = risk?.spreads?.reduce((a, sp) => (sp.danger.level > (a?.level ?? -1) ? sp.danger : a), null);
  const topProv = data.provinces[0]?.name;
  const period = days === 1 ? '24 hours' : days === 2 ? '48 hours' : '7 days';

  return (
    <>
      <Headline icon={s.activeEvents ? '🔥' : '✅'} title={s.activeEvents ? `${fmt(s.activeEvents)} fire${s.activeEvents === 1 ? ' is' : 's are'} burning now in ${data.name}` : `No fires burning now in ${data.name}`}>
        {s.events ? <>{fmt(s.events)} fires in the last {period}{topProv ? <>, mostly in <b>{topProv}</b></> : null}.</> : 'Nothing detected in this period.'}
        {worst && <> Fire weather today: <b style={{ color: worst.color }}>{worst.label.toLowerCase()}</b>.</>}
      </Headline>

      {threatened.length > 0 && (
        <Alert onClick={() => onTab('risk')}>
          <b>{threatened.length} town{threatened.length === 1 ? '' : 's'} near active fires</b> — {threatened.slice(0, 3).map((p) => p.name).join(', ')}
          {threatened.length > 3 ? '…' : ''}. See the danger forecast.
        </Alert>
      )}
      {risk && !risk.error && !threatened.length && (
        <Alert tone="ok" icon="✅" onClick={() => onTab('risk')}>No towns are in the projected path of active fires. See the forecast.</Alert>
      )}
      {risk === null && <Alert tone="info" icon="⏳">Checking wind and fire paths…</Alert>}

      <div className="stats">
        <Stat icon="🔥" label="Burning now" value={fmt(s.activeEvents)} sub="fires seen in last 24 h" tone="hot" />
        <Stat icon="📍" label="Fires in period" value={fmt(s.events)} sub={`last ${period}`} />
        <Stat icon="🛰" label="Detections" value={fmt(s.total)} sub={`${fmt(s.last24)} today`} info="One detection = one satellite pixel with a fire. A big fire produces many detections." />
        <Stat icon="💥" label="Very strong" value={fmt(s.highIntensity)} sub="big & intense detections" />
      </div>

      {harmonized && !harmonized.error && <SeasonStrip calendar={harmonized.calendar} />}

      <Section icon="🚒" title="Fires in this country" hint="Biggest first. Click one to see where it’s heading, who is in danger and the damage.">
        <EventList events={data.events.slice(0, 20)} onEvent={onEvent} />
      </Section>

      <Section icon="🗺" title="Which provinces are burning?" hint="Shaded on the map: darker red = more fire. Click on the map to check any spot.">
        <div className="rank">
          <div className="rank-head"><span /><span>Province</span><span /><span>detections</span><span>today</span></div>
          {data.provinces.slice(0, 15).map((p) => (
            <div key={p.id} className="rank-row static">
              <span className="swatch" style={{ background: tintColor(p.n, maxP) }} />
              <span className="rank-name">{p.name}</span>
              <Bar value={p.n} max={maxP} />
              <span className="rank-num">{fmt(p.n)}</span>
              <span className="rank-sub">{fmt(p.n24)}</span>
            </div>
          ))}
          {!data.provinces.length && <p className="muted">No fires in this period.</p>}
        </div>
      </Section>

      {data.daily.length > 1 && (
        <Section icon="📈" title="Fire detections per day">
          <div className="chart" style={{ height: 120 }}>
            <ResponsiveContainer>
              <BarChart data={data.daily} margin={{ top: 6, right: 4, left: -18, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#232326" />
                <XAxis dataKey="date" tickFormatter={(d) => new Date(d + 'T00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTip formatValue={(v) => fmt(v)} />} />
                <RBar dataKey="n" name="Detections" fill="#ec8a2c" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

    </>
  );
}
