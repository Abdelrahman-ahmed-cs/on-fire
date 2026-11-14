import React, { useMemo } from 'react';
import { Icon, toIcon } from './icons.jsx';
import { ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, LineChart, Line, BarChart, Bar } from 'recharts';
import { Section, Loading, ChartTip, Stat, Headline, Details } from './ui.jsx';
import { MONTHS, fmt, compact, SERIES } from '../lib.js';

// Visual: one MODIS pixel covers the same ground as ~7 VIIRS pixels.
function PixelCompare() {
  return (
    <div className="pixels">
      <figure>
        <svg viewBox="0 0 90 90" width="90" height="90" aria-hidden>
          <rect x="5" y="5" width="80" height="80" rx="3" fill="rgba(57,135,229,0.25)" stroke="#3987e5" strokeWidth="2" />
          <circle cx="62" cy="30" r="5" fill="#ff6a1f" />
        </svg>
        <figcaption><b style={{ color: SERIES.modis }}>MODIS</b> (2000 →)<br />1 km squares: sees big fires, misses many small ones</figcaption>
      </figure>
      <figure>
        <svg viewBox="0 0 90 90" width="90" height="90" aria-hidden>
          {Array.from({ length: 9 }, (_, i) => (
            <rect key={i} x={5 + (i % 3) * 27} y={5 + Math.floor(i / 3) * 27} width="25" height="25" rx="2" fill={i === 1 || i === 5 ? 'rgba(217,89,38,0.45)' : 'rgba(217,89,38,0.15)'} stroke="#d95926" strokeWidth="1.5" />
          ))}
          <circle cx="62" cy="30" r="5" fill="#ff6a1f" />
          <circle cx="20" cy="70" r="2.5" fill="#ff6a1f" />
        </svg>
        <figcaption><b style={{ color: SERIES.viirs }}>VIIRS</b> (2012 →)<br />375 m squares: sharper, also sees small fires</figcaption>
      </figure>
    </div>
  );
}

export default function HarmonizationPanel({ data, name }) {
  const series = useMemo(() => data?.series?.filter((s) => s.ym >= '2012-02') ?? [], [data]);
  if (!data) return <Loading text="Loading…" />;
  if (data.error) return <div className="notice">{data.error}</div>;
  const fit = data.method.fit;
  const mf = data.method.modelFit;
  const maxM = Math.max(1, ...data.scatter.map((p) => p.modis));
  const good = mf?.annualErrorPct !== null && mf?.annualErrorPct !== undefined && mf.annualErrorPct <= 15;

  return (
    <>
      <Headline icon="🛰" title="Two generations of satellites, one fair record">
        Old and new satellites count fires differently. We converted the old record so 25 years can be compared month by month.
      </Headline>

      <Section icon="1️⃣" title="The problem">
        <p className="story">Since 2000, NASA's <b>MODIS</b> satellites have spotted fires. In 2012 the sharper <b>VIIRS</b> satellites joined. VIIRS sees about <b>{fit ? fmt(fit.k, 1) : '2–3'}× more fire</b>, so the fire count jumps in 2012 even though the land didn't burn more.</p>
        <PixelCompare />
      </Section>

      <Section icon="2️⃣" title="How we fixed it">
        <ol className="steps">
          <li><b>Clean both records the same way.</b> Remove gas flares, factories and volcanoes, and uncertain detections.</li>
          <li><b>Count the same thing.</b> Instead of counting pixels, we count <i>“burning units”</i>: each day and each ~10 km square that had at least one fire. Big and small pixels then count alike.</li>
          <li><b>Learn the difference.</b> From 2012 on, both satellites watched the same fires. We measured how much more VIIRS sees <i>for each month of the year</i>, then converted the old MODIS years with that factor.</li>
        </ol>
      </Section>

      <Section icon="3️⃣" title="Does it work?">
        <div className={`verdict ${good ? 'good' : 'fair'}`}>
          <span className="verdict-icon">{toIcon(good ? '✅' : '⚠️', 18)}</span>
          <span>
            For {name}, converted MODIS matches the real VIIRS yearly totals to within <b>±{fmt(mf?.annualErrorPct, 0)}%</b> on average ({mf?.years} years tested).
            {good ? ' The old and new records can be compared fairly.' : ' Good enough for patterns and seasons; use single-year numbers with care.'}
          </span>
        </div>
        <div className="stats">
          <Stat label="VIIRS sees more by" value={fit ? `× ${fmt(fit.k, 2)}` : '—'} sub="conversion factor" tone="hot" />
          <Stat label="Monthly match (R²)" value={mf?.r2 !== null && mf?.r2 !== undefined ? fmt(mf.r2, 2) : '—'} sub="1.0 = perfect" info="R² of the seasonal model: how much of the month-to-month variation in VIIRS is reproduced by converted MODIS." />
        </div>

        <div className="chart-title">Before and after the conversion (2012 → today)</div>
        <div className="legend-row">
          <span><i style={{ background: SERIES.modis }} />MODIS as measured</span>
          <span><i style={{ background: SERIES.scaled }} />MODIS converted</span>
          <span><i style={{ background: SERIES.viirs }} />VIIRS as measured</span>
        </div>
        <div className="chart" style={{ height: 190 }}>
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 8, right: 6, left: -8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#232326" />
              <XAxis dataKey="ym" tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => v.slice(0, 4)} interval={23} />
              <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={compact} />
              <Tooltip content={<ChartTip formatValue={(v) => fmt(v)} />} />
              <Line dataKey="modis" name="MODIS as measured" stroke={SERIES.modis} dot={false} strokeWidth={1.5} />
              <Line dataKey="modisScaled" name="MODIS converted" stroke={SERIES.scaled} dot={false} strokeWidth={2} />
              <Line dataKey="viirs" name="VIIRS as measured" stroke={SERIES.viirs} dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <p className="hint">The green line (converted old satellite) follows the orange line (new satellite), so the conversion works.</p>
      </Section>

      <Details title="Technical details (scatter, factors per month, stability)">
        <Section title="MODIS vs VIIRS, same month" hint={`Each dot is one month of ${name} since 2012. The dashed line is the fitted conversion VIIRS = k × MODIS.`}>
          <div className="chart" style={{ height: 220 }}>
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 8, right: 10, left: -6, bottom: 12 }}>
                <CartesianGrid stroke="#232326" />
                <XAxis type="number" dataKey="modis" name="MODIS" tick={{ fill: '#6c6c72', fontSize: 11 }} tickFormatter={compact} label={{ value: 'MODIS burning units', position: 'insideBottom', offset: -6, fill: '#6c6c72', fontSize: 11 }} />
                <YAxis type="number" dataKey="viirs" name="VIIRS" tick={{ fill: '#6c6c72', fontSize: 11 }} tickFormatter={compact} />
                <Tooltip content={({ active, payload }) => active && payload?.length ? (
                  <div className="chart-tip">
                    <div className="chart-tip-title">{payload[0].payload.ym}</div>
                    <div className="chart-tip-row"><span className="swatch" style={{ background: SERIES.modis }} />MODIS<b>{fmt(payload[0].payload.modis)}</b></div>
                    <div className="chart-tip-row"><span className="swatch" style={{ background: SERIES.viirs }} />VIIRS<b>{fmt(payload[0].payload.viirs)}</b></div>
                  </div>
                ) : null} />
                {fit && <ReferenceLine segment={[{ x: 0, y: 0 }, { x: maxM, y: maxM * fit.k }]} stroke="#fff" strokeWidth={2} strokeDasharray="5 4" ifOverflow="extendDomain" />}
                <Scatter data={data.scatter} fill={SERIES.viirs} fillOpacity={0.7} shape="circle" />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        </Section>

        <Section title="Conversion factor for each month" hint="Fire size and vegetation change with the seasons, so each calendar month gets its own factor when there are enough fires.">
          <div className="kgrid">
            {data.method.kByMonth.map((k, m) => (
              <div key={m} className="kcell" title={`Fitted at ${k.level} level`}>
                <span>{MONTHS[m]}</span>
                <b>{fmt(k.k, 2)}</b>
                <small>{k.level.replace('-month', '/mo')}</small>
              </div>
            ))}
          </div>
        </Section>

        {data.annualOverlap?.length > 0 && (
          <Section title="Is the factor stable from year to year?" hint="VIIRS ÷ MODIS for each year. Bars close to the dashed line mean one factor fits all years.">
            <div className="chart" style={{ height: 140 }}>
              <ResponsiveContainer>
                <BarChart data={data.annualOverlap} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#232326" />
                  <XAxis dataKey="year" tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} interval={2} />
                  <YAxis tick={{ fill: '#6c6c72', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<ChartTip formatValue={(v) => `× ${fmt(v, 2)}`} />} />
                  {fit && <ReferenceLine y={fit.k} stroke="#fff" strokeDasharray="4 3" />}
                  <Bar dataKey="ratio" name="VIIRS / MODIS" fill={SERIES.viirs} radius={[4, 4, 0, 0]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Section>
        )}
        <p className="hint">
          Unit: {data.method.unit}. Single-factor fit k = {fit ? fmt(fit.k, 3) : '—'}, R² {fit ? fmt(fit.r2, 2) : '—'} over {fmt(fit?.n)} months; fit level: {data.method.fitLevel}. Confidence filter: MODIS ≥ 30%, VIIRS nominal/high. Static sources removed via FIRMS type flags, a 25-year persistent-source mask, and a ≥3-day stationary-heat check.
        </p>
      </Details>
    </>
  );
}
