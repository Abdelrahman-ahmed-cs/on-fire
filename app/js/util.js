// Shared helpers: data loading (cached), formatting, colour ramps, small SVG charts.
const cache = new Map();
export async function getJSON(url, opts) {
  const key = url + (opts?.body || "");
  if (!cache.has(key)) {
    cache.set(key, fetch(url, opts).then(r => {
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return r.json();
    }).catch(e => { cache.delete(key); throw e; }));
  }
  return cache.get(key);
}
export const data = name => getJSON(`/api/data/${name}`);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const fmt = n => n == null || isNaN(n) ? "–" : Math.abs(n) >= 100 ? Math.round(n).toLocaleString("en")
  : (Math.round(n * 10) / 10).toLocaleString("en");
export const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const cvd = () => document.body.classList.contains("cvd");
export const cssVar = name => getComputedStyle(document.body).getPropertyValue(name).trim();
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const icon = (id, cls = "ic") => `<svg class="${cls}"><use href="#i-${id}"/></svg>`;
export const help = text => `<span class="help" tabindex="0" aria-label="${esc(text)}">?<span class="bubble">${esc(text)}</span></span>`;

// Ramps. Warm by default (as in the team's reference screens); the colour-blind option is cividis-like.
const HEAT = ["#3a1606", "#7a2a08", "#c8430d", "#ff6a1f", "#ffa25e", "#ffe2c4"];      // calendar squares: dark ember -> pale peach
const CLIM = ["#ffc46b", "#ff9a3c", "#f26a1c", "#d8410e", "#b3260a"];                             // map heat: yellow -> deep red
const RISK = ["#fff3b0", "#ffd166", "#f8961e", "#f3722c", "#d62828"];
const CIVIDIS = ["#00224e", "#35456c", "#666970", "#948e77", "#c8b866", "#fee838"];
const DIVERGE = ["#3d6fd6", "#8fb1ee", "#2a2a2e", "#ff9a4d", "#ff3b30"];               // below normal - normal - above
const DIVERGE_CVD = ["#2f6fd0", "#8db8ee", "#3a3a3e", "#e6c84a", "#fee838"];
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export function lerp(stops, t) {
  t = Math.max(0, Math.min(1, t)); const x = t * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(x));
  const a = hex(stops[i]), b = hex(stops[i + 1]), f = x - i;
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}
export const heatStops = () => cvd() ? CIVIDIS : HEAT;
export const heatColor = t => lerp(heatStops(), t);
export const climStops = () => cvd() ? CIVIDIS.slice(2) : CLIM;
export const riskStops = () => cvd() ? CIVIDIS : RISK;
export const riskColor = t => lerp(riskStops(), t);
export const seqStops = heatStops, seqColor = heatColor;
export const divStops = () => cvd() ? DIVERGE_CVD : DIVERGE;
export const divColor = t => lerp(divStops(), t);               // t in 0..1, 0.5 = normal
export const anomalyT = ratio => 0.5 + Math.max(-1, Math.min(1, Math.log2(Math.max(ratio, 1e-3)) / 2.5)) / 2;
export const gradientCSS = stops => `linear-gradient(90deg, ${stops.join(",")})`;

// ---- tooltip (white, like the reference) ---------------------------------
let tipEl;
export function tip(evt, html) {
  if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; document.body.appendChild(tipEl); }
  if (!html) { tipEl.style.display = "none"; return; }
  tipEl.innerHTML = html; tipEl.style.display = "block";
  tipEl.style.left = Math.max(8, Math.min(evt.clientX + 14, innerWidth - tipEl.offsetWidth - 8)) + "px";
  tipEl.style.top = Math.min(evt.clientY + 16, innerHeight - tipEl.offsetHeight - 8) + "px";
}

// ---- count-up for headline numbers -------------------------------------------
export function countUp(el, to, { dur = 900, dec = 0, suffix = "" } = {}) {
  if (!el) return;
  const from = 0, t0 = performance.now();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = to.toFixed(dec) + suffix; return; }
  const f = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    const v = from + (to - from) * e;
    el.textContent = (dec ? v.toFixed(dec) : Math.round(v).toLocaleString("en")) + suffix;
    if (k < 1) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}

// ---- tiny SVG chart helpers --------------------------------------------
const NS = "http://www.w3.org/2000/svg";
export function svgEl(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; }
let gid = 0;
function stripes(svg, color, dark) {
  const id = "st" + (++gid), defs = svgEl("defs", {}, svg);
  const p = svgEl("pattern", { id, width: 8, height: 8, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
  svgEl("rect", { width: 8, height: 8, fill: color }, p);
  svgEl("rect", { width: 4, height: 8, fill: dark || "rgba(0,0,0,.16)" }, p);
  return `url(#${id})`;
}

/** Line chart. series: [{name,color,values:[{x,y}],dash,band:{lo:[],hi:[]},area}] with numeric x. */
export function lineChart(host, series, { height = 220, xLabel = x => x, vline, legend = true } = {}) {
  host.innerHTML = "";
  const W = host.clientWidth || 400, H = height, m = { l: 44, r: 16, t: 10, b: 22 };
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, host);
  const xs = series.flatMap(s => s.values.map(p => p.x));
  const ys = series.flatMap(s => [...s.values.map(p => p.y), ...(s.band ? s.band.hi : [])]);
  if (!xs.length) { host.textContent = "No data."; return; }
  const x0 = Math.min(...xs), x1 = Math.max(...xs), yMax = niceMax(Math.max(...ys, 1));
  const X = x => m.l + (x - x0) / Math.max(x1 - x0, 1) * (W - m.l - m.r);
  const Y = y => H - m.b - y / yMax * (H - m.t - m.b);
  for (let i = 0; i <= 3; i++) {
    const y = yMax * i / 3;
    svgEl("line", { x1: m.l, x2: W - m.r, y1: Y(y), y2: Y(y), class: "axis", "stroke-dasharray": i ? "2 5" : "" }, svg);
    svgEl("text", { x: m.l - 6, y: Y(y) + 4, "text-anchor": "end" }, svg).textContent = fmt(y);
  }
  const step = Math.max(1, Math.ceil((x1 - x0) / Math.max(3, Math.min(13, Math.floor((W - m.l - m.r) / 46)))));
  for (let x = x0; x <= x1; x += step)
    svgEl("text", { x: X(x), y: H - 5, "text-anchor": "middle" }, svg).textContent = xLabel(x);
  if (vline != null) {
    svgEl("line", { x1: X(vline.x), x2: X(vline.x), y1: m.t, y2: H - m.b, stroke: "rgba(255,255,255,.35)", "stroke-dasharray": "4 4" }, svg);
    svgEl("text", { x: X(vline.x) + 5, y: m.t + 10, style: "fill:#fff;font-weight:700" }, svg).textContent = vline.label;
  }
  for (const s of series) {
    if (s.band) {
      const up = s.values.map((p, i) => `${X(p.x)},${Y(s.band.hi[i])}`);
      const dn = s.values.map((p, i) => `${X(p.x)},${Y(s.band.lo[i])}`).reverse();
      svgEl("polygon", { points: [...up, ...dn].join(" "), fill: s.color, opacity: 0.16 }, svg);
    }
    if (s.area) {
      const gidA = "ga" + (++gid), defs = svgEl("defs", {}, svg);
      const lg = svgEl("linearGradient", { id: gidA, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      svgEl("stop", { offset: 0, "stop-color": s.color, "stop-opacity": .35 }, lg); svgEl("stop", { offset: 1, "stop-color": s.color, "stop-opacity": 0 }, lg);
      const pts = s.values.map(p => `${X(p.x)},${Y(p.y)}`);
      svgEl("polygon", { points: [`${X(s.values[0].x)},${Y(0)}`, ...pts, `${X(s.values.at(-1).x)},${Y(0)}`].join(" "), fill: `url(#${gidA})` }, svg);
    }
    const pl = svgEl("polyline", { points: s.values.map(p => `${X(p.x)},${Y(p.y)}`).join(" "), fill: "none", stroke: s.color,
      "stroke-width": s.width || 2, "stroke-dasharray": s.dash || "", "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    if (!s.dash) { const len = pl.getTotalLength?.() || 0; if (len) { pl.style.strokeDasharray = len; pl.style.strokeDashoffset = len;
      pl.style.transition = "stroke-dashoffset 1.2s cubic-bezier(.2,.8,.2,1)"; requestAnimationFrame(() => requestAnimationFrame(() => pl.style.strokeDashoffset = 0)); } }
    for (const p of s.values) {
      const c = svgEl("circle", { cx: X(p.x), cy: Y(p.y), r: 7, fill: "transparent" }, svg);
      c.addEventListener("mousemove", e => tip(e, `<b>${s.name}</b><br>${xLabel(p.x)}: ${fmt(p.y)}`));
      c.addEventListener("mouseleave", e => tip(e, null));
    }
  }
  if (!legend) return;
  const lg = document.createElement("div"); lg.className = "chart-legend";
  lg.innerHTML = series.map(s => `<span><i style="background:${s.color}${s.dash ? ";opacity:.6" : ""}"></i>${s.name}</span>`).join("");
  host.appendChild(lg);
}

/** Bar chart. items: [{label,value,color,value2,hot}] ; value2 draws a marker line (e.g. median). Bars are striped. */
export function barChart(host, items, { height = 150, labelEvery = 1, horizontal = false, unit = "", markColor = "#fff", cls = "" } = {}) {
  host.innerHTML = "";
  if (!items.length) { host.textContent = "No data."; return; }
  if (horizontal) {
    const max = Math.max(...items.map(i => i.value), 1);
    host.innerHTML = `<div class="list">${items.map(i => `<div class="row-btn" aria-disabled="true" style="grid-template-columns:minmax(0,1fr) 120px 56px">
      <span>${i.label}</span><span class="bar ${i.cls || cls}"><i style="width:${Math.max(2, i.value / max * 100)}%"></i></span>
      <span class="n">${fmt(i.value)}${unit}</span></div>`).join("")}</div>`;
    return;
  }
  const W = host.clientWidth || 400, H = height, m = { l: 40, r: 4, t: 8, b: 20 };
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, host);
  const yMax = niceMax(Math.max(...items.map(i => Math.max(i.value, i.value2 || 0)), 1));
  const bw = (W - m.l - m.r) / items.length, Y = y => H - m.b - y / yMax * (H - m.t - m.b);
  for (let i = 0; i <= 2; i++) {
    const y = yMax * i / 2;
    svgEl("line", { x1: m.l, x2: W - m.r, y1: Y(y), y2: Y(y), class: "axis", "stroke-dasharray": i ? "2 5" : "" }, svg);
    svgEl("text", { x: m.l - 5, y: Y(y) + 4, "text-anchor": "end" }, svg).textContent = fmt(y);
  }
  const fills = {};
  items.forEach((it, i) => {
    const x = m.l + i * bw, h = Math.max(H - m.b - Y(it.value), 0), w = Math.max(bw * 0.68, 1);
    const fill = fills[it.color] ??= stripes(svg, it.color);
    const r = svgEl("rect", { x: x + (bw - w) / 2, y: H - m.b, width: w, height: 0, rx: Math.min(6, w / 2), fill }, svg);
    r.style.transition = `y .8s cubic-bezier(.2,.8,.2,1) ${i * 18}ms, height .8s cubic-bezier(.2,.8,.2,1) ${i * 18}ms`;
    requestAnimationFrame(() => requestAnimationFrame(() => { r.setAttribute("y", Y(it.value)); r.setAttribute("height", h); }));
    r.addEventListener("mousemove", e => tip(e, `<b>${it.tipLabel || it.label}</b>: ${fmt(it.value)}${unit}${it.value2 != null ? `<br>typical: ${fmt(it.value2)}${unit}` : ""}`));
    r.addEventListener("mouseleave", e => tip(e, null));
    if (it.value2 != null) svgEl("line", { x1: x + 2, x2: x + bw - 2, y1: Y(it.value2), y2: Y(it.value2), stroke: markColor, "stroke-width": 2, "stroke-linecap": "round" }, svg);
    if (i % labelEvery === 0) svgEl("text", { x: x + bw / 2, y: H - 5, "text-anchor": "middle", style: it.hot ? "fill:#fff;font-weight:800" : "" }, svg).textContent = it.label;
  });
}

export function table(host, cols, rows, chosen = () => false) {
  host.innerHTML = `<table><thead><tr>${cols.map(c => `<th>${c.label}</th>`).join("")}</tr></thead><tbody>${
    rows.map(r => `<tr class="${chosen(r) ? "chosen" : ""}">${cols.map(c => `<td>${c.get(r)}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}

export function download(name, content, type = "text/csv") {
  const a = document.createElement("a");
  a.href = content instanceof Blob ? URL.createObjectURL(content) : URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
