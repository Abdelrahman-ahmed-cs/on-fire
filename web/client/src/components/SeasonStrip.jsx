import React from 'react';
import { MONTHS, MONTHS_LONG, fmt, normalWord } from '../lib.js';
import { Info } from './ui.jsx';

// "Is this a normal fire season?" card, driven by the 25-year harmonized record.
export default function SeasonStrip({ calendar }) {
  if (!calendar?.climatology) return null;
  const now = new Date().getUTCMonth();
  const clim = calendar.climatology;
  const max = Math.max(...clim.map((c) => c.mean), 1);
  const critical = new Set(calendar.criticalMonths);
  const inCritical = critical.has(now);
  const year = new Date().getUTCFullYear();
  const cur = calendar.cells.find((c) => c.year === year && c.month === now);
  const prevCell = now === 0 ? calendar.cells.find((c) => c.year === year - 1 && c.month === 11) : calendar.cells.find((c) => c.year === year && c.month === now - 1);
  // Compared with the MEDIAN of the same calendar month over all complete years (the challenge's
  // "current month against the historical median"); a month in progress with the same share of it.
  const median = (m) => clim[m].median ?? clim[m].mean;
  const prev = prevCell && median(prevCell.month) > 0 ? { ...prevCell, ratio: prevCell.value / median(prevCell.month) } : null;
  let ref = prev;
  if (cur) {
    const d = new Date();
    const frac = Math.max(1, d.getUTCDate() - 1) / new Date(Date.UTC(d.getUTCFullYear(), now + 1, 0)).getUTCDate();
    const expected = median(now) * frac;
    ref = expected > 0 ? { ...cur, ratio: cur.value / expected } : prev;
  }
  const nw = ref ? normalWord(ref.ratio) : null;

  return (
    <div className={`season ${inCritical ? 'critical' : ''}`}>
      <div className="season-head">
        <span className="season-tag">{inCritical ? 'Peak fire season' : 'Outside peak fire season'}</span>
        <span className="season-text">
          {nw ? (
            <>
              This {ref === prev ? 'past month' : 'month so far'} is <b className={nw.tone}>{nw.word}</b> ({fmt(ref.ratio * 100)}% of the median).
            </>
          ) : null}{' '}
          Fires peak in <b>{MONTHS_LONG[calendar.peakMonth]}</b>.
          <Info text={`Compared with the median of the same month over ${calendar.baselineYears ? calendar.baselineYears.join('–') : 'all complete years'} (NASA MODIS 2000–2011 converted to match VIIRS 2012–today). A month in progress is compared with the same share of that median.`} />
        </span>
      </div>
      <div className="season-bars" role="img" aria-label="How much burning usually happens in each month">
        {clim.map((c, m) => (
          <div key={m} className={`sb ${m === now ? 'now' : ''} ${critical.has(m) ? 'crit' : ''}`} title={`${MONTHS_LONG[m]}: ${fmt(c.share, 1)}% of a year's fires${critical.has(m) ? ' (peak season)' : ''}`}>
            <div className="sb-fill" style={{ height: `${Math.max(4, (c.mean / max) * 100)}%` }} />
            <span>{MONTHS[m][0]}</span>
          </div>
        ))}
      </div>
      <div className="season-foot">A normal year: bars show how much burning usually happens each month (bright = peak season, outlined = now).</div>
    </div>
  );
}
