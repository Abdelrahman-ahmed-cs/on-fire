import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons.jsx';
import * as maplibregl from 'maplibre-gl';
// Bundle MapLibre's web worker (and its shared chunk) so it also loads from the production build.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { AGE, PLACE_STATUS, ago, fmt, strengthWord, destination, compassName, MONTHS_LONG, greatCircle, bearingDeg } from '../lib.js';

maplibregl.setWorkerUrl(workerUrl);

// Bumped whenever the map shapes change, so browsers never reuse an old copy (North America was added 2026-11-13).
const GEO_V = '2026-11-14';
const PAD = { top: 90, bottom: 20, left: 20, right: 20 };
const TINT = '#ff4a1c';
const EMPTY = { type: 'FeatureCollection', features: [] };
const FONT = ['Open Sans Semibold'];
const FONT_BOLD = ['Open Sans Bold'];
// North America's three countries are split into states / provinces on the region map.
const NAM_ISOS = ['USA', 'CAN', 'MEX'];
const IS_NAM = ['in', ['get', 'iso'], ['literal', NAM_ISOS]];
const fc = (geometry) => ({ type: 'FeatureCollection', features: geometry ? [{ type: 'Feature', properties: {}, geometry }] : [] });
// Top view of a small drone, nose up (rotated to the flight bearing by the marker).
const DRONE_SVG = `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
  <g stroke="#fff" stroke-width="3" stroke-linecap="round"><path d="M20 20 44 44M44 20 20 44"/></g>
  ${[[16, 16], [48, 16], [16, 48], [48, 48]].map(([x, y]) => `<g transform="translate(${x} ${y})"><circle r="10" fill="rgba(255,255,255,0.14)" stroke="rgba(255,255,255,0.55)" stroke-width="1.2"/><g class="rotor"><rect x="-9" y="-1.2" width="18" height="2.4" rx="1.2" fill="#fff"/></g></g>`).join('')}
  <rect x="24" y="22" width="16" height="20" rx="6" fill="#ff6a1f" stroke="#fff" stroke-width="2"/>
  <path d="M32 14 37 22H27z" fill="#fff"/>
  <circle cx="32" cy="34" r="2.6" fill="#fff"/>
</svg>`;
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

const STYLE = {
  version: 8,
  glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 16,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    gibs: {
      type: 'raster',
      tiles: [`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${yesterday()}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
      tileSize: 256,
      maxzoom: 9,
      attribution: 'NASA GIBS / VIIRS NOAA-20',
    },
    labels: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 16,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0d10' } },
    { id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-saturation': -0.25, 'raster-brightness-max': 0.85, 'raster-fade-duration': 0 } },
    { id: 'gibs', type: 'raster', source: 'gibs', layout: { visibility: 'none' } },
  ],
};

// colour = how recent, size = how strong
const ageColor = ['step', ['get', 'ageH'], AGE[0].color, AGE[0].max, AGE[1].color, AGE[1].max, AGE[2].color];
const sizeByStrength = (scale) => ['interpolate', ['linear'], ['get', 'frp'], 0, 2.2 * scale, 5, 3 * scale, 20, 4.5 * scale, 50, 6 * scale, 100, 8 * scale];

// ---------- data → GeoJSON ----------
function firesToGeoJSON(live) {
  if (!live) return EMPTY;
  const { cols, rows } = live.fires;
  const ix = Object.fromEntries(cols.map((c, i) => [c, i]));
  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      id: r[ix.id],
      properties: { id: r[ix.id], frp: r[ix.frp], ageH: r[ix.ageH], sat: r[ix.sat], iso: r[ix.iso], event: r[ix.event], dn: r[ix.dn] },
      geometry: { type: 'Point', coordinates: [r[ix.lon], r[ix.lat]] },
    })),
  };
}

const pointsFC = (cells, weightKey) => ({
  type: 'FeatureCollection',
  features: cells.map((c) => ({ type: 'Feature', properties: { w: c[weightKey] }, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } })),
});

// Spread zones, direction arrows and smoke plumes for a list of projected fires.
function forecastFeatures(items) {
  const zones = [], arrows = [], plumes = [];
  for (const it of items) {
    const { lat, lon } = it.event;
    for (const e of [...(it.envelopes ?? [])].reverse()) zones.push({ type: 'Feature', properties: { hours: e.hours }, geometry: { type: 'Polygon', coordinates: [e.ring] } });
    const last = it.envelopes?.at(-1);
    const dir = last && last.headKm > 0.05 ? last.dir : it.windToward;
    const perDay = last ? last.headKm : 0;
    arrows.push({
      type: 'Feature',
      properties: { dir, size: Math.min(1.6, 0.8 + perDay / 10), label: `${compassName(dir)} · ${perDay < 0.1 ? 'barely moving' : `${fmt(perDay, 1)} km / 24 h`}` },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
    // Smoke plume: a wedge downwind, as long as the wind carries smoke in ~6 h
    const len = Math.max(6, Math.min(160, (it.windKmh ?? 10) * 6));
    const toward = it.windToward;
    for (const [f, a, op] of [[1, 16, 0.18], [0.55, 11, 0.22]]) {
      const ring = [[lon, lat]];
      for (let k = -a; k <= a; k += 4) ring.push(destination(lat, lon, len * f, toward + k));
      ring.push([lon, lat]);
      plumes.push({ type: 'Feature', properties: { op }, geometry: { type: 'Polygon', coordinates: [ring] } });
    }
    const mid = destination(lat, lon, len * 0.7, toward);
    plumes.push({ type: 'Feature', properties: { label: 'smoke' }, geometry: { type: 'Point', coordinates: mid } });
  }
  return { zones: { type: 'FeatureCollection', features: zones }, arrows: { type: 'FeatureCollection', features: arrows }, plumes: { type: 'FeatureCollection', features: plumes } };
}

function placesToGeoJSON(places) {
  return {
    type: 'FeatureCollection',
    features: places.map((p) => ({
      type: 'Feature',
      properties: { level: p.level, label: p.callout ? '' : `${p.name}${p.etaHours ? `\nfire could arrive in ~${Math.round(p.etaHours)} h` : ''}` },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
}

// ---------- icons ----------
function makeIcon(draw, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  draw(g, size);
  return g.getImageData(0, 0, size, size);
}
const windArrow = (g, s) => {
  g.translate(s / 2, s / 2);
  g.fillStyle = '#e8f4ff';
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, -26); g.lineTo(13, 0); g.lineTo(4, -2); g.lineTo(4, 26); g.lineTo(-4, 26); g.lineTo(-4, -2); g.lineTo(-13, 0);
  g.closePath();
  g.stroke();
  g.fill();
};
// Fat orange arrow whose tail sits at the icon's bottom centre (placed on the fire).
const spreadArrow = (g, s) => {
  g.translate(s / 2, 0);
  const grad = g.createLinearGradient(0, s, 0, 0);
  grad.addColorStop(0, 'rgba(255,120,0,0.35)');
  grad.addColorStop(1, '#ff3b1f');
  g.fillStyle = grad;
  g.strokeStyle = '#fff';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, 3); g.lineTo(22, 34); g.lineTo(8, 32); g.lineTo(8, s - 2); g.lineTo(-8, s - 2); g.lineTo(-8, 32); g.lineTo(-22, 34);
  g.closePath();
  g.fill();
  g.stroke();
};

function featureBounds(features) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else c.forEach(walk);
  };
  features.forEach((f) => walk(f.geometry.coordinates));
  return [[w, s], [e, n]];
}

// The largest polygon of a country (area weighted by cos(latitude)), e.g. the lower 48 states
// for the United States, whose Aleutian islands cross 180° and would otherwise zoom out to the whole world.
function mainland(features) {
  let best = null, bestA = -1;
  for (const f of features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) {
      const ring = p[0];
      let a = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
      a = Math.abs(a / 2) * Math.cos((ring[0][1] * Math.PI) / 180);
      if (a > bestA) { bestA = a; best = p; }
    }
  }
  return best ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: best } }] : features;
}

// The first place the fire could reach (shortest estimated arrival), as in the warning card.
function firstInPath(detail) {
  const inPath = (detail?.threatened ?? []).filter((p) => p.level !== 'watch');
  return [...inPath].sort((a, b) => (a.etaHours ?? 0) - (b.etaHours ?? 0))[0] ?? null;
}

function setSrc(map, id, data) {
  const s = map?.getSource(id);
  if (s) s.setData(data);
}

export default function MapView({ live, view, region, mode, layers, risk, countryData, eventDetail, focus, climGrid, historyOverview, historyMonth, aiData, aiSelected, onCountryClick, onFireClick, onPointClick, onAiClick, onBack, drawing, area, onAreaDrawn, travel, onTravelDone }) {
  const container = useRef(null);
  const mapRef = useRef(null);
  const countriesRef = useRef(null);
  const labelsRef = useRef(null);
  const tooltip = useRef(null);
  const [ready, setReady] = useState(false);
  const mapOk = () => ready && !!mapRef.current?.getLayer?.('fire-pts');
  const cb = useRef({});
  cb.current = { onCountryClick, onFireClick, onPointClick, onAiClick, onAreaDrawn, onTravelDone, view, region, live, mode, historyOverview, historyMonth, drawing };
  const markersRef = useRef([]);
  const calloutsRef = useRef([]);

  // ---------- init ----------
  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      bounds: region.bounds,
      fitBoundsOptions: { padding: PAD },
      attributionControl: { compact: true },
      maxZoom: 16.5,
      dragRotate: false,
      renderWorldCopies: false,
      fadeDuration: 0,
      maxTileCacheSize: 600,
    });
    mapRef.current = map;
    window.__onfireMap = map; // handy for debugging in the console
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    tooltip.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'tip', offset: 12, maxWidth: '280px' });

    map.on('load', async () => {
      map.addImage('wind', makeIcon(windArrow), { pixelRatio: 2 });
      map.addImage('spread', makeIcon(spreadArrow, 96), { pixelRatio: 2 });
      const [countries, labels] = await Promise.all([fetch(`/geo/countries.geojson?v=${GEO_V}`).then((r) => r.json()), fetch(`/geo/labels.geojson?v=${GEO_V}`).then((r) => r.json())]);
      countriesRef.current = countries;
      labelsRef.current = labels;
      const src = (id, data, extra = {}) => map.addSource(id, { type: 'geojson', data, ...extra });
      src('countries', countries, { generateId: true });
      src('provinces', `/geo/provinces.geojson?v=${GEO_V}`, { generateId: true });
      for (const id of ['fires', 'risk', 'zones', 'arrows', 'plumes', 'places', 'wind', 'event', 'clim', 'area-labels', 'ai', 'ai-sel', 'area', 'flight']) src(id, EMPTY);

      map.addLayer({ id: 'country-fill', type: 'fill', source: 'countries', paint: { 'fill-color': TINT, 'fill-opacity': 0 } });
      map.addLayer({ id: 'prov-fill', type: 'fill', source: 'provinces', filter: ['==', ['get', 'iso'], ''], paint: { 'fill-color': TINT, 'fill-opacity': 0 } });
      map.addLayer({ id: 'nam-prov-fill', type: 'fill', source: 'provinces', filter: IS_NAM, paint: { 'fill-color': TINT, 'fill-opacity': 0 } });
      map.addLayer({ id: 'country-mask', type: 'fill', source: 'countries', filter: ['==', ['get', 'iso'], ''], paint: { 'fill-color': '#05070a', 'fill-opacity': 0.6 } });
      map.addLayer({
        id: 'clim-heat', type: 'heatmap', source: 'clim',
        paint: {
          'heatmap-weight': ['get', 'w'],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 1.2, 6, 2, 9, 1.4],
          'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 3, 5, 5, 14, 8, 110],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.08, 'rgba(255,230,120,0.35)', 0.3, 'rgba(255,170,40,0.6)', 0.6, 'rgba(240,80,20,0.78)', 1, 'rgba(170,0,40,0.9)'],
          'heatmap-opacity': 0.85,
        },
      });
      map.addLayer({
        id: 'risk-heat', type: 'heatmap', source: 'risk',
        paint: {
          'heatmap-weight': ['min', 1, ['*', 1.8, ['get', 'w']]],
          'heatmap-intensity': 1.2,
          'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 4, 10, 6, 34, 8, 140],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.1, 'rgba(255,243,176,0.25)', 0.3, 'rgba(255,209,102,0.5)', 0.5, 'rgba(248,150,30,0.65)', 0.75, 'rgba(243,114,44,0.75)', 1, 'rgba(214,40,40,0.85)'],
          'heatmap-opacity': 0.75,
        },
      });
      // AI danger: coloured 50 km squares + a red glow on the high-risk ones
      map.addLayer({
        id: 'ai-cells', type: 'fill', source: 'ai', filter: ['==', ['geometry-type'], 'Polygon'], layout: { visibility: 'none' },
        paint: {
          'fill-color': ['case', ['==', ['get', 'red'], 1], '#ff1a1a', ['>=', ['get', 'p'], 0.5], '#ff7a00', '#ffc233'],
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 3, ['case', ['==', ['get', 'red'], 1], 0.62, ['>=', ['get', 'p'], 0.5], 0.42, 0.26], 7, ['case', ['==', ['get', 'red'], 1], 0.32, ['>=', ['get', 'p'], 0.5], 0.22, 0.14], 10, ['case', ['==', ['get', 'red'], 1], 0.14, ['>=', ['get', 'p'], 0.5], 0.1, 0.06]],
        },
      });
      map.addLayer({
        id: 'ai-glow', type: 'heatmap', source: 'ai', filter: ['all', ['==', ['geometry-type'], 'Point'], ['any', ['==', ['get', 'red'], 1], ['>=', ['get', 'p'], 0.5]]], layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': ['case', ['==', ['get', 'red'], 1], 1, 0.3],
          'heatmap-intensity': 1,
          'heatmap-radius': ['interpolate', ['exponential', 2], ['zoom'], 3, 12, 5, 40, 8, 160],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.2, 'rgba(255,120,0,0.18)', 0.5, 'rgba(255,50,0,0.35)', 1, 'rgba(255,0,40,0.55)'],
          // the glow is for the overview; fade it out when zoomed in so the land stays visible
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 7, 0.35, 8.5, 0],
        },
      });
      map.addLayer({ id: 'ai-sel', type: 'line', source: 'ai-sel', paint: { 'line-color': '#ffffff', 'line-width': 2.5 } });
      map.addLayer({ id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0, 6.5, 0.85] } });
      map.addLayer({ id: 'nam-prov-line', type: 'line', source: 'provinces', filter: IS_NAM, paint: { 'line-color': '#ffffff', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 1.5, 0.12, 4, 0.3], 'line-width': 0.7 } });
      map.addLayer({ id: 'prov-line', type: 'line', source: 'provinces', filter: ['==', ['get', 'iso'], ''], paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 0.8 } });
      map.addLayer({ id: 'prov-hover', type: 'line', source: 'provinces', paint: { 'line-color': '#ffd39a', 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 0] } });
      map.addLayer({ id: 'country-line', type: 'line', source: 'countries', paint: { 'line-color': '#ffffff', 'line-opacity': 0.5, 'line-width': 0.9 } });
      map.addLayer({ id: 'country-hover', type: 'line', source: 'countries', paint: { 'line-color': '#ffd39a', 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 3, 0] } });
      map.addLayer({ id: 'country-sel', type: 'line', source: 'countries', filter: ['==', ['get', 'iso'], ''], paint: { 'line-color': '#ff9d3c', 'line-width': 3 } });
      // smoke
      map.addLayer({ id: 'plume-fill', type: 'fill', source: 'plumes', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#e3e8ef', 'fill-opacity': ['*', 1.7, ['get', 'op']] } });
      map.addLayer({ id: 'plume-line', type: 'line', source: 'plumes', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#e3e8ef', 'line-opacity': 0.5, 'line-width': 1 } });
      map.addLayer({
        id: 'plume-label', type: 'symbol', source: 'plumes', filter: ['==', ['geometry-type'], 'Point'], minzoom: 6,
        layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11, 'text-letter-spacing': 0.15, 'text-transform': 'uppercase' },
        paint: { 'text-color': '#e6e9ee', 'text-halo-color': 'rgba(0,0,0,0.7)', 'text-halo-width': 1.2 },
      });
      // danger zones (where the fire could reach)
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zones', paint: { 'fill-color': ['match', ['get', 'hours'], 3, '#ff1f1f', 6, '#ff4d1f', 12, '#ff8c1a', '#ffc94d'], 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.3, 12, 0.16, 15, 0.06] } });
      map.addLayer({ id: 'zone-glow', type: 'line', source: 'zones', paint: { 'line-color': ['match', ['get', 'hours'], 3, '#ff1f1f', 6, '#ff4d1f', 12, '#ff8c1a', '#ffc94d'], 'line-width': 9, 'line-blur': 7, 'line-opacity': 0.45 } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zones', paint: { 'line-color': ['match', ['get', 'hours'], 3, '#ff1f1f', 6, '#ff4d1f', 12, '#ff8c1a', '#ffc94d'], 'line-width': 1.6, 'line-dasharray': [3, 2] } });
      // fires
      map.addLayer({
        id: 'fire-heat', type: 'heatmap', source: 'fires', maxzoom: 9, layout: { visibility: 'none' },
        paint: {
          'heatmap-weight': ['interpolate', ['linear'], ['get', 'frp'], 0, 0.2, 50, 1],
          'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 3, 0.6, 8, 2],
          'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 3, 6, 8, 22],
          'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', 0.15, 'rgba(255,200,60,0.35)', 0.4, 'rgba(255,140,0,0.6)', 0.7, 'rgba(255,60,0,0.8)', 1, 'rgba(255,20,80,0.95)'],
          'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.9, 9, 0],
        },
      });
      // Static glow for fires burning now (an animated pulse repainted the whole map every frame)
      map.addLayer({ id: 'fire-pulse', type: 'circle', source: 'fires', filter: ['<', ['get', 'ageH'], AGE[0].max], paint: { 'circle-color': AGE[0].color, 'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 5, 8, 12, 12, 22], 'circle-blur': 1, 'circle-opacity': 0.45 } });
      map.addLayer({
        id: 'fire-pts', type: 'circle', source: 'fires',
        paint: {
          'circle-color': ageColor,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, sizeByStrength(0.55), 7, sizeByStrength(1), 12, sizeByStrength(1.8)],
          'circle-stroke-color': 'rgba(0,0,0,0.75)',
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 0.4, 9, 1.2],
          'circle-opacity': ['step', ['get', 'ageH'], 1, AGE[1].max, 0.7],
        },
      });
      map.addLayer({
        id: 'spread-arrows', type: 'symbol', source: 'arrows',
        layout: {
          'icon-image': 'spread', 'icon-anchor': 'bottom', 'icon-rotate': ['get', 'dir'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
          'icon-size': ['interpolate', ['linear'], ['zoom'], 5, ['*', 0.55, ['get', 'size']], 10, ['*', 1, ['get', 'size']]],
          'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 11.5, 'text-anchor': 'top', 'text-offset': [0, 0.8], 'text-optional': true,
        },
        paint: { 'text-color': '#ffd9b3', 'text-halo-color': 'rgba(0,0,0,0.9)', 'text-halo-width': 1.5 },
      });
      map.addLayer({
        id: 'wind-arrows', type: 'symbol', source: 'wind', layout: { visibility: 'none',
          'icon-image': 'wind', 'icon-rotate': ['+', ['get', 'dir'], 180], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true,
          'icon-size': ['interpolate', ['linear'], ['get', 'speed'], 0, 0.45, 40, 1.1],
          'text-field': ['step', ['zoom'], '', 5.5, ['concat', ['to-string', ['round', ['get', 'speed']]], ' km/h']], 'text-font': FONT, 'text-size': 10, 'text-offset': [0, 2.1], 'text-allow-overlap': false,
        },
        paint: { 'text-color': '#cfe6ff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.2, 'icon-opacity': 0.85 },
      });
      map.addLayer({ id: 'event-ring', type: 'circle', source: 'event', paint: { 'circle-radius': 26, 'circle-color': 'rgba(255,255,255,0.06)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
      map.addLayer({
        id: 'place-pts', type: 'circle', source: 'places',
        paint: { 'circle-radius': 7, 'circle-color': ['match', ['get', 'level'], 'danger', PLACE_STATUS.danger.color, 'warning', PLACE_STATUS.warning.color, PLACE_STATUS.watch.color], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
      });
      map.addLayer({
        id: 'place-labels', type: 'symbol', source: 'places',
        layout: { 'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 14 },
        paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,0.95)', 'text-halo-width': 1.6 },
      });
      // drawn area (calendar for any box)
      map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': TINT, 'fill-opacity': 0.12 } });
      map.addLayer({ id: 'area-line', type: 'line', source: 'area', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
      // flight between the regions
      map.addLayer({ id: 'flight-plan', type: 'line', source: 'flight', filter: ['==', ['get', 'kind'], 'plan'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.35, 'line-width': 1.5, 'line-dasharray': [1, 3] } });
      map.addLayer({ id: 'flight-glow', type: 'line', source: 'flight', filter: ['==', ['get', 'kind'], 'done'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ff6a1f', 'line-width': 12, 'line-blur': 9, 'line-opacity': 0.6 } });
      map.addLayer({ id: 'flight-line', type: 'line', source: 'flight', filter: ['==', ['get', 'kind'], 'done'], layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ffd39a', 'line-width': 2.5 } });
      map.addLayer({
        id: 'area-labels', type: 'symbol', source: 'area-labels',
        layout: {
          'text-field': ['format', ['get', 'name'], { 'font-scale': 1 }, '\n', {}, ['get', 'sub'], { 'font-scale': 0.82, 'text-color': ['get', 'subColor'] }],
          'text-font': FONT_BOLD, 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 7, 14], 'text-max-width': 10, 'text-padding': 4,
          'symbol-sort-key': ['-', 0, ['get', 'rank']],
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.8 },
      });

      setupInteractions(map);
      setReady(true);
    });
    return () => {
      setReady(false);
      map.remove();
    };
  }, []);

  // ---------- 3D globe projection ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map?.setProjection) return;
    const globe = !!layers.globe;
    map.setProjection({ type: globe ? 'globe' : 'mercator' });
    map.setSky?.({
      'sky-color': '#000000',
      'horizon-color': '#ff6a1f',
      'fog-color': '#1a0b04',
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.6, 8, 0],
    });
    map.dragRotate[globe ? 'enable' : 'disable']();
    if (globe && cb.current.view.level === 'region') map.easeTo({ center: cb.current.region.globe, zoom: 1.9, pitch: 0, duration: 1600 });
    else if (!globe && cb.current.view.level === 'region') map.fitBounds(cb.current.region.bounds, { padding: PAD, duration: 1200 });
  }, [layers.globe, ready]);

  function setupInteractions(map) {
    let hoverCountry = null;
    let hoverProv = null;
    const clearHover = () => {
      if (hoverCountry !== null) map.setFeatureState({ source: 'countries', id: hoverCountry }, { hover: false });
      if (hoverProv !== null) map.setFeatureState({ source: 'provinces', id: hoverProv }, { hover: false });
      hoverCountry = hoverProv = null;
    };
    const firesNear = (pt) => (map.getLayoutProperty('fire-pts', 'visibility') === 'none' ? [] : map.queryRenderedFeatures([[pt.x - 6, pt.y - 6], [pt.x + 6, pt.y + 6]], { layers: ['fire-pts'] }));

    map.on('mousemove', (e) => {
      const { view, live, mode, historyOverview, historyMonth } = cb.current;
      clearHover();
      if (cb.current.drawing) {
        tooltip.current.remove();
        map.getCanvas().style.cursor = 'crosshair';
        return;
      }
      const fire = firesNear(e.point)[0];
      if (fire) {
        const p = fire.properties;
        const age = AGE.find((a) => p.ageH < a.max);
        map.getCanvas().style.cursor = 'pointer';
        tooltip.current.setLngLat(e.lngLat).setHTML(`<b>${strengthWord(p.frp)} fire</b> · <span style="color:${age.color}">${age.label.toLowerCase()}</span><br>Seen ${ago(p.ageH)} by the ${p.sat} satellite<br><span class="muted">Click to see where it is heading and who is in danger</span>`).addTo(map);
        return;
      }
      if (view.level === 'country') {
        const prov = map.queryRenderedFeatures(e.point, { layers: ['prov-fill'] })[0];
        if (prov) {
          hoverProv = prov.id;
          map.setFeatureState({ source: 'provinces', id: prov.id }, { hover: true });
          const stats = cb.current.provStats?.[prov.properties.id];
          tooltip.current.setLngLat(e.lngLat).setHTML(`${prov.properties.name ? `<b>${prov.properties.name}</b><br>` : ''}${stats ? `${fmt(stats.n)} fire detections · ${fmt(stats.n24)} today` : 'No fires detected'}<br><span class="muted">Click to check fire danger at this spot</span>`).addTo(map);
          map.getCanvas().style.cursor = 'crosshair';
          return;
        }
      }
      const st = view.level === 'region' && mode === 'now' ? map.queryRenderedFeatures(e.point, { layers: ['nam-prov-fill'] })[0] : null;
      if (st) {
        hoverProv = st.id;
        map.setFeatureState({ source: 'provinces', id: st.id }, { hover: true });
        const p = live?.summary.provinces?.find((x) => x.id === st.properties.id);
        const cn = countriesRef.current?.features.find((x) => x.properties.iso === st.properties.iso)?.properties.name ?? '';
        tooltip.current.setLngLat(e.lngLat).setHTML(`<b>${st.properties.name}</b> · ${cn}<br>${p ? `${fmt(p.events)} fire${p.events === 1 ? '' : 's'} · ${fmt(p.n)} detections` : 'No fires detected'}<br><span class="muted">Click to zoom in</span>`).addTo(map);
        map.getCanvas().style.cursor = 'pointer';
        return;
      }
      const c = map.queryRenderedFeatures(e.point, { layers: ['country-fill'] })[0];
      if (c && (view.level === 'region' || c.properties.iso !== view.iso)) {
        hoverCountry = c.id;
        map.setFeatureState({ source: 'countries', id: c.id }, { hover: true });
        let body;
        if (mode === 'history') {
          const h = historyOverview?.find((x) => x.iso === c.properties.iso);
          body = h ? `${fmt(h.shares[historyMonth], 1)}% of its yearly fires usually happen in ${MONTHS_LONG[historyMonth]}<br>Busiest month: ${MONTHS_LONG[h.peakMonth]}` : 'No history';
        } else {
          const s = live?.summary.countries.find((x) => x.iso === c.properties.iso);
          body = s ? `${fmt(s.events)} fires · ${fmt(s.n)} detections` : 'No fires detected';
        }
        tooltip.current.setLngLat(e.lngLat).setHTML(`<b>${c.properties.name}</b><br>${body}<br><span class="muted">Click to zoom in</span>`).addTo(map);
        map.getCanvas().style.cursor = 'pointer';
        return;
      }
      tooltip.current.remove();
      map.getCanvas().style.cursor = view.level === 'country' ? 'crosshair' : '';
    });
    map.on('mouseout', () => {
      clearHover();
      tooltip.current.remove();
    });
    map.on('click', (e) => {
      const { view } = cb.current;
      tooltip.current.remove();
      if (cb.current.drawing) return;
      const fire = firesNear(e.point)[0];
      if (fire) return cb.current.onFireClick(fire.properties);
      const c = map.queryRenderedFeatures(e.point, { layers: ['country-fill'] })[0];
      if (c && (view.level === 'region' || c.properties.iso !== view.iso)) return cb.current.onCountryClick(c.properties.iso, c.properties.name);
      if (cb.current.mode === 'ai' && c) return cb.current.onAiClick(e.lngLat.lat, e.lngLat.lng);
      if (view.level === 'country' && c) cb.current.onPointClick(e.lngLat.lat, e.lngLat.lng);
    });
  }

  // ---------- fires ----------
  const firesGeo = useMemo(() => firesToGeoJSON(live), [live]);
  useEffect(() => {
    if (mapOk()) setSrc(mapRef.current, 'fires', firesGeo);
  }, [ready, firesGeo]);

  // ---------- which layers each mode shows ----------
  useEffect(() => {
    if (!mapOk()) return;
    const map = mapRef.current;
    const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    const firesOn = mode !== 'history' && mode !== 'ai';
    vis('ai-cells', mode === 'ai');
    vis('ai-glow', mode === 'ai');
    vis('ai-sel', mode === 'ai');
    vis('fire-pts', firesOn);
        vis('fire-heat', firesOn && layers.heat);
    vis('clim-heat', mode === 'history');
    vis('risk-heat', mode === 'forecast');
    vis('wind-arrows', mode === 'forecast' || layers.wind);
    const fc = mode === 'forecast' || !!eventDetail;
    vis('nam-prov-line', view.level === 'region' && layers.provinces);
    for (const id of ['zone-fill', 'zone-glow', 'zone-line', 'spread-arrows', 'plume-fill', 'plume-line', 'plume-label', 'place-pts', 'place-labels']) vis(id, fc);
    vis('fire-pulse', firesOn && mode !== 'forecast');
    vis('esri', layers.imagery === 'esri');
    vis('gibs', layers.imagery === 'gibs');
    // In forecast mode, older fires fade so the arrows and zones stand out
    map.setPaintProperty('fire-pts', 'circle-opacity', mode === 'forecast' ? ['step', ['get', 'ageH'], 0.95, AGE[1].max, 0.25] : ['step', ['get', 'ageH'], 1, AGE[1].max, 0.7]);
  }, [ready, mode, layers, eventDetail, view.level]);

  // ---------- area tint + labels ----------
  useEffect(() => {
    if (!mapOk() || !labelsRef.current) return;
    const map = mapRef.current;
    const L = labelsRef.current.features;
    const iso = view.iso;
    const label = (f, sub, rank, subColor = '#ffc38a') => ({ type: 'Feature', properties: { name: f.properties.name, sub, rank, subColor }, geometry: f.geometry });
    let tint = 0;
    let provTint = 0;
    let feats = [];
    let stateFeats = [];
    if (view.level === 'region') {
      if (mode === 'history' && historyOverview) {
        const max = Math.max(1, ...historyOverview.map((h) => h.shares[historyMonth]));
        // the glow already shows where; keep only a faint tint so it stays readable
        tint = ['match', ['get', 'iso'], ...historyOverview.flatMap((h) => [h.iso, +(0.12 * (h.shares[historyMonth] / max)).toFixed(3)]), 0];
        feats = L.filter((f) => f.properties.kind === 'country').map((f) => {
          const h = historyOverview.find((x) => x.iso === f.properties.iso);
          return h && h.yearlyNormal > 30 ? label(f, `${fmt(h.shares[historyMonth], 0)}% of yearly fires`, h.shares[historyMonth]) : null;
        });
      } else if (live) {
        // Live mode: North America is shown by state / province, each region tinted against its own busiest area
        const split = mode === 'now';
        const list = split ? live.summary.countries.filter((c) => !NAM_ISOS.includes(c.iso)) : live.summary.countries;
        const max = Math.max(1, ...list.map((c) => c.n));
        tint = list.length ? ['match', ['get', 'iso'], ...list.flatMap((c) => [c.iso, +(0.04 + 0.46 * Math.sqrt(c.n / max)).toFixed(3)]), 0] : 0;
        if (mode === 'forecast' || mode === 'ai') tint = 0;
        const provs = split ? (live.summary.provinces ?? []).filter((p) => NAM_ISOS.includes(p.iso)) : [];
        const pmax = Math.max(1, ...provs.map((p) => p.n));
        provTint = provs.length ? ['match', ['get', 'id'], ...provs.flatMap((p) => [p.id, +(0.06 + 0.5 * Math.sqrt(p.n / pmax)).toFixed(3)]), 0] : 0;
        if (split)
          stateFeats = L.filter((f) => f.properties.kind === 'province' && NAM_ISOS.includes(f.properties.iso)).map((f) => {
            const p = provs.find((x) => x.id === f.properties.id);
            return p ? label(f, `${fmt(p.events)} fire${p.events === 1 ? '' : 's'}`, p.n) : label(f, 'no fires', -1, '#9aa3ad');
          });
        feats = L.filter((f) => f.properties.kind === 'country' && !(split && NAM_ISOS.includes(f.properties.iso))).map((f) => {
          const c = list.find((x) => x.iso === f.properties.iso);
          if (mode === 'forecast') return label(f, '', 0);
          if (mode === 'ai') {
            const a = aiData?.countries?.find((x) => x.iso === f.properties.iso);
            return a && (a.red || a.high) ? label(f, `${a.red ? `${a.red} red alert` : ''}${a.red && a.high ? ' · ' : ''}${a.high ? `${a.high} high` : ''}`, a.red * 10 + a.high, '#ff9a8a') : label(f, '', 0);
          }
          return c ? label(f, `${fmt(c.events)} fire${c.events === 1 ? '' : 's'}`, c.n) : label(f, 'no fires', 0, '#9aa3ad');
        });
      }
      map.setPaintProperty('country-fill', 'fill-opacity', tint);
      map.setPaintProperty('nam-prov-fill', 'fill-opacity', provTint);
      map.setPaintProperty('prov-fill', 'fill-opacity', 0);
      feats = feats.concat(stateFeats);
    } else {
      map.setPaintProperty('country-fill', 'fill-opacity', 0);
      map.setPaintProperty('nam-prov-fill', 'fill-opacity', 0);
      const provs = countryData?.iso === iso ? countryData.provinces : [];
      cb.current.provStats = Object.fromEntries(provs.map((p) => [p.id, p]));
      const max = Math.max(1, ...provs.map((p) => p.n));
      const op = provs.length && mode === 'now' ? ['match', ['get', 'id'], ...provs.flatMap((p) => [p.id, +(0.04 + 0.3 * Math.sqrt(p.n / max)).toFixed(3)]), 0] : 0;
      map.setPaintProperty('prov-fill', 'fill-opacity', op ? ['interpolate', ['linear'], ['zoom'], 7, op, 9.5, 0] : 0);
      if (mode === 'now')
        feats = L.filter((f) => f.properties.kind === 'province' && f.properties.iso === iso).map((f) => {
          const p = provs.find((x) => x.id === f.properties.id);
          return p ? label(f, `${fmt(p.n)} detections`, p.n) : null;
        });
    }
    setSrc(map, 'area-labels', { type: 'FeatureCollection', features: feats.filter(Boolean) });
  }, [ready, live, view.level, view.iso, countryData, mode, historyOverview, historyMonth, aiData]);

  // ---------- view level: region vs country ----------
  useEffect(() => {
    if (!mapOk()) return;
    const map = mapRef.current;
    const iso = view.iso ?? '';
    map.setFilter('country-mask', view.level === 'country' ? ['!=', ['get', 'iso'], iso] : ['==', ['get', 'iso'], '__none']);
    map.setFilter('country-sel', ['==', ['get', 'iso'], iso]);
    if (view.level === 'country' && countriesRef.current) {
      const feats = countriesRef.current.features.filter((f) => f.properties.iso === view.iso);
      // leave room for the mode bar / month player at the top of the map
      if (feats.length) map.fitBounds(featureBounds(region.id === 'NAM' ? mainland(feats) : feats), { padding: { top: 185, bottom: 40, left: 60, right: 60 }, duration: 1400, maxZoom: 8 });
    } else if (layers.globe) {
      map.easeTo({ center: region.globe, zoom: 1.9, pitch: 0, duration: 1600 });
    } else {
      map.fitBounds(region.bounds, { padding: PAD, duration: 1200 });
    }
  }, [ready, view.level, view.iso, region.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mapOk()) return;
    const iso = view.iso ?? '__none';
    mapRef.current.setFilter('prov-fill', ['==', ['get', 'iso'], iso]);
    mapRef.current.setFilter('prov-line', ['==', ['get', 'iso'], layers.provinces ? iso : '__none']);
  }, [ready, layers.provinces, view.iso]);

  // ---------- forecast: likelihood cloud, spread arrows, smoke, towns ----------
  useEffect(() => {
    if (!mapOk()) return;
    const map = mapRef.current;
    setSrc(map, 'risk', risk?.grid?.cells ? pointsFC(risk.grid.cells, 'score') : EMPTY);
    // coarser grids (1° Mexico, 2° United States / Canada) need a wider glow to stay one smooth surface
    const grow = (risk?.grid?.step ?? 0.5) / 0.5;
    map.setPaintProperty('risk-heat', 'heatmap-radius', ['interpolate', ['exponential', 2], ['zoom'], 4, 10 * grow, 6, 34 * grow, 8, 140 * grow]);
    let items = [];
    let places = [];
    if (eventDetail?.spread) {
      items = [{ event: eventDetail.event, envelopes: eventDetail.spread.envelopes, windToward: eventDetail.spread.windToward, windKmh: eventDetail.spread.weatherNow.wind_speed_10m }];
      const first = firstInPath(eventDetail);
      places = (eventDetail.threatened ?? []).filter((p) => p.level !== 'watch' || p.downwind).slice(0, 10).map((p) => (p === first ? { ...p, callout: true } : p));
      setSrc(map, 'event', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [eventDetail.event.lon, eventDetail.event.lat] } }] });
    } else {
      items = risk?.spreads ?? [];
      places = items.flatMap((s) => s.threatened.filter((p) => p.level !== 'watch'));
      setSrc(map, 'event', EMPTY);
    }
    const f = forecastFeatures(items);
    setSrc(map, 'zones', f.zones);
    setSrc(map, 'arrows', f.arrows);
    setSrc(map, 'plumes', f.plumes);
    setSrc(map, 'places', placesToGeoJSON(places));
  }, [ready, risk, eventDetail]);

  // ---------- history: where fires usually burn this month ----------
  useEffect(() => {
    if (!mapOk()) return;
    setSrc(mapRef.current, 'clim', climGrid?.cells ? { type: 'FeatureCollection', features: climGrid.cells.map(([lat, lon, p]) => ({ type: 'Feature', properties: { w: p }, geometry: { type: 'Point', coordinates: [lon, lat] } })) } : EMPTY);
  }, [ready, climGrid]);

  // ---------- AI danger squares, glow and pulsing red-alert markers ----------
  useEffect(() => {
    if (!mapOk()) return;
    const map = mapRef.current;
    markersRef.current.forEach((mk) => mk.remove());
    markersRef.current = [];
    if (mode !== 'ai' || !aiData?.cells) return setSrc(map, 'ai', EMPTY);
    const inView = (iso) => view.level !== 'country' || iso === view.iso;
    const feats = [];
    for (const [lat, lon, p, iso, red] of aiData.cells) {
      if (!inView(iso) || p < 0.2) continue;
      const h = 0.25;
      feats.push({ type: 'Feature', properties: { p, red }, geometry: { type: 'Polygon', coordinates: [[[lon - h, lat - h], [lon + h, lat - h], [lon + h, lat + h], [lon - h, lat + h], [lon - h, lat - h]]] } });
      feats.push({ type: 'Feature', properties: { p, red }, geometry: { type: 'Point', coordinates: [lon, lat] } });
    }
    setSrc(map, 'ai', { type: 'FeatureCollection', features: feats });
    // DOM markers animate with CSS, so they don't force the map to re-render
    // fewer, well-spaced markers at region zoom so they never pile up
    const spacing = view.level === 'country' ? 0.75 : 2.2;
    const byRegion = {};
    for (const a of aiData.alerts.filter((x) => inView(x.iso))) {
      const list = (byRegion[NAM_ISOS.includes(a.iso) ? 'NAM' : 'MENA'] ??= []);
      if (list.length >= (view.level === 'country' ? 25 : 14)) continue;
      if (list.some((b) => Math.abs(b.lat - a.lat) < spacing && Math.abs(b.lon - a.lon) < spacing)) continue;
      list.push(a);
    }
    const shown = Object.values(byRegion).flat();
    for (const a of shown) {
      const el = document.createElement('button');
      el.className = `ai-marker ${a.level.key}`;
      el.innerHTML = `<span class="ai-ring"></span><span class="ai-dot">${Math.round(a.p * 100)}%</span>`;
      el.title = `${a.level.label}: ${Math.round(a.p * 100)}% chance of fire${a.place ? ' near ' + a.place : ''}`;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        cb.current.onAiClick(a.lat, a.lon);
      });
      markersRef.current.push(new maplibregl.Marker({ element: el }).setLngLat([a.lon, a.lat]).addTo(map));
    }
  }, [ready, mode, aiData, view.level, view.iso]);

  useEffect(() => {
    if (!mapOk()) return;
    const h = 0.25;
    const s = aiSelected;
    setSrc(mapRef.current, 'ai-sel', s ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[s.lon - h, s.lat - h], [s.lon + h, s.lat - h], [s.lon + h, s.lat + h], [s.lon - h, s.lat + h], [s.lon - h, s.lat - h]]] } }] } : EMPTY);
  }, [ready, aiSelected]);

  // ---------- wind field for the visible area ----------
  const windOn = mode === 'forecast' || layers.wind;
  useEffect(() => {
    if (!mapOk() || !windOn) return;
    const map = mapRef.current;
    let timer;
    const load = () => {
      const b = map.getBounds();
      const bb = [b.getWest(), Math.max(-80, b.getSouth()), b.getEast(), Math.min(80, b.getNorth())].map((v) => v.toFixed(2)).join(',');
      fetch(`/api/wind?bbox=${bb}`)
        .then((r) => r.json())
        .then((pts) => Array.isArray(pts) && setSrc(map, 'wind', { type: 'FeatureCollection', features: pts.map((p) => ({ type: 'Feature', properties: { speed: p.speed, dir: p.dir }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })) }))
        .catch(() => {});
    };
    const onMove = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 600);
    };
    load();
    map.on('moveend', onMove);
    return () => {
      clearTimeout(timer);
      map.off('moveend', onMove);
    };
  }, [ready, windOn]);

  // ---------- fire impact: time labels on the spread rings + callout for the first place in the path ----------
  useEffect(() => {
    calloutsRef.current.forEach((m) => m.remove());
    calloutsRef.current = [];
    if (!mapOk() || !eventDetail?.spread) return;
    const map = mapRef.current;
    const { lat, lon } = eventDetail.event;
    const k = Math.cos((lat * Math.PI) / 180) ** 2;
    let lastKm = 0;
    for (const env of eventDetail.spread.envelopes) {
      if (env.headKm < 0.5 || env.headKm < lastKm * 1.35) continue;
      lastKm = env.headKm;
      let best = null, bd = -1;
      for (const [x, y] of env.ring) {
        const d = (x - lon) ** 2 * k + (y - lat) ** 2;
        if (d > bd) { bd = d; best = [x, y]; }
      }
      const el = document.createElement('div');
      el.className = 'ring-tag';
      el.textContent = `+${env.hours} h`;
      calloutsRef.current.push(new maplibregl.Marker({ element: el }).setLngLat(best).addTo(map));
    }
    const p = firstInPath(eventDetail);
    if (p) {
      const el = document.createElement('div');
      el.className = `place-callout ${p.level}`;
      const eta = p.etaHours ? `~${Math.round(p.etaHours)} h` : 'in zone';
      el.innerHTML = `<span class="pc-dot"></span><b></b><span class="pc-meta"></span><em>${eta}</em>`;
      el.querySelector('b').textContent = p.name;
      el.querySelector('.pc-meta').textContent = `${p.kind ?? 'town'} · ${fmt(p.distanceKm, 1)} km ${p.direction}`;
      calloutsRef.current.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -12] }).setLngLat([p.lon, p.lat]).addTo(map));
    }
  }, [ready, eventDetail]);

  // ---------- draw a box for the area calendar ----------
  useEffect(() => {
    if (!mapOk() || !drawing) return;
    const map = mapRef.current;
    let start = null;
    let last = null;
    const box = (a, b) => ({ type: 'Polygon', coordinates: [[[a.lng, a.lat], [b.lng, a.lat], [b.lng, b.lat], [a.lng, b.lat], [a.lng, a.lat]]] });
    const down = (e) => {
      start = last = e.lngLat;
      e.preventDefault();
      // the button may be released anywhere, even outside the map
      window.addEventListener('mouseup', up, { once: true });
    };
    const move = (e) => {
      if (!start) return;
      last = e.lngLat;
      setSrc(map, 'area', fc(box(start, last)));
    };
    const up = (ev) => {
      if (!start) return;
      const cr = map.getCanvas().getBoundingClientRect();
      const inside = ev.clientX >= cr.left && ev.clientX <= cr.right && ev.clientY >= cr.top && ev.clientY <= cr.bottom;
      const a = start, b = inside ? map.unproject([ev.clientX - cr.left, ev.clientY - cr.top]) : last;
      start = null;
      if (Math.abs(a.lng - b.lng) < 0.05 || Math.abs(a.lat - b.lat) < 0.05) return setSrc(map, 'area', EMPTY);
      const w = Math.max(-180, Math.min(a.lng, b.lng)), e2 = Math.min(180, Math.max(a.lng, b.lng));
      const s2 = Math.max(-85, Math.min(a.lat, b.lat)), n = Math.min(85, Math.max(a.lat, b.lat));
      const r = (v) => +v.toFixed(3);
      cb.current.onAreaDrawn({ type: 'Polygon', coordinates: [[[r(w), r(s2)], [r(e2), r(s2)], [r(e2), r(n)], [r(w), r(n)], [r(w), r(s2)]]] });
    };
    map.dragPan.disable();
    map.boxZoom?.disable();
    map.getCanvas().style.cursor = 'crosshair';
    map.on('mousedown', down);
    map.on('mousemove', move);
    return () => {
      map.off('mousedown', down);
      map.off('mousemove', move);
      window.removeEventListener('mouseup', up);
      map.dragPan.enable();
      map.boxZoom?.enable();
      map.getCanvas().style.cursor = '';
    };
  }, [ready, drawing]);

  const areaFitted = useRef(null);
  useEffect(() => {
    if (!mapOk() || drawing) return;
    const map = mapRef.current;
    setSrc(map, 'area', area?.geometry ? fc(area.geometry) : EMPTY);
    if (area?.bbox && areaFitted.current !== area.geometry) {
      areaFitted.current = area.geometry;
      map.fitBounds([[area.bbox[0], area.bbox[1]], [area.bbox[2], area.bbox[3]]], { padding: 120, maxZoom: 8, duration: 900 });
    }
  }, [ready, area, drawing]);

  // ---------- drone flight to the other region ----------
  useEffect(() => {
    if (!mapOk() || !travel) return;
    const map = mapRef.current;
    const to = travel.to;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cb.current.onTravelDone(to.id);
      return;
    }
    map.stop();
    const from = map.getCenter().toArray();
    const { points } = greatCircle(from, to.globe, 240);
    const plan = { type: 'Feature', properties: { kind: 'plan' }, geometry: { type: 'LineString', coordinates: points } };
    const z0 = map.getZoom();
    const z1 = layers.globe ? 1.9 : map.cameraForBounds(to.bounds, { padding: PAD })?.zoom ?? 2.5;
    const dip = Math.min(1.3, Math.max(0, Math.min(z0, z1) - 0.9));
    const el = document.createElement('div');
    el.className = 'drone';
    el.innerHTML = `<span class="drone-shadow"></span>${DRONE_SVG}`;
    const marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' }).setLngLat(from).addTo(map);
    // position along the route; f is clamped so a frame can never read outside it
    const at = (f) => {
      const x = Math.min(1, Math.max(0, f)) * (points.length - 1);
      const i = Math.max(0, Math.min(points.length - 2, Math.floor(x)));
      const t = x - i;
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t];
    };
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const T = 5600;
    const t0 = performance.now();
    let raf = 0, landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      cancelAnimationFrame(raf);
      clearTimeout(safety);
      el.classList.add('landed');
      cb.current.onTravelDone(to.id);
    };
    const step = () => {
      // performance.now(), not the frame timestamp: the first frame's timestamp can be earlier than t0
      const t = Math.min(1, Math.max(0, (performance.now() - t0) / T));
      try {
        const f = ease(t);
        const p = at(f);
        marker.setLngLat(p).setRotation(bearingDeg(at(f - 0.01), at(f + 0.01)));
        // the camera trails the drone a little and catches up on arrival; it lifts off mid-way to show the ocean
        map.jumpTo({ center: at(f - 0.04 * Math.sin(Math.PI * t)), zoom: z0 + (z1 - z0) * f - dip * Math.sin(Math.PI * t) });
        const n = Math.floor(f * (points.length - 1));
        setSrc(map, 'flight', { type: 'FeatureCollection', features: [plan, { type: 'Feature', properties: { kind: 'done' }, geometry: { type: 'LineString', coordinates: [...points.slice(0, n + 1), p] } }] });
      } catch (err) {
        console.error('flight frame failed', err);
        return land();
      }
      if (t < 1) raf = requestAnimationFrame(step);
      else land();
    };
    // if frames stop (hidden tab, a failed frame), land anyway shortly after the planned time
    const safety = setTimeout(land, T + 1500);
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(safety);
      const clear = () => { marker.remove(); setSrc(map, 'flight', EMPTY); };
      if (landed) setTimeout(clear, 1100);
      else clear();
    };
  }, [ready, travel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mapOk() && focus) mapRef.current.flyTo({ center: [focus.lon, focus.lat], zoom: focus.zoom ?? 10, duration: 1400 });
  }, [ready, focus]);

  return (
    <>
      <div ref={container} className="map" />
      {view.level === 'country' && (
        <button className="map-back" onClick={onBack}><Icon name="chevronLeft" size={14} />Region view</button>
      )}
    </>
  );
}
