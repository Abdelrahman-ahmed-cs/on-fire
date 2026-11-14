import React, { useEffect, useRef, useState } from 'react';
import createGlobe from 'cobe';
import OnFireMark from './OnFireMark.jsx';
import { Icon } from '../components/icons.jsx';

// Mission clock: satellite passes and FIRMS timestamps are all in UTC.
export function UtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <time className="utc" dateTime={now.toISOString()} title="Coordinated Universal Time (satellite passes are timed in UTC)">
      <span>UTC</span>
      {now.toISOString().slice(11, 19)}
    </time>
  );
}

// Spinning cobe globe (Middle East & North Africa facing the viewer first), with live fires as markers.
function BootGlobe({ fires }) {
  const ref = useRef(null);
  const markers = useRef([]);
  markers.current = (fires ?? []).slice(0, 400).map((f) => ({ location: [f.lat, f.lon], size: 0.03 + Math.min(0.07, (f.frpMax ?? 10) / 1200) }));
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let phi = -0.55; // MENA facing the viewer
    const size = canvas.offsetWidth * 2;
    const globe = createGlobe(canvas, {
      devicePixelRatio: 2,
      width: size,
      height: size,
      phi,
      theta: 0.32,
      dark: 1,
      diffuse: 2,
      mapSamples: 18000,
      mapBrightness: 9,
      baseColor: [0.32, 0.29, 0.27],
      markerColor: [1, 0.42, 0.12],
      glowColor: [1, 0.45, 0.15],
      markers: markers.current,
      onRender: (state) => {
        if (!reduce) phi += 0.0022;
        state.phi = phi;
        state.markers = markers.current;
      },
    });
    return () => globe.destroy();
  }, []);
  return (
    <div className="boot-globe">
      <canvas ref={ref} />
    </div>
  );
}

// Opening screen, shown until the first satellite feed arrives (minimum 1.4 s so the globe reads).
export function BootScreen({ ready, fires }) {
  const [minDone, setMinDone] = useState(false);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinDone(true), 1400);
    return () => clearTimeout(t);
  }, []);
  const done = ready && minDone;
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setGone(true), 700);
    return () => clearTimeout(t);
  }, [done]);
  if (gone) return null;
  return (
    <div className={`boot ${done ? 'done' : ''}`} role="status" aria-live="polite">
      <div className="boot-glow" />
      <BootGlobe fires={fires} />
      <div className="boot-inner">
        <OnFireMark size={84} />
        <div className="boot-name">ON FIRE</div>
        <div className="boot-sub">Every fire in the Middle East, North Africa &amp; North America, <span className="dim">seen from orbit.</span></div>
        <div className="boot-status">
          <span className="spinner" />
          {ready ? 'Feed acquired' : 'Acquiring MODIS / VIIRS feed'}
        </div>
      </div>
      <div className="boot-credit">NASA Space Apps Challenge 2026 · Data: NASA FIRMS · Not an official NASA product</div>
    </div>
  );
}

// Bottom-centre toasts, auto-dismissed.
export function Toasts({ items }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast">
          <span className="t-ico"><Icon name={t.icon ?? 'flame'} size={16} /></span>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export const SHORTCUTS = [
  ['1', 'Live fires'],
  ['2', 'Forecast'],
  ['3', 'History'],
  ['4', 'AI risk'],
  ['G', 'Toggle 3D globe'],
  ['L', 'Open layers'],
  ['P', 'Show / hide panel'],
  ['?', 'This help'],
];

export function KeyboardHelp({ onClose }) {
  return (
    <div className="kbd-help" onClick={onClose}>
      <div className="kbd-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <h2>Shortcuts <span className="dim">for faster flying.</span></h2>
        <div className="kbd-list">
          {SHORTCUTS.map(([k, l]) => (
            <div key={k}><span>{l}</span><kbd>{k}</kbd></div>
          ))}
        </div>
      </div>
    </div>
  );
}
