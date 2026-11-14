import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MONTHS, MONTHS_LONG } from '../lib.js';
import { Icon } from './icons.jsx';

export const MODES = [
  { id: 'now', icon: 'flame', label: 'Live fires' },
  { id: 'forecast', icon: 'compass', label: 'Forecast' },
  { id: 'history', icon: 'calendar', label: 'History' },
  { id: 'ai', icon: 'cpu', label: 'AI risk' },
  { id: 'truth', icon: 'target', label: 'Truth vs Prediction' },
];

// On Fire's Truth vs Prediction page, served by the Python server (port 8001) through the
// Node server's /truth/ path, so the app works on one port (local and hosted).
export const TRUTH_URL = '/truth/?embed=truth#truth';

// What the viewer is looking at, in one sentence.
function caption(mode, view, days, month, regionName = 'Middle East & North Africa') {
  const where = view.level === 'country' ? view.name : regionName === 'North America' ? regionName : `the ${regionName}`;
  const when = days === 1 ? 'the last 24 hours' : days === 2 ? 'the last 48 hours' : 'the last 7 days';
  if (mode === 'now') return `Satellite fire detections in ${where}, ${when}. Larger dots are stronger fires.`;
  if (mode === 'forecast')
    return view.level === 'country'
      ? `Projected spread, smoke direction and 3-day ignition likelihood for ${where}.`
      : 'Current wind field. Select a country to see projected spread and towns at risk.';
  if (mode === 'ai') return `Modelled fire probability per ~50 km cell${view.level === 'country' ? ` in ${where}` : ''} ${view.level === 'country' ? '' : ` in ${where}`} this month. Select a cell for drivers.`;
  return `Typical fire locations in ${MONTHS_LONG[month]} from 25 years of records for ${where}.`;
}

// Primary navigation: lives in the top bar.
// The white pill slides under the active tab with a spring.
export function ModeTabs({ mode, setMode }) {
  const nav = useRef(null);
  const [pill, setPill] = useState(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = nav.current?.querySelector('button.on');
      if (el) setPill({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure);
    return () => window.removeEventListener('resize', measure);
  }, [mode]);
  return (
    <nav className="nav-tabs" role="tablist" aria-label="Map mode" ref={nav}>
      {pill && <span className="nav-pill" style={{ width: pill.w, transform: `translateX(${pill.x}px)` }} aria-hidden />}
      {MODES.map((m, i) => (
        <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)} title={`${m.label} (${i + 1})`}>
          <Icon name={m.icon} size={16} />
          <span>{m.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function MapCaption({ mode, view, days, month, regionName }) {
  const tag = MODES.find((x) => x.id === mode)?.label;
  return (
    <div className="map-caption">
      <span className="cap-tag">{tag}</span>
      <span>{caption(mode, view, days, month, regionName)}</span>
    </div>
  );
}

// Month picker + play button for the History mode.
export function MonthPlayer({ month, setMonth, shares }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setMonth((m) => (m + 1) % 12), 1400);
    return () => clearInterval(t);
  }, [playing, setMonth]);
  const max = shares ? Math.max(...shares, 1) : 1;
  return (
    <div className="month-player">
      <button className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play through the year'}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <div className="months">
        {MONTHS.map((m, i) => (
          <button key={m} className={i === month ? 'on' : ''} onClick={() => { setPlaying(false); setMonth(i); }} title={shares ? `${MONTHS_LONG[i]}: ${shares[i].toFixed(1)}% of yearly fires` : MONTHS_LONG[i]}>
            {shares && <i style={{ height: `${Math.max(2, (shares[i] / max) * 24)}px` }} />}
            <span>{m}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Switch({ checked, onChange, disabled, label, hint }) {
  return (
    <label className={`menu-row switch-row ${disabled ? 'disabled' : ''}`}>
      <span className="menu-row-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={onChange} disabled={disabled} />
      <span className="switch" aria-hidden />
    </label>
  );
}

function Choice({ checked, onChange, label, hint }) {
  return (
    <label className={`menu-row choice-row ${checked ? 'on' : ''}`}>
      <input type="radio" name="imagery" checked={checked} onChange={onChange} />
      <span className="radio" aria-hidden />
      <span className="menu-row-text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function LayersMenu({ layers, setLayers, mode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const toggle = (k) => setLayers((l) => ({ ...l, [k]: !l[k] }));
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  useEffect(() => {
    const t = () => setOpen((o) => !o);
    window.addEventListener('onfire:toggle-layers', t);
    return () => window.removeEventListener('onfire:toggle-layers', t);
  }, []);
  const active = [layers.heat, layers.wind, layers.provinces].filter(Boolean).length;
  return (
    <div className="layers-menu" ref={ref}>
      <button className={`tool-btn ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu">
        <Icon name="layers" size={15} />
        <span>Layers</span>
        <span className="count">{active}</span>
        <Icon name="chevronDown" size={14} className="chev-ico" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-label">Base imagery</div>
          <Choice checked={layers.imagery === 'esri'} onChange={() => setLayers((l) => ({ ...l, imagery: 'esri' }))} label="High resolution" hint="Esri World Imagery" />
          <Choice checked={layers.imagery === 'gibs'} onChange={() => setLayers((l) => ({ ...l, imagery: 'gibs' }))} label="Yesterday's pass" hint="NASA GIBS, shows smoke plumes" />
          <div className="menu-sep" />
          <div className="menu-label">Overlays</div>
          <Switch label="Fire density" hint={mode === 'history' ? 'Not available in History' : 'Heatmap of detections'} checked={layers.heat} onChange={() => toggle('heat')} disabled={mode === 'history'} />
          <Switch label="Wind" hint={mode === 'forecast' ? 'Always on in Forecast' : '10 m wind direction'} checked={layers.wind || mode === 'forecast'} onChange={() => toggle('wind')} disabled={mode === 'forecast'} />
          <Switch label="Province borders" checked={layers.provinces} onChange={() => toggle('provinces')} />
        </div>
      )}
    </div>
  );
}

// 3D globe projection toggle (MapLibre native globe).
export function GlobeButton({ on, onToggle }) {
  return (
    <button className={`tool-btn ${on ? 'globe-on' : ''}`} onClick={onToggle} aria-pressed={on} title="Toggle 3D globe (G)">
      <Icon name="globe" size={16} />
      <span>{on ? 'Globe' : '3D'}</span>
    </button>
  );
}
