import React, { useId } from 'react';

// On Fire mark: a flame circled by an orbit (same shapes as the On Fire logo), in a ring badge.
// variant="patch" full badge · "glyph" flame only (small sizes) · "mono" one colour (currentColor).
export const BRAND = {
  navy: '#0A0A0B',
  red: '#FF6A1F',
  sand: '#FFC9A3',
  cream: '#FFF4EC',
};

const FLAME = 'M32 5c4.2 10.5 18 17.6 18 33.4a18 18 0 0 1-36 0c0-9.4 5.1-15.4 9.2-21 .9 5.9 3.6 9.1 7 10.1C29 20 29.4 12 32 5Z';
const CORE = 'M32 31c2.4 4.6 8.2 7.4 8.2 13.4a8.2 8.2 0 0 1-16.4 0c0-3.9 2.1-6.4 4-8.6.6 2.6 1.9 3.9 3.4 4.4C31 37.3 31 34 32 31Z';

function Flame({ id, mono }) {
  if (mono) return <path d={FLAME} fill="currentColor" />;
  return (
    <>
      <defs>
        <linearGradient id={`fl${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd166" /><stop offset=".45" stopColor="#ff6a2a" /><stop offset="1" stopColor="#e0174f" /></linearGradient>
        <linearGradient id={`or${id}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#7fe7ff" /><stop offset=".5" stopColor="#ffffff" /><stop offset="1" stopColor="#b9a3ff" /></linearGradient>
      </defs>
      <path d="M4 44A28 8.5 0 0 1 60 44" fill="none" stroke={`url(#or${id})`} strokeWidth="2.2" opacity=".55" />
      <path d={FLAME} fill={`url(#fl${id})`} />
      <path d={CORE} fill="#fff6dc" />
      <path d="M4 44A28 8.5 0 0 0 60 44" fill="none" stroke={`url(#or${id})`} strokeWidth="2.6" strokeLinecap="round" />
    </>
  );
}

export default function OnFireMark({ size = 32, variant = 'patch', title = 'On Fire', className = '' }) {
  const id = useId().replace(/:/g, '');
  if (variant === 'glyph' || variant === 'mono') {
    return (
      <svg className={`onfire-mark ${className}`} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
        <Flame id={id} mono={variant === 'mono'} />
      </svg>
    );
  }
  return (
    <svg className={`onfire-mark ${className}`} width={size} height={size} viewBox="0 0 72 72" role="img" aria-label={title}>
      <circle cx="36" cy="36" r="35" fill={BRAND.navy} />
      <defs><linearGradient id={`ring${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FF9A4D" /><stop offset="1" stopColor="#E8501A" /></linearGradient></defs>
      <circle cx="36" cy="36" r="32" fill="none" stroke={`url(#ring${id})`} strokeWidth="3.2" />
      <g transform="translate(13 11) scale(.72)">
        <Flame id={id} />
      </g>
    </svg>
  );
}

// Wordmark: condensed, wide-tracked, set like a mission designation.
export function Wordmark({ sub = true }) {
  return (
    <span className="wordmark">
      <span className="wordmark-name">ON FIRE</span>
      {sub && <span className="wordmark-sub">MODIS + VIIRS fire record</span>}
    </span>
  );
}
