import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapView from './components/MapView.jsx';
import RegionPanel from './components/RegionPanel.jsx';
import CountryPanel from './components/CountryPanel.jsx';
import EventPanel from './components/EventPanel.jsx';
import CalendarPanel from './components/CalendarPanel.jsx';
import HarmonizationPanel from './components/HarmonizationPanel.jsx';
import RiskPanel from './components/RiskPanel.jsx';
import PointCard from './components/PointCard.jsx';
import Legend from './components/Legend.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { ModeTabs, MapCaption, MonthPlayer, LayersMenu, GlobeButton, MODES, TRUTH_URL } from './components/MapControls.jsx';
import { Icon } from './components/icons.jsx';
import OnFireMark, { Wordmark } from './brand/OnFireMark.jsx';
import { UtcClock, BootScreen, Toasts, KeyboardHelp } from './brand/Chrome.jsx';
import GuideCard from './components/GuideCard.jsx';
import AIPanel from './components/AIPanel.jsx';
import { TravelButton, TravelHud, FireWarning, AreaPanel, AreaCoords, LiveDownloads, AiDownloads } from './components/Extras.jsx';
import { api, ago, REGIONS, regionById, regionOfIso } from './lib.js';

const harmonizedCache = new Map();
// Panel tab ⇄ map mode, so the map always illustrates what the panel explains.
const TAB_MODE = { overview: 'now', risk: 'forecast', calendar: 'history', ai: 'ai' };
const MODE_TAB = { now: 'overview', forecast: 'risk', history: 'calendar', ai: 'ai', truth: 'overview' };

export default function App() {
  const [days, setDays] = useState(2);
  const [region, setRegion] = useState('MENA');
  const reg = regionById(region);
  // live fires of both regions: the map shows them all, the panel the selected region
  const [liveAll, setLiveAll] = useState({});
  const live = liveAll[region] && !liveAll[region].error ? liveAll[region] : null;
  const liveErr = liveAll[region]?.error ?? null;
  const [view, setView] = useState({ level: 'region', iso: null, name: null });
  const [tab, setTabRaw] = useState('overview');
  const [mode, setModeRaw] = useState('now');
  const [historyMonth, setHistoryMonth] = useState(new Date().getUTCMonth());
  const [eventId, setEventId] = useState(null);
  const [eventDetail, setEventDetail] = useState(null);
  const [countryData, setCountryData] = useState(null);
  const [risk, setRisk] = useState(null);
  const [riskLoading, setRiskLoading] = useState(false);
  const [point, setPoint] = useState(null);
  const [layers, setLayers] = useState({ heat: false, wind: false, provinces: true, imagery: 'esri', globe: false });
  const [harmonized, setHarmonized] = useState({});
  const [climGrid, setClimGrid] = useState(null);
  const [historyOverview, setHistoryOverview] = useState(null);
  const [focus, setFocus] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [aiWhen, setAiWhen] = useState('current');
  const [aiData, setAiData] = useState({});
  const [aiCell, setAiCell] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [help, setHelp] = useState(false);
  const [spin, setSpin] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [area, setArea] = useState(null);
  const [travel, setTravel] = useState(null);
  const [warnHidden, setWarnHidden] = useState(null);
  const aiPending = useRef(new Set());
  const prevActive = useRef(null);

  const toast = useCallback((text, icon) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, text, icon }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);
  const toggleGlobe = useCallback(() => setLayers((l) => ({ ...l, globe: !l.globe })), []);

  const setTab = useCallback((t) => {
    setTabRaw(t);
    if (TAB_MODE[t]) setModeRaw(TAB_MODE[t]);
  }, []);
  const setMode = useCallback(
    (m) => {
      setModeRaw(m);
      const t = MODE_TAB[m];
      if (t === 'risk' && view.level !== 'country') return setTabRaw('overview');
      setTabRaw(t);
      setEventId(null);
    },
    [view.level],
  );

  // ---- live fires ----
  const loadLive = useCallback(() => {
    Promise.all(REGIONS.map((r) => api(`/api/live?days=${days}&region=${r.id}`).catch((e) => ({ error: e.message }))))
      .then((list) => setLiveAll(Object.fromEntries(REGIONS.map((r, i) => [r.id, list[i]]))));
  }, [days]);
  const mapLive = useMemo(() => {
    const list = REGIONS.map((r) => liveAll[r.id]).filter((j) => j && !j.error);
    if (!list.length) return null;
    return {
      ...list[0],
      fires: { cols: list[0].fires.cols, rows: list.flatMap((j) => j.fires.rows) },
      events: list.flatMap((j) => j.events),
      summary: { ...list[0].summary, countries: list.flatMap((j) => j.summary.countries), provinces: list.flatMap((j) => j.summary.provinces ?? []) },
    };
  }, [liveAll]);
  useEffect(() => {
    loadLive();
    const t = setInterval(loadLive, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, [loadLive]);

  useEffect(() => {
    const n = live?.summary?.activeEvents;
    if (n == null) return;
    if (prevActive.current != null && live.region === prevActive.region && n > prevActive.current) toast(`${n - prevActive.current} new fire${n - prevActive.current === 1 ? '' : 's'} since the last satellite pass`);
    prevActive.current = n;
    prevActive.region = live.region;
  }, [live, toast]);

  // ---- country data ----
  useEffect(() => {
    if (!view.iso) return setCountryData(null);
    let dead = false;
    api(`/api/country/${view.iso}?days=${days}`).then((j) => !dead && setCountryData(j)).catch(() => {});
    return () => (dead = true);
  }, [view.iso, days, live?.fetchedAt]);

  useEffect(() => {
    setRisk(null);
    if (!view.iso) return;
    let dead = false;
    setRiskLoading(true);
    api(`/api/risk/${view.iso}`)
      .then((j) => !dead && setRisk(j))
      .catch((e) => !dead && setRisk({ error: e.message }))
      .finally(() => !dead && setRiskLoading(false));
    return () => (dead = true);
  }, [view.iso, live?.fetchedAt]);

  // ---- harmonized record (region or country) ----
  const hIso = view.iso || region;
  useEffect(() => {
    if (harmonized[hIso]) return;
    if (harmonizedCache.has(hIso)) return setHarmonized((h) => ({ ...h, [hIso]: harmonizedCache.get(hIso) }));
    api(`/api/harmonized/${hIso}`)
      .then((j) => {
        harmonizedCache.set(hIso, j);
        setHarmonized((h) => ({ ...h, [hIso]: j }));
      })
      .catch((e) => setHarmonized((h) => ({ ...h, [hIso]: { error: e.message } })));
  }, [hIso, harmonized]);

  // ---- history mode data ----
  useEffect(() => {
    if (mode !== 'history') return;
    if (!historyOverview) api('/api/history-overview').then(setHistoryOverview).catch(() => {}); // all countries; the map shows the ones in view
    let dead = false;
    const ids = view.iso ? [view.iso] : REGIONS.map((r) => r.id);
    Promise.all(ids.map((id) => api(`/api/climgrid/${id}?month=${historyMonth}`).catch(() => null))).then((gs) => {
      if (dead) return;
      const ok = gs.filter(Boolean);
      setClimGrid(ok.length ? { ...ok[0], cells: ok.flatMap((g) => g.cells) } : null);
    });
    return () => (dead = true);
  }, [mode, view.iso, historyMonth, historyOverview]);

  // ---- AI danger prediction ----
  const aiKey = `${region}-${aiWhen}`;
  useEffect(() => {
    if (mode !== 'ai') return;
    // the selected region first, then the other one for the map
    for (const r of [region, ...REGIONS.map((x) => x.id).filter((x) => x !== region)]) {
      const k = `${r}-${aiWhen}`;
      if (aiData[k] || aiPending.current.has(k)) continue;
      aiPending.current.add(k);
      api(`/api/ml/predict?when=${aiWhen}&region=${r}`)
        .then((j) => setAiData((d) => ({ ...d, [k]: j })))
        .catch((e) => setAiData((d) => ({ ...d, [k]: { error: e.message } })))
        .finally(() => aiPending.current.delete(k));
    }
  }, [mode, aiWhen, aiData, region]);
  const mapAi = useMemo(() => {
    const list = REGIONS.map((r) => aiData[`${r.id}-${aiWhen}`]).filter((j) => j?.cells);
    if (!list.length) return null;
    return { ...list[0], cells: list.flatMap((j) => j.cells), alerts: list.flatMap((j) => j.alerts), countries: list.flatMap((j) => j.countries) };
  }, [aiData, aiWhen]);
  const inspectAi = useCallback((lat, lon) => {
    setAiCell({ loading: true, lat, lon });
    setTabRaw('ai');
    setPanelOpen(true);
    api(`/api/ml/cell?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}&when=${aiWhen}&region=${region}`)
      .then((j) => setAiCell(j))
      .catch((e) => setAiCell({ error: e.message }));
  }, [aiWhen, region]);
  useEffect(() => {
    if (aiCell?.lat && !aiCell.loading) inspectAi(aiCell.lat, aiCell.lon);
  }, [aiWhen]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- event detail ----
  useEffect(() => {
    setEventDetail(null);
    if (!eventId) return;
    let dead = false;
    api(`/api/event/${eventId}`)
      .then((j) => {
        if (dead) return;
        setEventDetail(j);
        // Village / building details from OpenStreetMap arrive a few seconds later.
        if (j.surroundingsPending)
          api(`/api/event/${eventId}/surroundings`)
            .then((s) => !dead && setEventDetail((d) => (d && d.event?.id === j.event.id ? { ...d, surroundingsPending: false, surroundings: s.surroundings, threatened: s.threatened ?? d.threatened, population: s.population ?? d.population } : d)))
            .catch(() => !dead && setEventDetail((d) => (d ? { ...d, surroundingsPending: false } : d)));
      })
      .catch((e) => !dead && setEventDetail({ error: e.message }));
    return () => (dead = true);
  }, [eventId]);

  const selectCountry = useCallback((iso, name) => {
    setRegion(regionOfIso(iso));
    setArea(null);
    setView({ level: 'country', iso, name });
    setEventId(null);
    setPoint(null);
    setTabRaw((t) => (t === 'harmonization' ? t : MODE_TAB[mode] ?? 'overview'));
    setPanelOpen(true);
  }, [mode]);
  const backToRegion = useCallback(() => {
    setArea(null);
    setView({ level: 'region', iso: null, name: null });
    setEventId(null);
    setPoint(null);
    setTabRaw((t) => (t === 'risk' ? 'overview' : t));
  }, []);
  const switchRegion = useCallback((id) => {
    setRegion(id);
    setArea(null);
    setView({ level: 'region', iso: null, name: null });
    setEventId(null);
    setPoint(null);
    setAiCell(null);
    setTabRaw((t) => (t === 'risk' ? 'overview' : t));
  }, []);
  const selectEvent = useCallback(
    (id, iso) => {
      if (!id) return;
      const ev = live?.events.find((e) => e.id === id);
      if (iso && iso !== view.iso) {
        setRegion(regionOfIso(iso));
        setView({ level: 'country', iso, name: ev?.country ?? iso });
      }
      setEventId(id);
      setPoint(null);
      setPanelOpen(true);
      if (mode === 'history') setModeRaw('now');
      if (ev) setFocus({ lon: ev.lon, lat: ev.lat, zoom: 10, t: Date.now() });
    },
    [live, view.iso, mode],
  );
  const inspectPoint = useCallback((lat, lon) => {
    setPoint({ lat, lon, loading: true });
    api(`/api/point?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`)
      .then((j) => setPoint(j))
      .catch((e) => setPoint({ lat, lon, error: e.message }));
  }, []);

  const areaDrawn = useCallback((geometry) => {
    setDrawing(false);
    setEventId(null);
    setPoint(null);
    setPanelOpen(true);
    const ring = geometry.coordinates[0];
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    setArea({ geometry, bbox, loading: true });
    const post = (url) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ geometry }) })
        .then((r) => r.json().catch(() => ({})).then((j) => (r.ok ? j : Promise.reject(Object.assign(new Error(j.error || `Request failed (${r.status})`), { outside: !!j.outside })))));
    const mine = (fn) => setArea((a) => (a?.geometry === geometry ? fn(a) : a));
    // 1) 2000-2025 archive (fast), 2) then 2026 from NASA FIRMS + this month vs past years
    post('/api/area-calendar')
      .then((j) => {
        mine((a) => ({ ...a, ...j, loading: false, recentLoading: !!j.calendar }));
        if (!j.calendar) return;
        return post('/api/area-recent')
          .then((r) => mine((a) => ({ ...a, series: r.series, calendar: r.calendar ?? a.calendar, recent: r.recent, thisMonth: r.thisMonth, recentLoading: false })))
          .catch((e) => mine((a) => ({ ...a, recentLoading: false, recentError: e.message })));
      })
      .catch((e) => mine((a) => ({ ...a, loading: false, error: e.message, outside: e.outside })));
  }, []);
  const other = REGIONS.find((r) => r.id !== region);
  const startTravel = useCallback((fromCenter) => {
    setEventId(null);
    setPoint(null);
    setTravel({ to: other, fromCenter, t: Date.now() });
  }, [other]);
  const travelDone = useCallback((id) => {
    setTravel(null);
    switchRegion(id);
  }, [switchRegion]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(e.target.tagName)) return;
      const m = MODES[Number(e.key) - 1];
      if (m) return setMode(m.id);
      const k = e.key.toLowerCase();
      if (k === 'g') { toggleGlobe(); return; }
      if (k === 'l') { window.dispatchEvent(new Event('onfire:toggle-layers')); return; }
      if (k === 'p') { setPanelOpen((o) => !o); return; }
      if (e.key === '?') { setHelp((h) => !h); return; }
      if (e.key === 'Escape') { setHelp(false); setDrawing(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMode, toggleGlobe]);
  useEffect(() => {
    if (layers.globe) toast('3D globe on. Drag to spin, G to switch back', 'globe');
  }, [layers.globe, toast]);

  const tabs = view.level === 'country'
    ? [['overview', 'Overview'], ['risk', 'Forecast'], ['ai', 'AI risk'], ['calendar', 'Seasonality'], ['harmonization', 'Methodology']]
    : [['overview', 'Overview'], ['ai', 'AI risk'], ['calendar', 'Seasonality'], ['harmonization', 'Methodology']];

  const h = harmonized[hIso];
  const areaName = view.level === 'country' ? view.name : reg.name;
  const monthShares = view.level === 'country' ? h?.calendar?.climatology?.map((c) => c.share) : harmonized[region]?.calendar?.climatology?.map((c) => c.share);

  return (
    <div className={`app ${panelOpen ? '' : 'panel-closed'}`}>
      <header className="topbar">
        <div className="brand">
          <span onClick={() => { setSpin((n) => n + 1); setHelp(true); }} title="Shortcuts (?)" style={{ display: 'contents' }}>
            <OnFireMark size={40} key={spin} className={spin ? 'spin' : ''} />
          </span>
          <Wordmark />
        </div>
        <ModeTabs mode={mode} setMode={setMode} />
        <div className="topbar-controls">
          <UtcClock />
          <button className="round-btn" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><Icon name="keyboard" size={17} /></button>
          <div className="seg" role="group" aria-label="Region">
            {REGIONS.map((r) => (
              <button key={r.id} className={region === r.id ? 'on' : ''} aria-pressed={region === r.id} onClick={() => switchRegion(r.id)} title={`Show ${r.name}`}>{r.short}</button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Time window">
            {[[1, '24h'], [2, '48h'], [7, '7d']].map(([d, l]) => (
              <button key={d} className={days === d ? 'on' : ''} aria-pressed={days === d} onClick={() => setDays(d)} title={`Fires from the last ${d === 7 ? '7 days' : `${d * 24} hours`}`}>{l}</button>
            ))}
          </div>
          <div className={`status ${liveErr ? 'err' : live ? 'ok' : ''}`} title="NASA FIRMS near-real-time data, refreshed every 20 minutes">
            <span className="dot" />
            <span className="status-text">{liveErr ? 'Feed lost' : live ? `FIRMS · ${ago((Date.now() - live.fetchedAt) / 3600000)}` : 'Acquiring…'}</span>
          </div>
        </div>
      </header>
      <BootScreen ready={!!live || !!liveErr} fires={live?.events} />
      {mode === 'truth' && <iframe className="truth-frame" src={TRUTH_URL} title="Truth vs Prediction" />}
      <Toasts items={toasts} />
      {help && <KeyboardHelp onClose={() => setHelp(false)} />}

      <main className="map-wrap">
        <ErrorBoundary label="The map">
          <MapView
            live={mapLive}
            view={view}
            region={reg}
            mode={mode}
            layers={layers}
            risk={view.level === 'country' ? risk : null}
            countryData={countryData}
            eventDetail={eventId ? eventDetail : null}
            focus={focus}
            climGrid={mode === 'history' ? climGrid : null}
            historyOverview={historyOverview}
            historyMonth={historyMonth}
            aiData={mapAi}
            aiSelected={aiCell && !aiCell.loading && !aiCell.error ? aiCell : null}
            onAiClick={inspectAi}
            onCountryClick={selectCountry}
            onFireClick={(fire) => selectEvent(fire.event, fire.iso)}
            onPointClick={inspectPoint}
            onBack={backToRegion}
            drawing={drawing}
            area={area}
            onAreaDrawn={areaDrawn}
            travel={travel}
            onTravelDone={travelDone}
          />
        </ErrorBoundary>
        <MapCaption mode={mode} view={view} days={days} month={historyMonth} regionName={reg.name} />
        <div className="map-tools">
          <button className={`tool-btn ${drawing ? 'globe-on' : ''}`} onClick={() => setDrawing((d) => !d)} aria-pressed={drawing} title="Draw a box on the map to get its 25-year fire calendar">
            <Icon name="boxSelect" size={16} />
            <span>{drawing ? 'Drag on the map' : 'Area'}</span>
          </button>
          <GlobeButton on={layers.globe} onToggle={toggleGlobe} />
          <LayersMenu layers={layers} setLayers={setLayers} mode={mode} />
        </div>
        <Legend mode={mode} view={view} hasEvent={!!eventId} />
        {mode === 'history' && <MonthPlayer month={historyMonth} setMonth={setHistoryMonth} shares={monthShares} />}
        {point && <PointCard point={point} onClose={() => setPoint(null)} />}
        {drawing && <AreaCoords onSubmit={areaDrawn} onCancel={() => setDrawing(false)} />}
        {eventId && eventDetail?.event?.id === eventId && warnHidden !== eventId && <FireWarning detail={eventDetail} onClose={() => setWarnHidden(eventId)} />}
        {view.level === 'region' && mode !== 'truth' && !travel && !drawing && !area && !eventId && (
          <TravelButton to={other} side={other.id === 'NAM' ? 'left' : 'right'} onGo={() => startTravel(window.__onfireMap ? window.__onfireMap.getCenter().toArray() : reg.globe)} />
        )}
        {travel && <TravelHud travel={travel} />}
        <GuideCard />
        <button className="panel-toggle" onClick={() => setPanelOpen((o) => !o)} aria-label={panelOpen ? 'Hide panel' : 'Show panel'}>
          <Icon name={panelOpen ? 'chevronRight' : 'chevronLeft'} size={14} />
        </button>
      </main>

      <aside className="panel">
        <nav className="crumbs" aria-label="Where you are">
          <button className={view.level === 'region' && !eventId ? 'cur' : ''} onClick={backToRegion}>Region</button>
          {view.iso && (
            <>
              <Icon name="chevronRight" size={12} className="crumb-sep" />
              <button className={!eventId ? 'cur' : ''} onClick={() => setEventId(null)}>{view.name}</button>
            </>
          )}
          {area && !eventId && (
            <>
              <Icon name="chevronRight" size={12} className="crumb-sep" />
              <span className="cur">Drawn area</span>
            </>
          )}
          {eventId && (
            <>
              <Icon name="chevronRight" size={12} className="crumb-sep" />
              <span className="cur">Fire detail</span>
            </>
          )}
        </nav>

        {eventId ? (
          <ErrorBoundary key={eventId} label="Fire details">
            <EventPanel detail={eventDetail} onBack={() => setEventId(null)} onFocus={setFocus} />
          </ErrorBoundary>
        ) : area ? (
          <ErrorBoundary key={area.bbox.join(',')} label="The area calendar">
            <AreaPanel area={area} onBack={() => setArea(null)} />
          </ErrorBoundary>
        ) : (
          <>
            <div className="panel-title">
              <h1>{areaName}</h1>
              {view.level === 'region' && (
                <button className="travel-wide" onClick={() => startTravel(window.__onfireMap ? window.__onfireMap.getCenter().toArray() : reg.globe)} disabled={!!travel}>
                  <Icon name="drone" size={18} />
                  <span>{travel ? `Flying to ${travel.to.name}…` : `Click to travel to ${other.name} !!`}</span>
                </button>
              )}
            </div>
            <div className="tabs" role="tablist">
              {tabs.map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>
            <div className="panel-body">
              <ErrorBoundary key={`${tab}-${view.iso}`} label="This panel">
                {tab === 'overview' && view.level === 'region' && <RegionPanel live={live?.region === region ? live : null} error={liveErr} days={days} onCountry={selectCountry} onEvent={selectEvent} harmonized={harmonized[region]} countryTotal={reg.countries} />}
                {tab === 'overview' && view.level === 'country' && <CountryPanel data={countryData} days={days} onEvent={selectEvent} harmonized={h} risk={risk} onTab={setTab} />}
                {tab === 'risk' && <RiskPanel risk={risk} loading={riskLoading} onEvent={selectEvent} name={view.name} />}
                {tab === 'ai' && <AIPanel data={aiData[aiKey]} when={aiWhen} setWhen={setAiWhen} view={view} cell={aiCell} onCloseCell={() => setAiCell(null)} onAlert={(al) => { inspectAi(al.lat, al.lon); setFocus({ lat: al.lat, lon: al.lon, zoom: 7.5, t: Date.now() }); }} />}
                {tab === 'overview' && live && (view.level === 'region' || countryData?.iso === view.iso) && <LiveDownloads live={live} iso={view.iso} events={view.level === 'country' ? countryData.events : null} name={areaName} />}
                {tab === 'ai' && aiData[aiKey]?.alerts && !aiCell && <AiDownloads alerts={aiData[aiKey].alerts.filter((a) => !view.iso || a.iso === view.iso)} monthName={aiData[aiKey].target.monthName} name={areaName} />}
                {tab === 'calendar' && (
                  <CalendarPanel
                    data={h}
                    name={areaName}
                    range={view.level === 'country'
                      ? { csvHref: (from, to) => `/api/area-hotspots.csv?iso=${view.iso}&start=${from}&end=${to}`, maxDays: 366, csvNote: 'Hotspots from 2026 are fetched from NASA FIRMS for the whole country, so this can take a minute.' }
                      : {}}
                  />
                )}
                {tab === 'harmonization' && <HarmonizationPanel data={h} name={areaName} />}
              </ErrorBoundary>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
