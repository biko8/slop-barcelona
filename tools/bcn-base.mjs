// Shared data loading, coordinate frame and geometry helpers for the Barcelona geodata generator.
// Source: OpenStreetMap (tools/data/bcn_*.json, written by tools/bcn-extract.py from a .osm.pbf).
//
// Frame: 1 unit = 1 m, x = Eixample-grid "east" (along Carrer d'Aragó toward the Besòs), z = grid "south" (down
// Passeig de Gràcia toward the sea), so north = -z is up toward Collserola. Origin at the centre of Plaça de Catalunya;
// the axes are turned to the Cerdà grid's measured bearing (≈ 45° from true north).
//
// Run tools/build-bcn-geodata.mjs to generate js/bcn-geodata.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = process.env.GEO_DATA || fileURLToPath(new URL('data/', import.meta.url));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const log = (...a) => console.log('[geodata]', ...a);

// =====================================================================================================================
// 1. FRAME
// =====================================================================================================================
const LAT0 = 41.38703; // Plaça de Catalunya, centre of the square
const LON0 = 2.17005;
const A = 6378137.0;
const E2 = 6.69437999014e-3;
const PHI0 = (LAT0 * Math.PI) / 180;
const SIN0 = Math.sin(PHI0);
const NRAD = A / Math.sqrt(1 - E2 * SIN0 * SIN0);
const MRAD = (A * (1 - E2)) / Math.pow(1 - E2 * SIN0 * SIN0, 1.5);
const KX = (Math.PI / 180) * NRAD * Math.cos(PHI0);
const KY = (Math.PI / 180) * MRAD;
let THETA = (-44.8 * Math.PI) / 180; // bearing of grid north (up Balmes), refined below from the Eixample streets

const enu = (lon, lat) => [(lon - LON0) * KX, (lat - LAT0) * KY];
function toWorld(lon, lat) {
  const [e, n] = enu(lon, lat);
  const c = Math.cos(THETA);
  const s = Math.sin(THETA);
  return [e * c - n * s, -(e * s + n * c)];
}
function toLonLat(x, z) {
  const c = Math.cos(THETA);
  const s = Math.sin(THETA);
  const e = x * c - z * s;
  const n = -x * s - z * c;
  return [LON0 + e / KX, LAT0 + n / KY];
}

// The detailed city: a grid-aligned rectangle from Sants & Plaça d'Espanya to Poblenou, the lower slopes of Gràcia
// down to the sea (the land inside it, see section 4)
const DETAIL = { x0: -2900, x1: 3500, z0: -2500, z1: 3200 };

// =====================================================================================================================
// 2. GEOMETRY HELPERS
// =====================================================================================================================
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  return { x0, x1, z0, z1 };
}
const centroid = (r) => [r.reduce((t, p) => t + p[0], 0) / r.length, r.reduce((t, p) => t + p[1], 0) / r.length];
function pointInRing(r, x, z) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, az] = r[i];
    const [bx, bz] = r[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}
// Ramer-Douglas-Peucker on an open polyline
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, az] = pts[a];
    const [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dz - (pts[i][1] - az) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
// RDP on a closed ring (split at the two farthest-apart vertices)
function rdpRing(ring, eps) {
  let i0 = 0;
  let far = 0, i1 = 0;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[i0][0], ring[i][1] - ring[i0][1]);
    if (d > far) { far = d; i1 = i; }
  }
  const a = rdp(ring.slice(i0, i1 + 1), eps);
  const b = rdp([...ring.slice(i1), ring[i0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

// ---------------------------------------------------------------------------------------------------------------------
// Raster tools (for cutting piers off the shoreline and merging polygons)
// ---------------------------------------------------------------------------------------------------------------------
class Raster {
  constructor(x0, z0, x1, z1, res) {
    this.res = res;
    this.x0 = Math.floor(x0 / res) * res;
    this.z0 = Math.floor(z0 / res) * res;
    this.w = Math.ceil((x1 - this.x0) / res) + 1;
    this.h = Math.ceil((z1 - this.z0) / res) + 1;
    this.d = new Uint8Array(this.w * this.h);
  }
  // Scanline fill of a ring (even-odd) with `val`
  fillRing(ring, val = 1) {
    const { res, x0, z0, w, h, d } = this;
    const bb = bbox(ring);
    const jy0 = Math.max(0, Math.floor((bb.z0 - z0) / res));
    const jy1 = Math.min(h - 1, Math.ceil((bb.z1 - z0) / res));
    const xs = [];
    for (let j = jy0; j <= jy1; j++) {
      const z = z0 + (j + 0.5) * res;
      xs.length = 0;
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const [xa, za] = ring[k];
        const [xb, zb] = ring[i];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
      xs.sort((p, q) => p - q);
      for (let n = 0; n + 1 < xs.length; n += 2) {
        const i0 = Math.max(0, Math.ceil((xs[n] - x0) / res - 0.5));
        const i1 = Math.min(w - 1, Math.floor((xs[n + 1] - x0) / res - 0.5));
        for (let i = i0; i <= i1; i++) d[j * w + i] = val;
      }
    }
  }
  // Squared Euclidean distance (in cells) from every cell to the nearest cell where mask(v) is true (Felzenszwalb)
  edt(isSource) {
    const { w, h, d } = this;
    const INF = 1e20;
    const f = new Float64Array(Math.max(w, h));
    const out = new Float32Array(w * h);
    const v = new Int32Array(Math.max(w, h));
    const zz = new Float64Array(Math.max(w, h) + 1);
    const dt1 = (n, get, set) => {
      for (let q = 0; q < n; q++) f[q] = get(q);
      let k = 0;
      v[0] = 0;
      zz[0] = -INF;
      zz[1] = INF;
      for (let q = 1; q < n; q++) {
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= zz[k]) {
          k--;
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        zz[k] = s;
        zz[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (zz[k + 1] < q) k++;
        set(q, (q - v[k]) * (q - v[k]) + f[v[k]]);
      }
    };
    for (let i = 0; i < w * h; i++) out[i] = isSource(d[i]) ? 0 : INF;
    for (let i = 0; i < w; i++) dt1(h, (q) => out[q * w + i], (q, val) => (out[q * w + i] = val));
    for (let j = 0; j < h; j++) dt1(w, (q) => out[j * w + q], (q, val) => (out[j * w + q] = val));
    return out;
  }
  // Morphological opening of the 1-cells with a disc of radius r metres
  open(r) {
    const rc = (r / this.res) ** 2;
    const toWater = this.edt((x) => x === 0);
    const eroded = new Uint8Array(this.d.length);
    for (let i = 0; i < eroded.length; i++) eroded[i] = toWater[i] > rc ? 1 : 0;
    const save = this.d;
    this.d = eroded;
    const toEroded = this.edt((x) => x === 1);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = this.d[i] && toEroded[i] <= rc + 1e-6 ? 1 : 0;
  }
  // Morphological closing (fills inlets / gaps narrower than 2r)
  close(r) {
    const rc = (r / this.res) ** 2;
    const toLand = this.edt((x) => x === 1);
    const dil = new Uint8Array(this.d.length);
    for (let i = 0; i < dil.length; i++) dil[i] = toLand[i] <= rc ? 1 : 0;
    const save = this.d;
    this.d = dil;
    const toGap = this.edt((x) => x === 0);
    this.d = save;
    for (let i = 0; i < this.d.length; i++) this.d[i] = dil[i] && toGap[i] > rc ? 1 : 0;
  }
  // Keep only the 4-connected component containing the most cells
  keepLargest() {
    const { w, h, d } = this;
    const lab = new Int32Array(w * h);
    let best = 0, bestN = 0, cur = 0;
    const stack = [];
    for (let s = 0; s < w * h; s++) {
      if (!d[s] || lab[s]) continue;
      cur++;
      let n = 0;
      stack.push(s);
      lab[s] = cur;
      while (stack.length) {
        const p = stack.pop();
        n++;
        const i = p % w, j = (p - i) / w;
        if (i > 0 && d[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack.push(p - 1); }
        if (i < w - 1 && d[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack.push(p + 1); }
        if (j > 0 && d[p - w] && !lab[p - w]) { lab[p - w] = cur; stack.push(p - w); }
        if (j < h - 1 && d[p + w] && !lab[p + w]) { lab[p + w] = cur; stack.push(p + w); }
      }
      if (n > bestN) { bestN = n; best = cur; }
    }
    for (let i = 0; i < w * h; i++) d[i] = lab[i] === best ? 1 : 0;
  }
  // Outer boundary of the (single) region as a ring of cell-corner points (Moore-neighbour style edge walk)
  traceOuter() {
    const { w, h, d, res, x0, z0 } = this;
    const at = (i, j) => (i >= 0 && j >= 0 && i < w && j < h ? d[j * w + i] : 0);
    // Directed boundary edges keep land on the left: start at the first land cell's top edge
    let si = -1, sj = -1;
    outer: for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (at(i, j)) { si = i; sj = j; break outer; }
    // Walk corners: position (cx, cz) in corner coordinates, direction index 0:+x 1:+z 2:-x 3:-z
    const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
    let cx = si, cz = sj, dir = 0; // top edge of cell (si, sj), walking +x with land below (on the right in screen, z down)
    const pts = [];
    const start = `${cx},${cz},${dir}`;
    let guard = 0;
    // For a corner walk with land on the right (z down means right = +z side when walking +x):
    // cells around corner (cx, cz): A=(cx-1,cz-1) B=(cx,cz-1) C=(cx-1,cz) D=(cx,cz)
    do {
      pts.push([x0 + cx * res, z0 + cz * res]);
      cx += DX[dir];
      cz += DZ[dir];
      // Cells ahead-left and ahead-right relative to the walking direction
      const cellAt = (dxl, dzl) => at(cx + dxl, cz + dzl);
      // Determine the cells: for each direction, the two cells in front of the corner
      let left, right;
      if (dir === 0) { left = cellAt(0, -1); right = cellAt(0, 0); }
      else if (dir === 1) { left = cellAt(0, 0); right = cellAt(-1, 0); }
      else if (dir === 2) { left = cellAt(-1, 0); right = cellAt(-1, -1); }
      else { left = cellAt(-1, -1); right = cellAt(0, -1); }
      if (left && right) dir = (dir + 3) % 4; // turn left (land ahead): keep land on the right
      else if (!left && right) { /* straight */ }
      else dir = (dir + 1) % 4; // turn right
      if (++guard > 50000000) throw new Error('trace runaway');
    } while (`${cx},${cz},${dir}` !== start);
    // Merge collinear runs, then take edge midpoints (turns the raster's stairs into 45° runs before simplifying)
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length];
      if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q);
    }
    // (true corners, between two edges longer than 3 cells, are kept: a rectangle's stay square)
    const long = (a, b) => Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]) > 3 * res;
    const res2 = [];
    out.forEach((q, i) => {
      const p = out[(i + out.length - 1) % out.length];
      const n = out[(i + 1) % out.length];
      if (long(p, q) && long(q, n)) res2.push(q);
      res2.push([(q[0] + n[0]) / 2, (q[1] + n[1]) / 2]);
    });
    return res2;
  }
}

// =====================================================================================================================
// 3. FRAME CALIBRATION FROM THE EIXAMPLE
// =====================================================================================================================
const roadsOSM = load('bcn_roads.json').elements;
{
  // Bearing: length-weighted median of the long straight pieces of Cerdà's streets, folded onto one quarter turn
  const CERDA = /^(Carrer d'Aragó|Carrer de València|Carrer de Mallorca|Carrer de Provença|Carrer del Rosselló|Carrer de Còrsega|Carrer del Consell de Cent|Carrer de la Diputació|Carrer de Balmes|Carrer d'Enric Granados|Carrer d'Aribau|Carrer de Muntaner|Carrer de Casanova|Carrer de Villarroel|Carrer de Pau Claris|Carrer de Roger de Llúria|Carrer del Bruc|Carrer de Girona|Carrer de Bailèn|Carrer de Sardenya|Carrer de la Marina)$/;
  const angs = [];
  for (const w of roadsOSM) {
    if (!CERDA.test(w.tags.name || '')) continue;
    const p = w.pts;
    for (let i = 1; i < p.length; i++) {
      const [e0, n0] = enu(...p[i - 1]);
      const [e1, n1] = enu(...p[i]);
      const L = Math.hypot(e1 - e0, n1 - n0);
      if (L < 30) continue;
      let a = (Math.atan2(e1 - e0, n1 - n0) * 180) / Math.PI; // bearing
      a = ((a % 90) + 90) % 90; // folded to [0, 90): the grid's bearings modulo a quarter turn sit near 45°
      angs.push([a, L]);
    }
  }
  angs.sort((p, q) => p[0] - q[0]);
  const tot = angs.reduce((t, a) => t + a[1], 0);
  let acc = 0;
  for (const [a, L] of angs) {
    acc += L;
    if (acc >= tot / 2) {
      // grid north points up Balmes (toward Collserola, north-west)
      THETA = ((a - 90) * Math.PI) / 180;
      break;
    }
  }
  log(`grid north bearing ${((THETA * 180) / Math.PI).toFixed(3)}° (${angs.length} Eixample pieces)`);
}

// =====================================================================================================================
// 4. COASTLINE & LAND (OpenStreetMap natural=coastline: land on the left of each way)
// =====================================================================================================================
function chainCoastline(ways, bb) {
  const key = (p) => `${p[0]},${p[1]}`;
  const byStart = new Map();
  for (const w of ways) byStart.set(key(w[0]), w);
  const used = new Set();
  const chains = [];
  for (const w of ways) {
    if (used.has(w)) continue;
    let first = w;
    const seen = new Set([w]);
    for (;;) {
      const prev = ways.find((u) => !seen.has(u) && !used.has(u) && key(u[u.length - 1]) === key(first[0]));
      if (!prev) break;
      seen.add(prev);
      first = prev;
    }
    const pts = [];
    let cur = first;
    while (cur && !used.has(cur)) {
      used.add(cur);
      pts.push(...(pts.length ? cur.slice(1) : cur));
      cur = byStart.get(key(cur[cur.length - 1]));
    }
    const c = pts.map(([lon, lat]) => toWorld(lon, lat));
    // An open chain whose end lies at the edge of the extract was cut there: carry that end on out of any raster
    // along its last heading
    const cut = ([lon, lat]) => Math.min(lat - bb[0], bb[2] - lat, (lon - bb[1]) * 0.75, (bb[3] - lon) * 0.75) < 0.004;
    if (key(pts[0]) !== key(pts[pts.length - 1]) && c.length > 1) {
      const out = (p, q) => {
        const L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
        return [p[0] + ((p[0] - q[0]) / L) * 40000, p[1] + ((p[1] - q[1]) / L) * 40000];
      };
      if (cut(pts[0])) c.unshift(out(c[0], c[Math.min(5, c.length - 1)]));
      if (cut(pts[pts.length - 1])) c.push(out(c[c.length - 1], c[Math.max(0, c.length - 6)]));
    }
    chains.push(c);
  }
  return chains;
}
const coastOSM = load('bcn_coast.json');
const coastChains = chainCoastline(coastOSM.elements, coastOSM.bbox).sort((a, b) => b.length - a.length);
log(`coastline: ${coastChains.length} chains; longest ${coastChains.slice(0, 5).map((c) => c.length).join(', ')}`);

// Land raster over a box: the coastline drawn as walls, the sea flooded from the cells just right of every coastline
// segment (the sea side), everything the flood can't reach is land
function landRaster(x0, z0, x1, z1, res) {
  const R = new Raster(x0, z0, x1, z1, res);
  const { w, h, d } = R;
  const WALL = 2;
  const cell = (x, z) => [Math.floor((x - R.x0) / res), Math.floor((z - R.z0) / res)];
  const seeds = [];
  for (const c of coastChains) {
    for (let k = 0; k + 1 < c.length; k++) {
      const [ax, az] = c[k];
      const [bx, bz] = c[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / (res * 0.4)));
      for (let s = 0; s <= n; s++) {
        const [i, j] = cell(ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n);
        if (i >= 0 && j >= 0 && i < w && j < h) d[j * w + i] = WALL;
      }
      if (L < 1e-6) continue;
      // right of the direction of travel in (x, z) with z down the map: (dx, dz) -> (-dz, dx) is to the right of a walk
      // seen from above with x east & z south? x = east, z = south: right of heading (dx, dz) is (-dz, dx)
      const rx = -(bz - az) / L;
      const rz = (bx - ax) / L;
      for (const t of [0.25, 0.5, 0.75]) seeds.push(cell(ax + (bx - ax) * t + rx * res * 0.75, az + (bz - az) * t + rz * res * 0.75));
    }
  }
  const SEA = 3;
  const stack = [];
  for (const [i, j] of seeds) {
    if (i < 0 || j < 0 || i >= w || j >= h) continue;
    const k = j * w + i;
    if (d[k] === 0) { d[k] = SEA; stack.push(k); }
  }
  while (stack.length) {
    const p = stack.pop();
    const i = p % w;
    const j = (p - i) / w;
    if (i > 0 && d[p - 1] === 0) { d[p - 1] = SEA; stack.push(p - 1); }
    if (i < w - 1 && d[p + 1] === 0) { d[p + 1] = SEA; stack.push(p + 1); }
    if (j > 0 && d[p - w] === 0) { d[p - w] = SEA; stack.push(p - w); }
    if (j < h - 1 && d[p + w] === 0) { d[p + w] = SEA; stack.push(p + w); }
  }
  for (let k = 0; k < d.length; k++) d[k] = d[k] === SEA ? 0 : 1;
  return R;
}

// The detailed city: the land inside the DETAIL rectangle, opened to drop moles & breakwaters narrower than ~16 m
const RES = 2;
// Sutherland-Hodgman clip of a ring to an axis-aligned rectangle
function clipRingToRect(ring, r) {
  let out = ring;
  for (const [axis, lim, keepBelow] of [[0, r.x0, false], [0, r.x1, true], [1, r.z0, false], [1, r.z1, true]]) {
    const src = out;
    out = [];
    const inside = (p) => (keepBelow ? p[axis] <= lim : p[axis] >= lim);
    for (let i = 0; i < src.length; i++) {
      const a = src[(i + src.length - 1) % src.length];
      const b = src[i];
      if (inside(b) !== inside(a)) {
        const t = (lim - a[axis]) / (b[axis] - a[axis]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
      if (inside(b)) out.push(b);
    }
  }
  return out;
}
// (traced over a margin, then clipped: the rectangle's corners stay square)
const M = 200;
const landR = landRaster(DETAIL.x0 - M, DETAIL.z0 - M, DETAIL.x1 + M, DETAIL.z1 + M, RES);
landR.open(8);
landR.keepLargest();
let land = clipRingToRect(rdpRing(landR.traceOuter(), 1.6), DETAIL);
if (ringArea(land) > 0) land.reverse();
log(`detailed land ring: ${land.length} pts, ${(Math.abs(ringArea(land)) / 1e6).toFixed(2)} km²`);

// The metropolitan land around it (low-detail city out to the fogged horizon): the coast across the whole extract
const EXTRACT = (() => {
  const bb = load('bcn_coast.json').bbox; // [lat0, lon0, lat1, lon1]
  const corners = [[bb[1], bb[0]], [bb[3], bb[0]], [bb[3], bb[2]], [bb[1], bb[2]]].map(([lon, lat]) => toWorld(lon, lat));
  return bbox(corners);
})();
const metroR = landRaster(EXTRACT.x0, EXTRACT.z0, EXTRACT.x1, EXTRACT.z1, 4);
metroR.open(24);
metroR.keepLargest();
const metroLand = rdpRing(metroR.traceOuter(), 6);
if (ringArea(metroLand) > 0) metroLand.reverse();
log(`metropolitan land ring: ${metroLand.length} pts, ${(Math.abs(ringArea(metroLand)) / 1e6).toFixed(1)} km²`);

const geo = { get THETA() { return THETA; }, land, metroLand, coastChains, DETAIL, EXTRACT, LAT0, LON0, KX, KY };
export { geo, toWorld, toLonLat, enu, rdp, rdpRing, ringArea, bbox, centroid, pointInRing, Raster, load, log, roadsOSM, landRaster };
