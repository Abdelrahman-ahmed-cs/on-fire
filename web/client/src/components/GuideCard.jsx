import React, { useState } from 'react';
import { Icon } from './icons.jsx';
import OnFireMark from '../brand/OnFireMark.jsx';

const KEY = 'onfire-guide-dismissed';
const read = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

// First-visit "how to use" card: three steps, dismissible.
export default function GuideCard() {
  const [hidden, setHidden] = useState(read);
  if (hidden) return null;
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="guide">
      <div className="guide-head"><OnFireMark size={24} variant="glyph" /><div className="guide-title">Mission briefing</div><button className="icon-btn" onClick={close} aria-label="Dismiss"><Icon name="x" size={14} /></button></div>
      <ol>
        <li><b>Click a country</b> to zoom in and see its fires.</li>
        <li><b>Click a fire</b> to see where it’s heading, who is in danger and the damage.</li>
        <li>Use <b>Forecast</b>, <b>History</b> and <b>AI risk</b> in the top bar to change the view.</li>
      </ol>
      <button className="btn small primary" onClick={close}>Got it</button>
    </div>
  );
}
