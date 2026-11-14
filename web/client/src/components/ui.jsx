import React from 'react';
import { toIcon } from './icons.jsx';

export function Stat({ label, value, sub, tone, small, icon, info }) {
  return (
    <div className={`stat ${tone ?? ''} ${small ? 'small' : ''}`}>
      <div className="stat-label">{icon && <span className="stat-icon">{toIcon(icon, 14)}</span>}{label}{info && <Info text={info} />}</div>
      <div className="stat-value"><CountUp value={value} /></div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Section({ title, hint, children, right, icon, info }) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{icon && <span className="section-icon">{toIcon(icon, 15)}</span>}{title}{info && <Info text={info} />}</h2>
        {right}
      </div>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  );
}

export function Loading({ text = 'Loading…' }) {
  return (
    <div className="loading">
      <span className="spinner" />
      {text}
    </div>
  );
}

export function Bar({ value, max, color = '#ff9a4d' }) {
  return (
    <div className="bar-track">
      <div className="bar-fill" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%`, background: color }} />
    </div>
  );
}

export function Badge({ color, children, title }) {
  return (
    <span className="badge" style={{ '--badge': color }} title={title}>
      <span className="badge-dot" />
      {children}
    </span>
  );
}

// Recharts tooltip rendered with our own styling
export function ChartTip({ active, payload, label, formatLabel, formatValue }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-title">{formatLabel ? formatLabel(label, payload) : label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="chart-tip-row">
          <span className="swatch" style={{ background: p.color || p.fill }} />
          <span>{p.name}</span>
          <b>{formatValue ? formatValue(p.value, p) : p.value}</b>
        </div>
      ))}
    </div>
  );
}

// Small "?" bubble that explains a term in plain words on hover / focus.
export function Info({ text }) {
  return (
    <span className="info" tabIndex={0} aria-label={text}>
      ?
      <span className="info-bubble" role="tooltip">{text}</span>
    </span>
  );
}

// Big one-glance summary at the top of every panel.
export function Headline({ icon, title, children, tone }) {
  return (
    <div className={`headline ${tone ?? ''}`}>
      {icon && <div className="headline-icon" aria-hidden>{toIcon(icon, 18)}</div>}
      <div>
        <div className="headline-title">{title}</div>
        {children && <div className="headline-text">{children}</div>}
      </div>
    </div>
  );
}

export function Alert({ tone = 'danger', icon = '⚠️', children, onClick }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`alert ${tone}`} onClick={onClick}>
      <span className="alert-icon" aria-hidden>{toIcon(icon, 16)}</span>
      <span className="alert-body">{children}</span>
      {onClick && <span className="chev">{toIcon('➡️', 14)}</span>}
    </Tag>
  );
}

// Collapsible block for technical details, so nothing is removed but the main view stays simple.
export function Details({ title = 'Technical details', children, open = false }) {
  return (
    <details className="details" open={open}>
      <summary>{title}</summary>
      <div className="details-body">{children}</div>
    </details>
  );
}

// Numbers count up from their previous value (ease-out), e.g. "1,046".
export function useCountUp(value, ms = 900) {
  const target = typeof value === 'number' ? value : typeof value === 'string' && /^\d[\d,]*$/.test(value) ? Number(value.replace(/,/g, '')) : null;
  const [n, setN] = React.useState(target ?? 0);
  const from = React.useRef(0);
  React.useEffect(() => {
    if (target == null) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return setN(target);
    const start = performance.now();
    const a = from.current;
    let raf;
    const step = (t) => {
      const k = Math.min(1, (t - start) / ms);
      const v = Math.round(a + (target - a) * (1 - Math.pow(1 - k, 4)));
      setN(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return target == null ? value : n.toLocaleString('en-US');
}

export function CountUp({ value }) {
  return <>{useCountUp(value)}</>;
}
