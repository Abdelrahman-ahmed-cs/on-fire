import React, { useEffect, useRef, useState } from 'react';
import { CountUp } from './ui.jsx';
import { Icon } from './icons.jsx';

const VIIRS = new Set(['S-NPP', 'NOAA-20', 'NOAA-21']);
const SHORT = { 'S-NPP': 'NPP', 'NOAA-20': 'N20', 'NOAA-21': 'N21', Terra: 'TER', Aqua: 'AQA' };

// Stack of round satellite badges, like the avatar stack on a wallet card.
export function SatStack({ sats, max = 3 }) {
  const list = [...sats].sort((a, b) => b[1] - a[1]);
  const shown = list.slice(0, max);
  return (
    <div className="sat-stack" aria-label={`Seen by ${list.map(([k]) => k).join(', ')}`}>
      {shown.map(([k, n]) => (
        <span key={k} className={`sat-badge ${VIIRS.has(k) ? 'viirs' : 'modis'}`} title={`${k}: ${n.toLocaleString('en-US')} detections (${VIIRS.has(k) ? 'VIIRS 375 m' : 'MODIS 1 km'})`}>
          {SHORT[k] ?? k.slice(0, 3)}
        </span>
      ))}
      {list.length > max && <span className="more">+{list.length - max}</span>}
    </div>
  );
}

// Swipeable metric card: one big number per slide, dots, auto-advance, primary action at the base.
export default function HeroCard({ slides, sats, live = true, chip, action }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const drag = useRef(null);
  const n = slides.length;
  useEffect(() => {
    if (paused || n < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), 5200);
    return () => clearInterval(t);
  }, [paused, n]);
  const go = (d) => setI((x) => (x + d + n) % n);
  const onDown = (e) => (drag.current = e.clientX);
  const onUp = (e) => {
    if (drag.current == null) return;
    const dx = e.clientX - drag.current;
    drag.current = null;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
  };
  return (
    <div
      className="hero-card"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onKeyDown={(e) => (e.key === 'ArrowRight' ? go(1) : e.key === 'ArrowLeft' ? go(-1) : null)}
      tabIndex={0}
      role="region"
      aria-roledescription="carousel"
      aria-label="Key figures"
    >
      <div className="hero-top">
        <span className="hero-chip">{live && <span className="dot" />}{chip}</span>
        <button className="round-btn" onClick={() => go(1)} aria-label="Next figure"><Icon name="chevronRight" size={16} /></button>
      </div>
      <div className="hero-slides" style={{ transform: `translateX(-${i * 100}%)` }}>
        {slides.map((s, k) => (
          <div key={s.label} className="hero-slide" aria-hidden={k !== i}>
            <div className="hero-label">{s.label}</div>
            <div className="hero-value">{k === i ? <CountUp value={s.value} /> : s.value}</div>
            <div className="hero-sub">{s.sub}</div>
          </div>
        ))}
      </div>
      <div className="hero-row">
        {sats && <SatStack sats={sats} />}
        <div className="hero-dots" style={{ padding: 0 }}>
          {slides.map((s, k) => <button key={s.label} className={k === i ? 'on' : ''} onClick={() => setI(k)} aria-label={`Show ${s.label}`} />)}
        </div>
      </div>
      {action && (
        <button className="hero-action" onClick={action.onClick}>
          <span className="plus"><Icon name={action.icon ?? 'arrowRight'} size={13} /></span>
          {action.label}
        </button>
      )}
    </div>
  );
}
