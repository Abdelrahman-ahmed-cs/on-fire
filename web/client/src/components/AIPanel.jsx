import React from 'react';
import { Icon, toIcon } from './icons.jsx';
import { Section, Loading, Headline, Details, Badge, Stat, Info } from './ui.jsx';
import { fmt, compact, listJoin } from '../lib.js';

const GROUP_ICON = { history: '📅', heat: '🌡', dryness: '🏜', fuel: '🌾', wind: '💨', place: '🗺' };

function Percent({ p, level }) {
  return (
    <div className={`ai-pct ${level.key}`} style={{ "--p": Math.round(p * 100) }}>
      <b>{Math.round(p * 100)}%</b>
      <span>{level.label}</span>
    </div>
  );
}

// Detail card for one ~50 km area: probability, why, and what to do.
function CellCard({ cell, onClose }) {
  if (cell.loading) return <div className="ai-card"><Loading text="Asking the AI about this area…" /></div>;
  if (cell.error) return <div className="ai-card"><div className="error">{cell.error}</div><button className="btn small" onClick={onClose}>Close</button></div>;
  const c = cell.conditions;
  const byWho = cell.advice.reduce((acc, a) => ((acc[a.who] ??= []).push(a), acc), {});
  return (
    <div className={`ai-card ${cell.level.key}`}>
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <div className="ai-card-top">
        <Percent p={cell.p} level={cell.level} />
        <div>
          <div className="ai-card-title">{cell.place ? `Around ${cell.place}` : 'This area'}, {cell.country}</div>
          <div className="ai-card-sub">Chance that fire breaks out in this ~50 km area in {cell.target.monthName} {cell.target.year}</div>
        </div>
      </div>

      <div className="chart-title">Why the AI thinks so</div>
      <div className="reasons">
        {cell.reasons.length ? cell.reasons.map((r) => (
          <div key={r.key} className="reason">
            <span className="reason-icon">{toIcon(GROUP_ICON[r.key], 15)}</span>
            <span>{r.text}</span>
          </div>
        )) : <div className="muted">No strong fire drivers here this month.</div>}
        {cell.lowering?.map((r) => (
          <div key={r.key} className="reason good">
            <span className="reason-icon"><Icon name="check" size={15} /></span>
            <span>{r.label} lowers the risk</span>
          </div>
        ))}
      </div>

      <div className="cond-grid">
        <span><Icon name="thermo" size={13} className="inline-icon" /> {fmt(c.tmax, 0)} °C highs <small>({c.tmaxAnom > 0 ? '+' : ''}{fmt(c.tmaxAnom, 1)} vs normal)</small></span>
        <span><Icon name="rain" size={13} className="inline-icon" /> {fmt(c.rain3m * 30, 0)} mm/month rain lately</span>
        <span><Icon name="drop" size={13} className="inline-icon" /> {fmt(c.rh)} % humidity</span>
        <span><Icon name="sprout" size={13} className="inline-icon" /> soil {fmt(c.soilWet * 100)} % wet</span>
        <span><Icon name="wind" size={13} className="inline-icon" /> {fmt(c.windKmh)} km/h wind</span>
        <span><Icon name="calendar" size={13} className="inline-icon" /> burned {c.histYears}/{c.histOf} years this month</span>
      </div>
      {cell.popNearby > 0 && <p className="hint">{compact(cell.popNearby)} people live within 30 km ({listJoin(cell.townsNearby.slice(0, 3).map((t) => t.name))}).</p>}

      <div className="chart-title">How to reduce the risk</div>
      {Object.entries(byWho).map(([who, items]) => (
        <div key={who} className="advice-group">
          <div className="advice-who">{who}</div>
          {items.map((a) => (
            <div key={a.title} className="advice">
              <span className="advice-icon">{toIcon(a.icon, 16) ?? <Icon name="info" size={16} />}</span>
              <div>
                <b>{a.title}</b>
                <p>{a.text}</p>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function AIPanel({ data, when, setWhen, view, cell, onCloseCell, onAlert }) {
  if (!data) return <Loading text="The AI is scoring every 50 km area…" />;
  if (data.error) return <div className="notice">{data.error}</div>;
  const iso = view.level === 'country' ? view.iso : null;
  const alerts = data.alerts.filter((a) => !iso || a.iso === iso);
  const countries = data.countries.filter((c) => !iso || c.iso === iso);
  const red = countries.reduce((s, c) => s + c.red, 0);
  const high = countries.reduce((s, c) => s + c.high, 0);
  const m = data.model.metrics;
  const topPlaces = alerts.filter((a) => a.place).slice(0, 3).map((a) => a.place);
  const imp = Object.entries(data.model.groupImportance).sort((a, b) => b[1] - a[1]);
  const maxImp = imp[0]?.[1] || 1;

  return (
    <>
      <div className="seg ai-when" role="group" aria-label="Prediction month">
        <button className={when === 'current' ? 'on' : ''} onClick={() => setWhen('current')}>This month</button>
        <button className={when === 'next' ? 'on' : ''} onClick={() => setWhen('next')}>Next month</button>
      </div>

      {cell && <CellCard cell={cell} onClose={onCloseCell} />}

      <Headline icon={red ? '🚨' : high ? '⚠️' : '✅'} tone={red ? 'warn' : ''} title={red ? `${red} area${red === 1 ? '' : 's'} on RED ALERT for ${data.target.monthName}` : high ? `${high} high-risk area${high === 1 ? '' : 's'} in ${data.target.monthName}` : `Low fire risk in ${data.target.monthName}`}>
        {red + high ? <>Most at risk: <b>{listJoin(topPlaces)}</b>. </> : null}
        Click a pulsing marker or any area on the map to see why and what to do.
      </Headline>

      <div className="stats">
        <Stat icon="🚨" label="Red alert areas" value={fmt(red)} sub="75 %+ and weather makes it worse" tone="hot" info="Red alert = fire is very likely (75 %+) AND this month's heat, dryness, fuel or wind push the chance above what is usual for the place." />
        <Stat icon="⚠️" label="High-risk areas" value={fmt(high)} sub="50 %+ chance (often seasonal burning)" />
      </div>

      <Section icon="🚨" title="Top alerts" hint="Each area is about 50 × 50 km. Click one to see the reasons and how to reduce the risk.">
        <div className="events">
          {alerts.slice(0, 15).map((a, i) => (
            <button key={i} className="event-row" onClick={() => onAlert(a)}>
              <span className={`ai-mini ${a.level.key}`}>{Math.round(a.p * 100)}%</span>
              <span className="event-main">
                <span className="event-title">{a.place ? `Around ${a.place}` : `${a.lat.toFixed(1)}°, ${a.lon.toFixed(1)}°`}{!iso ? `, ${a.country}` : ''}</span>
                <span className="event-sub">{a.reasons.map((r) => r.label.toLowerCase()).slice(0, 2).join(' · ') || 'seasonal risk'}</span>
              </span>
              <Badge color={a.level.color}>{a.level.label}</Badge>
            </button>
          ))}
          {!alerts.length && <p className="muted"><Icon name="check" size={13} className="inline-icon" /> No area reaches high risk this month.</p>}
        </div>
      </Section>

      {!iso && (
        <Section icon="🗺" title="Alerts by country">
          <table className="table">
            <thead><tr><th>Country</th><th>Red alert</th><th>High</th><th>Highest chance</th></tr></thead>
            <tbody>
              {countries.filter((c) => c.red || c.high).map((c) => (
                <tr key={c.iso}>
                  <td><b>{c.name}</b></td>
                  <td>{c.red ? <Badge color="#ff1a1a">{c.red}</Badge> : '—'}</td>
                  <td>{c.high ? <Badge color="#ff7a00">{c.high}</Badge> : '—'}</td>
                  <td>{Math.round(c.maxP * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <Section icon="🎯" title="Can we trust it?" hint={`Tested on ${data.model.data.testFrom.slice(0, 4)}–${data.model.data.to.slice(0, 4)}, years the AI never saw during training.`}>
        <div className="verdict good">
          <span className="verdict-icon"><Icon name="target" size={15} /></span>
          <span>
            When it raised a <b>red alert</b>, fire really came <b>{fmt((m.redAlert.precision ?? 0) * 100)}%</b> of the time.
            Areas it rated high or above burned {fmt((m.highOrAbove.precision ?? 0) * 100)}% of the time, and caught <b>{fmt((m.recallHigh ?? 0) * 100)}%</b> of all fires in advance.
            {m.lowAreasBurned !== undefined && m.lowAreasBurned !== null ? <> Areas rated low burned only {fmt(m.lowAreasBurned * 100)}% of the time.</> : null}
          </span>
        </div>
        <div className="stats">
          <Stat label="Ranking skill (AUC)" value={fmt(m.auc, 2)} sub={`history alone: ${fmt(m.aucHistoryOnly, 2)}`} info="AUC = how often the AI ranks a place that burned above one that didn't. 1.0 = perfect, 0.5 = guessing. Compared with using past fire frequency alone." />
          <Stat label="Tested on" value={compact(m.samples)} sub="area-months" />
        </div>
      </Section>

      <Section icon="🧠" title="What makes fires likely?" hint="How much the AI's accuracy drops if we hide each kind of information. Fire history matters most (fires repeat in the same places and seasons). Weather then decides whether this year is worse than usual, which is what triggers red alerts.">
        <div className="imp">
          {imp.map(([k, v]) => (
            <div key={k} className="imp-row">
              <span className="with-icon">{toIcon(GROUP_ICON[k], 13)} {data.model.groups[k]}</span>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(v / maxImp) * 100}%`, background: '#ff7a2f' }} /></div>
              <b>{v >= 0.01 ? fmt(v * 100, 1) : '<1'}</b>
            </div>
          ))}
        </div>
      </Section>

      <Details title="How does the AI work?">
        <p className="hint">
          A <b>gradient-boosted decision-tree</b> model ({data.model.data.rows ? compact(data.model.data.rows) : '—'} examples, {data.model.data.cells} areas of 50 km) learned when and where fires happen from {data.model.data.from.slice(0, 4)}–{data.model.data.to.slice(0, 4)}.
          Fire records: {data.model.data.labels}. Weather: {data.model.data.weather}: monthly highest temperature, rain, humidity, wind and soil moisture, plus rain in the previous 3 and 6 months (drought and grass growth), heatwave anomaly, elevation, season and each area's fire history.
        </p>
        <p className="hint">
          For {data.target.monthName}, weather comes from: {data.weatherSource}. The percentage is the chance that satellites detect at least one fire in the area during the month. Each prediction is explained by tracing which inputs pushed the chance up or down. Model trained {new Date(data.model.trainedAt).toLocaleDateString('en-GB')}.
        </p>
      </Details>
    </>
  );
}
