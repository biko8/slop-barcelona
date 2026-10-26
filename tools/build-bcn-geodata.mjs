// tools/build-bcn-geodata.mjs — writes js/bcn-geodata.js (see bcn-base.mjs for the frame and the data source)
// usage: node --max-old-space-size=8192 tools/build-bcn-geodata.mjs [out.js]
// (the OpenStreetMap layers in tools/data/bcn_*.json come from tools/bcn-extract.py)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { geo, toWorld, rdp, rdpRing, ringArea, bbox, pointInRing, load, log } from './bcn-base.mjs';
import { ways, chamfers } from './bcn-ways.mjs';
import { blocks, STRIP } from './bcn-blocks.mjs';
import { buildRoadGraph } from './bcn-roadgraph.mjs';

const OUT = process.argv[2] || fileURLToPath(new URL('../js/bcn-geodata.js', import.meta.url));
const OUT_METRO = process.argv[3] || fileURLToPath(new URL('../js/bcn-metro.js', import.meta.url));
const q = (v) => Math.round(v * 10) / 10;
const flat = (pts) => pts.flatMap(([x, z]) => [q(x), q(z)]);
const D = geo.DETAIL;
const inDetail = ([x, z]) => x > D.x0 - 50 && x < D.x1 + 50 && z > D.z0 - 50 && z < D.z1 + 50;

// --- Named streets: the ways merged into polylines per name & width, for maps, labels & lookups ---------------------
function mergeRoads() {
  const byKey = new Map();
  for (const w of ways) {
    if (!w.t.name || !w.pts.some(inDetail)) continue;
    const dir = w.t.oneway === 'yes' || w.t.junction === 'roundabout' ? 1 : w.t.oneway === '-1' ? -1 : 0;
    const k = `${w.t.name}|${Math.round(w.w)}|${dir}|${w.lanes || 0}|${w.t.highway === 'pedestrian' ? 1 : 0}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(w.pts);
  }
  const out = [];
  const pk = (p) => `${q(p[0])},${q(p[1])}`;
  for (const [k, lines] of byKey) {
    const [name, w, dir, lanes, ped] = k.split('|');
    const byStart = new Map(lines.map((l) => [pk(l[0]), l]));
    const used = new Set();
    for (const l of lines) {
      if (used.has(l)) continue;
      let first = l;
      const seen = new Set([l]);
      for (;;) {
        const prev = lines.find((m) => !seen.has(m) && !used.has(m) && pk(m[m.length - 1]) === pk(first[0]));
        if (!prev) break;
        seen.add(prev);
        first = prev;
      }
      const line = [];
      let cur = first;
      while (cur && !used.has(cur)) {
        used.add(cur);
        line.push(...(line.length ? cur.slice(1) : cur));
        cur = byStart.get(pk(cur[cur.length - 1]));
      }
      out.push([name, +w, +dir, +lanes, +ped, flat(rdp(line, 0.8))]);
    }
  }
  return out;
}
const roads = mergeRoads();
log(`${roads.length} named street polylines`);

// --- Parks, water & beaches (maps, ground cover) ---------------------------------------------------------------------
const areas = load('bcn_areas.json').elements;
const parks = [];
const water = [];
const beaches = [];
for (const a of areas) {
  if (!a.ring) continue;
  const r = a.ring.map(([lon, lat]) => toWorld(lon, lat));
  if (!r.some(inDetail)) continue;
  const A = Math.abs(ringArea(r));
  const ring = rdpRing(r.slice(0, -1), 0.8);
  if (ring.length < 3) continue;
  if (ringArea(ring) > 0) ring.reverse();
  if (['park', 'garden', 'forest', 'wood', 'grass', 'meadow', 'recreation_ground', 'village_green', 'cemetery'].includes(a.kind) && A > 1500) {
    parks.push({ name: a.name, cat: a.kind, area: Math.round(A), rings: [flat(ring)] });
  } else if (a.kind === 'water' && A > 60) {
    water.push({ name: a.name, ring: flat(ring) });
  } else if ((a.kind === 'beach' || a.kind === 'sand') && A > 2000) {
    beaches.push({ name: a.name, ring: flat(ring) });
  }
}
log(`${parks.length} parks, ${water.length} water bodies, ${beaches.length} beaches`);

// --- Landmarks: real footprints from OpenStreetMap -------------------------------------------------------------------
const landmarks = {};
for (const e of load('bcn_landmarks.json').elements) {
  const r = e.ring.map(([lon, lat]) => toWorld(lon, lat));
  const b = bbox(r);
  const area = Math.abs(ringArea(r));
  const prev = landmarks[e.name];
  if (prev && prev.area >= area) continue;
  landmarks[e.name] = { x: q((b.x0 + b.x1) / 2), z: q((b.z0 + b.z1) / 2), w: q(b.x1 - b.x0), d: q(b.z1 - b.z0), h: e.height || (e.levels ? q(e.levels * 3.6) : null), area: Math.round(area), ring: flat(rdpRing(r.slice(0, -1), 0.4)) };
}
log(`${Object.keys(landmarks).length} landmark footprints`);

// --- Points of note at their real coordinates ------------------------------------------------------------------------
const POINTS = {
  placaCatalunya: [41.38703, 2.17005], sagradaFamilia: [41.40363, 2.17436], casaBatllo: [41.39165, 2.16492],
  pedrera: [41.39540, 2.16190], arcTriomf: [41.39104, 2.18064], ciutadella: [41.38810, 2.18750], torreGlories: [41.40358, 2.18950],
  barceloneta: [41.37840, 2.19250], colom: [41.37581, 2.17774], hotelW: [41.36860, 2.19010], catedral: [41.38393, 2.17619],
  liceu: [41.38050, 2.17360], boqueria: [41.38200, 2.17170], santaMariaMar: [41.38375, 2.18190], palauMusica: [41.38753, 2.17530],
  hotelArts: [41.38630, 2.19660], placaEspanya: [41.37510, 2.14900], mnac: [41.36850, 2.15340], placaReial: [41.38010, 2.17530],
  universitat: [41.38630, 2.16410], santAntoni: [41.37870, 2.16190], glories: [41.40360, 2.18750], diagonalPg: [41.39550, 2.16120],
  campNou: [41.38090, 2.12280], tibidabo: [41.42190, 2.11890], montjuicCastle: [41.36330, 2.16610], torreAgbarTop: [41.40358, 2.18950]
};
const points = Object.fromEntries(Object.entries(POINTS).map(([k, [lat, lon]]) => [k, toWorld(lon, lat).map(q)]));

// --- Street furniture from OpenStreetMap: signalised junctions, metro entrances, Bicing docks & fountains -----------
const roadGraph = buildRoadGraph();
const furniture = { signals: [], metro: [], bicing: [], fountains: [] };
{
  const inLand = ([x, z]) => x > D.x0 && x < D.x1 && z > D.z0 && z < D.z1 && pointInRing(geo.land, x, z);
  const pts = load('bcn_points.json').elements.map(([kind, lon, lat, name]) => ({ kind, p: toWorld(lon, lat), name })).filter((e) => inLand(e.p));
  // A junction of three or more links is signalised when OpenStreetMap has a signal within 25 m of it (signals are
  // mapped at the junction or at each approach's stop line)
  const N = roadGraph.nodes;
  const degree = new Map();
  for (const [a, b] of roadGraph.links) for (const n of [a, b]) degree.set(n, (degree.get(n) || 0) + 1);
  const cell = (x, z) => `${Math.floor(x / 32)},${Math.floor(z / 32)}`;
  const signalCells = new Map();
  for (const e of pts) {
    if (e.kind !== 'signal') continue;
    const k = cell(...e.p);
    if (!signalCells.has(k)) signalCells.set(k, []);
    signalCells.get(k).push(e.p);
  }
  for (const [n, deg] of degree) {
    if (deg < 3) continue;
    const x = N[n * 2], z = N[n * 2 + 1];
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dz = -1; dz <= 1 && !hit; dz++) {
        for (const [sx, sz] of signalCells.get(`${Math.floor(x / 32) + dx},${Math.floor(z / 32) + dz}`) || []) {
          if (Math.hypot(sx - x, sz - z) < 25) { hit = true; break; }
        }
      }
    }
    if (hit) furniture.signals.push(q(x), q(z));
  }
  for (const e of pts) {
    if (e.kind === 'metro') furniture.metro.push([q(e.p[0]), q(e.p[1]), e.name]);
    else if (e.kind === 'bicing') furniture.bicing.push(q(e.p[0]), q(e.p[1]));
    else if (e.kind === 'fountain') furniture.fountains.push(q(e.p[0]), q(e.p[1]));
  }
  log(`${furniture.signals.length / 2} signalised junctions, ${furniture.metro.length} metro entrances, ${furniture.bicing.length / 2} Bicing docks, ${furniture.fountains.length / 2} fountains`);
}

// --- Assemble -----------------------------------------------------------------------------------------------------------
const GEO = {
  version: 1,
  frame: { bearingDeg: Math.round(((geo.THETA * 180) / Math.PI) * 1000) / 1000, origin: 'Plaça de Catalunya', lat0: geo.LAT0, lon0: geo.LON0, kx: q(geo.KX), ky: q(geo.KY), units: 'm', strip: STRIP, sidewalk: 5, detail: D },
  land: flat(geo.land),
  metroLand: flat(geo.metroLand),
  roads,
  // Street centreline graph (bcn-roadgraph.mjs): nodes [x, z, ...], links [node a, node b, name index, curb-to-curb
  // width, travel lanes, direction (1: a -> b, -1: b -> a, 0: both), inner shape points [x, z, ...]]
  roadGraph,
  // Signalised junctions [x, z, ...], metro entrances [[x, z, name], ...], Bicing docks & drinking fountains [x, z, ...]
  furniture,
  // [outline, lot rects, park share, area name, rectangular, frontage frames [[θ, px, pz, lot rects], ...] | 0,
  //  beach share, square share, OSM storeys (area-weighted median), OSM storeys (95th percentile),
  //  Eixample illa [x0, x1, z0, z1, chamfer legs] (its building line's square) | 0]
  blocks: blocks.map((b) => [flat(b.poly), b.rects.map((r) => r.map(q)), b.park, b.name, b.rect ? 1 : 0,
    b.frames ? b.frames.map(([th, px, pz, rs]) => [Math.round(th * 1e4) / 1e4, q(px), q(pz), rs.map((r) => r.map(q))]) : 0,
    b.beach, b.square, b.storeys[0], b.storeys[1], b.illa ? b.illa.map(q) : 0]),
  // Cerdà's chamfered crossings (traffic signals): [x, z, curb chamfer |dx| + |dz|, ...]
  crossings: chamfers.flatMap((c) => [q(c.x), q(c.z), q(c.curb)]),
  parks,
  water,
  beaches,
  landmarks,
  points
};

const json = JSON.stringify(GEO);
const header = `// js/bcn-geodata.js — GENERATED by tools/build-bcn-geodata.mjs, do not edit by hand.
// Real Barcelona geography in the simulation's world frame: 1 unit = 1 m, x = Eixample-grid east (toward the Besòs),
// z = grid south (toward the sea), origin at the centre of Plaça de Catalunya, axes turned ${GEO.frame.bearingDeg}° from true north.
// Polygons & polylines are flat [x0, z0, x1, z1, ...] arrays.
// Source: © OpenStreetMap contributors (ODbL 1.0).
`;
fs.writeFileSync(OUT, `${header}export const GEO = ${json};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const [k, v] of Object.entries(GEO)) log(`  ${k}: ${(JSON.stringify(v).length / 1024).toFixed(0)} KB`);

// --- The metropolitan area's buildings (outside the detailed city): OpenStreetMap footprints as oriented boxes -------
// [x, z, length, width, turn about +y (rad, the box's length along local x), height, ...]
{
  const out = [];
  let n = 0;
  const DEG = Math.PI / 180;
  for (const [lon, lat, area, levels, height, , bearing, len, wid] of load('bcn_buildings.json').elements) {
    if (area < 30 || !len) continue;
    const [x, z] = toWorld(lon, lat);
    if (!pointInRing(geo.metroLand, x, z)) continue;
    // inside the detailed city (and its edge strip) the blocks build their own
    if (x > D.x0 - 10 && x < D.x1 + 10 && z > D.z0 - 10 && z < D.z1 + 10 && pointInRing(geo.land, x, z)) continue;
    const h = height || (levels ? levels * 3.2 + 1 : 9 + (area > 600 ? 6 : 0));
    // the long side's bearing -> its direction in the frame -> the turn about +y taking local x onto it
    const b = bearing * DEG;
    const [ex, ez] = [Math.sin(b), Math.cos(b)]; // east, north
    const th = geo.THETA;
    const dx = ex * Math.cos(th) - ez * Math.sin(th);
    const dz = -(ex * Math.sin(th) + ez * Math.cos(th));
    const rot = Math.atan2(-dz, dx);
    out.push(q(x), q(z), q(Math.max(4, len)), q(Math.max(4, wid)), Math.round(rot * 1000) / 1000, q(Math.min(180, h)));
    n++;
  }
  const header = `// js/bcn-metro.js — GENERATED by tools/build-bcn-geodata.mjs, do not edit by hand.
// The metropolitan area around the detailed city: OpenStreetMap building footprints as oriented boxes in the world frame
// (see bcn-geodata.js), [x, z, length, width, turn about +y (rad), height, ...]. Source: © OpenStreetMap contributors (ODbL 1.0).
`;
  fs.writeFileSync(OUT_METRO, `${header}export const METRO_BUILDINGS = new Float32Array(${JSON.stringify(out)});\n`);
  log(`wrote ${OUT_METRO}: ${n} metropolitan buildings (${(fs.statSync(OUT_METRO).size / 1024).toFixed(0)} KB)`);
}
