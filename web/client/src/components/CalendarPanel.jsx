import React, { useMemo, useRef, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, AreaChart, Area, ReferenceLine } from 'recharts';
import { Section, Loading, ChartTip, Stat, Headline } from './ui.jsx';
import { Icon } from './icons.jsx';
import { MONTHS, MONTHS_LONG, fmt, compact, quantileColor, anomalyColor, ACTIVITY_RAMP, SERIES, normalWord, listJoin, downloadFile, toCsv, slug } from '../lib.js';
import { DownloadButtons, svgToPng, RangeSection } from './Extras.jsx';

function trendWord(t) {
  if (!t) return '—';
  if (t.pctPerYear > 1.5) return 'Increasing';
  if (t.pctPerYear > 0.5) return 'Slightly up';
  if (t.pctPerYear < -1.5) return 'Decreasing';
  if (t.pctPerYear < -0.5) return 'Slightly down';
  return 'Stable';
}

function monthRanges(months) {
  // [5,6,7,11] → "Jun–Aug, Dec"
  const out = [];
  let start = null;
  months.forEach((m, i) => {
    if (start === null) start = m;
    if (months[i + 1] !== m + 1) {
      out.push(start === m ? MONTHS[m] : `${MONTHS[start]}–${MONTHS[m]}`);
      start = null;
    }
  });
  return out.join(', ');
}

function Heatmap({ calendar, mode, counts }) {
  const [hover, setHover] = useState(null);
  const years = [...calendar.years].reverse();
  const byKey = useMemo(() => Object.fromEntries(calendar.cells.map((c) => [`${c.year}-${c.month}`, c])), [calendar]);
  // Quantile classes keep contrast whatever the range of the data.
  const breaks = useMemo(() => {
    const v = calendar.cells.map((c) => c.value).filter((x) => x > 0).sort((a, b) => a - b);
    return ACTIVITY_RAMP.slice(1).map((_, i) => v[Math.floor(((i + 1) / ACTIVITY_RAMP.length) * (v.length - 1))] ?? 0);
  }, [calendar]);
  const critical = new Set(calendar.criticalMonths);
  const cw = 26, ch = 13, gap = 2, left = 36, top = 18;
  const width = left + 12 * (cw + gap);
  const height = top + years.length * (ch + gap) + 4;
  return (
    <div className="heatmap-wrap" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="Burning activity calendar, years by months">
        {MONTHS.map((m, i) => (
          <g key={m}>
            <text x={left + i * (cw + gap) + cw / 2} y={11} textAnchor="middle" className={`hm-month ${critical.has(i) ? 'crit' : ''}`}>{m[0]}{m[1]}</text>
            {critical.has(i) && <rect x={left + i * (cw + gap)} y={14} width={cw} height={2} rx={1} fill="#ff6b35" />}
          </g>
        ))}
        {years.map((y, r) => (
          <g key={y}>
            <text x={left - 6} y={top + r * (ch + gap) + ch - 3} textAnchor="end" className="hm-year">{y}</text>
            {MONTHS.map((_, m) => {
              const c = byKey[`${y}-${m}`];
              const fill = !c ? 'transparent' : mode === 'anomaly' ? anomalyColor(c.z) : quantileColor(c.value, breaks);
              return (
                <rect
                  key={m}
                  x={left + m * (cw + gap)}
                  y={top + r * (ch + gap)}
                  width={cw}
                  height={ch}
                  rx={2}
                  fill={fill}
                  stroke={hover && hover.year === y && hover.month === m ? '#fff' : 'none'}
                  strokeWidth={1.5}
                  onMouseEnter={() => c && setHover({ ...c, x: (left + m * (cw + gap) + cw / 2) / width, y: (top + r * (ch + gap)) / height })}
                />
              );
            })}
            {y === 2012 && <line x1={left - 30} x2={width} y1={top + r * (ch + gap) + ch + 1} y2={top + r * (ch + gap) + ch + 1} stroke="#6c6c72" strokeDasharray="3 3" strokeWidth={0.8} />}
          </g>
        ))}
      </svg>
      {hover && (
        <div className="hm-tip" style={{ left: `${hover.x * 100}%`, top: `${hover.y * 100}%` }}>
          <b>{MONTHS_LONG[hover.month]} {hover.year}</b>
          <div>{fmt(hover.value, 0)} burning units <small>(days × 10 km squares with fire)</small></div>
          <div>{hover.ratio !== null ? `${fmt(hover.ratio * 100)}% of normal` : ''}{hover.z ? ` · z = ${hover.z > 0 ? '+' : ''}${hover.z}` : ''}</div>
          {counts?.[`${hover.year}-${hover.month}`] && <div>{hotspotLine(counts[`${hover.year}-${hover.month}`])}</div>}
          <div className="muted">{hover.source === 'VIIRS' ? 'VIIRS S-NPP observed' : 'MODIS, harmonized to VIIRS scale'}</div>
        </div>
      )}
    </div>
  );
}

// "Hotspots detected: MODIS 1,234 · VIIRS 5,678" for one month (raw counts, not comparable between sensors).
const hotspotLine = (c) => `Hotspots detected: ${[c.m != null ? `MODIS ${fmt(c.m)}` : null, c.v != null ? `VIIRS ${fmt(c.v)}` : null].filter(Boolean).join(' · ')}`;

// One row per month: hotspots each sensor detected and the harmonized value the calendar shows.
function calendarCsv(data, cal) {
  const ratio = Object.fromEntries(cal.cells.map((c) => [`${c.year}-${c.month}`, c]));
  const rows = (data.series ?? []).map((s) => {
    const y = +s.ym.slice(0, 4), m = +s.ym.slice(5) - 1;
    const c = ratio[`${y}-${m}`];
    return [y, m + 1, s.modisCount ?? '', s.viirsCount ?? '', s.value, s.source, c?.ratio ?? '', c?.z ?? ''];
  });
  return toCsv(['year', 'month', 'modis_hotspots', 'viirs_hotspots', 'harmonized_burning_units', 'source', 'ratio_to_normal', 'z_score'], rows);
}

export default function CalendarPanel({ data, name, children, range }) {
  const [mode, setMode] = useState('activity');
  const hmRef = useRef(null);
  const counts = useMemo(() => Object.fromEntries((data?.series ?? []).map((s) => [`${+s.ym.slice(0, 4)}-${+s.ym.slice(5) - 1}`, { m: s.modisCount ?? null, v: s.viirsCount ?? null }])), [data]);
  if (!data) return <Loading text="Loading 25-year harmonized record…" />;
  if (data.error) return <div className="notice">{data.error}</div>;
  const cal = data.calendar;
  const now = new Date().getUTCMonth();
  const climData = cal.climatology.map((c, m) => ({ month: MONTHS[m], mean: +c.mean.toFixed(1), crit: cal.criticalMonths.includes(m), m }));
  const annualData = cal.annual.map((a) => ({ ...a, era: a.year < 2012 ? 'MODIS × k' : 'VIIRS' }));
  const weekly = cal.weekly.meanDetections.map((v, i) => ({ week: i + 1, v, month: MONTHS[Math.min(11, Math.floor((i * 7) / 30.44))] }));

  // complete years only, so an unfinished year is never ranked
  const topYears = [...cal.annual].filter((a) => a.complete && a.total > 0).sort((a, b) => b.total - a.total).slice(0, 3);
  const topMonths = [...cal.cells].filter((c) => c.value > 0).sort((a, b) => b.value - a.value).slice(0, 3);
  const ytd = normalWord(cal.ytd.ratio);
  const critNames = cal.criticalMonths.map((m) => MONTHS_LONG[m]);

  return (
    <>
      <Headline icon="📅" title={`In ${name}, fires peak in ${MONTHS_LONG[cal.peakMonth]}`}>
        The fire season runs <b>{monthRanges(cal.fireSeason)}</b>{critNames.length ? <>; the most dangerous months are <b>{listJoin(critNames)}</b></> : null}.
        {ytd ? <> So far, {cal.ytd.year} has been <b className={ytd.tone}>{ytd.word}</b>.</> : null}
      </Headline>
      <div className="stats">
        <Stat icon="📆" label="Fire season" small value={cal.fireSeason.length ? monthRanges(cal.fireSeason) : '—'} sub="3 of 4 fires happen then" tone="hot" info="The fewest months that together hold 75% of a normal year's burning." />
        <Stat icon="⛰" label="Worst month" value={MONTHS_LONG[cal.peakMonth] ?? '—'} sub={`${fmt(cal.climatology[cal.peakMonth]?.share, 1)}% of a year's fires`} />
        <Stat icon="📈" label="Since 2001" value={trendWord(cal.trend)} small sub={cal.trend ? `${cal.trend.pctPerYear > 0 ? '+' : ''}${fmt(cal.trend.pctPerYear, 1)}% per year` : ''} info="Straight-line trend of yearly totals over all complete years." />
        <Stat icon="🗓" label={`${cal.ytd.year} so far`} value={ytd ? ytd.word.replace(' than normal', '') : '—'} small sub={cal.ytd.ratio !== null ? `${fmt(cal.ytd.ratio * 100)}% of a normal year` : ''} />
      </div>

      <Section
        icon="🗓"
        title="25 years of fire, month by month"
        hint="Each square is one month (rows = years, columns = months). Brighter = more fire. Switch to 'Compared to normal' to spot unusual months. Hover a square for details, including the raw hotspot counts."
        right={
          <div className="seg small">
            <button className={mode === 'activity' ? 'on' : ''} onClick={() => setMode('activity')}>Amount</button>
            <button className={mode === 'anomaly' ? 'on' : ''} onClick={() => setMode('anomaly')}>Compared to normal</button>
          </div>
        }
      >
        <div ref={hmRef}><Heatmap calendar={cal} mode={mode} counts={counts} /></div>
        {mode === 'activity' ? (
          <div className="scale">
            <span>Little fire</span>
            {ACTIVITY_RAMP.map((c) => <i key={c} style={{ background: c }} />)}
            <span>A lot</span>
          </div>
        ) : (
          <div className="scale">
            <span>Quieter than normal</span>
            {[-2.5, -1.8, -1, 0, 1, 1.8, 2.5].map((z) => <i key={z} style={{ background: anomalyColor(z) }} />)}
            <span>Busier</span>
          </div>
        )}
        <p className="hint unit-note">
          <b>Burning unit</b> = one 10 km square with at least one hotspot on one day. VIIRS sees about 7× more hotspots than MODIS for the same fire, so On Fire counts squares, not raw hotspots, and converts MODIS to the VIIRS scale. That keeps all 25 years comparable.
        </p>
      </Section>

      <Section icon="📊" title="A normal year" hint={`How much burning each month usually has (average ${cal.baselineYears?.join('–') ?? '—'}). Bright bars = dangerous months, white outline = this month.`}>
        <div className="chart" style={{ height: 150 }}>
          <ResponsiveContainer>
            <BarChart data={climData} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#232326" />
              <XAxis dataKey="month" tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} interval={0} tickFormatter={(m) => m[0]} />
              <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={compact} />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTip formatLabel={(l, p) => `${MONTHS_LONG[p[0]?.payload.m]}${p[0]?.payload.crit ? ' · critical' : ''}`} formatValue={(v) => `${fmt(v)} burning units`} />} />
              <Bar dataKey="mean" name="Average" radius={[4, 4, 0, 0]} maxBarSize={22}>
                {climData.map((d) => <Cell key={d.m} fill={d.crit ? '#ff6a1f' : '#7a3b10'} stroke={d.m === now ? '#fff' : 'none'} strokeWidth={1.5} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Section>

      {cal.weekly.years > 0 && (
        <Section icon="🗓" title="Week by week" hint={`Average number of fire detections in each week of the year (${cal.weekly.years} years). The dashed white line is this week.`}>
          <div className="chart" style={{ height: 120 }}>
            <ResponsiveContainer>
              <AreaChart data={weekly} margin={{ top: 8, right: 4, left: -14, bottom: 0 }}>
                <defs>
                  <linearGradient id="wk" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#ff6a1f" stopOpacity={0.7} />
                    <stop offset="1" stopColor="#ff6a1f" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#232326" />
                <XAxis dataKey="week" tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} ticks={[1, 10, 19, 27, 36, 45]} tickFormatter={(w) => MONTHS[Math.min(11, Math.floor(((w - 1) * 7) / 30.44))]} />
                <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={compact} />
                <Tooltip content={<ChartTip formatLabel={(w, p) => `Week ${w} (${p[0]?.payload.month})`} formatValue={(v) => `${fmt(v)} detections`} />} />
                <ReferenceLine x={Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 604800000) + 1} stroke="#fff" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="v" name="Average" stroke="#ff6a1f" strokeWidth={2} fill="url(#wk)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      <Section icon="📈" title="Year by year" hint="Total burning each year. Blue years come from the older MODIS satellites, converted so they compare fairly with the newer VIIRS years (orange). Faded = year not finished.">
        <div className="legend-row">
          <span><i style={{ background: SERIES.modis }} />MODIS × k (2000–2011)</span>
          <span><i style={{ background: SERIES.viirs }} />VIIRS (2012–)</span>
        </div>
        <div className="chart" style={{ height: 160 }}>
          <ResponsiveContainer>
            <BarChart data={annualData} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#232326" />
              <XAxis dataKey="year" tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} interval={4} />
              <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={compact} />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTip formatLabel={(y, p) => `${y}${p[0]?.payload.complete ? '' : ' (partial year)'}`} formatValue={(v) => `${fmt(v)} burning units`} />} />
              <Bar dataKey="total" name="Activity" radius={[4, 4, 0, 0]}>
                {annualData.map((d) => <Cell key={d.year} fill={d.year < 2012 ? SERIES.modis : SERIES.viirs} fillOpacity={d.complete ? 1 : 0.45} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {topYears.length > 0 && (
          <p className="top-years">
            <span>Busiest years</span>
            {topYears.map((a, i) => <b key={a.year}>{i ? ' · ' : ''}{a.year} <small>{compact(a.total)}</small></b>)}
          </p>
        )}
        {topMonths.length > 0 && (
          <p className="top-years">
            <span>Busiest months</span>
            {topMonths.map((c, i) => <b key={`${c.year}-${c.month}`}>{i ? ' · ' : ''}{MONTHS[c.month]} {c.year} <small>{compact(c.value)}</small></b>)}
          </p>
        )}
      </Section>
      {range && <RangeSection series={data.series ?? []} calendar={cal} {...range} />}
      <Section icon={<Icon name="download" size={15} />} title="Downloads" hint={`The month-by-month record for ${name}, ready for a spreadsheet or a report.`}>
        <DownloadButtons
          items={[
            { label: 'Calendar (CSV)', icon: 'fileText', onClick: () => downloadFile(`onfire_calendar_${slug(name)}.csv`, calendarCsv(data, cal)) },
            { label: 'Calendar (PNG)', icon: 'download', onClick: () => svgToPng(hmRef.current?.querySelector('svg'), `onfire_calendar_${slug(name)}.png`, `${name} · burning activity by month (${mode === 'anomaly' ? 'compared to normal' : 'amount'})`) },
          ]}
        />
        {children}
      </Section>
    </>
  );
}
