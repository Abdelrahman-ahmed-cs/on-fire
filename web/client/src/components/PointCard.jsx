import React from 'react';
import { Icon, toIcon } from './icons.jsx';
import { Badge } from './ui.jsx';
import { fmt, MONTHS, compassName } from '../lib.js';

export default function PointCard({ point, onClose }) {
  const month = new Date().getUTCMonth();
  return (
    <div className="point-card">
      <button className="close" onClick={onClose} aria-label="Close">×</button>
      <div className="pc-title">{point.province?.name ?? 'Location'}{point.country ? `, ${point.country.name}` : ''}</div>
      <div className="pc-sub">{point.lat.toFixed(3)}°, {point.lon.toFixed(3)}°</div>
      {point.loading && <div className="muted">Checking conditions…</div>}
      {point.error && <div className="error">{point.error}</div>}
      {point.weather && (
        <>
          <div className="pc-row">
            <span>Fire danger now</span>
            <Badge color={point.danger.color}>{point.danger.label}</Badge>
          </div>
          <div className="pc-grid">
            <span><Icon name="thermo" size={13} className="inline-icon" /> {fmt(point.weather.temperature_2m, 1)} °C</span>
            <span><Icon name="drop" size={13} className="inline-icon" /> {fmt(point.weather.relative_humidity_2m)}%</span>
            <span><Icon name="wind" size={13} className="inline-icon" /> {fmt(point.weather.wind_speed_10m)} km/h → {compassName((point.weather.wind_direction_10m + 180) % 360)}</span>
            {point.air && <span><Icon name="cloud" size={13} className="inline-icon" /> AQI {fmt(point.air.us_aqi)} ({point.air.category?.label})</span>}
          </div>
          {point.history && (
            <>
              <div className="pc-row">
                <span>Burned in {MONTHS[month]} in</span>
                <b>{fmt(point.history.p * 100)}% of the last {point.history.years} years</b>
              </div>
              <div className="pc-spark" title="Share of years with fire in this 25 km cell, by month">
                {point.history.byMonth.map((v, m) => (
                  <div key={m} className={m === month ? 'now' : ''}>
                    <i style={{ height: `${Math.max(3, v * 100)}%` }} />
                    <span>{MONTHS[m][0]}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
