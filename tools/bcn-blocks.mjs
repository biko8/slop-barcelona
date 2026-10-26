// Barcelona's blocks ("curb islands") from the OpenStreetMap street centrelines: every at-grade roadway is stamped at
// its curb-to-curb width over the land (minus a waterfront strip), Cerdà's chamfered corners (xamfrans) are cut at
// the Eixample's grid crossings, and what's left is labelled. Each block: curb outline polygon, the lot rects inside its
// building line (in the grid frame, or in frontage frames turned to the streets it fronts), park / beach / square
// shares and the heights OpenStreetMap gives its buildings.
import { geo, toWorld, Raster, rdpRing, ringArea, bbox, load, log } from './bcn-base.mjs';
import { ways, chamfers } from './bcn-ways.mjs';

export const STRIP = 14; // waterfront strip kept clear of blocks (promenade, moll edge), metres in from the shore
const RES = 1;
const DEG = Math.PI / 180;

// --- Land: the detailed land eroded by the waterfront strip --------------------------------------------------------------
const D0 = geo.DETAIL;
const R = new Raster(D0.x0, D0.z0, D0.x1, D0.z1, RES);
R.fillRing(geo.land, 1);
{
  const coarse = new Raster(D0.x0, D0.z0, D0.x1, D0.z1, 2);
  coarse.fillRing(geo.land, 1);
  // only the sea counts as shore: the rectangle's own edges are not a waterfront
  for (let i = 0; i < coarse.w; i++) { coarse.d[i] = 2; coarse.d[(coarse.h - 1) * coarse.w + i] = 2; }
  for (let j = 0; j < coarse.h; j++) { coarse.d[j * coarse.w] = 2; coarse.d[j * coarse.w + coarse.w - 1] = 2; }
  const toSea = coarse.edt((v) => v === 0);
  const rc = (STRIP / 2) ** 2;
  for (let j = 0; j < R.h; j++) {
    const cj = Math.min(coarse.h - 1, Math.floor((j * RES) / 2));
    for (let i = 0; i < R.w; i++) {
      const ci = Math.min(coarse.w - 1, Math.floor((i * RES) / 2));
      if (toSea[cj * coarse.w + ci] <= rc) R.d[j * R.w + i] = 0;
    }
  }
}
const W = R.w, H = R.h, D = R.d;
// Buildable (inside the building lines): starts as the land, loses every roadway + its sidewalk
const build = new Uint8Array(D);

function stampCapsule(ax, az, bx, bz, r, target, val = 0) {
  const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - R.x0) / RES));
  const ix1 = Math.min(W - 1, Math.ceil((Math.max(ax, bx) + r - R.x0) / RES));
  const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - r - R.z0) / RES));
  const iz1 = Math.min(H - 1, Math.ceil((Math.max(az, bz) + r - R.z0) / RES));
  if (ix0 > ix1 || iz0 > iz1) return;
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz || 1e-9;
  const r2 = r * r;
  for (let j = iz0; j <= iz1; j++) {
    const pz = R.z0 + (j + 0.5) * RES;
    for (let i = ix0; i <= ix1; i++) {
      const k = j * W + i;
      if (target[k] === val) continue;
      const px = R.x0 + (i + 0.5) * RES;
      let t = ((px - ax) * dx + (pz - az) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px, ez = az + t * dz - pz;
      if (ex * ex + ez * ez <= r2) target[k] = val;
    }
  }
}
function stampDiamond(cx, cz, rad, target) {
  const ix0 = Math.max(0, Math.floor((cx - rad - R.x0) / RES)), ix1 = Math.min(W - 1, Math.ceil((cx + rad - R.x0) / RES));
  const iz0 = Math.max(0, Math.floor((cz - rad - R.z0) / RES)), iz1 = Math.min(H - 1, Math.ceil((cz + rad - R.z0) / RES));
  for (let j = iz0; j <= iz1; j++) {
    const pz = R.z0 + (j + 0.5) * RES;
    for (let i = ix0; i <= ix1; i++) {
      const px = R.x0 + (i + 0.5) * RES;
      if (Math.abs(px - cx) + Math.abs(pz - cz) <= rad) target[j * W + i] = 0;
    }
  }
}
for (const w of ways) {
  for (let i = 1; i < w.pts.length; i++) {
    const [ax, az] = w.pts[i - 1];
    const [bx, bz] = w.pts[i];
    stampCapsule(ax, az, bx, bz, w.r, D);
    stampCapsule(ax, az, bx, bz, w.r + w.sidewalk, build);
  }
}
for (const c of chamfers) {
  stampDiamond(c.x, c.z, c.curb, D);
  stampDiamond(c.x, c.z, c.line, build);
}

// --- Label curb islands (4-connected) --------------------------------------------------------------------------------
const lab = new Int32Array(W * H);
const comps = [];
{
  const stack = new Int32Array(W * H);
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!D[s0] || lab[s0]) continue;
    const id = comps.length + 1;
    let sp = 0, n = 0, i0 = W, i1 = -1, j0 = H, j1 = -1;
    stack[sp++] = s0;
    lab[s0] = id;
    while (sp) {
      const p = stack[--sp];
      n++;
      const i = p % W, j = (p - i) / W;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
      if (i > 0 && D[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (i < W - 1 && D[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (j > 0 && D[p - W] && !lab[p - W]) { lab[p - W] = id; stack[sp++] = p - W; }
      if (j < H - 1 && D[p + W] && !lab[p + W]) { lab[p + W] = id; stack[sp++] = p + W; }
    }
    comps.push({ id, n, i0, i1, j0, j1, start: s0 });
  }
}
log(`${comps.length} curb islands labelled`);

// --- Contour of one component (corner walk keeping the component on the right) ---------------------------------------
function traceComponent(c) {
  const at = (i, j) => (i >= 0 && j >= 0 && i < W && j < H && lab[j * W + i] === c.id ? 1 : 0);
  const si = c.start % W, sj = (c.start - si) / W;
  const DX = [1, 0, -1, 0], DZ = [0, 1, 0, -1];
  let cx = si, cz = sj, dir = 0;
  const pts = [];
  const start = cx + ',' + cz + ',' + dir;
  let guard = 0;
  do {
    pts.push([R.x0 + cx * RES, R.z0 + cz * RES]);
    cx += DX[dir];
    cz += DZ[dir];
    let left, right;
    if (dir === 0) { left = at(cx, cz - 1); right = at(cx, cz); }
    else if (dir === 1) { left = at(cx, cz); right = at(cx - 1, cz); }
    else if (dir === 2) { left = at(cx - 1, cz); right = at(cx - 1, cz - 1); }
    else { left = at(cx - 1, cz - 1); right = at(cx, cz - 1); }
    if (left && right) dir = (dir + 3) % 4;
    else if (!right) dir = (dir + 1) % 4;
    if (++guard > 4e6) break;
  } while (cx + ',' + cz + ',' + dir !== start);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[(i + pts.length - 1) % pts.length], q = pts[i], n = pts[(i + 1) % pts.length];
    if ((q[0] - p[0]) * (n[1] - q[1]) - (q[1] - p[1]) * (n[0] - q[0]) !== 0) out.push(q);
  }
  return destair(out, RES * 1.5);
}

// Raster stairs -> lines: short edges (stair steps) are replaced by their midpoints, vertices between two long edges
// (true corners) are kept
function destair(out, short) {
  const n = out.length;
  const len = (i) => { const a = out[i], b = out[(i + 1) % n]; return Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]); };
  const res = [];
  for (let i = 0; i < n; i++) {
    const prevLong = len((i + n - 1) % n) > short;
    const nextLong = len(i) > short;
    if (prevLong && nextLong) res.push(out[i]);
    if (!nextLong) { const a = out[i], b = out[(i + 1) % n]; res.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); }
  }
  return res;
}

// --- Greedy axis-aligned lot rects in a mask (largest rectangle in a histogram) ----------------------------------------
// On a w x h 0/1 mask (cleared as it goes), up to maxRects rects [i0, i1, j0, j1] (cells, inclusive) of at least
// minSide x minSide cells and 120 cells, until 93% of the mask is covered
function maskRects(m, w, h, maxRects = 8, minSide = 8) {
  let total = 0;
  for (let k = 0; k < w * h; k++) total += m[k];
  const rects = [];
  const hist = new Int32Array(w);
  const stack = new Int32Array(w + 1);
  let covered = 0;
  for (let it = 0; it < maxRects; it++) {
    hist.fill(0);
    let best = 0, bi0 = 0, bi1 = 0, bj0 = 0, bj1 = 0;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) hist[i] = m[j * w + i] ? hist[i] + 1 : 0;
      let sp = 0;
      for (let i = 0; i <= w; i++) {
        const hh = i < w ? hist[i] : 0;
        while (sp && hist[stack[sp - 1]] >= hh) {
          const top = stack[--sp];
          const height = hist[top];
          const left = sp ? stack[sp - 1] + 1 : 0;
          const width = i - left;
          if (height >= minSide && width >= minSide) {
            const area = height * width;
            if (area > best) { best = area; bi0 = left; bi1 = i - 1; bj0 = j - height + 1; bj1 = j; }
          }
        }
        stack[sp++] = i;
      }
    }
    if (best < 120 || (rects.length && best < total * 0.06)) break;
    rects.push([bi0, bi1, bj0, bj1]);
    covered += best;
    for (let j = bj0; j <= bj1; j++) for (let i = bi0; i <= bi1; i++) m[j * w + i] = 0;
    if (covered > total * 0.93) break;
  }
  return rects;
}
function lotRects(c, maxRects = 8) {
  const w = c.i1 - c.i0 + 1, h = c.j1 - c.j0 + 1;
  const m = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = (c.j0 + j) * W + c.i0 + i;
    if (build[k] && lab[k] === c.id) m[j * w + i] = 1;
  }
  const rects = maskRects(m, w, h, maxRects);
  return rects.map(([i0, i1, j0, j1]) => [R.x0 + (c.i0 + i0) * RES, R.x0 + (c.i0 + i1 + 1) * RES, R.z0 + (c.j0 + j0) * RES, R.z0 + (c.j0 + j1 + 1) * RES]);
}

// --- Frontage frames of irregular islands (Ciutat Vella, Gràcia, Sants, the xamfrans...) ---------------------------
// The street directions an island fronts: its outline's edge directions modulo 90°, length-weighted, in up to 3
// clusters ±7° wide. Every island cell joins the cluster of its nearest outline edge; each cluster's cells are then
// re-sampled in a frame turned to its direction and covered with lot rects there (inside the building line), which
// buildings.js fills like a grid block and turns back into place. Returns [[θ, px, pz, rects], ...] with
// world = p + R_y(θ)·(local − p) (three.js rotation about +y), or null for an island fronting the grid alone.
const wrap90 = (a) => ((((a + Math.PI / 4) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) - Math.PI / 4;
function blockFrames(c, poly) {
  const edges = [];
  let per = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    edges.push({ ax, az, bx, bz, L, phi: wrap90(Math.atan2(bz - az, bx - ax)), k: -1 });
    per += L;
  }
  const clusters = [];
  for (let n = 0; n < 3; n++) {
    let seed = null, seedW = 0;
    for (const e of edges) {
      if (e.k >= 0 || e.L < 4) continue;
      let w = 0;
      for (const f of edges) if (f.k < 0 && Math.abs(wrap90(f.phi - e.phi)) <= 7 * DEG) w += f.L;
      if (w > seedW) { seedW = w; seed = e; }
    }
    if (!seed || seedW < 14 || (n > 0 && seedW < per * 0.12)) break;
    const members = edges.filter((f) => f.k < 0 && Math.abs(wrap90(f.phi - seed.phi)) <= 7 * DEG);
    let sx = 0, sy = 0;
    for (const f of members) { sx += f.L * Math.cos(4 * f.phi); sy += f.L * Math.sin(4 * f.phi); }
    for (const f of members) f.k = clusters.length;
    clusters.push({ phi: Math.atan2(sy, sx) / 4 });
  }
  if (!clusters.length || (clusters.length === 1 && Math.abs(clusters[0].phi) < 2 * DEG)) return null;
  for (const e of edges) {
    if (e.k >= 0) continue;
    let bd = Infinity;
    clusters.forEach((cl, k) => { const d = Math.abs(wrap90(e.phi - cl.phi)); if (d < bd) { bd = d; e.k = k; } });
  }

  // Island cells -> cluster of the nearest outline edge
  const w = c.i1 - c.i0 + 1, h = c.j1 - c.j0 + 1;
  const owner = new Int8Array(w * h).fill(-1);
  for (let j = 0; j < h; j++) {
    const pz = R.z0 + (c.j0 + j + 0.5) * RES;
    for (let i = 0; i < w; i++) {
      if (lab[(c.j0 + j) * W + c.i0 + i] !== c.id) continue;
      if (clusters.length === 1) { owner[j * w + i] = 0; continue; }
      const px = R.x0 + (c.i0 + i + 0.5) * RES;
      let bd = Infinity, bk = 0;
      for (const e of edges) {
        const dx = e.bx - e.ax, dz = e.bz - e.az;
        let t = ((px - e.ax) * dx + (pz - e.az) * dz) / (e.L * e.L);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = e.ax + t * dx - px, ez = e.az + t * dz - pz;
        const d = ex * ex + ez * ez;
        if (d < bd) { bd = d; bk = e.k; }
      }
      owner[j * w + i] = bk;
    }
  }

  const px = R.x0 + ((c.i0 + c.i1 + 1) * RES) / 2;
  const pz = R.z0 + ((c.j0 + c.j1 + 1) * RES) / 2;
  // Each cluster's frame: the island re-sampled turned to the cluster's direction, its building line (`prop`, from the
  // buildable raster) and its own region (`reg`)
  const views = clusters.map((cl, k) => {
    const th = -cl.phi; // local +x (u) runs along the cluster's edges
    const cs = Math.cos(th), sn = Math.sin(th);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of [[c.i0, c.j0], [c.i1 + 1, c.j0], [c.i0, c.j1 + 1], [c.i1 + 1, c.j1 + 1]]) {
      const dx = R.x0 + x * RES - px, dz = R.z0 + z * RES - pz;
      const u = px + dx * cs - dz * sn, v = pz + dx * sn + dz * cs; // R_y(-θ)
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    u0 = Math.floor(u0); v0 = Math.floor(v0);
    const lw = Math.ceil(u1 - u0) + 1, lh = Math.ceil(v1 - v0) + 1;
    const prop = new Uint8Array(lw * lh);
    const reg = new Uint8Array(lw * lh);
    const cell = new Int32Array(lw * lh).fill(-1);
    for (let j = 0; j < lh; j++) {
      const dv = v0 + j + 0.5 - pz;
      for (let i = 0; i < lw; i++) {
        const du = u0 + i + 0.5 - px;
        const x = px + du * cs + dv * sn, z = pz - du * sn + dv * cs; // R_y(θ)
        const gi = Math.floor((x - R.x0) / RES) - c.i0, gj = Math.floor((z - R.z0) / RES) - c.j0;
        if (gi < 0 || gj < 0 || gi >= w || gj >= h) continue;
        const o = owner[gj * w + gi];
        if (o < 0) continue;
        cell[j * lw + i] = gj * w + gi;
        if (build[(c.j0 + gj) * W + c.i0 + gi]) prop[j * lw + i] = 1;
        if (o === k) reg[j * lw + i] = 1;
      }
    }
    return { th, u0, v0, lw, lh, prop, reg, cell, rects: [] };
  });
  // Pass 1: each cluster's lots inside its own region. Pass 2: corner wedges & seams no region's lots reached, from
  // any frame. Island cells under a lot, grown by a cell, can't be built on twice.
  const used = new Uint8Array(w * h);
  const markUsed = (k) => {
    const gi = k % w, gj = (k - gi) / w;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = gi + di, j = gj + dj;
      if (i >= 0 && j >= 0 && i < w && j < h) used[j * w + i] = 1;
    }
  };
  for (const pass of [1, 2]) {
    for (const vw of views) {
      const { lw, lh, prop, reg, cell } = vw;
      const m = new Uint8Array(lw * lh);
      for (let k = 0; k < lw * lh; k++) m[k] = prop[k] && (pass === 2 || reg[k]) && cell[k] >= 0 && !used[cell[k]] ? 1 : 0;
      const rects = maskRects(m, lw, lh, pass === 1 ? 6 : 4, 10);
      for (const [i0, i1, j0, j1] of rects) {
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (cell[j * lw + i] >= 0) markUsed(cell[j * lw + i]);
        vw.rects.push([vw.u0 + i0, vw.u0 + i1 + 1, vw.v0 + j0, vw.v0 + j1 + 1]);
      }
    }
  }
  const frames = views.filter((vw) => vw.rects.length).map((vw) => [vw.th, px, pz, vw.rects]);
  return frames.length ? frames : null;
}

// --- Illes: the Eixample's chamfered blocks ------------------------------------------------------------------------------
// A curb island with four 45° chamfer faces (the xamfrans) and four sides along the grid is one of Cerdà's illes:
// [x0, x1, z0, z1, c], its building line's square (the buildable cells' bounds) and the chamfer's legs on it. The
// buildings.js illa layout rings it with apartment houses round a courtyard, a house facing each chamfer.
const XAMFRA = 14.1;
function illaOf(c) {
  // the island's building line: a square-ish area along the grid whose four corners are cut (a cell just inside each
  // corner of its bounds is off it) while its sides run straight up to the cuts
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (let j = c.j0; j <= c.j1; j++) {
    for (let i = c.i0; i <= c.i1; i++) {
      const k = j * W + i;
      if (lab[k] !== c.id || !build[k]) continue;
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
      if (j < j0) j0 = j;
      if (j > j1) j1 = j;
    }
  }
  const bw = (i1 - i0 + 1) * RES, bd = (j1 - j0 + 1) * RES;
  if (!(bw >= 55 && bd >= 55 && bw <= 140 && bd <= 140)) return null;
  const on = (i, j) => lab[j * W + i] === c.id && build[j * W + i] === 1;
  const m = Math.round(3 / RES), far = Math.round(30 / RES), side = Math.round(3 / RES);
  for (const [ci, cj, si, sj] of [[i0, j0, 1, 1], [i1, j0, -1, 1], [i0, j1, 1, -1], [i1, j1, -1, -1]]) {
    if (on(ci + si * m, cj + sj * m)) return null;
    if (!on(ci + si * side, cj + sj * far) || !on(ci + si * far, cj + sj * side)) return null;
  }
  return [R.x0 + i0 * RES, R.x0 + (i1 + 1) * RES, R.z0 + j0 * RES, R.z0 + (j1 + 1) * RES, XAMFRA];
}

// --- Land cover: parks, beaches & squares, rasterised at 2 m and counted per island ------------------------------------
const COVER = { park: 1, beach: 2, square: 3 };
const GREEN = new Set(['park', 'garden', 'grass', 'forest', 'wood', 'meadow', 'village_green', 'recreation_ground', 'scrub', 'heath', 'grassland', 'cemetery']);
const cover = new Raster(D0.x0, D0.z0, D0.x1, D0.z1, 2);
const named = []; // [cover raster value -> name] for the largest named areas
const nameRaster = new Int32Array(cover.w * cover.h);
const areas = load('bcn_areas.json').elements;
{
  const kindOf = (k) => (GREEN.has(k) ? 'park' : k === 'beach' || k === 'sand' ? 'beach' : k === 'square' ? 'square' : null);
  // big areas first so smaller ones (a garden in a park, a square's lawn) paint over them
  const list = areas.filter((a) => a.ring && kindOf(a.kind)).map((a) => ({ ...a, w: a.ring.map(([lon, lat]) => toWorld(lon, lat)), cover: kindOf(a.kind) }));
  for (const a of list) a.area = Math.abs(ringArea(a.w));
  list.sort((p, q) => q.area - p.area);
  const tmp = new Raster(D0.x0, D0.z0, D0.x1, D0.z1, 2);
  for (const a of list) {
    if (a.cover === 'park' && a.area < 150) continue;
    tmp.fillRing(a.w, 1);
    for (const hole of a.holes || []) tmp.fillRing(hole.map(([lon, lat]) => toWorld(lon, lat)), 0);
    const id = a.name ? named.push(a.name) : 0;
    // only the ring's bounding box: copy its cells over and clear them again
    const bb = bbox(a.w);
    const i0 = Math.max(0, Math.floor((bb.x0 - tmp.x0) / 2)), i1 = Math.min(tmp.w - 1, Math.ceil((bb.x1 - tmp.x0) / 2));
    const j0 = Math.max(0, Math.floor((bb.z0 - tmp.z0) / 2)), j1 = Math.min(tmp.h - 1, Math.ceil((bb.z1 - tmp.z0) / 2));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * tmp.w + i;
        if (!tmp.d[k]) continue;
        tmp.d[k] = 0;
        cover.d[k] = COVER[a.cover];
        if (id) nameRaster[k] = id;
      }
    }
  }
}

// Parks, beaches & squares are open ground: no lot reaches into them
for (let j = 0; j < H; j++) {
  const cj = Math.floor((j * RES) / 2) * cover.w;
  for (let i = 0; i < W; i++) {
    if (build[j * W + i] && cover.d[cj + Math.floor((i * RES) / 2)]) build[j * W + i] = 0;
  }
}

// --- Building heights from OpenStreetMap (levels, height) per island -----------------------------------------------------
const heights = new Map(); // island id -> [[levels, area], ...]
for (const [lon, lat, area, levels, height] of load('bcn_buildings.json').elements) {
  const lv = levels || (height ? height / 3.2 : null);
  if (!lv || lv > 60) continue;
  const [x, z] = toWorld(lon, lat);
  const i = Math.floor((x - R.x0) / RES), j = Math.floor((z - R.z0) / RES);
  if (i < 0 || j < 0 || i >= W || j >= H) continue;
  let id = lab[j * W + i];
  if (!id) {
    // a footprint centroid in a courtyard or on the building line's edge: look a few metres around
    for (const [di, dj] of [[4, 0], [-4, 0], [0, 4], [0, -4], [8, 0], [-8, 0], [0, 8], [0, -8]]) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < W && jj < H && lab[jj * W + ii]) { id = lab[jj * W + ii]; break; }
    }
  }
  if (!id) continue;
  if (!heights.has(id)) heights.set(id, []);
  heights.get(id).push([lv, area]);
}
// Area-weighted median & the 95th percentile of an island's storeys
function storeys(list) {
  if (!list || !list.length) return [0, 0];
  const s = list.slice().sort((a, b) => a[0] - b[0]);
  const tot = s.reduce((t, e) => t + e[1], 0);
  let acc = 0, med = s[0][0], p95 = s[s.length - 1][0];
  for (const [lv, a] of s) { acc += a; if (acc >= tot * 0.5) { med = lv; break; } }
  acc = 0;
  for (const [lv, a] of s) { acc += a; if (acc >= tot * 0.95) { p95 = lv; break; } }
  return [Math.round(med), Math.round(p95)];
}

// --- Assemble blocks ---------------------------------------------------------------------------------------------------
const blocks = [];
let small = 0;
for (const c of comps) {
  const area = c.n * RES * RES;
  if (area < 40) { small++; continue; }
  let poly = traceComponent(c);
  poly = rdpRing(poly, 0.5);
  if (poly.length < 3) continue;
  if (ringArea(poly) > 0) poly.reverse();
  const bw = (c.i1 - c.i0 + 1) * RES, bd = (c.j1 - c.j0 + 1) * RES;
  const rectness = area / (bw * bd);
  // land cover shares & the most common area name over the island
  const counts = [0, 0, 0, 0];
  const names = new Map();
  let n = 0;
  for (let j = c.j0; j <= c.j1; j += 2) {
    for (let i = c.i0; i <= c.i1; i += 2) {
      if (lab[j * W + i] !== c.id) continue;
      n++;
      const k = Math.floor((j * RES) / 2) * cover.w + Math.floor((i * RES) / 2);
      counts[cover.d[k]]++;
      if (nameRaster[k]) names.set(nameRaster[k], (names.get(nameRaster[k]) || 0) + 1);
    }
  }
  let name = '';
  let best = 0;
  for (const [id, cnt] of names) if (cnt > best) { best = cnt; name = named[id - 1]; }
  const share = (v) => (n ? Math.round((counts[v] / n) * 100) / 100 : 0);
  const open = share(1) + share(2) + share(3) > 0.6;
  const illa = open ? null : illaOf(c);
  const rects = area >= 300 && !open && !illa ? lotRects(c) : [];
  const frames = rectness <= 0.985 && area >= 300 && !open && !illa ? blockFrames(c, poly) : null;
  blocks.push({
    poly,
    area: Math.round(area),
    rect: rectness > 0.985,
    rects,
    frames,
    illa,
    park: share(1),
    beach: share(2),
    square: share(3),
    name: best > n * 0.3 ? name : '',
    storeys: storeys(heights.get(c.id))
  });
}
log(`${blocks.length} blocks (${blocks.filter((b) => b.rect).length} rectangular, ${blocks.filter((b) => !b.rects.length).length} without lots); ${small} specks dropped`);
log(`${blocks.filter((b) => b.illa).length} Eixample illes, ${blocks.filter((b) => b.frames).length} irregular blocks with frontage frames; ${blocks.filter((b) => b.park > 0.6).length} parks, ${blocks.filter((b) => b.beach > 0.6).length} beaches, ${blocks.filter((b) => b.square > 0.6).length} squares`);

export { blocks, ways, chamfers, R as blockRaster, lab as blockLabels, build as buildRaster };
