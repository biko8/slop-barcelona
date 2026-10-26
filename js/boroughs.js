import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  attribute,
  positionWorld,
  positionGeometry,
  normalGeometry,
  normalWorld,
  sin,
  abs,
  floor,
  fract,
  max,
  min,
  clamp,
  mix,
  step,
  smoothstep,
  dot,
  fwidth,
  select,
  length
} from 'three/tsl';
import { cityUniforms, filteredPulse } from './tsl-materials.js';
import { METRO_LAND, ISLAND_BOUNDS, GEO_FRAME_DETAIL, onLand, lonLatToWorld } from './city-config.js';
import { METRO_BUILDINGS } from './bcn-metro.js';

// The metropolitan area around the detailed city: the land out to the fogged horizon with the Collserola range & the
// hills of Gràcia and Horta rising behind the city, and every building OpenStreetMap maps there as an instanced box
// on the ground (bcn-metro.js: real positions, footprints, orientations & heights).

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Colour constants in this file are authored as sRGB swatches (like the hex colours elsewhere) and converted to the
// linear values the shaders and lighting work in
const toLinear = (c) => Math.pow(c, 2.2);
const srgb = (r, g, b) => vec3(toLinear(r), toLinear(g), toLinear(b));

// =====================================================================================================================
// 1. TERRAIN: the plain rising inland to the foot of Collserola, its ridge (Sant Pere Màrtir, Tibidabo, Valldaura)
//    and the hills between (Putxet, Tres Creus, el Carmel, la Rovira, la Peira), real summits & heights. The detailed
//    city stays flat at y = 0 (the land eases up from its edges).
// =====================================================================================================================
const HILLS = [
  // [lon, lat, height (m), radius (m)]
  [2.1395, 41.4078, 150, 320], // el Putxet
  [2.1515, 41.4147, 160, 330], // Turó de les Tres Creus (Park Güell)
  [2.1576, 41.4185, 240, 360], // Turó del Carmel
  [2.1620, 41.4194, 235, 300], // Turó de la Rovira
  [2.1700, 41.4320, 110, 330], // Turó de la Peira
  [2.1265, 41.4130, 175, 360] // Sant Gervasi: Turó de Monterols & Mont d'Orsà's foothills
].map(([lon, lat, h, r]) => ({ ...lonLatToWorld(lon, lat), h, r }));
const RIDGE = [
  // Collserola's crest, south-west to north-east: [lon, lat, height (m)]
  [2.0700, 41.3900, 260], [2.0968, 41.3996, 399], [2.1100, 41.4140, 430], [2.1189, 41.4219, 512], [2.1330, 41.4330, 440],
  [2.1450, 41.4440, 400], [2.1700, 41.4600, 360], [2.2000, 41.4800, 300]
].map(([lon, lat, h]) => ({ ...lonLatToWorld(lon, lat), h }));
const RIDGE_HALF = 1400; // the range's flanks
const D = GEO_FRAME_DETAIL;

/** Ground height (m) at (x, z): 0 in the detailed city & at sea */
function ridgeHeightAt(x, z) {
  // the plain climbs ~1:30 inland (grid north, −z) from the detailed city's top edge
  let h = Math.max(0, Math.min(120, (D.z0 + 200 - z) / 30));
  for (const p of HILLS) {
    const d2 = (x - p.x) ** 2 + (z - p.z) ** 2;
    h = Math.max(h, p.h * Math.exp(-d2 / (p.r * p.r)));
  }
  for (let i = 0; i + 1 < RIDGE.length; i++) {
    const a = RIDGE[i];
    const b = RIDGE[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    const crest = a.h + (b.h - a.h) * t;
    h = Math.max(h, crest * Math.exp(-((d / RIDGE_HALF) ** 2) * 1.6) * (1 + 0.08 * Math.sin(x * 0.004 + z * 0.003)));
  }
  // eased down to the detailed city's edges (a rectangle) over 400 m
  const ox = Math.max(D.x0 - x, 0, x - D.x1);
  const oz = Math.max(D.z0 - z, 0, z - D.z1);
  const out = Math.hypot(ox, oz);
  const ease = Math.min(1, out / 400);
  return h * ease * ease * (3 - 2 * ease);
}

function pointInPolygon(pts, x, z) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
// The metropolitan land outline in 64 m cells, for quick tests
const METRO_CELL = 64;
const METRO_GRID = (() => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of METRO_LAND) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const i0 = Math.floor(x0 / METRO_CELL), j0 = Math.floor(z0 / METRO_CELL);
  const w = Math.ceil(x1 / METRO_CELL) - i0 + 1, h = Math.ceil(z1 / METRO_CELL) - j0 + 1;
  const cells = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) cells[j * w + i] = pointInPolygon(METRO_LAND, (i0 + i + 0.5) * METRO_CELL, (j0 + j + 0.5) * METRO_CELL) ? 1 : 0;
  }
  return { i0, j0, w, h, cells, x0, x1, z0, z1 };
})();
/** Is (x, z) on the metropolitan land (the detailed city included)? */
function landAt(x, z) {
  const i = Math.floor(x / METRO_CELL) - METRO_GRID.i0, j = Math.floor(z / METRO_CELL) - METRO_GRID.j0;
  if (i < 0 || j < 0 || i >= METRO_GRID.w || j >= METRO_GRID.h) return z < ISLAND_BOUNDS.minZ; // inland beyond the extract
  return !!METRO_GRID.cells[j * METRO_GRID.w + i];
}

// The ground: a 50 m grid over the metropolitan land (and on out inland to the horizon), each triangle kept unless it
// lies wholly at sea or wholly on the detailed city (which has its own deck); 4 cm under the city's deck
function buildTerrainGeometry() {
  const STEP = 50;
  const x0 = Math.floor((METRO_GRID.x0 - 6000) / STEP) * STEP;
  const x1 = Math.ceil((METRO_GRID.x1 + 6000) / STEP) * STEP;
  const z0 = Math.floor((METRO_GRID.z0 - 8000) / STEP) * STEP;
  const z1 = Math.ceil(METRO_GRID.z1 / STEP) * STEP;
  const nx = (x1 - x0) / STEP + 1;
  const nz = (z1 - z0) / STEP + 1;
  const pos = new Float32Array(nx * nz * 3);
  const land = new Uint8Array(nx * nz);
  const city = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * STEP, z = z0 + j * STEP;
      const k = j * nx + i;
      const inside = x > METRO_GRID.x0 && x < METRO_GRID.x1 && z > METRO_GRID.z0 && z < METRO_GRID.z1;
      land[k] = inside ? (landAt(x, z) ? 1 : 0) : (z < METRO_GRID.z0 + 200 ? 1 : 0);
      city[k] = onLand(x, z) ? 1 : 0;
      pos[k * 3] = x;
      pos[k * 3 + 1] = land[k] ? ridgeHeightAt(x, z) - 0.04 : -0.6;
      pos[k * 3 + 2] = z;
    }
  }
  const idx = [];
  const keep = (a, b, c) => (land[a] || land[b] || land[c]) && !(city[a] && city[b] && city[c]);
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      if (keep(a, c, b)) idx.push(a, c, b);
      if (keep(b, c, d)) idx.push(b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

const hash12 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

const valueNoise = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash12(i);
  const b = hash12(i.add(vec2(1.0, 0.0)));
  const c = hash12(i.add(vec2(0.0, 1.0)));
  const d = hash12(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// 0 by day, ~0.75 at blue hour, 1 at night
const nightFactorNode = () => smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);

// Ground: the city's carpet of streets & roofs on the plain and the lower slopes, Collserola's pine & holm-oak woods
// higher up (with bare scrub on the steepest faces), street lamps twinkling in the built-up parts at night
function createLandMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0 });
  const p = positionWorld.xz;
  const y = positionWorld.y;
  const px = length(fwidth(p));
  const fine = smoothstep(8.0, 1.5, px);
  const n1 = valueNoise(p.mul(0.011));
  const n2 = valueNoise(p.mul(0.045).add(3.1));
  const slope = float(1.0).sub(normalWorld.y);
  // built-up below ~180 m, wood above (the edge frayed by noise)
  const wood = smoothstep(120.0, 200.0, y.add(n1.mul(90.0)));
  // a street grid ~130 m (the Cerdà pitch) with the roofs between: grid lines fade when they get under a pixel
  const gx = abs(fract(p.x.div(133.3)).sub(0.5)).mul(133.3);
  const gz = abs(fract(p.y.div(133.3)).sub(0.5)).mul(133.3);
  const streets = max(float(1.0).sub(smoothstep(4.0, 7.0, gx)), float(1.0).sub(smoothstep(4.0, 7.0, gz))).mul(fine);
  const roofs = mix(srgb(0.55, 0.47, 0.4), srgb(0.68, 0.63, 0.56), n2);
  const city = mix(roofs, srgb(0.32, 0.32, 0.33), streets.mul(0.8));
  const forest = mix(srgb(0.19, 0.26, 0.14), srgb(0.27, 0.32, 0.18), n2);
  const scrub = mix(srgb(0.45, 0.42, 0.33), srgb(0.36, 0.35, 0.26), n1);
  mat.colorNode = mix(city, mix(forest, scrub, smoothstep(0.35, 0.6, slope)), wood);
  const lamps = streets.mul(float(1.0).sub(wood)).mul(step(0.55, valueNoise(p.mul(0.09))));
  mat.emissiveNode = srgb(1.0, 0.72, 0.42).mul(lamps.mul(nightFactorNode()).mul(0.5));
  return mat;
}

// =====================================================================================================================
// 2. BUILDINGS (instanced boxes on the ground, from OpenStreetMap)
// =====================================================================================================================

// Unit box with its base at y = 0 and no bottom face
const BOX_GEO = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  const src = g.index.array;
  const keep = [];
  for (let i = 0; i < src.length; i++) if (i < 18 || i >= 24) keep.push(src[i]);
  g.setIndex(keep);
  g.clearGroups();
  return g;
})();

// Facade swatches in sRGB: cream & ochre stucco, stone, terracotta, white render, brick
const PALETTE = [
  [0.80, 0.73, 0.60], [0.76, 0.62, 0.45], [0.84, 0.80, 0.72], [0.70, 0.48, 0.36], [0.88, 0.86, 0.82],
  [0.62, 0.42, 0.33], [0.74, 0.70, 0.64], [0.79, 0.67, 0.52]
];

function createBoroughBuildingMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 });
  const info = attribute('bInfo', 'vec4');
  const tint = attribute('bTint', 'vec4');
  const pG = positionGeometry;
  const nG = normalGeometry;
  const style = tint.w;

  const isRoof = step(0.5, nG.y).toVar();
  const faceX = step(0.5, abs(nG.x));
  const wallW = mix(info.x, info.z, faceX);
  const u = mix(pG.x, pG.z, faceX).add(0.5).mul(wallW).add(info.w.mul(3.7)).toVar();
  const y = pG.y.mul(info.y).toVar();

  const s0 = style.lessThan(0.5);
  const s1 = style.lessThan(1.5);
  const s2 = style.lessThan(2.5);
  const s3 = style.lessThan(3.5);
  const pick = (a, b, c, d, e) => select(s0, float(a), select(s1, float(b), select(s2, float(c), select(s3, float(d), float(e)))));
  const bay = pick(3.0, 1.6, 4.8, 2.2, 2.6);
  const floorH = pick(3.1, 3.7, 4.6, 3.3, 3.4);
  const winW = pick(0.44, 0.88, 0.62, 0.96, 0.46);
  const winH = pick(0.54, 0.74, 0.46, 0.44, 0.56);
  const litProb = pick(0.32, 0.36, 0.14, 0.3, 0.3);
  const glassy = pick(0.15, 1.0, 0.1, 0.35, 0.15);

  const gu = u.div(bay).toVar();
  const gv = y.div(floorH).toVar();
  const fwU = fwidth(gu).toVar();
  const fwV = fwidth(gv).toVar();
  const winMask = filteredPulse(gu, float(0.5).sub(winW.mul(0.5)), float(0.5).add(winW.mul(0.5)), fwU)
    .mul(filteredPulse(gv, float(0.42).sub(winH.mul(0.5)), float(0.42).add(winH.mul(0.5)), fwV))
    .mul(float(1.0).sub(isRoof))
    .mul(step(1.0, gv))
    .mul(float(1.0).sub(step(info.y.sub(1.2), y)))
    .toVar();
  const cellHash = hash12(floor(vec2(gu, gv)).add(vec2(info.w.mul(0.61), info.w.mul(1.37))));
  const far = smoothstep(0.35, 1.2, max(fwU, fwV)).toVar();
  const lit = mix(step(cellHash, litProb), litProb, far).toVar();

  const bHash = fract(info.w.mul(0.1373));
  const grime = valueNoise(vec2(u.mul(0.45), y.mul(0.05).add(info.w))).toVar();
  const fwY = fwidth(y);
  const parapet = smoothstep(fwY.negate(), fwY, y.sub(info.y.sub(0.85))).mul(float(1.0).sub(isRoof));
  const wallBase = tint.rgb.mul(float(0.84).add(bHash.mul(0.3))).mul(mix(float(0.78), float(1.0), smoothstep(0.0, 9.0, y)));
  const wallCol = mix(wallBase.mul(mix(float(0.86), float(1.07), grime)), wallBase.mul(mix(float(0.62), float(1.3), step(0.55, bHash))), parapet);
  const storefront = float(1.0).sub(step(4.2, y)).mul(float(1.0).sub(isRoof));
  // Window frames & sills (white / cream trim on masonry, dark mullions on glass & warehouses, aluminium on modern)
  const frameMask = filteredPulse(gu, float(0.45).sub(winW.mul(0.5)), float(0.55).add(winW.mul(0.5)), fwU)
    .mul(filteredPulse(gv, float(0.36).sub(winH.mul(0.5)), float(0.45).add(winH.mul(0.5)), fwV))
    .mul(float(1.0).sub(isRoof))
    .mul(step(1.0, gv))
    .mul(float(1.0).sub(step(info.y.sub(1.2), y)));
  const frame = max(frameMask.sub(winMask), 0.0);
  const cFrame = vec3(1.0, 0.98, 0.94).mul(pick(0.58, 0.04, 0.05, 0.34, 0.5));
  // Dark interiors (the sky shows up through Fresnel reflection), some drawn blinds; tinted curtain-wall glass
  const winHash = hash12(floor(vec2(gu, gv)).add(vec2(info.w.mul(1.91), 5.3)));
  const blinds = mix(step(0.84, winHash), float(0.16), far).mul(float(1.0).sub(glassy));
  const cGlass = mix(mix(vec3(0.012, 0.014, 0.017), vec3(0.05, 0.065, 0.08), glassy), srgb(0.56, 0.53, 0.47), blinds);
  const roofCol = mix(srgb(0.30, 0.30, 0.31), srgb(0.66, 0.66, 0.65), step(0.72, bHash));
  let col = mix(wallCol, cFrame, frame);
  col = mix(col, cGlass, winMask);
  col = mix(col, vec3(0.09, 0.085, 0.08), storefront.mul(0.65));
  col = mix(col, roofCol, isRoof);
  mat.colorNode = col;
  mat.roughnessNode = mix(mix(float(0.86), float(0.5), frame), mix(float(0.14), float(0.06), glassy), winMask);
  mat.metalnessNode = winMask.mul(glassy).mul(0.6);

  const night = nightFactorNode();
  const warm = mix(vec3(1.0, 0.66, 0.36), vec3(0.92, 0.86, 0.76), step(0.78, cellHash));
  const dimmer = mix(fract(cellHash.mul(13.7)).mul(0.75).add(0.25), float(0.62), far);
  const shop = storefront.mul(step(0.35, hash12(vec2(floor(gu), info.w)))).mul(0.8);
  mat.emissiveNode = warm.mul(winMask.mul(lit).mul(dimmer).add(shop)).mul(night.mul(0.95).add(cityUniforms.uInteriorGlow.mul(0.1)));
  return mat;
}

function buildBuildingChunks(list, material, chunkSize, name) {
  const chunks = new Map();
  for (const b of list) {
    const key = Math.floor(b.x / chunkSize) + ',' + Math.floor(b.z / chunkSize);
    let arr = chunks.get(key);
    if (!arr) chunks.set(key, (arr = []));
    arr.push(b);
  }
  const meshes = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (const [key, arr] of chunks) {
    const geo = new THREE.BufferGeometry();
    geo.setIndex(BOX_GEO.index);
    geo.setAttribute('position', BOX_GEO.attributes.position);
    geo.setAttribute('normal', BOX_GEO.attributes.normal);
    const info = new Float32Array(arr.length * 4);
    const tint = new Float32Array(arr.length * 4);
    const mesh = new THREE.InstancedMesh(geo, material, arr.length);
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      q.setFromAxisAngle(yAxis, b.rot);
      m.compose(p.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.d));
      mesh.setMatrixAt(i, m);
      info[i * 4] = b.w;
      info[i * 4 + 1] = b.h;
      info[i * 4 + 2] = b.d;
      info[i * 4 + 3] = b.seed;
      tint[i * 4] = toLinear(b.tint[0]);
      tint[i * 4 + 1] = toLinear(b.tint[1]);
      tint[i * 4 + 2] = toLinear(b.tint[2]);
      tint[i * 4 + 3] = b.style;
    }
    geo.setAttribute('bInfo', new THREE.InstancedBufferAttribute(info, 4));
    geo.setAttribute('bTint', new THREE.InstancedBufferAttribute(tint, 4));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = name + ':' + key;
    meshes.push(mesh);
  }
  return meshes;
}

function buildBoroughs(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'Boroughs';

  const landMat = createLandMaterial();
  const terrain = new THREE.Mesh(buildTerrainGeometry(), landMat);
  terrain.name = 'MetroLand';
  terrain.receiveShadow = true;
  group.add(terrain);

  // Buildings: each OpenStreetMap footprint's oriented box on the ground (sunk 1.5 m into slopes)
  const B = METRO_BUILDINGS;
  const list = [];
  const rand = mulberry32(9071);
  for (let i = 0; i < B.length; i += 6) {
    const x = B[i], z = B[i + 1];
    const h = B[i + 5];
    const y = ridgeHeightAt(x, z) - 1.5;
    const tall = h > 45;
    list.push({
      x, y, z, w: B[i + 2], d: B[i + 3], h: h + 1.5, rot: B[i + 4],
      seed: Math.floor(rand() * 1000),
      tint: tall ? [0.62, 0.66, 0.7] : PALETTE[Math.floor(rand() * PALETTE.length)],
      style: tall ? 1 : rand() < 0.15 ? 3 : 0
    });
  }
  const buildingMat = createBoroughBuildingMaterial();
  for (const mesh of buildBuildingChunks(list, buildingMat, 1200, 'MetroBuildings')) group.add(mesh);

  scene.add(group);
  console.info(`[boroughs] ${list.length} metropolitan buildings built in ${(performance.now() - t0).toFixed(0)} ms`);
  return { group, ridgeHeightAt, landAt, colliders: [] };
}

export { buildBoroughs, ridgeHeightAt, landAt as boroughLandAt };
