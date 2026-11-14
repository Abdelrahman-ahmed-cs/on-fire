// Is a point on land? Natural Earth 1:50m countries (public domain), used only to tell the
// land of a drawn box that On Fire does not cover from the sea (data/world/land50m.geojson).
import fs from 'node:fs';
import path from 'node:path';

let index = null;
function load() {
  if (index) return index;
  const fc = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../data/world/land50m.geojson'), 'utf8'));
  index = [];
  for (const f of fc.features) {
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const p of polys) {
      let w = 180, s = 90, e = -180, n = -90;
      for (const [x, y] of p[0]) {
        if (x < w) w = x;
        if (x > e) e = x;
        if (y < s) s = y;
        if (y > n) n = y;
      }
      index.push({ bb: [w, s, e, n], rings: p, name: f.properties.name });
    }
  }
  return index;
}

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Name of the country at a point, or null at sea.
export function landAt(lon, lat) {
  for (const p of load()) {
    const [w, s, e, n] = p.bb;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (inRing(p.rings[0], lon, lat) && !p.rings.slice(1).some((h) => inRing(h, lon, lat))) return p.name;
  }
  return null;
}
