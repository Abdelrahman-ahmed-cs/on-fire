import React from 'react';
import { fmt, ago, eventStrength, STRENGTH_COLOR } from '../lib.js';

export default function EventList({ events, onEvent, showCountry }) {
  if (!events?.length) return <p className="muted">No fires in this period.</p>;
  return (
    <div className="events">
      {events.map((e) => {
        const strength = eventStrength(e.frpSum);
        const status = e.lastAgeH <= 6 ? 'Burning now' : e.lastAgeH <= 24 ? 'Today' : `Last seen ${ago(e.lastAgeH)}`;
        return (
          <button key={e.id} className="event-row" onClick={() => onEvent(e.id, e.iso)}>
            <span className={`pulse ${e.lastAgeH <= 6 ? 'live' : e.lastAgeH <= 24 ? 'recent' : ''}`} />
            <span className="event-main">
              <span className="event-title">{e.provName || 'Unknown area'}{showCountry ? `, ${e.country}` : ''}</span>
              <span className="event-sub">
                {status} · {e.durationH >= 1 ? `burning ${e.durationH >= 48 ? `${Math.round(e.durationH / 24)} days` : `${Math.round(e.durationH)} h`}` : 'just started'} · {fmt(e.n)} detections
              </span>
            </span>
            <span className="strength" style={{ '--s': STRENGTH_COLOR[strength] }}>{strength}</span>
          </button>
        );
      })}
    </div>
  );
}
