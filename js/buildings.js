import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createFireEscapes } from './fire-escapes.js';
import {
  Fn,
  float,
  vec2,
  color,
  uv,
  positionWorld,
  normalWorldGeometry,
  abs,
  fract,
  step,
  smoothstep,
  fwidth,
  max,
  min,
  mix,
  length,
  mx_noise_float,
  mx_worley_noise_float
} from 'three/tsl';
import { ISLAND_BOUNDS, BLOCKS, LANDMARK_SITES } from './city-config.js';
import {
  createPreWarBuildingMaterial,
  createCurtainWallMaterial,
  createFacadeBoxes,
  filteredPulse,
  WALL_KINDS
} from './tsl-materials.js';
import { pavedPlazaRects, parkTreeSites, sidewalkBlocks } from './city-grid.js';

// Building massing follows each block's lots and frontage frames. Footprints combine non-overlapping boxes.
// A spatial quadtree streams cornices, rooftop equipment, fire escapes and storefront details around the player.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spatial 2D quadtree for range queries around the active player/camera position.
 */
class Quadtree {
  constructor(bounds, capacity = 6, maxDepth = 6, depth = 0) {
    this.bounds = bounds; // { minX, maxX, minZ, maxZ }
    this.capacity = capacity;
    this.maxDepth = maxDepth;
    this.depth = depth;
    this.items = [];
    this.divided = false;
    this.nw = null;
    this.ne = null;
    this.sw = null;
    this.se = null;
  }

  containsPoint(x, z) {
    const b = this.bounds;
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
  }

  intersectsCircle(cx, cz, radius) {
    const b = this.bounds;
    const closestX = Math.max(b.minX, Math.min(cx, b.maxX));
    const closestZ = Math.max(b.minZ, Math.min(cz, b.maxZ));
    const dx = cx - closestX;
    const dz = cz - closestZ;
    return (dx * dx + dz * dz) <= (radius * radius);
  }

  subdivide() {
    const b = this.bounds;
    const midX = (b.minX + b.maxX) * 0.5;
    const midZ = (b.minZ + b.maxZ) * 0.5;
    const nextDepth = this.depth + 1;

    this.nw = new Quadtree({ minX: b.minX, maxX: midX, minZ: b.minZ, maxZ: midZ }, this.capacity, this.maxDepth, nextDepth);
    this.ne = new Quadtree({ minX: midX, maxX: b.maxX, minZ: b.minZ, maxZ: midZ }, this.capacity, this.maxDepth, nextDepth);
    this.sw = new Quadtree({ minX: b.minX, maxX: midX, minZ: midZ, maxZ: b.maxZ }, this.capacity, this.maxDepth, nextDepth);
    this.se = new Quadtree({ minX: midX, maxX: b.maxX, minZ: midZ, maxZ: b.maxZ }, this.capacity, this.maxDepth, nextDepth);
    this.divided = true;

    for (const item of this.items) {
      this._insertIntoChildren(item);
    }
    this.items.length = 0;
  }

  _insertIntoChildren(item) {
    if (this.nw.containsPoint(item.cx, item.cz)) return this.nw.insert(item);
    if (this.ne.containsPoint(item.cx, item.cz)) return this.ne.insert(item);
    if (this.sw.containsPoint(item.cx, item.cz)) return this.sw.insert(item);
    if (this.se.containsPoint(item.cx, item.cz)) return this.se.insert(item);
    return false;
  }

  insert(item) {
    if (!this.containsPoint(item.cx, item.cz)) return false;

    if (!this.divided) {
      if (this.items.length < this.capacity || this.depth >= this.maxDepth) {
        this.items.push(item);
        return true;
      }
      this.subdivide();
    }
    return this._insertIntoChildren(item);
  }

  queryRange(cx, cz, radius, found = []) {
    if (!this.intersectsCircle(cx, cz, radius)) return found;

    const rSq = radius * radius;
    if (!this.divided) {
      for (let i = 0; i < this.items.length; i++) {
        const item = this.items[i];
        const dx = item.cx - cx;
        const dz = item.cz - cz;
        if (dx * dx + dz * dz <= rSq) {
          found.push(item);
        }
      }
      return found;
    }

    this.nw.queryRange(cx, cz, radius, found);
    this.ne.queryRange(cx, cz, radius, found);
    this.sw.queryRange(cx, cz, radius, found);
    this.se.queryRange(cx, cz, radius, found);
    return found;
  }
}

// ============================================================================
// RECTILINEAR FOOTPRINTS: plans as unions of non-overlapping axis-aligned rects { x0, x1, z0, z1 }
// (x runs west → east, z north → south)
// ============================================================================
const EPS = 0.05;
const rect = (x0, x1, z0, z1) => ({ x0, x1, z0, z1 });
const rectW = (r) => r.x1 - r.x0;
const rectD = (r) => r.z1 - r.z0;
const insetAll = (r, d) => rect(r.x0 + d, r.x1 - d, r.z0 + d, r.z1 - d);

// Length of side `s` of rect r, and the rect's extent perpendicular to it
const sideLen = (r, s) => (s === 'n' || s === 's' ? r.x1 - r.x0 : r.z1 - r.z0);
const sideDepth = (r, s) => (s === 'n' || s === 's' ? r.z1 - r.z0 : r.x1 - r.x0);

/** Rect in the frame of side `s` of r: `a` runs along that side (from its west / north end), `b` inward from it */
function sideRect(r, s, a0, a1, b0, b1) {
  if (s === 'n') return rect(r.x0 + a0, r.x0 + a1, r.z0 + b0, r.z0 + b1);
  if (s === 's') return rect(r.x0 + a0, r.x0 + a1, r.z1 - b1, r.z1 - b0);
  if (s === 'w') return rect(r.x0 + b0, r.x0 + b1, r.z0 + a0, r.z0 + a1);
  return rect(r.x1 - b1, r.x1 - b0, r.z0 + a0, r.z0 + a1);
}

/** Light court `cw` wide and `cd` deep, cut into the middle of side `s` (shifted `off` along it) */
function courtHole(r, s, cw, cd, off = 0) {
  const L = sideLen(r, s);
  return sideRect(r, s, (L - cw) * 0.5 + off, (L + cw) * 0.5 + off, -1, cd);
}

/** Notches nx (along x) by nz (along z) cut from the given corners of r */
function cornerHoles(r, nx, nz, corners = ['nw', 'ne', 'sw', 'se']) {
  return corners.map((c) => {
    const x0 = c[1] === 'w' ? r.x0 - 1 : r.x1 - nx;
    const z0 = c[0] === 'n' ? r.z0 - 1 : r.z1 - nz;
    return rect(x0, x0 + nx + 1, z0, z0 + nz + 1);
  });
}

/**
 * `r` minus `holes`, as non-overlapping rects: sliced into strips across `axis` ('x': strips running north-south,
 * 'z': strips running east-west) at every hole edge, neighbouring strips with identical spans merged back, so a
 * U-plan comes out as its base bar plus two wings. Slice so the street front stays one piece (one window grid).
 */
function carve(r, holes, axis = 'x') {
  const flip = axis === 'z';
  const U0 = flip ? r.z0 : r.x0;
  const U1 = flip ? r.z1 : r.x1;
  const V0 = flip ? r.x0 : r.z0;
  const V1 = flip ? r.x1 : r.z1;
  const hs = holes.map((h) => (flip ? [h.z0, h.z1, h.x0, h.x1] : [h.x0, h.x1, h.z0, h.z1]));
  const cuts = [U0, U1];
  for (const [u0, u1] of hs) {
    if (u0 > U0 + EPS && u0 < U1 - EPS) cuts.push(u0);
    if (u1 > U0 + EPS && u1 < U1 - EPS) cuts.push(u1);
  }
  cuts.sort((a, b) => a - b);

  const out = [];
  let open = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const ua = cuts[i];
    const ub = cuts[i + 1];
    if (ub - ua < EPS) continue;
    const um = (ua + ub) * 0.5;
    let spans = [[V0, V1]];
    for (const [u0, u1, v0, v1] of hs) {
      if (um <= u0 || um >= u1) continue;
      const next = [];
      for (const [a, b] of spans) {
        if (v1 <= a + EPS || v0 >= b - EPS) {
          next.push([a, b]);
          continue;
        }
        if (v0 > a + EPS) next.push([a, v0]);
        if (v1 < b - EPS) next.push([v1, b]);
      }
      spans = next;
    }
    const nextOpen = [];
    for (const [a, b] of spans) {
      let strip = open.find((o) => Math.abs(o[2] - a) < EPS && Math.abs(o[3] - b) < EPS);
      if (strip) {
        strip[1] = ub;
      } else {
        strip = [ua, ub, a, b];
        out.push(strip);
      }
      nextOpen.push(strip);
    }
    open = nextOpen;
  }
  return out.map(([u0, u1, v0, v1]) => (flip ? rect(v0, v1, u0, u1) : rect(u0, u1, v0, v1)));
}

function buildCityBlocks(scene) {
  const group = new THREE.Group();
  group.name = 'CityBlocks';
  const colliders = [];

  // Frame of the lots being populated. Irregular blocks come with frontage frames (city-config.js BLOCKS: lots laid
  // out along the streets they front, in a frame turned by θ about p); the generator works in the frame as on a grid
  // block, and everything it emits is turned into place (placeInFrame), so buildings line up with their street.
  let xf = null; // { th, cs, sn, px, pz }
  let minLot = 15; // smallest lot side built on (frontage frames come in lots of 10 m and up, see bcn-blocks.mjs)
  const toWorld = (x, z) => (xf
    ? [xf.px + (x - xf.px) * xf.cs + (z - xf.pz) * xf.sn, xf.pz - (x - xf.px) * xf.sn + (z - xf.pz) * xf.cs]
    : [x, z]);
  // Player collider over the rect [x0, x1] x [z0, z1] (of the current frame): an oriented box inside its world AABB
  function pushCollider(x0, x1, z0, z1, minY, maxY) {
    if (!xf) {
      colliders.push({ minX: x0, maxX: x1, minZ: z0, maxZ: z1, minY, maxY });
      return;
    }
    const [cx, cz] = toWorld((x0 + x1) * 0.5, (z0 + z1) * 0.5);
    const hx = (x1 - x0) * 0.5;
    const hz = (z1 - z0) * 0.5;
    const ex = Math.abs(xf.cs) * hx + Math.abs(xf.sn) * hz;
    const ez = Math.abs(xf.sn) * hx + Math.abs(xf.cs) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY, maxY, obb: { cx, cz, hx, hz, cs: xf.cs, sn: xf.sn } });
  }

  // Re-seeded from each block's position (see populateBlock), so every block is reproducible on its own
  let rand = mulberry32(10019);
  const range = (a, b) => a + (b - a) * rand();
  const irange = (a, b) => a + Math.floor(rand() * (b - a + 1));
  const chance = (p) => rand() < p;
  const pick = (items) => items[Math.floor(rand() * items.length)];
  // Weighted pick from [[value, weight], ...]
  function pickW(table) {
    let total = 0;
    for (const e of table) total += e[1];
    let r = rand() * total;
    for (const e of table) {
      r -= e[1];
      if (r < 0) return e[0];
    }
    return table[table.length - 1][0];
  }

  // Spatial Quadtree covering the whole detailed city
  const quadtree = new Quadtree({
    minX: ISLAND_BOUNDS.minX - 50,
    maxX: ISLAND_BOUNDS.maxX + 50,
    minZ: ISLAND_BOUNDS.minZ - 50,
    maxZ: ISLAND_BOUNDS.maxZ + 50
  }, 6, 9);
  const allBlocks = [];

  const facades = [
    // 0: Eixample stone & cream stucco (tall balcony doors, a storey ~3.5 m)
    [createPreWarBuildingMaterial, {
      stoneColor: 0xd7c6a3,
      trimColor: 0xa8946f,
      windowGlassColor: 0x1a2430,
      windowWidth: 2.4,
      floorHeight: 3.5,
      windowRatioX: 0.42,
      windowRatioY: 0.68,
      litProbability: 0.5,
      warmth: 0.84,
      stucco: 1,
      seed: 12.4
    }],
    // 1: Ochre & terracotta stucco (Gràcia, Sants, the Eixample's plainer houses)
    [createPreWarBuildingMaterial, {
      stoneColor: 0xc8925f,
      trimColor: 0xe4d4b4,
      windowGlassColor: 0x17212b,
      windowWidth: 2.3,
      floorHeight: 3.3,
      windowRatioX: 0.42,
      windowRatioY: 0.66,
      litProbability: 0.56,
      warmth: 0.88,
      stucco: 1,
      seed: 27.8
    }],
    // 2: Weathered old-town render & Poblenou's factory brick
    [createPreWarBuildingMaterial, {
      stoneColor: 0x9c7458,
      trimColor: 0xcdb898,
      windowGlassColor: 0x151e26,
      windowWidth: 2.0,
      floorHeight: 3.2,
      windowRatioX: 0.4,
      windowRatioY: 0.64,
      litProbability: 0.6,
      warmth: 0.9,
      stucco: 0.6,
      seed: 41.2
    }],
    // 3: Blue-teal curtain-wall glass (Diagonal's office towers, 22@)
    [createCurtainWallMaterial, {
      glassTint: 0x1a3a52,
      frameTint: 0x3b4c5b,
      windowWidth: 2.7,
      floorHeight: 3.9,
      litProbability: 0.60,
      warmth: 0.52,
      reflectivity: 0.92,
      seed: 63.5
    }],
    // 4: Dark bronze / charcoal glass (Diagonal Mar, Plaça d'Europa)
    [createCurtainWallMaterial, {
      glassTint: 0x242220,
      frameTint: 0x3c3631,
      windowWidth: 2.5,
      floorHeight: 3.8,
      litProbability: 0.64,
      warmth: 0.72,
      reflectivity: 0.88,
      seed: 81.9
    }],
    // 5: Silver / ice-blue contemporary glass (the Vila Olímpica's towers, Glòries)
    [createCurtainWallMaterial, {
      glassTint: 0x264664,
      frameTint: 0xb0bcc8,
      windowWidth: 2.9,
      floorHeight: 4.1,
      litProbability: 0.58,
      warmth: 0.48,
      reflectivity: 0.95,
      seed: 94.3
    }]
  ];
  const materials = facades.map(([create, opts]) => create({ ...opts, boxLocal: true }));
  // Storey height of each facade: buildings are massed in whole storeys so every window row lines up across tiers
  const storeys = facades.map(([, opts]) => opts.floorHeight);

  const buckets = materials.map(() => []);

  // ============================================================================
  // BUILDING MASSING TOOLKIT
  // A building is a list of non-overlapping parts { x0, x1, z0, z1, y0, y1 } on one lot: footprints carved into
  // plans, extruded storey by storey, tiers stacked on whole storeys
  // ============================================================================
  function building(blk, mat, lot) {
    return {
      mat,
      lot,
      parts: [],
      // Lot sides facing a street; the others are party walls / rear lot lines shared with neighbours
      street: {
        n: lot.z0 - blk.minZ < EPS,
        s: blk.maxZ - lot.z1 < EPS,
        w: lot.x0 - blk.minX < EPS,
        e: blk.maxX - lot.x1 < EPS
      }
    };
  }

  // Extrude footprint `rects` from storey f0 up to storey f1
  function mass(b, rects, f0, f1) {
    if (f1 <= f0) return;
    const s = storeys[b.mat];
    for (const r of rects) {
      if (r.x1 - r.x0 < 0.5 || r.z1 - r.z0 < 0.5) continue;
      b.parts.push({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y0: f0 * s, y1: f1 * s });
    }
  }

  // `r` pulled back `d` from the lot's street sides (and `party` from its party walls): zoning setbacks
  function streetInset(b, r, d, party = 0) {
    const s = b.street;
    return rect(r.x0 + (s.w ? d : party), r.x1 - (s.e ? d : party), r.z0 + (s.n ? d : party), r.z1 - (s.s ? d : party));
  }

  // Storeys `f` capped so a tower rises at most ~7x as tall as its lot is narrow (no needles on the small lots of
  // Ciutat Vella's irregular blocks)
  const slender = (f, lot, mat) => Math.min(f, Math.max(6, Math.floor((Math.min(rectW(lot), rectD(lot)) * 7) / storeys[mat])));

  // How far part p's cornice reaches past its `side` wall: `oh` out into open air, flush against parts of the same
  // building rising past it, tucked just inside party walls (a neighbour's own ledge may run at the same height)
  function corniceReach(b, p, side, oh) {
    const alongX = side === 'n' || side === 's';
    const c = side === 'n' ? p.z0 : side === 's' ? p.z1 : side === 'w' ? p.x0 : p.x1;
    const edge = side === 'n' ? b.lot.z0 : side === 's' ? b.lot.z1 : side === 'w' ? b.lot.x0 : b.lot.x1;
    if (Math.abs(c - edge) < EPS && !b.street[side]) return -0.03;
    for (const q of b.parts) {
      if (q === p || q.y1 < p.y1 - EPS || q.y0 > p.y1 - EPS) continue;
      const qc = side === 'n' ? q.z1 : side === 's' ? q.z0 : side === 'w' ? q.x1 : q.x0;
      if (Math.abs(qc - c) > EPS) continue;
      if (alongX ? (q.x0 < p.x1 - EPS && q.x1 > p.x0 + EPS) : (q.z0 < p.z1 - EPS && q.z1 > p.z0 + EPS)) return 0;
    }
    return oh;
  }

  // The spans of [a0, a1] left after removing the `cuts` ([c0, c1] pairs)
  function spanMinus(a0, a1, cuts) {
    let spans = [[a0, a1]];
    for (const [c0, c1] of cuts) {
      const next = [];
      for (const [s0, s1] of spans) {
        if (c1 <= s0 + EPS || c0 >= s1 - EPS) {
          next.push([s0, s1]);
          continue;
        }
        if (c0 > s0 + EPS) next.push([s0, c0]);
        if (c1 < s1 - EPS) next.push([c1, s1]);
      }
      spans = next;
    }
    return spans;
  }
  const spanLen = (spans) => spans.reduce((t, [s0, s1]) => t + s1 - s0, 0);

  // What part p's `side` wall looks out on: the spans of it not hidden by parts of the same building built flush
  // against it, and how much of those the building's own wings screen across a court or light well
  function wallView(b, p, side) {
    const alongX = side === 'n' || side === 's';
    const c = side === 'n' ? p.z0 : side === 's' ? p.z1 : side === 'w' ? p.x0 : p.x1;
    const flush = [];
    const across = [];
    for (const q of b.parts) {
      if (q === p || q.y1 < p.y0 + EPS || q.y0 > p.y1 - EPS) continue;
      const qc = side === 'n' ? q.z1 : side === 's' ? q.z0 : side === 'w' ? q.x1 : q.x0;
      const gap = side === 'n' || side === 'w' ? c - qc : qc - c;
      if (gap < -EPS) continue; // beside or behind the wall
      (gap < EPS ? flush : across).push(alongX ? [q.x0, q.x1] : [q.z0, q.z1]);
    }
    const visible = spanMinus(alongX ? p.x0 : p.z0, alongX ? p.x1 : p.z1, flush);
    const open = visible.flatMap(([s0, s1]) => spanMinus(s0, s1, across));
    return { visible, screened: spanLen(visible) - spanLen(open) };
  }

  // Facade treatment of each wall of part p, in createFacadeBoxes `faces` order (w, e, n, s). Street fronts (the lot
  // fronts a street there and the building's own wings don't screen most of the wall) get storefronts (`shops[side]`)
  // or a residential entrance, and so do the side walls of courts open to the street; walls on the lot lines shared
  // with neighbours stay windowless; the rest are rear yard, court & air-shaft walls. A `freestanding` building
  // (towers in the park) fronts every way; `o.walls` forces one WALL_KINDS everywhere.
  function wallKinds(b, p, shops, o) {
    if (o.walls !== undefined) return [o.walls, o.walls, o.walls, o.walls];
    const front = (side) => (shops[side] ? WALL_KINDS.shop : WALL_KINDS.entry);
    return ['w', 'e', 'n', 's'].map((side) => {
      if (o.freestanding) return front(side);
      const { visible, screened } = wallView(b, p, side);
      if (b.street[side] && screened < spanLen(visible) * 0.5) return front(side);
      const c = side === 'w' ? p.x0 : side === 'e' ? p.x1 : side === 'n' ? p.z0 : p.z1;
      const edge = side === 'w' ? b.lot.x0 : side === 'e' ? b.lot.x1 : side === 'n' ? b.lot.z0 : b.lot.z1;
      if (!b.street[side] && Math.abs(c - edge) < EPS) return WALL_KINDS.lotLine;
      // A court wall reaching the street line belongs to a court open to the street
      const alongX = side === 'n' || side === 's';
      const [e0, e1, s0, s1] = alongX ? [b.lot.x0, b.lot.x1, b.street.w, b.street.e] : [b.lot.z0, b.lot.z1, b.street.n, b.street.s];
      const onStreet = visible.some(([a, z]) => (s0 && a - e0 < EPS) || (s1 && e1 - z < EPS));
      return screened > EPS && onStreet ? WALL_KINDS.entry : WALL_KINDS.rear;
    });
  }

  // Ground-floor frontage on an avenue: storefront awnings (if it has shops), remembered for scaffolding sheds
  function avenueFront(blk, side, z0, z1, shops = true) {
    blk.avenueFronts[side].push([z0, z1]);
    const len = z1 - z0;
    const n = Math.max(1, Math.round(len / 12));
    const seg = len / n;
    if (seg < 4.5) return;
    for (let k = 0; k < n; k++) {
      if (!chance(0.62)) continue;
      const colorIdx = irange(0, 4);
      if (!shops) continue;
      blk.awnings.push({
        x: side === 'w' ? blk.minX - 0.9 : blk.maxX + 0.9,
        y: 3.8,
        z: z0 + seg * (k + 0.5),
        w: 1.8,
        d: Math.min(8.5, seg - 1.6),
        sideDir: side === 'w' ? -1 : 1,
        colorIdx
      });
    }
  }

  /**
   * Emits building `b`: facade boxes, map footprints, colliders matching each part, stone cornices
   * under every masonry roof line, rooftop bulkhead & water tower, fire escapes and avenue storefront awnings.
   * o: { cornice, corniceH, roof: 'mech' | 'prewar' | 'walkup' | 'none', wtP, hvacH, fireEscapes, rearFireEscapes,
   *      awnings, shops: 'all' | 'avenue' | 'none' | probability of 'all' (street fronts with storefronts on the
   *      ground floor, the others get a residential entrance), freestanding, walls (see wallKinds) }
   */
  function commit(blk, b, o = {}) {
    const parts = b.parts;
    if (!parts.length) return;
    const mat = b.mat;
    const storey = storeys[mat];
    const tone = rand();
    let shopsOn = o.shops ?? 'all';
    if (typeof shopsOn === 'number') shopsOn = tone < shopsOn ? 'all' : 'none';
    const shops = { w: shopsOn !== 'none', e: shopsOn !== 'none', n: shopsOn === 'all', s: shopsOn === 'all' };
    let top = parts[0];
    for (const p of parts) {
      const w = p.x1 - p.x0;
      const d = p.z1 - p.z0;
      const h = p.y1 - p.y0;
      const box = { x: p.x0 + w * 0.5, y: p.y0 + h * 0.5, z: p.z0 + d * 0.5, w, h, d, faces: wallKinds(b, p, shops, o), tone };
      buckets[mat].push(box);
      blk.facadeBoxes.push(box);
      blk.footprints.push({ x0: p.x0, x1: p.x1, z0: p.z0, z1: p.z1, h: p.y1, tone });
      if (p.y1 > blk.maxH) blk.maxH = p.y1;
      pushCollider(p.x0, p.x1, p.z0, p.z1, p.y0, p.y1);
      if (p.y1 > top.y1 + EPS || (p.y1 > top.y1 - EPS && w * d > rectW(top) * rectD(top))) top = p;
    }

    // 1. Stone cornices & setback ledges
    if (o.cornice ?? mat <= 2) {
      const ch = o.corniceH ?? (mat === 2 ? 0.75 : 0.9);
      for (const p of parts) {
        const x0 = p.x0 - corniceReach(b, p, 'w', 0.6);
        const x1 = p.x1 + corniceReach(b, p, 'e', 0.6);
        const z0 = p.z0 - corniceReach(b, p, 'n', 0.6);
        const z1 = p.z1 + corniceReach(b, p, 's', 0.6);
        blk.cornices.push({ x: (x0 + x1) * 0.5, y: p.y1, z: (z0 + z1) * 0.5, w: x1 - x0, h: ch, d: z1 - z0 });
      }
    }

    // 2. Rooftop gear on the highest roof: water tower on one half, bulkhead / mechanical penthouse on the other
    const roof = o.roof ?? 'mech';
    if (roof !== 'none') {
      const tw = rectW(top);
      const td = rectD(top);
      const halves = tw >= td
        ? [rect(top.x0, top.x0 + tw * 0.5, top.z0, top.z1), rect(top.x0 + tw * 0.5, top.x1, top.z0, top.z1)]
        : [rect(top.x0, top.x1, top.z0, top.z0 + td * 0.5), rect(top.x0, top.x1, top.z0 + td * 0.5, top.z1)];
      if (chance(0.5)) halves.reverse();
      let bulkheadArea = top;
      if (roof !== 'mech' && chance(o.wtP ?? 0.7)) {
        const fits = (r) => rectW(r) >= 4.6 && rectD(r) >= 4.6;
        const spot = fits(halves[0]) ? halves[0] : fits(top) ? top : null;
        if (spot) {
          const jx = rectW(spot) * 0.5 - 2.3;
          const jz = rectD(spot) * 0.5 - 2.3;
          blk.waterTowers.push({
            x: (spot.x0 + spot.x1) * 0.5 + range(-jx, jx),
            y: top.y1,
            z: (spot.z0 + spot.z1) * 0.5 + range(-jz, jz)
          });
          bulkheadArea = spot === top ? null : halves[1];
        }
      }
      if (bulkheadArea) {
        const aw = rectW(bulkheadArea);
        const ad = rectD(bulkheadArea);
        const big = roof === 'mech';
        const hw = Math.min(aw - 1.2, big ? Math.max(3, aw * range(0.4, 0.65)) : range(2.4, 4.2));
        const hd = Math.min(ad - 1.2, big ? Math.max(3, ad * range(0.4, 0.65)) : range(2.4, 4.2));
        if (hw >= 1.8 && hd >= 1.8) {
          const jx = (aw - hw) * 0.5 - 0.6;
          const jz = (ad - hd) * 0.5 - 0.6;
          blk.hvacUnits.push({
            x: (bulkheadArea.x0 + bulkheadArea.x1) * 0.5 + range(-jx, jx),
            y: top.y1,
            z: (bulkheadArea.z0 + bulkheadArea.z1) * 0.5 + range(-jz, jz),
            w: hw,
            h: o.hvacH ?? (big ? range(3.4, 5.8) : range(2.4, 3.2)),
            d: hd
          });
        }
      }
    }

    // 3. Wrought-iron fire escapes on walk-up street fronts (and over the rear yards)
    if (o.fireEscapes) {
      for (const p of parts) {
        if (p.y0 > EPS) continue;
        const nf = Math.round(p.y1 / storey);
        const w = p.x1 - p.x0;
        if (nf < 3 || w < 4.6) continue;
        // A landing per floor from the 2nd up, aligned with this facade's floor spacing.
        const landings = Math.min(nf - 1, 7);
        const h = (landings - 1) * storey + 1;
        for (const side of ['n', 's']) {
          const front = side === 'n' ? p.z0 - blk.minZ < EPS : blk.maxZ - p.z1 < EPS;
          if (!front) {
            const gap = side === 'n' ? p.z0 - b.lot.z0 : b.lot.z1 - p.z1;
            if (!o.rearFireEscapes || gap < 1.2 || corniceReach(b, p, side, 1) <= 0) continue;
          }
          const z = side === 'n' ? p.z0 - 0.55 : p.z1 + 0.55;
          const count = w >= 15 ? 2 : 1;
          for (let k = 0; k < count; k++) {
            blk.fireEscapes.push({
              x: p.x0 + (w * (k + 0.5)) / count, y: storey + 0.1, z, h, storey, landings,
              facing: side === 'n' ? Math.PI : 0
            });
          }
        }
      }
    }

    // 4. Storefront awnings along the avenue frontage (the dice are rolled either way, so the block stays the same)
    if (o.awnings !== false) {
      for (const p of parts) {
        if (p.y0 > EPS) continue;
        if (p.x0 - blk.minX < EPS) avenueFront(blk, 'w', p.z0, p.z1, shops.w);
        if (blk.maxX - p.x1 < EPS) avenueFront(blk, 'e', p.z0, p.z1, shops.e);
      }
    }
  }

  // Corner treatments for tower shafts: notched (re-entrant corners), stepped (double notches), plus (cruciform),
  // L (one corner cut away) or a plain rect
  function shapeHoles(r, shape) {
    const w = rectW(r);
    const d = rectD(r);
    const m = Math.min(w, d);
    if (shape === 'notched') {
      const n = Math.min(range(2, 4), m * 0.22);
      return n >= 1.2 ? cornerHoles(r, n, n) : [];
    }
    if (shape === 'stepped') {
      const a = Math.min(range(3, 4.5), m * 0.26);
      return a >= 2 ? [...cornerHoles(r, a, a * 0.5), ...cornerHoles(r, a * 0.5, a)] : [];
    }
    if (shape === 'plus') return cornerHoles(r, w * range(0.24, 0.3), d * range(0.24, 0.3));
    if (shape === 'L') return cornerHoles(r, w * range(0.35, 0.5), d * range(0.35, 0.5), [pick(['nw', 'ne', 'sw', 'se'])]);
    return [];
  }

  // ============================================================================
  // MID-BLOCK ROW BUILDINGS (lots fronting one side street, `side` = that street; half the block deep)
  // ============================================================================

  // ============================================================================
  // APARTMENT HOUSES (corner lots along an avenue, through-block lots mid-block)
  // ============================================================================

  // Post-war tower on a podium (white / red brick, or glass for the newer condos): shaft pulled back from the
  // streets with notched, stepped or cruciform corners; plain parapet & big mechanical penthouse
  function postwarTower(blk, side, lot, cfg, glass) {
    const L = rectD(lot);
    const W = rectW(lot);
    const mat = glass ? pickW([[3, 3], [5, 3], [4, 1]]) : pickW(cfg.towerMats);
    const b = building(blk, mat, lot);
    const pf = mat >= 3 ? irange(2, 5) : irange(1, 2);
    const f = pf + irange(cfg.tower[0], cfg.tower[1]);
    const plaza = chance(0.3) ? range(3, 6) : 0;
    const podium = sideRect(lot, side, 0, L, plaza, W);
    mass(b, [podium], 0, pf);
    const st = range(1.5, 3.2);
    let shaft = sideRect(lot, side, st, L - st, plaza + range(0, 2.5), W - range(0, 2));
    if (rectW(shaft) < 9 || rectD(shaft) < 9) shaft = podium;
    mass(b, carve(shaft, shapeHoles(shaft, pickW([['notched', 3], ['rect', 2], ['stepped', 1.5], ['plus', 0.8]])), 'x'), pf, f);
    commit(blk, b, { cornice: false, roof: 'mech', shops: 'avenue' });
  }

  // Loft building filling its lot: light well / rear yard, 1916 setbacks on the tall ones
  function loftBuilding(blk, lot, cfg) {
    const b = building(blk, pickW(cfg.mats), lot);
    const W = rectW(lot);
    const D = rectD(lot);
    const through = b.street.n && b.street.s;
    const f = irange(cfg.floors[0], cfg.floors[1]);
    const holes = [];
    if (!through) {
      const rear = b.street.n ? 's' : 'n';
      if (chance(0.45)) holes.push(sideRect(lot, rear, -1, W + 1, -1, D * range(0.1, 0.28)));
      else if (W > 12 && chance(0.4)) holes.push(courtHole(lot, rear, W * range(0.3, 0.45), D * range(0.25, 0.4)));
    } else if (D > 18 && W > 10 && chance(0.45)) {
      const walls = ['w', 'e'].filter((s) => !b.street[s]);
      if (walls.length) {
        const lw = range(3, 5.5);
        holes.push(sideRect(lot, pick(walls), D * 0.5 - lw * 0.5, D * 0.5 + lw * 0.5, -1, Math.min(W * 0.32, range(2.4, 4))));
      }
    }
    const axis = through ? 'x' : 'z';
    const cuts = [f];
    if (f >= cfg.setbackAt && chance(0.75)) {
      cuts.unshift(f - irange(2, Math.min(5, f - 8)));
      if (f >= cfg.setbackAt + 6 && chance(0.6)) cuts.unshift(cuts[0] - irange(3, 6));
    }
    let fl = 0;
    let foot = lot;
    cuts.forEach((c, i) => {
      if (i > 0) foot = streetInset(b, foot, range(2.4, 3.8));
      mass(b, carve(foot, holes, axis), fl, c);
      fl = c;
    });
    commit(blk, b, { roof: 'walkup', wtP: cfg.wtP, fireEscapes: chance(cfg.feP) });
  }

  // Loft block (SoHo, Tribeca, NoHo, Garment District, Chelsea, Flatiron): full lot coverage, corner lofts through to
  // both streets, stretches of independent half-depth lofts back to back between them
  function loftBlock(blk, cfg, x0, x1) {
    const { minZ, maxZ } = blk;
    const halfD = (maxZ - minZ) * 0.5;
    const minW = cfg.lotW[0] * 0.7;
    blk.yards.push(rect(x0 + 2, x1 - 2, minZ + 3, maxZ - 3));
    let x = x0;
    while (x1 - x > 0.5) {
      if (x - blk.minX < EPS || chance(cfg.throughP)) {
        let w = range(cfg.lotW[0], cfg.lotW[1]);
        if (x1 - x - w < minW) w = x1 - x;
        loftBuilding(blk, rect(x, x + w, minZ, maxZ), cfg);
        x += w;
        continue;
      }
      let len = range(18, 40);
      if (x1 - x - len < minW) len = x1 - x;
      for (const side of ['n', 's']) {
        let xx = x;
        while (x + len - xx > 0.5) {
          let w = range(cfg.lotW[0], cfg.lotW[1]);
          if (x + len - xx - w < minW) w = x + len - xx;
          loftBuilding(blk, side === 'n' ? rect(xx, xx + w, minZ, minZ + halfD) : rect(xx, xx + w, maxZ - halfD, maxZ), cfg);
          xx += w;
        }
      }
      x += len;
    }
  }

  // Curtain-wall tower: full-lot podium, shaft set back from the streets and the party walls (further on big lots) with
  // rect / notched / stepped / L corners, often a slimmer crown
  function glassTower(blk, lot, cfg) {
    const b = building(blk, pickW(cfg.glassMats), lot);
    let f = irange(cfg.towerFloors[0], cfg.towerFloors[1]);
    if (chance(0.12)) f += irange(3, 6);
    f = slender(f, lot, b.mat);
    const pf = Math.min(f - 6, irange(2, 8));
    mass(b, [lot], 0, pf);
    // Clear of the party walls, the shaft is glazed all round above its neighbours
    let shaft = streetInset(b, lot, range(1.5, 3.5), rectW(lot) > 44 ? range(2, 6) : 1.5);
    if (rectW(shaft) < 12 || rectD(shaft) < 12) shaft = streetInset(b, lot, 1);
    const holes = shapeHoles(shaft, pickW(cfg.shaftShapes));
    const crown = insetAll(shaft, range(2, 3.5));
    const f1 = chance(0.45) && rectW(crown) >= 8 && rectD(crown) >= 8 ? Math.max(pf + 4, Math.round(f * range(0.68, 0.82))) : f;
    mass(b, carve(shaft, holes, 'x'), pf, f1);
    if (f1 < f) mass(b, carve(crown, shapeHoles(crown, chance(0.5) ? 'notched' : 'rect'), 'x'), f1, f);
    commit(blk, b, { cornice: false, roof: 'mech' });
  }

  // 1916-zoning "wedding cake": a full-lot base, setback tiers pulled back from the streets, then a tower at least
  // ~half the lot wide; a stone cornice on every tier
  function decoTower(blk, lot, cfg) {
    const b = building(blk, pickW(cfg.decoMats), lot);
    const W = rectW(lot);
    const D = rectD(lot);
    const f = slender(irange(cfg.towerFloors[0], cfg.towerFloors[1]), lot, b.mat);
    const tiers = [lot];
    while (tiers.length < 4) {
      const cur = tiers[tiers.length - 1];
      const d = range(2, 3.4);
      const next = tiers.length === 1 ? streetInset(b, cur, d) : insetAll(cur, d);
      if (rectW(next) < Math.max(10, W * 0.45) || rectD(next) < Math.max(9, D * 0.45)) break;
      tiers.push(next);
    }
    let fl = 0;
    tiers.forEach((t, i) => {
      const last = i === tiers.length - 1;
      const left = f - fl;
      const tf = last ? left : Math.max(2, Math.round(left * (i === 0 ? range(0.38, 0.55) : range(0.35, 0.55))));
      mass(b, last && i > 0 && chance(0.45) ? carve(t, shapeHoles(t, 'notched'), 'x') : [t], fl, fl + tf);
      fl += tf;
    });
    commit(blk, b, { roof: 'prewar', wtP: 0.15 });
  }

  // International Style slab behind an open avenue plaza (Seagram / Sixth Avenue style), sometimes a low rear wing
  function slabTower(blk, lot, cfg) {
    const b = building(blk, pickW(cfg.glassMats), lot);
    const W = rectW(lot);
    const f = slender(irange(cfg.towerFloors[0], cfg.towerFloors[1]), lot, b.mat);
    const ps = b.street.w && b.street.e ? pick(['w', 'e']) : b.street.w ? 'w' : b.street.e ? 'e' : null;
    const plaza = ps ? Math.min(range(8, 14), W * 0.35) : 0;
    const zIn = range(1.5, 3);
    // Clear of the party wall as well: glazed on all four sides
    const slab = rect(
      lot.x0 + (ps === 'w' ? plaza : b.street.w ? 0 : 2),
      lot.x1 - (ps === 'e' ? plaza : b.street.e ? 0 : 2),
      lot.z0 + (b.street.n ? zIn : 0),
      lot.z1 - (b.street.s ? zIn : 0)
    );
    if (rectW(slab) > 26 && chance(0.4)) {
      const wing = rectW(slab) * range(0.3, 0.42);
      const behindW = ps !== 'e';
      mass(b, [behindW ? rect(slab.x0, slab.x1 - wing, slab.z0, slab.z1) : rect(slab.x0 + wing, slab.x1, slab.z0, slab.z1)], 0, f);
      mass(b, [behindW ? rect(slab.x1 - wing, slab.x1, lot.z0, lot.z1) : rect(slab.x0, slab.x0 + wing, lot.z0, lot.z1)], 0, irange(3, 6));
    } else {
      mass(b, [slab], 0, f);
    }
    commit(blk, b, { cornice: false, roof: 'mech' });
  }

  // Billionaires' Row: one slender supertall on a podium (kept under ~235m so the landmarks still lead the skyline)
  function slenderTower(blk, lot) {
    const mat = pickW([[5, 3], [3, 2], [0, 1]]);
    const b = building(blk, mat, lot);
    const s = storeys[mat];
    const f = irange(Math.floor(185 / s), Math.floor(235 / s));
    const pf = irange(3, 6);
    mass(b, [lot], 0, pf);
    const shaft = streetInset(b, lot, range(1, 2), 1.5); // clear of the party walls: glazed all round
    const f1 = f - irange(3, 6);
    mass(b, carve(shaft, shapeHoles(shaft, pickW([['notched', 2], ['rect', 2], ['stepped', 1]])), 'x'), pf, f1);
    mass(b, [insetAll(shaft, range(1.8, 2.6))], f1, f);
    commit(blk, b, { cornice: mat <= 2, roof: 'mech' });
  }

  function officeTower(blk, lot, cfg, style) {
    if (style === 'deco') decoTower(blk, lot, cfg);
    else if (style === 'slab') slabTower(blk, lot, cfg);
    else if (style === 'resTower') postwarTower(blk, lot.x0 - blk.minX < EPS ? 'w' : 'e', lot, cfg, false);
    else glassTower(blk, lot, cfg);
  }

  // Office-block filler: older loft / office buildings (light wells on deep lots, 1916 setbacks when tall), modern
  // glass mid-rises, the odd low holdout
  function midrise(blk, lot, cfg) {
    const mat = pickW(cfg.fillMats);
    const glass = mat >= 3;
    const b = building(blk, mat, lot);
    const W = rectW(lot);
    const D = rectD(lot);
    const f = chance(0.15) ? irange(2, 5) : irange(cfg.fillFloors[0], cfg.fillFloors[1]);
    const holes = [];
    if (!glass && D > 18 && W > 11 && chance(0.5)) {
      const walls = ['w', 'e'].filter((s) => !b.street[s]);
      if (walls.length) {
        const lw = range(3, 5);
        holes.push(sideRect(lot, pick(walls), D * 0.5 - lw * 0.5, D * 0.5 + lw * 0.5, -1, Math.min(W * 0.3, range(2.4, 4))));
      }
    }
    const f1 = !glass && f >= 12 && chance(0.7) ? f - irange(2, 4) : f;
    mass(b, carve(lot, holes, 'x'), 0, f1);
    if (f1 < f) mass(b, carve(streetInset(b, lot, range(2.4, 3.8)), holes, 'x'), f1, f);
    commit(blk, b, glass ? { cornice: false, roof: 'mech' } : { roof: 'prewar', wtP: 0.55 });
  }

  function officeFill(blk, a, b, cfg) {
    const { minZ, maxZ } = blk;
    const halfD = (maxZ - minZ) * 0.5;
    let x = a;
    while (b - x > 0.5) {
      let w = range(9, 22);
      if (b - x - w < 7) w = b - x;
      if (w > 18 || chance(0.6)) {
        midrise(blk, rect(x, x + w, minZ, maxZ), cfg);
      } else {
        midrise(blk, rect(x, x + w, minZ, minZ + halfD), cfg);
        midrise(blk, rect(x, x + w, maxZ - halfD, maxZ), cfg);
      }
      x += w;
    }
  }

  // Office block (Midtown, FiDi, Hudson Yards): a pair of towers on the avenue corners, one big tower (or a slab
  // behind a plaza) with older neighbours, or a single full-block tower. Floor plates stay real-sized (towers up to
  // ~62 m, slabs ~72 m along the street) however long the block is: the rest of it fills with older buildings
  function officeBlock(blk, cfg, x0, x1) {
    const { minZ, maxZ } = blk;
    const span = x1 - x0;
    const full = (a, b) => rect(a, b, minZ, maxZ);
    // Floor-plate caps from a position hash (no dice rolled, so blocks under the caps come out as before)
    const cap = (k, lo, hi) => lo + (hi - lo) * (Math.abs(Math.sin(x0 * 12.9898 + minZ * 78.233 + k * 37.719) * 43758.5453) % 1);
    const plan = span < 34 ? 'full' : pickW(cfg.plans);
    if (plan === 'full') {
      officeTower(blk, full(x0, x1), cfg, pickW(cfg.styles));
    } else if (plan === 'slender') {
      const w = Math.min(range(18, 24), span * 0.5);
      let left = range(0, span - w);
      if (left < 8) left = 0;
      else if (span - w - left < 8) left = span - w;
      slenderTower(blk, full(x0 + left, x0 + left + w));
      officeFill(blk, x0, x0 + left, cfg);
      officeFill(blk, x0 + left + w, x1, cfg);
    } else if (plan === 'pair') {
      let wa = Math.min(cap(1, 44, 62), Math.max(18, span * range(0.3, 0.42)));
      let wb = Math.min(cap(2, 44, 62), Math.max(18, span * range(0.3, 0.42)));
      if (span - wa - wb < 9) {
        wa += (span - wa - wb) * 0.5;
        wb = span - wa;
      }
      officeTower(blk, full(x0, x0 + wa), cfg, pickW(cfg.styles));
      officeTower(blk, full(x1 - wb, x1), cfg, pickW(cfg.styles));
      officeFill(blk, x0 + wa, x1 - wb, cfg);
    } else {
      let wm = Math.min(plan === 'plaza' ? cap(3, 58, 72) : cap(3, 46, 62), span * (plan === 'plaza' ? range(0.55, 0.75) : range(0.5, 0.68)));
      if (span - wm < 9) wm = span;
      const atW = chance(0.5);
      officeTower(blk, atW ? full(x0, x0 + wm) : full(x1 - wm, x1), cfg, plan === 'plaza' ? 'slab' : pickW(cfg.styles));
      if (atW) officeFill(blk, x0 + wm, x1, cfg);
      else officeFill(blk, x0, x1 - wm, cfg);
    }
  }

  // ============================================================================
  // BARCELONA HOUSES: the Eixample's illes, the old town's cases, Gràcia's low terraces
  // ============================================================================

  // Apartment house ("casa") on its lot fronting `side`: a street bar k.depth deep with a light well (pati de llums)
  // on a party wall or mid-lot, a flat roof terrace (terrat) with its stair hut, sometimes an attic floor (sobreàtic)
  // set back behind a terrace; shops on the ground floor
  function casa(blk, lot, side, k) {
    const b = building(blk, k.mat, lot);
    const L = sideLen(lot, side);
    const dep = Math.min(sideDepth(lot, side), k.depth);
    const holes = [];
    if (L >= 9 && dep >= 12 && chance(0.7)) {
      const pw = range(2.4, 4);
      const pd = range(3, 5);
      const pb = dep * range(0.35, 0.55);
      const at = irange(0, 2);
      const [a0, a1] = at === 0 ? [-1, pw] : at === 1 ? [(L - pw) * 0.5, (L + pw) * 0.5] : [L - pw, L + 1];
      holes.push(sideRect(lot, side, a0, a1, pb, pb + pd));
    }
    mass(b, carve(sideRect(lot, side, 0, L, 0, dep), holes, side === 'n' || side === 's' ? 'z' : 'x'), 0, k.floors);
    if (k.attic && dep > 9) mass(b, [sideRect(lot, side, 0, L, range(2.5, 3.5), dep - range(0, 3))], k.floors, k.floors + 1);
    commit(blk, b, { roof: 'walkup', wtP: 0, corniceH: 0.6, shops: k.shops ?? 0.75 });
  }

  // Storeys of a house in the block being built: OpenStreetMap's median for the block when it knows, else the profile's
  let blockStoreys = 0;
  const houseFloors = (cfg) => {
    if (blockStoreys >= 2) return Math.max(2, Math.min(cfg.floors[1] + 2, blockStoreys + pick([-1, 0, 0, 0, 1])));
    return irange(cfg.floors[0], cfg.floors[1]);
  };

  // Houses along the street on `side` of `strip` (lots cfg.lotW wide, each as deep as the strip)
  function houses(blk, strip, side, cfg) {
    const along = side === 'n' || side === 's';
    const a1 = along ? strip.x1 : strip.z1;
    let a = along ? strip.x0 : strip.z0;
    while (a1 - a > 0.5) {
      let w = range(cfg.lotW[0], cfg.lotW[1]);
      if (a1 - a - w < cfg.lotW[0] * 0.6) w = a1 - a;
      const lot = along ? rect(a, a + w, strip.z0, strip.z1) : rect(strip.x0, strip.x1, a, a + w);
      casa(blk, lot, side, { mat: pickW(cfg.mats), floors: houseFloors(cfg), depth: sideDepth(lot, side), attic: chance(cfg.atticP), shops: cfg.shops });
      a += w;
    }
  }

  // An illa of the Eixample on its building-line square: apartment houses all round (cfg.depth deep), Cerdà's
  // courtyard left open in the middle, its ground floor often roofed over by one-storey workshops & shops. The
  // chamfered corners stay clear for the houses facing the xamfrans (illaCorner, built in their own frames)
  let illaChamfer = 0;
  function illaBlock(blk, cfg, x0, x1) {
    const { minZ: z0, maxZ: z1 } = blk;
    const c = illaChamfer;
    const dep = Math.min(range(cfg.depth[0], cfg.depth[1]), (Math.min(x1 - x0, z1 - z0) - 12) * 0.5);
    houses(blk, rect(x0 + c, x1 - c, z0, z0 + dep), 'n', cfg);
    houses(blk, rect(x0 + c, x1 - c, z1 - dep, z1), 's', cfg);
    houses(blk, rect(x0, x0 + dep, z0 + dep, z1 - dep), 'w', cfg);
    houses(blk, rect(x1 - dep, x1, z0 + dep, z1 - dep), 'e', cfg);
    const court = rect(x0 + dep, x1 - dep, z0 + dep, z1 - dep);
    blk.yards.push(insetAll(court, -0.5));
    if (chance(cfg.courtP)) {
      const b = building(blk, pickW(cfg.mats), court);
      const garden = insetAll(court, range(7, 14));
      mass(b, rectW(garden) > 10 && rectD(garden) > 10 ? carve(court, [garden], 'x') : [court], 0, 1);
      commit(blk, b, { cornice: false, roof: 'none', shops: 'none', awnings: false, walls: WALL_KINDS.rear });
    }
  }

  // The house facing a xamfrà, in a frame turned to it (its lot's north side on the chamfer): the corner's tallest
  // house, a storey above its neighbours, often crowned by a corner tribune
  function illaCorner(blk, cfg, x0, x1) {
    const lot = rect(x0, x1, blk.minZ, blk.maxZ);
    const b = building(blk, pickW(cfg.mats), lot);
    const f = houseFloors(cfg) + 1;
    mass(b, [lot], 0, f);
    if (chance(0.35)) {
      const t = rect((x0 + x1) * 0.5 - 3.5, (x0 + x1) * 0.5 + 3.5, blk.minZ, blk.minZ + 6);
      mass(b, [t], f, f + irange(1, 2));
    }
    commit(blk, b, { roof: 'walkup', wtP: 0, corniceH: 0.7, shops: 'all' });
  }

  // Old-town block (Gòtic, Raval, Born, Barceloneta, Gràcia...): narrow houses along every street, back to back
  // through the middle, light wells between them
  function cascBlock(blk, cfg, x0, x1) {
    const { minZ: z0, maxZ: z1 } = blk;
    const W = x1 - x0;
    const D = z1 - z0;
    if (W >= D) {
      const half = D <= 26 ? D : D * 0.5;
      houses(blk, rect(x0, x1, z0, z0 + half), 'n', cfg);
      if (half < D) houses(blk, rect(x0, x1, z0 + half, z1), 's', cfg);
    } else {
      const half = W <= 26 ? W : W * 0.5;
      houses(blk, rect(x0, x0 + half, z0, z1), 'w', cfg);
      if (half < W) houses(blk, rect(x0 + half, x1, z0, z1), 'e', cfg);
    }
  }

  const LAYOUTS = {
    loft: loftBlock,
    office: officeBlock,
    illa: illaBlock,
    corner: illaCorner,
    casc: cascBlock
  };

  // ============================================================================
  // NEIGHBOURHOOD PROFILES
  // ============================================================================
  // Eixample: PB + 5-7 + àtic, cream stone & stucco, the odd ochre house
  const ILLA = { kind: 'illa', floors: [6, 8], depth: [20, 25], lotW: [13, 21], mats: [[0, 6], [1, 3], [2, 1]], atticP: 0.45, courtP: 0.6, shops: 0.85 };
  const ILLA_CORNER = { ...ILLA, kind: 'corner' };
  const CASC = { kind: 'casc', floors: [4, 6], lotW: [6, 11], mats: [[2, 5], [1, 4], [0, 2]], atticP: 0.2, shops: 0.7 };
  const BARCELONETA = { ...CASC, floors: [4, 5], lotW: [7, 9], mats: [[1, 5], [2, 3], [0, 2]], shops: 0.5 };
  const GRACIA = { ...CASC, floors: [3, 5], lotW: [6, 10], mats: [[1, 6], [0, 3], [2, 2]], atticP: 0.25, shops: 0.55 };
  const SANTS = { ...CASC, floors: [5, 7], lotW: [8, 15], mats: [[1, 5], [0, 4], [2, 2]], atticP: 0.35, shops: 0.65 };
  const EIXAMPLE_IRREGULAR = { ...CASC, floors: [6, 8], lotW: [12, 19], mats: ILLA.mats, atticP: 0.45, shops: 0.85 };
  // Poblenou: old factories & lofts in brick, 22@'s new offices in glass
  const LOFT = { kind: 'loft', lotW: [12, 28], throughP: 0.55, floors: [3, 7], mats: [[2, 6], [1, 3], [0, 1]], setbackAt: 99, wtP: 0, feP: 0 };
  const OFFICE = {
    kind: 'office',
    plans: [['pair', 3], ['major', 3], ['full', 2], ['plaza', 1.5]],
    styles: [['glass', 6], ['slab', 2]],
    towerFloors: [12, 24],
    glassMats: [[3, 4], [5, 3], [4, 2]],
    decoMats: [[0, 6], [1, 3]],
    fillMats: [[0, 4], [1, 3], [3, 2], [5, 1]],
    fillFloors: [5, 9],
    shaftShapes: [['rect', 4], ['notched', 2], ['L', 1]]
  };
  const OLYMPIC = { ...OFFICE, plans: [['pair', 2], ['major', 2], ['plaza', 2]], styles: [['glass', 3], ['resTower', 2]], towerFloors: [10, 20], fillFloors: [6, 9], tower: [8, 16], towerMats: [[0, 3], [1, 2]] };

  // Profile of a block by its real neighbourhood (city-config.js districtAt)
  function blockProfile(blk, district) {
    if (blk.illa) return blk.illa === 'corner' ? ILLA_CORNER : ILLA;
    switch (district) {
      case 'gotic':
      case 'raval':
      case 'born': return CASC;
      case 'barceloneta': return BARCELONETA;
      case 'gracia':
      case 'sant_gervasi': return GRACIA;
      case 'sants':
      case 'poble_sec':
      case 'sant_antoni':
      case 'montjuic': return SANTS;
      case 'poblenou': return chance(0.3) ? OFFICE : LOFT;
      case 'vila_olimpica': return OLYMPIC;
      case 'glories': return chance(0.4) ? OFFICE : EIXAMPLE_IRREGULAR;
      case 'port': return LOFT;
      default: return EIXAMPLE_IRREGULAR;
    }
  }

  /**
   * Populates a single block with lots and buildings for its neighbourhood and registers its high-detail
   * architectural features (stone cornices, water towers, rooftop bulkheads, fire escapes, awnings, storefront
   * fascia signs, and scaffolding sheds) into the Quadtree.
   */
  function populateBlock(minX, maxX, minZ, maxZ, district = 'eixample', illa = null) {
    const bw = maxX - minX;
    const bd = maxZ - minZ;
    if (bw < minLot || bd < minLot) return;
    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;

    const blockDetail = {
      id: `${district}_${Math.round(cx)}_${Math.round(cz)}`,
      cx,
      cz,
      minX,
      maxX,
      minZ,
      maxZ,
      district,
      illa,
      cornices: [],
      waterTowers: [],
      hvacUnits: [],
      fireEscapes: [],
      awnings: [],
      scaffoldSheds: [],
      footprints: [], // { x0, x1, z0, z1, h, tone } per building part, lowest first (maps; + pts: its world corners when turned)
      yards: [], // rear yards, courts & lawns { x0, x1, z0, z1 } (+ ry: turned about their centre)
      maxH: 0,
      avenueFronts: { w: [], e: [] }, // ground-floor frontage [z0, z1] along each avenue
      facadeBoxes: [] // this block's facade boxes (until it's built)
    };
    const bucketMarks = buckets.map((items) => items.length);
    rand = mulberry32((Math.imul(Math.round(minX * 4), 73856093) ^ Math.imul(Math.round(minZ * 4), 19349663) ^ 10019) >>> 0);

    if (maxX - minX > 0.5) {
      const profile = blockProfile(blockDetail, district);
      LAYOUTS[profile.kind](blockDetail, profile, minX, maxX);
    }
    delete blockDetail.facadeBoxes;

    // Sidewalk scaffolding shed along a stretch of the west avenue frontage
    const fronts = blockDetail.avenueFronts.w;
    if (fronts.length && chance(0.2)) {
      const [z0, z1] = fronts.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
      if (z1 - z0 > 8) blockDetail.scaffoldSheds.push({ x: minX - 2.2, y: 0.22, z: (z0 + z1) * 0.5, w: 3.8, d: (z1 - z0) * 0.85 });
    }

    blockDetail.footprints.sort((a, b) => a.h - b.h);
    if (xf) placeInFrame(blockDetail, bucketMarks);
    quadtree.insert(blockDetail);
    allBlocks.push(blockDetail);
  }

  // Turns everything a lot of the current frame emitted into place: facade boxes, roof gear, cornices, fire escapes,
  // awnings & sheds get the frame's turn (ry) about their own centre, map footprints their world corners, the block
  // its world centre (streaming) & bounds
  function placeInFrame(blk, marks) {
    const th = xf.th;
    buckets.forEach((items, m) => {
      for (let i = marks[m]; i < items.length; i++) {
        const b = items[i];
        [b.x, b.z] = toWorld(b.x, b.z);
        b.ry = th;
      }
    });
    for (const list of [blk.cornices, blk.waterTowers, blk.hvacUnits, blk.fireEscapes, blk.awnings, blk.scaffoldSheds]) {
      for (const o of list) {
        [o.x, o.z] = toWorld(o.x, o.z);
        o.ry = th;
      }
    }
    const corners = (x0, x1, z0, z1) => [toWorld(x0, z0), toWorld(x1, z0), toWorld(x1, z1), toWorld(x0, z1)].map(([x, z]) => ({ x, z }));
    const bounds = (o, pts) => {
      o.x0 = Math.min(...pts.map((p) => p.x));
      o.x1 = Math.max(...pts.map((p) => p.x));
      o.z0 = Math.min(...pts.map((p) => p.z));
      o.z1 = Math.max(...pts.map((p) => p.z));
    };
    for (const f of blk.footprints) {
      f.pts = corners(f.x0, f.x1, f.z0, f.z1);
      bounds(f, f.pts);
    }
    for (const y of blk.yards) {
      const [cx, cz] = toWorld((y.x0 + y.x1) * 0.5, (y.z0 + y.z1) * 0.5);
      const hw = (y.x1 - y.x0) * 0.5;
      const hd = (y.z1 - y.z0) * 0.5;
      Object.assign(y, { x0: cx - hw, x1: cx + hw, z0: cz - hd, z1: cz + hd, ry: th });
    }
    const pts = corners(blk.minX, blk.maxX, blk.minZ, blk.maxZ);
    [blk.cx, blk.cz] = toWorld(blk.cx, blk.cz);
    const b = {};
    bounds(b, pts);
    Object.assign(blk, { minX: b.x0, maxX: b.x1, minZ: b.z0, maxZ: b.z1, ry: th, pts });
  }

  // ============================================================================
  // LANDMARK LOTS: the footprints landmarks.js builds on (real OpenStreetMap outlines + a margin) stay clear of the
  // generic buildings, which fill the rest of their blocks
  // ============================================================================
  const LANDMARK_RESERVE = [
    ['Basílica de la Sagrada Família', 22], ['Casa Batlló', 1], ['Casa Milà', 1], ['Torre Glòries', 6], ['W Barcelona', 6],
    ['Catedral de la Santa Creu i Santa Eulàlia', 3], ['Basílica de Santa Maria del Mar', 2], ['Gran Teatre del Liceu', 1],
    ['Palau de la Música Catalana', 1], ['Hotel Arts', 8], ['Torre Mapfre', 8], ['Arc de Triomf', 4], ['Casa Amatller', 1]
  ].map(([name, m]) => {
    const t = LANDMARK_SITES[name];
    if (!t) return null;
    return { x0: t.x - t.w / 2 - m, x1: t.x + t.w / 2 + m, z0: t.z - t.d / 2 - m, z1: t.z + t.d / 2 + m };
  }).filter(Boolean);
  const hitR = (a, x0, x1, z0, z1) => a.x0 < x1 && a.x1 > x0 && a.z0 < z1 && a.z1 > z0;
  // [x0, x1, z0, z1] minus the reserved rects, as up to four slabs per hole (strips across the full depth first). In a
  // frontage frame the reserves are their bounds in the frame
  function minusReserves(r) {
    let reserves = LANDMARK_RESERVE;
    if (xf) {
      reserves = LANDMARK_RESERVE.map((h) => {
        const pts = [[h.x0, h.z0], [h.x1, h.z0], [h.x1, h.z1], [h.x0, h.z1]].map(([x, z]) => [
          xf.px + (x - xf.px) * xf.cs - (z - xf.pz) * xf.sn,
          xf.pz + (x - xf.px) * xf.sn + (z - xf.pz) * xf.cs
        ]);
        return { x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])), z0: Math.min(...pts.map((p) => p[1])), z1: Math.max(...pts.map((p) => p[1])) };
      });
    }
    let parts = [r];
    for (const h of reserves) {
      const next = [];
      for (const [x0, x1, z0, z1] of parts) {
        if (!hitR(h, x0, x1, z0, z1)) { next.push([x0, x1, z0, z1]); continue; }
        if (h.x0 > x0) next.push([x0, h.x0, z0, z1]);
        if (h.x1 < x1) next.push([h.x1, x1, z0, z1]);
        const mx0 = Math.max(x0, h.x0), mx1 = Math.min(x1, h.x1);
        if (h.z0 > z0) next.push([mx0, mx1, z0, h.z0]);
        if (h.z1 < z1) next.push([mx0, mx1, h.z1, z1]);
      }
      parts = next;
    }
    return parts;
  }
  function overlapsLandmark(minX, maxX, minZ, maxZ) {
    return LANDMARK_RESERVE.some((h) => hitR(h, minX, maxX, minZ, maxZ));
  }

  // ============================================================================
  // A. EVERY REAL BLOCK OF BARCELONA (city-config.js BLOCKS): each curb island's lots inside its building line,
  //    filled for its neighbourhood. An Eixample illa is built on its building-line square, the houses facing its four
  //    xamfrans each in a frame turned 45° to its chamfer; the old town's & Gràcia's irregular blocks come with
  //    frontage frames: lot rects laid out along each street they front, filled in the frame and turned into place.
  // ============================================================================
  // Superblocks (campuses, the port's sheds, the Fòrum...) are cut into strips about a street block deep with a ~9 m
  // passage between them, so no lot (and no building) runs 100+ m deep
  const DEEP_LOT = 95;
  function splitDeep(r) {
    const [x0, x1, z0, z1] = r;
    const d = z1 - z0;
    if (d <= DEEP_LOT) return [r];
    const gap = 9;
    const n = Math.max(2, Math.round((d + gap) / (64 + gap)));
    const s = (d - gap * (n - 1)) / n;
    const out = [];
    for (let k = 0; k < n; k++) out.push([x0, x1, z0 + k * (s + gap), z0 + k * (s + gap) + s]);
    return out;
  }
  // The four xamfrans of an illa: corner, direction into the block & the frame turn that faces a lot's north side out
  // onto the chamfer
  const XAMFRANS = [[-1, -1, Math.PI / 4], [1, -1, -Math.PI / 4], [-1, 1, (3 * Math.PI) / 4], [1, 1, (-3 * Math.PI) / 4]];
  const CORNER_DEPTH = 16;
  for (const b of BLOCKS) {
    if (b.park > 0.6 || b.median) continue;
    blockStoreys = b.storeys[0];
    if (b.illa && !overlapsLandmark(b.illa[0], b.illa[1], b.illa[2], b.illa[3])) {
      const [x0, x1, z0, z1, c] = b.illa;
      illaChamfer = c;
      populateBlock(x0, x1, z0, z1, b.district, 'illa');
      minLot = 12;
      const half = (c * Math.SQRT2) / 2;
      for (const [sx, sz, th] of XAMFRANS) {
        const px = (sx < 0 ? x0 : x1) - (sx * c) / 2;
        const pz = (sz < 0 ? z0 : z1) - (sz * c) / 2;
        xf = { th, cs: Math.cos(th), sn: Math.sin(th), px, pz };
        populateBlock(px - half, px + half, pz, pz + CORNER_DEPTH, b.district, 'corner');
        xf = null;
      }
      continue;
    }
    if (b.illa) {
      // an illa with a landmark on it (the Sagrada Família's): its lots round the reserve, like any other block
      for (const part of minusReserves([b.illa[0], b.illa[1], b.illa[2], b.illa[3]])) {
        const [x0, x1, z0, z1] = part;
        if (x1 - x0 >= 15 && z1 - z0 >= 15) populateBlock(x0, x1, z0, z1, b.district);
      }
      continue;
    }
    minLot = b.frames ? 12 : 15;
    for (const [th, px, pz, rects] of b.frames || [[0, 0, 0, b.rects]]) {
      xf = th ? { th, cs: Math.cos(th), sn: Math.sin(th), px, pz } : null;
      for (const r of rects) {
        for (const part of minusReserves(r)) {
          for (const [x0, x1, z0, z1] of splitDeep(part)) {
            if (x1 - x0 < minLot || z1 - z0 < minLot) continue;
            populateBlock(x0, x1, z0, z1, b.district);
          }
        }
      }
      xf = null;
    }
  }
  minLot = 15;

  // B6. Narrow leftover slabs no building fits on (8-26 m wide: clipped short by the shore or cut by a diagonal street)
  //     become sitting areas: a row or two of honey locusts & planes in tree pits (planted by street-details.js)
  {
    const plazas = pavedPlazaRects || [];
    const sites = parkTreeSites;
    const hit = (r, x0, x1, z0, z1) => r.minX < x1 && r.maxX > x0 && r.minZ < z1 && r.maxZ > z0;
    for (const s of (sites && sidewalkBlocks) || []) {
      const x0 = s.cx - s.w / 2;
      const x1 = s.cx + s.w / 2;
      const z0 = s.cz - s.d / 2;
      const z1 = s.cz + s.d / 2;
      if (s.cover || (s.block && (s.block.median || s.block.park > 0.6))) continue;
      const narrow = Math.min(s.w, s.d);
      if (narrow < 8 || narrow > 26 || Math.max(s.w, s.d) < 20) continue;
      if (allBlocks.some((b) => hit(b, x0 + 2, x1 - 2, z0 + 2, z1 - 2)) || plazas.some((r) => hit(r, x0, x1, z0, z1))) continue;
      if (overlapsLandmark(x0, x1, z0, z1)) continue;
      const alongX = s.w > s.d;
      const len = alongX ? s.w : s.d;
      const n = Math.max(1, Math.floor((len - 6) / 8));
      const lanes = narrow >= 15 ? [-narrow / 4, narrow / 4] : [0];
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n - 0.5;
        for (const [j, o] of lanes.entries()) {
          const u = (len - 6) * t + (j % 2) * 2;
          const x = alongX ? s.cx + u : s.cx + o;
          const z = alongX ? s.cz + o : s.cz + u;
          const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
          sites.push({ x, y: 0.22, z, scale: 0.8 + h * 0.3, species: h < 0.55 ? 1 : 0, tier: 1 });
        }
      }
    }
  }

  // ============================================================================
  // C. STATIC ISLAND-WIDE ARCHITECTURAL MASSING (6 TSL Facade Materials)
  // ============================================================================
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const dummy = new THREE.Object3D();

  buckets.forEach((items, matIdx) => {
    if (items.length === 0) return;
    const inst = createFacadeBoxes(materials[matIdx], items);
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  });

  // Rear yards, light courts & project lawns: one thin slab per patch just above the sidewalk (buildings standing on
  // it hide the rest). Lawn, paving and tree canopies come from world-space noise; detail finer than a pixel fades
  // to its average so the gardens don't shimmer from the air
  const yardMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.0 });
  yardMat.colorNode = Fn(() => {
    const p = positionWorld.xz;
    const px = length(fwidth(p)); // metres per pixel
    const fine = smoothstep(0.9, 0.12, px);
    const crownLOD = smoothstep(8.0, 3.0, px); // crowns a few pixels wide or more are drawn, smaller ones averaged
    const grain = mx_noise_float(p.mul(1.9)).mul(fine).mul(0.5).add(0.5);
    const clump = mx_noise_float(p.mul(0.7).add(5.3)).mul(smoothstep(2.0, 0.4, px)).mul(0.5).add(0.5);

    // Lawns with grey / beige patios & light-court paving
    const patch = mx_noise_float(p.mul(0.21)).mul(smoothstep(12.0, 4.0, px));
    const lawn = mix(color(0x5d7a3a), color(0x7a944c), grain);
    const paving = mix(color(0x8c8679), color(0xa59e90), grain);
    const ground = mix(lawn, paving, smoothstep(0.15, 0.45, patch));

    // Street-tree-sized (~12 m) & small (~6 m) crowns, domed: sunlit crowns, softer & darker towards their rims
    const w1 = mx_worley_noise_float(p.mul(0.085));
    const w2 = mx_worley_noise_float(p.mul(0.16).add(17.0));
    const crowns = max(smoothstep(0.55, 0.3, w1), smoothstep(0.45, 0.25, w2).mul(0.85));
    const rim = smoothstep(0.0, 1.0, min(w1.div(0.55), w2.div(0.45)));
    const leaves = mix(color(0x3f5e2a), color(0x5e7f3b), clump.mul(0.6).add(grain.mul(0.4))).mul(mix(float(1.08), float(0.78), rim));
    const leavesMean = mix(color(0x3f5e2a), color(0x5e7f3b), 0.5).mul(0.93);
    return mix(ground, mix(leavesMean, leaves, crownLOD), mix(float(0.5), crowns, crownLOD));
  })();
  const yardRects = [];
  for (const blk of allBlocks) yardRects.push(...blk.yards);
  if (yardRects.length) {
    const yardInst = new THREE.InstancedMesh(unitBox, yardMat, yardRects.length);
    yardRects.forEach((r, i) => {
      dummy.position.set((r.x0 + r.x1) * 0.5, 0.225, (r.z0 + r.z1) * 0.5);
      dummy.rotation.set(0, r.ry || 0, 0);
      dummy.scale.set(r.x1 - r.x0, 0.05, r.z1 - r.z0);
      dummy.updateMatrix();
      yardInst.setMatrixAt(i, dummy.matrix);
    });
    dummy.rotation.set(0, 0, 0);
    yardInst.receiveShadow = true;
    group.add(yardInst);
  }

  // ============================================================================
  // D. QUADTREE-STREAMED HIGH-DETAIL ARCHITECTURAL POOLS (LOD0 around player)
  // ============================================================================
  const MAX_CORNICES = 7000;
  const MAX_WATER_TOWERS = 1400;
  const MAX_HVAC = 1600;
  const MAX_AWNINGS = 1800;
  const MAX_SHEDS = 300;

  // 1. Projecting horizontal stone cornices & parapet ledges
  const corniceMat = new THREE.MeshStandardNodeMaterial({ color: 0xc8bca6, roughness: 0.78, metalness: 0.08 });
  const corniceInst = new THREE.InstancedMesh(unitBox, corniceMat, MAX_CORNICES);
  corniceInst.castShadow = true;
  corniceInst.receiveShadow = true;
  corniceInst.frustumCulled = false;
  group.add(corniceInst);

  // 2. 3-part rooftop cedar water towers with steel hoop bands & open 4-leg steel trestle
  const woodMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.78 });
  woodMat.colorNode = Fn(() => {
    const u = uv();
    // Preserve the average width of seams and hoops when they become smaller than a pixel.
    const staveCoord = u.x.mul(28.0);
    const staveSeam = filteredPulse(fract(staveCoord), 0.46, 0.54, fwidth(staveCoord));
    const staveTone = mix(color(0x8e6343), color(0x5c3e26), staveSeam.mul(0.55));
    const bandCoord = u.y.mul(5.0);
    const isHoop = filteredPulse(fract(bandCoord), 0.42, 0.58, fwidth(bandCoord));
    return mix(staveTone, color(0x1f2328), isHoop);
  })();
  const roofCapMat = new THREE.MeshStandardNodeMaterial({ color: 0x3b4045, roughness: 0.65, metalness: 0.3 });
  const legMat = new THREE.MeshStandardNodeMaterial({ color: 0x262b30, roughness: 0.45, metalness: 0.68 });
  const barrelGeo = new THREE.CylinderGeometry(1.65, 1.75, 3.6, 12);
  const coneGeo = new THREE.ConeGeometry(1.9, 1.5, 12);

  // Open 4-leg structural steel trestle with cross-bracing and top chime deck
  const trestleParts = [];
  const legPostGeo = new THREE.BoxGeometry(0.24, 2.75, 0.24);
  const legPositions = [
    [-1.05, 0, -1.05],
    [1.05, 0, -1.05],
    [-1.05, 0, 1.05],
    [1.05, 0, 1.05],
  ];
  for (const [lx, ly, lz] of legPositions) {
    const g = legPostGeo.clone();
    g.rotateZ(lx > 0 ? 0.08 : -0.08);
    g.rotateX(lz > 0 ? -0.08 : 0.08);
    g.translate(lx, ly, lz);
    trestleParts.push(g);
  }
  const deckRingGeo = new THREE.CylinderGeometry(1.88, 1.88, 0.22, 12);
  deckRingGeo.translate(0, 1.22, 0);
  trestleParts.push(deckRingGeo);
  const braceX1 = new THREE.BoxGeometry(2.15, 0.14, 0.14);
  braceX1.translate(0, 0.2, -1.02);
  trestleParts.push(braceX1);
  const braceX2 = new THREE.BoxGeometry(2.15, 0.14, 0.14);
  braceX2.translate(0, 0.2, 1.02);
  trestleParts.push(braceX2);
  const braceZ1 = new THREE.BoxGeometry(0.14, 0.14, 2.15);
  braceZ1.translate(-1.02, -0.45, 0);
  trestleParts.push(braceZ1);
  const braceZ2 = new THREE.BoxGeometry(0.14, 0.14, 2.15);
  braceZ2.translate(1.02, -0.45, 0);
  trestleParts.push(braceZ2);
  const riserPipe = new THREE.CylinderGeometry(0.24, 0.24, 2.6, 8);
  trestleParts.push(riserPipe);
  const legsGeo = mergeGeometries(trestleParts, false);

  const barrelInst = new THREE.InstancedMesh(barrelGeo, woodMat, MAX_WATER_TOWERS);
  const coneInst = new THREE.InstancedMesh(coneGeo, roofCapMat, MAX_WATER_TOWERS);
  const legsInst = new THREE.InstancedMesh(legsGeo, legMat, MAX_WATER_TOWERS);
  barrelInst.castShadow = barrelInst.receiveShadow = true;
  coneInst.castShadow = coneInst.receiveShadow = true;
  legsInst.castShadow = legsInst.receiveShadow = true;
  barrelInst.frustumCulled = coneInst.frustumCulled = legsInst.frustumCulled = false;
  group.add(legsInst, barrelInst, coneInst);

  // 3. Rooftop mechanical penthouses & HVAC chillers with top exhaust fans & side louvers
  const hvacMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.52, metalness: 0.45 });
  hvacMat.colorNode = Fn(() => {
    const u = uv();
    const isTop = step(0.7, normalWorldGeometry.y);
    const fan1 = length(u.sub(vec2(0.3, 0.5)));
    const fan2 = length(u.sub(vec2(0.7, 0.5)));
    const fanDist = min(fan1, fan2);
    const inFanWell = smoothstep(0.19, 0.17, fanDist);
    // Average subpixel slats and fan rings instead of letting them shimmer at a distance.
    const fanCoord = fanDist.mul(16.0);
    const fanRing = filteredPulse(fract(fanCoord), 0.4835, 0.5165, fwidth(fanCoord)).mul(inFanWell);
    const topCol = mix(color(0x889098), color(0x1b2026), inFanWell.mul(0.82).sub(fanRing.mul(0.45)));

    const inLouverBox = step(0.12, u.x).mul(step(u.x, 0.88)).mul(step(0.18, u.y)).mul(step(u.y, 0.82));
    const slatCoord = u.y.mul(14.0);
    const louverSlat = filteredPulse(fract(slatCoord), 0.45, 1.0, fwidth(slatCoord)).mul(inLouverBox);
    const panelSeam = smoothstep(0.03, 0.0, abs(fract(u.x.mul(3.0)).sub(0.5)));
    const sideCol = mix(color(0x7c848c), color(0x282e36), max(louverSlat.mul(0.72), panelSeam.mul(0.35)));
    return mix(sideCol, topCol, isTop);
  })();
  const hvacInst = new THREE.InstancedMesh(unitBox, hvacMat, MAX_HVAC);
  hvacInst.castShadow = hvacInst.receiveShadow = true;
  hvacInst.frustumCulled = false;
  group.add(hvacInst);

  // 4. Instanced fire escapes: real steps nearby, lightweight silhouettes in the distance.
  const fireEscapeSystem = createFireEscapes(group);

  // 5. Ground-floor retail canvas awnings & illuminated storefront fascia signs
  const awningMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.65 });
  const awningPalette = [
    new THREE.Color(0x9e222e),
    new THREE.Color(0x1f593b),
    new THREE.Color(0x213d68),
    new THREE.Color(0xd9912b),
    new THREE.Color(0x2d2d32)
  ];
  const awningInst = new THREE.InstancedMesh(unitBox, awningMat, MAX_AWNINGS);
  awningInst.castShadow = awningInst.receiveShadow = true;
  awningInst.frustumCulled = false;
  // Pre-initialize instanceColor buffer so dynamic updates work cleanly
  for (let i = 0; i < MAX_AWNINGS; i++) {
    awningInst.setColorAt(i, awningPalette[i % awningPalette.length]);
  }
  group.add(awningInst);

  const signThemes = [
    { bg: '#161210', border: '#c89d54', text: 'BAR CELONA · TAPES · VERMUT', color: '#ffe4a8' },
    { bg: '#0f5a2e', border: '#7ee08f', text: 'FARMÀCIA · FARMACIA', color: '#ffffff' },
    { bg: '#142b20', border: '#d4af37', text: 'LLIBRERIA & CAFÈ', color: '#fff2cc' },
    { bg: '#280a10', border: '#ff5252', text: 'FORN DE PA · PASTISSERIA', color: '#ffd180' },
    { bg: '#101318', border: '#e0e6ed', text: 'QUEVIURES · FRUITA I VERDURA', color: '#f5f9ff' }
  ];
  const MAX_SIGNS_PER_THEME = Math.ceil(MAX_AWNINGS / signThemes.length) + 32;
  const signInsts = signThemes.map((st) => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 96;
    const ctx = c.getContext('2d');
    ctx.fillStyle = st.bg;
    ctx.fillRect(0, 0, 512, 96);
    ctx.strokeStyle = st.border;
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, 500, 84);
    ctx.fillStyle = st.color;
    ctx.font = '800 26px Inter, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(st.text, 256, 50);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sMat = new THREE.MeshBasicNodeMaterial({ map: tex });
    const sInst = new THREE.InstancedMesh(unitBox, sMat, MAX_SIGNS_PER_THEME);
    sInst.frustumCulled = false;
    group.add(sInst);
    return sInst;
  });

  // 6. Sidewalk construction scaffolding sheds
  const shedMat = new THREE.MeshStandardNodeMaterial({ color: 0x214f37, roughness: 0.6, metalness: 0.25 });
  const shedInst = new THREE.InstancedMesh(unitBox, shedMat, MAX_SHEDS);
  shedInst.castShadow = shedInst.receiveShadow = true;
  shedInst.frustumCulled = false;
  group.add(shedInst);

  // 7. Ground-floor storefront clustered SpotLights (awnings/fascia signs)
  const storeLightGroup = new THREE.Group();
  storeLightGroup.name = 'StoreClusteredLights';
  scene.add(storeLightGroup);

  const storeThemeColors = [
    new THREE.Color(0xffd896), // Bistro warm gold
    new THREE.Color(0xd8eeff), // Pharmacy crisp cool white
    new THREE.Color(0xffe4ad), // Bookstore warm amber
    new THREE.Color(0xffbe88), // 24hr Deli warm orange-gold
    new THREE.Color(0xfff2d6)  // Watch boutique warm ivory
  ];

  const STORE_SPOT_POOL = 28;
  const STORE_SPOT_INTENSITY = 46 * ((0.85 - 0.15) / 0.90);
  const storeSpotPool = [];
  for (let i = 0; i < STORE_SPOT_POOL; i++) {
    const spot = new THREE.SpotLight(0xffd896, 0, 12.0, 0.84, 0.80, 1.30);
    spot.castShadow = false;
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    storeLightGroup.add(spot);
    storeLightGroup.add(spot.target);
    storeSpotPool.push(spot);
  }

  const activeAwnings = [];
  const spotCandidates = [];

  // ============================================================================
  // E. DYNAMIC QUADTREE STREAMING UPDATE AROUND PLAYER / CAMERA
  // ============================================================================
  let lastStreamX = Infinity;
  let lastStreamZ = Infinity;
  const STREAM_RADIUS = 560; // High-detail architectural radius around player in meters

  // Streaming rewrites only the active prefix; unused pool capacity need not cross the GPU queue.
  function flagRange(attribute, count) {
    if (count === 0) return;
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, count * attribute.itemSize);
    attribute.needsUpdate = true;
  }

  function update(focusX, focusZ, force = false) {
    const dx = focusX - lastStreamX;
    const dz = focusZ - lastStreamZ;
    if (!force && (dx * dx + dz * dz) < 324) {
      // Player moved less than 18m since last Quadtree stream update
      return;
    }
    lastStreamX = focusX;
    lastStreamZ = focusZ;

    const nearbyBlocks = quadtree.queryRange(focusX, focusZ, STREAM_RADIUS);
    // Sort closest blocks first so if any pool hits capacity, closest blocks around the player always win
    nearbyBlocks.sort((a, b) => {
      const da = (a.cx - focusX) * (a.cx - focusX) + (a.cz - focusZ) * (a.cz - focusZ);
      const db = (b.cx - focusX) * (b.cx - focusX) + (b.cz - focusZ) * (b.cz - focusZ);
      return da - db;
    });
    activeAwnings.length = 0;

    let corniceCount = 0;
    let wtCount = 0;
    let hvacCount = 0;
    fireEscapeSystem.begin();
    let awningCount = 0;
    let shedCount = 0;
    const signCounts = signInsts.map(() => 0);

    for (let bIdx = 0; bIdx < nearbyBlocks.length; bIdx++) {
      const blk = nearbyBlocks[bIdx];
      // every piece of a block turned into a frontage frame shares its turn (see placeInFrame)
      dummy.rotation.set(0, blk.ry || 0, 0);
      const collectNearLights = bIdx < 20;

      // 1. Stone cornices & setback ledges, hung just below their roof line (top 0.1h under it, so no two ledges or
      //    roofs share a plane) so roofs & terraces keep their own roofing instead of a stone lid
      for (let i = 0; i < blk.cornices.length && corniceCount < MAX_CORNICES; i++) {
        const c = blk.cornices[i];
        dummy.position.set(c.x, c.y - c.h * 0.6, c.z);
        dummy.scale.set(c.w, c.h, c.d);
        dummy.updateMatrix();
        corniceInst.setMatrixAt(corniceCount++, dummy.matrix);
      }

      // 2. Rooftop cedar water towers
      for (let i = 0; i < blk.waterTowers.length && wtCount < MAX_WATER_TOWERS; i++) {
        const wt = blk.waterTowers[i];
        dummy.scale.set(1, 1, 1);

        dummy.position.set(wt.x, wt.y + 1.3, wt.z);
        dummy.updateMatrix();
        legsInst.setMatrixAt(wtCount, dummy.matrix);

        dummy.position.set(wt.x, wt.y + 4.2, wt.z);
        dummy.updateMatrix();
        barrelInst.setMatrixAt(wtCount, dummy.matrix);

        dummy.position.set(wt.x, wt.y + 6.7, wt.z);
        dummy.updateMatrix();
        coneInst.setMatrixAt(wtCount, dummy.matrix);
        wtCount++;
      }

      // 3. Rooftop HVAC & mechanical bulkheads
      for (let i = 0; i < blk.hvacUnits.length && hvacCount < MAX_HVAC; i++) {
        const u = blk.hvacUnits[i];
        dummy.position.set(u.x, u.y + u.h * 0.5, u.z);
        dummy.scale.set(u.w, u.h, u.d);
        dummy.updateMatrix();
        hvacInst.setMatrixAt(hvacCount++, dummy.matrix);
      }

      // 4. Wrought-iron fire escapes
      for (const fe of blk.fireEscapes) fireEscapeSystem.add(fe, focusX, focusZ);

      // 5. Retail awnings & illuminated storefront fascia signs
      for (let i = 0; i < blk.awnings.length && awningCount < MAX_AWNINGS; i++) {
        const a = blk.awnings[i];
        dummy.position.set(a.x, a.y, a.z);
        dummy.scale.set(a.w, 0.75, a.d);
        dummy.updateMatrix();
        awningInst.setMatrixAt(awningCount, dummy.matrix);
        awningInst.setColorAt(awningCount, awningPalette[a.colorIdx % awningPalette.length]);

        const themeIdx = awningCount % signInsts.length;
        if (signCounts[themeIdx] < MAX_SIGNS_PER_THEME) {
          dummy.position.set(a.x, 4.68, a.z);
          dummy.scale.set(0.28, 0.86, a.d * 0.92);
          dummy.updateMatrix();
          signInsts[themeIdx].setMatrixAt(signCounts[themeIdx]++, dummy.matrix);
        }
        if (collectNearLights) {
          activeAwnings.push({ a, themeIdx, ry: blk.ry || 0 });
        }
        awningCount++;
      }

      // 6. Sidewalk construction sheds
      for (let i = 0; i < blk.scaffoldSheds.length && shedCount < MAX_SHEDS; i++) {
        const s = blk.scaffoldSheds[i];
        dummy.position.set(s.x, s.y + 3.6, s.z);
        dummy.scale.set(s.w, 0.85, s.d);
        dummy.updateMatrix();
        shedInst.setMatrixAt(shedCount++, dummy.matrix);
      }
    }
    dummy.rotation.set(0, 0, 0);

    corniceInst.count = corniceCount;
    flagRange(corniceInst.instanceMatrix, corniceCount);

    legsInst.count = wtCount;
    barrelInst.count = wtCount;
    coneInst.count = wtCount;
    flagRange(legsInst.instanceMatrix, wtCount);
    flagRange(barrelInst.instanceMatrix, wtCount);
    flagRange(coneInst.instanceMatrix, wtCount);

    hvacInst.count = hvacCount;
    flagRange(hvacInst.instanceMatrix, hvacCount);

    fireEscapeSystem.end();

    awningInst.count = awningCount;
    flagRange(awningInst.instanceMatrix, awningCount);
    if (awningInst.instanceColor) flagRange(awningInst.instanceColor, awningCount);

    signInsts.forEach((sInst, idx) => {
      sInst.count = signCounts[idx];
      flagRange(sInst.instanceMatrix, signCounts[idx]);
    });

    shedInst.count = shedCount;
    flagRange(shedInst.instanceMatrix, shedCount);
  }

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function updateLights(camera) {
    if (!camera) {
      for (let i = 0; i < STORE_SPOT_POOL; i++) {
        storeSpotPool[i].intensity = 0;
        storeSpotPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const camX = camera.position.x;
    const camY = camera.position.y;
    const camZ = camera.position.z;
    const e = camera.matrixWorld.elements;
    const fwdLen = Math.hypot(e[8], e[10]) || 1;
    const fwdX = -e[8] / fwdLen;
    const fwdZ = -e[10] / fwdLen;
    const STORE_MAX_DIST = 115;

    spotCandidates.length = 0;
    for (let i = 0; i < activeAwnings.length; i++) {
      const item = activeAwnings[i];
      const a = item.a;
      const dx = a.x - camX;
      const dz = a.z - camZ;
      const d2 = dx * dx + dz * dz + camY * camY;
      if (d2 > STORE_MAX_DIST * STORE_MAX_DIST) continue;
      const d = Math.sqrt(d2);
      const forwardDot = dx * fwdX + dz * fwdZ;
      const effDist = d + Math.max(0, 6.0 - forwardDot) * 2.8;
      if (effDist >= STORE_MAX_DIST) continue;
      spotCandidates.push({ item, effDist });
    }
    spotCandidates.sort((a, b) => a.effDist - b.effDist);

    const storeCutoff = spotCandidates.length > STORE_SPOT_POOL
      ? Math.min(STORE_MAX_DIST, spotCandidates[STORE_SPOT_POOL].effDist)
      : STORE_MAX_DIST;
    const activeSpots = Math.min(STORE_SPOT_POOL, spotCandidates.length);
    for (let i = 0; i < STORE_SPOT_POOL; i++) {
      const spot = storeSpotPool[i];
      if (i < activeSpots) {
        const cand = spotCandidates[i];
        const { a, themeIdx, ry } = cand.item;
        const fade = smoothFade(cand.effDist, storeCutoff * 0.62, storeCutoff);
        const sideDir = a.sideDir || 1;
        const outX = Math.cos(ry) * sideDir;
        const outZ = -Math.sin(ry) * sideDir;
        spot.position.set(a.x + outX * 0.45, 4.35, a.z + outZ * 0.45);
        spot.target.position.set(a.x + outX * 1.85, 0.0, a.z + outZ * 1.85);
        spot.target.updateMatrixWorld();
        spot.color.copy(storeThemeColors[themeIdx % storeThemeColors.length]);
        spot.intensity = STORE_SPOT_INTENSITY * fade;
      } else {
        spot.intensity = 0;
        spot.position.set(0, -1000, 0);
      }
    }
  }

  // Initial Quadtree stream centered on Plaça de Catalunya
  update(0, 62, true);

  scene.add(group);
  return {
    group,
    colliders,
    quadtree,
    allBlocks,
    update,
    updateLights
  };
}

export { Quadtree, buildCityBlocks };
