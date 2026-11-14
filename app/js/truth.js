// Truth vs Prediction: the frozen model's risk map for the week a fire began (left)
// against what actually burned (right). Plays by itself: picks a fire, flies there, sweeps
// the divider left and right, overlays the truth, then moves to the next fire.
// Dragging the divider or clicking a fire takes over. Numbers from pipeline/out/backtests.json.
import { $, $$, data, fmt, icon, help, riskColor, riskStops, gradientCSS, countUp } from "./util.js";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const square = (c, props) => ({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [[
  [c.lon - .125, c.lat - .125], [c.lon + .125, c.lat - .125], [c.lon + .125, c.lat + .125], [c.lon - .125, c.lat + .125], [c.lon - .125, c.lat - .125]]] } });
const pct = v => v == null ? "–" : (Math.round(v * 10) / 10) + "%";
const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
// the automatic sweep: divider position (0 = all truth, 100 = all prediction), seconds
const SCRIPT = [
  { to: 50, dur: 0, hold: 2.0, phase: "Flying to the fire" },
  { to: 100, dur: 2.0, hold: 1.0, phase: "The prediction, made before the week began" },
  { to: 0, dur: 3.2, hold: 1.4, phase: "Revealing what actually burned", scan: true },
  { to: 100, dur: 2.6, hold: 0.4, phase: "Back to the prediction", scan: true, rev: true },
  { to: 100, dur: 0, hold: 2.6, phase: "Overlay: white squares are where it burned", overlay: true },
  { to: 50, dur: 1.4, hold: 1.4, phase: "Side by side" },
];
const TOTAL = SCRIPT.reduce((s, k) => s + k.dur + k.hold, 0);

let backs, metrics, names, maps = {}, cur = 0, v = 50, playing = true, t0 = 0, raf = 0, ready = false, FC = false, FC_LABEL = "";

export async function initTruth() {
  [backs, metrics] = await Promise.all([data("backtests.json"), data("risk_metrics.json")]);
  FC = metrics.forecast_assumption === "perfect" || /forecast/i.test(metrics.model_selection?.chosen || "");
  FC_LABEL = metrics.forecast_label || "assumes a perfect 7-day weather forecast";
  names = Object.keys(backs);
  const short = n => n.startsWith("Largest fire in ") ? n.slice(16).split(",")[0] : n.split(",")[0];
  $("#tv-fires").innerHTML = names.map((n, i) => `<button role="tab" data-i="${i}">${short(n)}<small>${backs[n].fire_start.slice(0, 4)}</small><span class="prog"><i></i></span></button>`).join("");
  $$("#tv-fires button").forEach(b => b.addEventListener("click", () => { cur = +b.dataset.i; start(); }));
  $("#tv-play").addEventListener("click", () => { playing = !playing; playIcon(); if (playing) start(); });
  $("#tv-legend").innerHTML = `<div class="lg-h">Left: predicted chance of fire in the week</div>
    <div class="ramp" style="background:${gradientCSS(riskStops())}"></div><div class="ramp-ends"><span>low</span><span>high</span></div>
    <div class="lg-row" style="margin-top:10px"><span class="lg-sq" style="background:#ff2d3a;box-shadow:0 0 0 1.5px #fff"></span>Burned that week or the next</div>
    <div class="lg-note">Each square is 0.25°, about 25 km. The model only saw fire data from before the week.</div>`;

  const style = () => ({ version: 8, sources: {
      base: { type: "raster", tileSize: 256, maxzoom: 18, tiles: [ESRI], attribution: "Imagery: Esri, Maxar, Earthstar Geographics" },
      cells: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    layers: [{ id: "base", type: "raster", source: "base", paint: { "raster-brightness-max": 0.5, "raster-saturation": -0.45 } }] });
  maps.real = new maplibregl.Map({ container: "tv-real", style: style(), center: [0, 30], zoom: 2, attributionControl: { compact: true }, dragRotate: false });
  maps.pred = new maplibregl.Map({ container: "tv-pred", style: style(), center: [0, 30], zoom: 2, attributionControl: false, dragRotate: false, interactive: false });
  await Promise.all([new Promise(r => maps.pred.on("load", r)), new Promise(r => maps.real.on("load", r))]);
  maps.real.on("move", () => maps.pred.jumpTo({ center: maps.real.getCenter(), zoom: maps.real.getZoom(), bearing: maps.real.getBearing(), pitch: maps.real.getPitch() }));
  maps.pred.addLayer({ id: "risk", type: "fill", source: "cells", paint: { "fill-color": ["get", "color"], "fill-opacity": ["get", "op"], "fill-opacity-transition": { duration: 800 } } });
  maps.pred.addLayer({ id: "burn", type: "line", source: "cells", filter: ["==", ["get", "burned"], true], layout: { visibility: "none" },
    paint: { "line-color": "#ffffff", "line-width": 2.2 } });
  maps.real.addLayer({ id: "grid", type: "fill", source: "cells", filter: ["!=", ["get", "burned"], true], paint: { "fill-color": "#ffffff", "fill-opacity": 0.05 } });
  maps.real.addLayer({ id: "glow", type: "line", source: "cells", filter: ["==", ["get", "burned"], true], paint: { "line-color": "#ff2d3a", "line-width": 10, "line-blur": 8, "line-opacity": 0.75 } });
  maps.real.addLayer({ id: "burned", type: "fill", source: "cells", filter: ["==", ["get", "burned"], true], paint: { "fill-color": "#ff2d3a", "fill-opacity": 0.92 } });
  maps.real.addLayer({ id: "burned-l", type: "line", source: "cells", filter: ["==", ["get", "burned"], true], paint: { "line-color": "#fff", "line-width": 1.4 } });
  wireDrag();
  ready = true;
  start();
}
export function truthShown(on) {            // pause the loop while the page is hidden
  if (!ready) return;
  if (on) { maps.real.resize(); maps.pred.resize(); if (playing) start(); } else cancelAnimationFrame(raf);
}

function setV(x) {
  v = Math.max(0, Math.min(100, x));
  $("#tv-pred").style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $("#tv-line").style.left = v + "%"; $("#tv-scan").style.left = v + "%";
}
function playIcon() { $("#tv-play").innerHTML = icon(playing ? "pause" : "play"); $("#tv-play").setAttribute("aria-label", playing ? "Pause" : "Play"); }
function setPhase(t) { const el = $("#tv-phase"); if (el && el.textContent !== t) el.textContent = t; }

function wireDrag() {
  const st = $("#tv-stage"); let drag = false;
  const at = e => { const r = st.getBoundingClientRect(); setV(100 * (e.clientX - r.left) / r.width); };
  $("#tv-line").addEventListener("pointerdown", e => { drag = true; e.preventDefault(); $("#tv-line").setPointerCapture(e.pointerId); takeOver(); at(e); });
  $("#tv-line").addEventListener("pointermove", e => drag && at(e));
  $("#tv-line").addEventListener("pointerup", () => { drag = false; });
  $("#tv-line").tabIndex = 0; $("#tv-line").setAttribute("role", "slider"); $("#tv-line").setAttribute("aria-label", "Compare prediction with what burned");
  $("#tv-line").addEventListener("keydown", e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { takeOver(); setV(v + (e.key === "ArrowLeft" ? -4 : 4)); e.preventDefault(); } });
}
function takeOver() {
  if (!playing) return;
  playing = false; playIcon(); cancelAnimationFrame(raf); $("#tv-scan").classList.remove("on");
  setPhase("Manual: drag the line, or press play to resume");
}

function start() {
  cancelAnimationFrame(raf);
  show(names[cur]);
  $$("#tv-fires button").forEach((b, i) => { b.classList.toggle("active", i === cur); b.querySelector(".prog i").style.width = "0"; });
  $$("#tv-fires button")[cur].scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  if (!playing) { setV(50); setPhase("Manual: drag the line, or press play to resume"); return; }
  t0 = performance.now(); let from = 50; setV(50);
  const prog = $$("#tv-fires button")[cur].querySelector(".prog i");
  const tick = now => {
    const t = (now - t0) / 1000; let acc = 0, seg = null, segStart = 0, segFrom = from;
    let pos = 50;
    for (let k = 0, f = 50; k < SCRIPT.length; k++) {
      const s = SCRIPT[k];
      if (t < acc + s.dur + s.hold) { seg = s; segStart = acc; segFrom = f; break; }
      acc += s.dur + s.hold; f = s.to;
    }
    if (!seg) { cur = (cur + 1) % names.length; return start(); }
    const local = t - segStart;
    pos = seg.dur ? segFrom + (seg.to - segFrom) * ease(Math.min(1, local / seg.dur)) : seg.to;
    setV(pos); setPhase(seg.phase);
    const sc = $("#tv-scan"); sc.classList.toggle("on", !!seg.scan && local < seg.dur); sc.classList.toggle("rev", !!seg.rev);
    maps.pred.setLayoutProperty("burn", "visibility", seg.overlay ? "visible" : "none");
    prog.style.width = Math.min(100, 100 * t / TOTAL) + "%";
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}

function verdictOf(p) {
  return p == null ? { word: "No data", cls: "plain", text: "No burning cells were recorded at this location that week." }
    : p >= 90 ? { word: "Flagged", cls: "", text: "The fire's cells were among the highest-risk places in the country that week." }
    : p >= 60 ? { word: "Raised, not flagged", cls: "plain", text: "The fire's cells were rated above the typical cell, but not near the top." }
    : { word: "Not anticipated", cls: "warn", text: "The model rated the fire's cells no higher than a typical cell. Reported anyway." };
}

function show(name) {
  const b = backs[name], p = b.model.risk_percentile_in_country, q = b.baseline.risk_percentile_in_country, vd = verdictOf(p);
  const feats = b.cells.map(c => square(c, { color: riskColor(Math.sqrt(c.risk)), op: 0.12 + 0.8 * Math.min(1, Math.sqrt(c.risk) * 1.4), burned: c.burned }));
  for (const m of [maps.pred, maps.real]) m.getSource("cells").setData({ type: "FeatureCollection", features: feats });
  maps.real.flyTo({ center: [b.centre[1], b.centre[0]], zoom: innerWidth > 900 ? 5.6 : 5, duration: playing ? 2600 : 1200, curve: 1.6, essential: true });
  const usesFc = b.uses_forecast_weather ?? FC;
  const tag = usesFc && FC ? `<span class="est fc">${FC_LABEL}</span>` : "";
  const lf = metrics.large_fires, w = b.why_main_cell, wx = w.weather_last_week, fw = w.weather_forecast_week;
  const maxD = Math.max(...w.drivers.map(d => Math.abs(d[1])), 1e-6);
  const fixed = !b.group || b.group.startsWith("Fixed");
  $("#tv-side").innerHTML = `
    <div class="region-head"><div class="rh-top"><small>${fixed ? "Fixed before the model was trained" : "Chosen by rule: largest fire in its region"}</small></div>
      <h1>${name.replace(/, \d{4}/, "")}</h1></div>
    <div class="pane">
    <div class="hero ${vd.cls}"><div class="verdict-ring" style="--p:0;--ring:${vd.cls === "warn" ? "var(--alert)" : vd.cls === "plain" ? "var(--amber)" : "var(--ember)"}"><b data-count="${p ?? 0}">0</b><small>rank %</small></div>
      <div class="hero-body"><span class="badge ${vd.cls === "warn" ? "red" : vd.cls === "plain" ? "mod" : "high"}">${vd.word}</span>
        <h3 style="margin-top:8px">Began ${b.fire_start} in ${b.country}</h3><p>${vd.text}</p>${tag}</div></div>
    <div class="card"><div class="sec-head"><span class="sec-ic">${icon("target")}</span><h2>Where the fire ranked in ${b.country}</h2></div>
      <p class="desc">Share of the country's cells rated below the fire's cells, the week it began. Raised above 60, flagged above 90.</p>
      <div class="meter"><span class="zone" style="left:60%;width:30%;background:rgba(255,179,64,.25)"></span><span class="zone" style="left:90%;width:10%;background:rgba(255,106,31,.6)"></span>
        <span class="mk model" style="left:0%">Model ${pct(p)}</span><span class="mk base" style="left:0%">Baseline ${pct(q)}</span></div>
      <div class="vs"><div class="side model"><small>Model: risk on the fire's cells</small><b>${pct(b.model.mean_risk_on_fire_cells_pct)}</b></div>
        <div class="side"><small>Baseline</small><b>${pct(b.baseline.mean_risk_on_fire_cells_pct)}</b></div>
        <div class="side model"><small>Burning cells in ${b.country} caught by the top 10%</small><b>${pct(b.model.country_burning_cells_caught_in_top10pct)}</b></div>
        <div class="side"><small>Baseline</small><b>${pct(b.baseline.country_burning_cells_caught_in_top10pct)}</b></div></div>
      <dl class="kv"><dt>Prediction for the week of</dt><dd>${b.prediction_for_week_starting}</dd>
        <dt>Fire data used up to</dt><dd>${b.data_used_up_to}</dd></dl>${b.forecast_note ? `<div class="note" style="margin:-6px 0 12px">${b.forecast_note}</div>` : ""}
      ${b.by_version ? `<table><thead><tr><th>Version</th><th>Rank</th></tr></thead><tbody>${Object.entries(b.by_version).map(([n, s]) =>
        `<tr class="${n === (metrics.model_selection?.chosen || metrics.chosen) ? "chosen" : ""}"><td>${n.split(" (")[0]}${/forecast/i.test(n) ? " · forecast weather*" : ""}</td><td class="mono">${pct(s.risk_percentile_in_country)}</td></tr>`).join("")}
        <tr><td>Baseline</td><td class="mono">${pct(q)}</td></tr></tbody></table>${FC ? `<div class="note">* ${FC_LABEL}.</div>` : ""}` : ""}</div>
    <div class="card"><div class="sec-head"><span class="sec-ic">${icon("chip")}</span><h2>Why ${pct(w.risk_pct)} for its riskiest cell</h2></div>
      ${w.drivers.map(([k, d]) => `<div class="drv"><span>${k}</span><span class="track"><i class="${d >= 0 ? "up" : "dn"}" style="width:${Math.abs(d) / maxD * 50}%"></i></span><span>${d >= 0 ? "raises" : "lowers"}</span></div>`).join("")}
      <div class="note">Weather the week before: max ${wx.tmax_last_week}°C (${wx.tmax_anomaly >= 0 ? "+" : ""}${wx.tmax_anomaly}°C against normal), humidity ${wx.rh_last_week}%, wind ${wx.wind_last_week} m/s, rain over 4 weeks ${wx.rain_last_4_weeks} mm.</div>
      ${usesFc && fw ? `<div class="note">Weather of the week itself, used as the forecast: average max ${fw.fc_tmax}°C, hottest day ${fw.fc_hottest_day}°C, humidity ${fw.fc_rh}%, windiest day ${fw.fc_windiest_day} m/s, rain ${fw.fc_rain} mm.</div>` : ""}</div>
    ${lf ? `<div class="hero plain"><div class="hero-ic">${icon("trend")}</div><div class="hero-body">
      <h3>Not just these six: every large fire</h3>
      <p>All <b>${fmt(lf.all.fires)}</b> critical fires of 2021–2025. <b>${lf.all.model_pct_inside_top10}%</b> began inside the model's top 10% of risk for their country, against <b>${lf.all.baseline_pct_inside_top10}%</b> for the baseline.${FC ? ` <span class="est fc">${FC_LABEL}</span>` : ""}</p>
      <div class="list" style="margin-top:12px">${Object.entries(lf.by_region).map(([r, s]) => `<div class="row-btn" aria-disabled="true" style="grid-template-columns:minmax(0,1fr) 120px 56px;background:rgba(0,0,0,.3)">
        <span>${r}<small>${fmt(s.fires)} fires · baseline ${s.baseline_pct_inside_top10}%</small></span><span class="bar"><i style="width:${s.model_pct_inside_top10}%"></i></span><span class="n">${s.model_pct_inside_top10}%</span></div>`).join("")}</div></div></div>` : ""}
    <div class="note">The model was frozen with data to the end of 2020. Three fires were fixed before training; three more are chosen by a rule (largest fire in each region, 2021–2025). All six are shown whatever the result. Baseline = how often the place burned in that week of the year before.</div>
    </div>`;
  // animate ring, counters and markers in
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const ring = $("#tv-side .verdict-ring"); if (!ring) return;
    const target = p ?? 0, s0 = performance.now();
    const f = now => { const k = Math.min(1, (now - s0) / 1100), e = 1 - Math.pow(1 - k, 3); ring.style.setProperty("--p", target * e);
      ring.querySelector("b").textContent = Math.round(target * e); if (k < 1) requestAnimationFrame(f); };
    requestAnimationFrame(f);
    const mk = $("#tv-side .mk.model"), mb = $("#tv-side .mk.base");
    if (mk) mk.style.left = (p ?? 0) + "%"; if (mb) mb.style.left = (q ?? 0) + "%";
  }));
  $("#tv-stage").classList.remove("tv-flash"); void $("#tv-stage").offsetWidth; $("#tv-stage").classList.add("tv-flash");
}
