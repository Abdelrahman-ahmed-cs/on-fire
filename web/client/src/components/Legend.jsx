import React, { useState } from 'react';
import { AGE, PLACE_STATUS } from '../lib.js';
import { Icon } from './icons.jsx';

// A legend per map mode, in plain words.
export default function Legend({ mode, view, hasEvent }) {
  const [open, setOpen] = useState(true);
  const showForecast = mode === 'forecast' || hasEvent;
  return (
    <div className={`legend ${open ? '' : 'closed'}`}>
      <button className="legend-toggle" onClick={() => setOpen((o) => !o)}><Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />Legend</button>
      {open && (
        <>
          {mode !== 'history' && mode !== 'ai' && (
            <div className="lg-block">
              <div className="lg-title">Fires</div>
              {AGE.map((a) => (
                <div key={a.label} className="lg-row">
                  <span className={`lg-dot ${a.max === 6 ? 'pulse' : ''}`} style={{ background: a.color }} />
                  <span><b>{a.label}</b> <small>{a.sub}</small></span>
                </div>
              ))}
              <div className="lg-sizes">
                {[4, 6, 9, 12].map((s) => <span key={s} style={{ width: s * 2, height: s * 2 }} />)}
                <small>small → very strong fire</small>
              </div>
            </div>
          )}
          {mode === 'now' && (
            <div className="lg-block">
              <div className="lg-title">{view.level === 'region' ? 'Countries' : 'Provinces'}</div>
              <div className="lg-ramp tint" />
              <div className="lg-ends"><span>few fires</span><span>many fires</span></div>
            </div>
          )}
          {showForecast && (
            <div className="lg-block">
              <div className="lg-title">Forecast</div>
              <div className="lg-row"><span className="lg-arrow" /> Direction the fire is spreading</div>
              <div className="lg-row"><span className="lg-zone" /> Area it could reach in 24 h</div>
              <div className="lg-row"><span className="lg-smoke" /> Where the smoke is blowing</div>
              {Object.values(PLACE_STATUS).map((s) => (
                <div key={s.label} className="lg-row"><span className="lg-dot ring" style={{ background: s.color }} />{s.label}</div>
              ))}
              {mode === 'forecast' && view.level === 'country' && (
                <>
                  <div className="lg-row" style={{ marginTop: 4 }}>Chance of new fires (next 3 days)</div>
                  <div className="lg-ramp risk" />
                  <div className="lg-ends"><span>low</span><span>high</span></div>
                </>
              )}
              <div className="lg-row"><span className="lg-wind">↑</span> Wind (points where it blows)</div>
            </div>
          )}
          {mode === 'ai' && (
            <div className="lg-block">
              <div className="lg-title">AI: chance of fire this month</div>
              <div className="lg-row"><span className="lg-sq-fill" style={{ background: '#ff1a1a' }} /><b>Red alert</b>&nbsp;<small>75 %+ and bad weather</small></div>
              <div className="lg-row"><span className="lg-sq-fill" style={{ background: '#ff7a00' }} /><b>High</b>&nbsp;<small>50 %+</small></div>
              <div className="lg-row"><span className="lg-sq-fill" style={{ background: '#ffc233' }} /><b>Moderate</b>&nbsp;<small>20–50 %</small></div>
              <div className="lg-row"><span className="lg-pulse" /> Pulsing marker = alert (click it)</div>
              <div className="lg-row"><small>One square ≈ 50 × 50 km</small></div>
            </div>
          )}
          {mode === 'history' && (
            <div className="lg-block">
              <div className="lg-title">Usual fire places</div>
              <div className="lg-ramp clim" />
              <div className="lg-ends"><span>rarely burns</span><span>burns most years</span></div>
              <div className="lg-row" style={{ marginTop: 4 }}><small>Use the month buttons below, or press play to step through the year.</small></div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
