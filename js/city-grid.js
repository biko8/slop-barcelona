import * as THREE from 'three/webgpu';
import {
  float,
  vec2,
  vec3,
  color,
  uv,
  texture,
  positionWorld,
  normalWorldGeometry,
  fract,
  floor,
  mod,
  sin,
  dot,
  abs,
  min,
  max,
  mix,
  step,
  smoothstep,
  clamp,
  fwidth,
  length,
  screenCoordinate
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ISLAND_BOUNDS, COASTLINE, BLOCKS } from './city-config.js';
import { GEO } from './bcn-geodata.js';
import {
  createRoadSurfaceMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createParkLawnMaterial,
  createParkPavingMaterial,
  createParkLampGlobeMaterial,
  createParkLampPoolMaterial
} from './tsl-materials.js';

// Live construction data consumed by the building and street-detail builders after buildCityGrid().
let centralParkClearings;
let parkTreeSites;
let parkLampSites;
let pavedPlazaRects;
let sidewalkBlocks;

// Barcelona's ground: the sea, the coast, raised sidewalks & curbs, parks, squares and beaches.
// The metropolitan area around the detailed city and its hills are built in boroughs.js.

/**
 * Merges static non-instanced THREE.Mesh objects sharing the same material into a single
 * batched BufferGeometry per material to minimize WebGPU render & shadow pass draw calls.
 */
function batchStaticGroupMeshes(rootGroup, excludeMaterials = null) {
  rootGroup.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(rootGroup.matrixWorld).invert();
  const buckets = new Map();

  rootGroup.traverse((obj) => {
    if (!obj.isMesh || obj.isInstancedMesh || !obj.geometry || !obj.material) return;
    if (excludeMaterials && excludeMaterials.has(obj.material)) return;
    const attrs = obj.geometry.attributes;
    if (!attrs.position || !attrs.normal || !attrs.uv) return;
    if (!buckets.has(obj.material)) {
      buckets.set(obj.material, []);
    }
    buckets.get(obj.material).push(obj);
  });

  for (const [mat, meshes] of buckets.entries()) {
    if (meshes.length < 2) continue;
    const geos = [];
    let anyCast = false;
    let anyReceive = false;

    for (const m of meshes) {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      for (const key of Object.keys(g.attributes)) {
        if (key !== 'position' && key !== 'normal' && key !== 'uv') {
          g.deleteAttribute(key);
        }
      }
      const relMat = new THREE.Matrix4().multiplyMatrices(invRoot, m.matrixWorld);
      g.applyMatrix4(relMat);
      geos.push(g);
      if (m.castShadow) anyCast = true;
      if (m.receiveShadow) anyReceive = true;
      if (m.parent) m.parent.remove(m);
    }

    const merged = mergeGeometries(geos, false);
    if (merged) {
      const batchedMesh = new THREE.Mesh(merged, mat);
      batchedMesh.castShadow = anyCast;
      batchedMesh.receiveShadow = anyReceive;
      rootGroup.add(batchedMesh);
    }
  }
}

/**
 * Helper to convert an array of world {x, z} polygon vertices into a horizontal THREE.Shape
 * in (x, -z) space so that rotating by rotateX(-Math.PI / 2) maps (x, -z, 0) -> (x, 0, z)
 * with an upward (+Y) surface normal.
 */
function createWorldXZShape(pts) {
  const shape = new THREE.Shape();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) shape.moveTo(p.x, -p.z);
    else shape.lineTo(p.x, -p.z);
  }
  shape.closePath();
  return shape;
}

function createExtrudedPolygonMesh(pts, bottomY, height, material, receiveShadow = true, castShadow = false) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bottomY, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  mesh.castShadow = castShadow;
  return mesh;
}

function createFlatPolygonMesh(pts, y, material, receiveShadow = true) {
  const shape = createWorldXZShape(pts);
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

/**
 * Tags every vertex of a mesh using the shared park paving material with its paving style (uv.x, see
 * createParkPavingMaterial: 0 hex asphalt pavers, 1 light granite plaza pavers, 2 bluestone slabs).
 */
/**
 * A simple polygon ([{x, z}], either winding, convex or not) offset inward by d with mitred corners (miters clamped
 * to 3d); null if it collapses
 */
function offsetPolygonInward(pts, d) {
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const s = area > 0 ? 1 : -1; // positive area: the inside lies left of each edge, i.e. along (-dz, dx)
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n];
    const q = pts[i];
    const r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z;
    let bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9;
    const lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s; // inward normals of the two edges
    const n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * d, z: q.z + n1z * d }); continue; }
    mx /= ml; mz /= ml;
    const cos = mx * n1x + mz * n1z; // miter length = d / cos(half angle)
    const len = Math.min(3 * d, d / Math.max(1e-3, cos));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  let a2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) a2 += out[j].x * out[i].z - out[i].x * out[j].z;
  return a2 * area > 0 && Math.abs(a2) < Math.abs(area) ? out : null;
}

/** Polygon offset by d (d > 0 inward, d < 0 outward), mitred corners clamped to 3|d|; null if it degenerates */
function offsetPolygon(pts, d) {
  if (d > 0) return offsetPolygonInward(pts, d);
  const n = pts.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  const s = area > 0 ? -1 : 1; // outward normal side
  const D = -d;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], q = pts[i], r = pts[(i + 1) % n];
    let ax = q.x - p.x, az = q.z - p.z, bx = r.x - q.x, bz = r.z - q.z;
    const la = Math.hypot(ax, az) || 1e-9, lb = Math.hypot(bx, bz) || 1e-9;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az * s, n1z = ax * s, n2x = -bz * s, n2z = bx * s;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { out.push({ x: q.x + n1x * D, z: q.z + n1z * D }); continue; }
    mx /= ml; mz /= ml;
    const len = Math.min(3 * D, D / Math.max(1e-3, mx * n1x + mz * n1z));
    out.push({ x: q.x + mx * len, z: q.z + mz * len });
  }
  return out;
}

function setPavingStyle(geo, style) {
  const uvAttr = geo.attributes.uv;
  for (let i = 0; i < uvAttr.count; i++) uvAttr.setXY(i, style, 0);
  uvAttr.needsUpdate = true;
  return geo;
}

function buildCityGrid(scene) {
  const group = new THREE.Group();
  group.name = 'CityGrid';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);

  // Ground footprints that traffic and pedestrians must keep clear of (medians, plazas, monuments, parks)
  const footprints = [];
  const addFootprint = (x, z, w, d) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });

  // =========================================================================
  // 1. THE MEDITERRANEAN & THE PORT'S BASINS: one water plane out to the horizon
  // =========================================================================
  const waterMat = createWaterMaterial();
  const harborWaterGeo = new THREE.PlaneGeometry(60000, 60000, 1, 1);
  harborWaterGeo.rotateX(-Math.PI / 2);
  const harborWaterMesh = new THREE.Mesh(harborWaterGeo, waterMat);
  harborWaterMesh.position.set(0, ISLAND_BOUNDS.waterLevel, -50);
  group.add(harborWaterMesh);

  // =========================================================================
  // 2. THE QUAYS' STONE EDGE & THE ROADWAY ASPHALT DECK (Y = 0) OVER THE DETAILED CITY'S LAND
  // =========================================================================
  const seawallMat = new THREE.MeshStandardNodeMaterial({
    color: 0x6b655c,
    roughness: 0.82,
    metalness: 0.1
  });
  // The moll's stone face a little proud of the deck edge, down to the water
  const seawallPolygon = offsetPolygon(COASTLINE, -1.5) || COASTLINE;
  group.add(createExtrudedPolygonMesh(seawallPolygon, -2.35, 2.31, seawallMat, true, false));
  const roadMat = createRoadSurfaceMaterial();
  group.add(createFlatPolygonMesh(COASTLINE, 0.0, roadMat, true));

  // =========================================================================
  // 3. PARK LAWN MATERIALS
  // =========================================================================
  const cpLawnMat = createParkLawnMaterial(false);
  const cpMeadowMat = createParkLawnMaterial(true);

  // =========================================================================
  // 4. RAISED SIDEWALKS & GRANITE CURBSTONES: every real curb island of Barcelona (city-config.js BLOCKS, from the
  //    street centreline at its curb-to-curb widths). Rectangular islands are instanced slabs; the rest (the
  //    Eixample's chamfered illes, Ciutat Vella's irregular blocks, the medians down Gran Via & Diagonal)
  //    are extruded from their outlines
  // =========================================================================
  const sidewalkMat = createSidewalkMaterial();
  const curbMat = createCurbMaterial();
  const medianHedgeMat = new THREE.MeshStandardNodeMaterial({ color: 0x366e3b, roughness: 0.82 });
  const blockSidewalks = []; // { cx, cz, w, d, block } axis-aligned slabs (irregular islands: their lot cover)
  const roadSidewalks = []; // the curbs road-network.js bounds the roads with (medians go in as footprints)
  const slabGeos = [];
  const curbGeos = [];
  const hedgeGeos = [];
  const SW_TOP = 0.22;
  for (const b of BLOCKS) {
    if (b.park > 0.6 && !b.median && b.parkName !== 'Bryant Park') continue; // parks build their own perimeter sidewalk (sections 7, 7B)
    if (b.rect) {
      const slab = { cx: (b.minX + b.maxX) * 0.5, cz: (b.minZ + b.maxZ) * 0.5, w: b.maxX - b.minX, d: b.maxZ - b.minZ, block: b };
      blockSidewalks.push(slab);
      if (b.median) addFootprint(slab.cx, slab.cz, slab.w, slab.d);
      else roadSidewalks.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    } else {
      // curb (granite) ring under a sidewalk slab inset by 0.25 m, like the instanced pair below
      const curb = createExtrudedPolygonMesh(b.poly, 0.0, 0.18, curbMat).geometry;
      curbGeos.push(curb);
      const inner = offsetPolygonInward(b.poly, 0.25);
      if (inner) slabGeos.push(createExtrudedPolygonMesh(inner, 0.03, SW_TOP - 0.03, sidewalkMat).geometry);
      // rect cover for the consumers that work on rectangles: the lot rects grown back out to the curb
      for (const [x0, x1, z0, z1] of b.rects) {
        const r = { minX: x0 - 4.4, maxX: x1 + 4.4, minZ: z0 - 4.4, maxZ: z1 + 4.4 };
        blockSidewalks.push({ cx: (r.minX + r.maxX) * 0.5, cz: (r.minZ + r.maxZ) * 0.5, w: r.maxX - r.minX, d: r.maxZ - r.minZ, block: b, cover: true });
        if (!b.median) roadSidewalks.push(r);
      }
      if (b.median) addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
    }
    // Planted medians down Gran Via, Diagonal, Meridiana...: a clipped hedge on the slab
    if (b.median && Math.min(b.maxX - b.minX, b.maxZ - b.minZ) > 2.2) {
      const hedge = offsetPolygonInward(b.poly, 1.0);
      if (hedge) hedgeGeos.push(createExtrudedPolygonMesh(hedge, SW_TOP, 0.55, medianHedgeMat).geometry);
    }
  }
  const mergeInto = (geos, mat, cast = false) => {
    for (let i = 0; i < geos.length; i += 400) {
      const m = new THREE.Mesh(mergeGeometries(geos.slice(i, i + 400), false), mat);
      m.receiveShadow = true;
      m.castShadow = cast;
      group.add(m);
    }
  };
  mergeInto(curbGeos, curbMat, true);
  mergeInto(slabGeos, sidewalkMat);
  mergeInto(hedgeGeos, medianHedgeMat, true);

  const rectSlabs = blockSidewalks.filter((s) => !s.cover);
  const swInstanced = new THREE.InstancedMesh(unitBox, sidewalkMat, rectSlabs.length);
  const curbInstanced = new THREE.InstancedMesh(unitBox, curbMat, rectSlabs.length);
  swInstanced.receiveShadow = true;
  curbInstanced.receiveShadow = true;
  curbInstanced.castShadow = true;

  rectSlabs.forEach((blk, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(blk.cx, 0.125, blk.cz);
    dummy.scale.set(blk.w - 0.5, 0.19, blk.d - 0.5);
    dummy.updateMatrix();
    swInstanced.setMatrixAt(i, dummy.matrix);

    dummy.position.set(blk.cx, 0.095, blk.cz);
    dummy.scale.set(blk.w, 0.17, blk.d);
    dummy.updateMatrix();
    curbInstanced.setMatrixAt(i, dummy.matrix);
  });
  swInstanced.instanceMatrix.needsUpdate = true;
  curbInstanced.instanceMatrix.needsUpdate = true;
  group.add(swInstanced, curbInstanced);

  // 5. Street furniture shared by the parks, squares & promenades (instanced at the end of section 6)
  const pavingMat = createParkPavingMaterial();
  const graniteMat = new THREE.MeshStandardNodeMaterial({ color: 0x86837c, roughness: 0.8 }); // benches, planters, copings
  const benchMatrices = []; // slatted park benches
  const lampMatrices = []; // cast-iron lampposts with glass globes
  const treeSites = []; // { x, y, z, scale, species } park & plaza trees planted by street-details.js (section 7)
  const pavedRects = []; // plaza & park slab bounds, exported so street trees (street-details.js) stay off them

  function addBench(x, y, z, rotY) {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, rotY, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    benchMatrices.push(dummy.matrix.clone());
  }
  function addLamp(x, y, z) {
    lampMatrices.push(new THREE.Matrix4().makeTranslation(x, y, z));
  }

  // No park fills a district here (no woodland clearings to keep for street-details.js)
  centralParkClearings = null;

  // 6. Parks, squares & beaches on their real blocks (bcn-geodata.js land cover): hex-paver walks, stone-coped lawn
  //    beds under scattered trees, paved squares with plane trees & benches, sand
  const PARK_Y = ISLAND_BOUNDS.parkPavingHeight; // hex-paver walks (sidewalk tops are at 0.22)
  const BED_Y = 0.41; // lawn top inside the granite bed copings
  const parkLawnGeos = [];
  const inPolygon = (x, z, pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
    }
    return inside;
  };
  const prand = (x, z, k = 0) => {
    const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
    return s - Math.floor(s);
  };

  // ---- Parks (Ciutadella, Montjuïc's gardens, the Eixample's interior gardens...): the curb island paved like a park
  //      walk, a stone-coped lawn inset from it under scattered trees (big planes along the walk), lampposts on the
  //      perimeter
  const sandMat = new THREE.MeshStandardNodeMaterial({ color: 0xd8c49a, roughness: 1.0 });
  const parks = BLOCKS.filter((b) => b.park > 0.6 && !b.median && b.area > 250);
  const lampsAlong = (ring, y, step) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      for (let t = step / 2; t < len - 8; t += step) addLamp(a.x + ((c.x - a.x) * t) / len, y, a.z + ((c.z - a.z) * t) / len);
    }
  };
  for (const b of parks) {
    addFootprint((b.minX + b.maxX) * 0.5, (b.minZ + b.maxZ) * 0.5, b.maxX - b.minX, b.maxZ - b.minZ);
    pavedRects.push({ minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ });
    // Beaches: a sand fan from the promenade's edge, no curb
    if (b.beach > b.park && b.beach > b.square) {
      group.add(createFlatPolygonMesh(b.poly, 0.06, sandMat, true));
      continue;
    }
    const slab = offsetPolygonInward(b.poly, 0.1) || b.poly;
    group.add(createExtrudedPolygonMesh(b.poly, 0.0, PARK_Y - 0.04, curbMat, true, false));
    const top = createExtrudedPolygonMesh(slab, 0.0, PARK_Y, pavingMat, true, false);
    group.add(top);
    // Squares (Plaça de Catalunya, Plaça Reial, the Eixample's xamfrà squares...): paved, plane trees on a grid in
    // their own pits, benches between them
    if (b.square >= b.park) {
      setPavingStyle(top.geometry, 1);
      const inner = offsetPolygonInward(b.poly, 3.5);
      if (!inner) continue;
      const SP = 9;
      for (let gx = b.minX + SP * 0.5; gx < b.maxX; gx += SP) {
        for (let gz = b.minZ + SP * 0.5; gz < b.maxZ; gz += SP) {
          if (!inPolygon(gx, gz, inner) || prand(gx, gz, 11) < 0.35) continue;
          if (prand(gx, gz, 12) < 0.2) addBench(gx, PARK_Y, gz, Math.floor(prand(gz, gx, 13) * 4) * Math.PI * 0.5);
          else treeSites.push({ x: gx, y: PARK_Y, z: gz, scale: 0.9 + prand(gx, gz, 3) * 0.3, species: 0 });
        }
      }
      lampsAlong(inner, PARK_Y, 26);
      continue;
    }
    setPavingStyle(top.geometry, 0);
    const bed = offsetPolygonInward(b.poly, Math.min(5, Math.min(b.maxX - b.minX, b.maxZ - b.minZ) * 0.2));
    if (!bed) continue;
    group.add(createExtrudedPolygonMesh(bed, 0.2, BED_Y - 0.21, graniteMat, true, false));
    const lawnTop = offsetPolygonInward(bed, 0.3);
    if (lawnTop) parkLawnGeos.push(createExtrudedPolygonMesh(lawnTop, 0.3, BED_Y - 0.3, cpLawnMat).geometry);
    // trees on a jittered grid inside the bed: planes, nettle trees & the odd stone pine
    const SP = 11;
    for (let gx = b.minX + SP * 0.5; gx < b.maxX; gx += SP) {
      for (let gz = b.minZ + SP * 0.5; gz < b.maxZ; gz += SP) {
        const tx = gx + (prand(gx, gz) - 0.5) * SP * 0.7;
        const tz = gz + (prand(gz, gx, 1) - 0.5) * SP * 0.7;
        if (prand(tx, tz, 9) < 0.3) continue; // glades
        const inner = lawnTop || bed;
        if (!inPolygon(tx, tz, inner)) continue;
        const r = prand(tx, tz, 2);
        treeSites.push({ x: tx, y: BED_Y, z: tz, scale: 0.9 + prand(tx, tz, 3) * 0.4, species: r < 0.55 ? 0 : (r < 0.75 ? 1 : 2) });
      }
    }
    lampsAlong(slab, PARK_Y, 34);
  }

  // The beaches (and the zoo's sandy enclosures): sand over their real outlines, just above the promenade's slab
  for (const b of GEO.beaches) {
    const pts = [];
    for (let i = 0; i < b.ring.length; i += 2) pts.push({ x: b.ring[i], z: b.ring[i + 1] });
    if (pts.length < 3) continue;
    group.add(createFlatPolygonMesh(pts, SW_TOP + 0.015, sandMat, true));
    const xs = pts.map((p) => p.x);
    const zs = pts.map((p) => p.z);
    pavedRects.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) });
  }

  // The water in the parks (Ciutadella's lake, Montjuïc's ponds & fountains) over their lawns
  for (const w of GEO.water) {
    const pts = [];
    for (let i = 0; i < w.ring.length; i += 2) pts.push({ x: w.ring[i], z: w.ring[i + 1] });
    if (pts.length < 3) continue;
    group.add(createFlatPolygonMesh(pts, BED_Y + 0.02, waterMat, true));
  }

  // One merged lawn mesh for every park
  if (parkLawnGeos.length) {
    const parkLawnMesh = new THREE.Mesh(mergeGeometries(parkLawnGeos, false), cpLawnMat);
    parkLawnMesh.receiveShadow = true;
    group.add(parkLawnMesh);
  }

  // Instanced plaza & park furniture: slatted benches (seat facing +z) & cast-iron lampposts with globes
  if (benchMatrices.length) {
    const benchGeo = mergeGeometries([
      new THREE.BoxGeometry(1.9, 0.06, 0.46).translate(0, 0.45, 0.02),
      new THREE.BoxGeometry(1.9, 0.34, 0.05).rotateX(-0.22).translate(0, 0.74, -0.22),
      new THREE.BoxGeometry(0.07, 0.45, 0.52).translate(-0.86, 0.225, 0),
      new THREE.BoxGeometry(0.07, 0.45, 0.52).translate(0.86, 0.225, 0),
      new THREE.BoxGeometry(0.06, 0.06, 0.5).translate(-0.9, 0.62, 0.02),
      new THREE.BoxGeometry(0.06, 0.06, 0.5).translate(0.9, 0.62, 0.02)
    ]);
    const benchMat = new THREE.MeshStandardNodeMaterial({ color: 0x34503a, roughness: 0.66, metalness: 0.15 });
    const benchInst = new THREE.InstancedMesh(benchGeo, benchMat, benchMatrices.length);
    benchMatrices.forEach((m, i) => benchInst.setMatrixAt(i, m));
    benchInst.instanceMatrix.needsUpdate = true;
    benchInst.castShadow = true;
    benchInst.receiveShadow = true;
    benchInst.computeBoundingSphere();
    group.add(benchInst);
  }
  if (lampMatrices.length) {
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.15, 0.2, 0.7, 8).translate(0, 0.35, 0),
      new THREE.CylinderGeometry(0.055, 0.085, 3.1, 8).translate(0, 2.25, 0),
      new THREE.CylinderGeometry(0.13, 0.07, 0.2, 8).translate(0, 3.85, 0)
    ]);
    const poleMat = new THREE.MeshStandardNodeMaterial({ color: 0x1c201d, roughness: 0.45, metalness: 0.6 });
    const globeGeo = new THREE.SphereGeometry(0.27, 12, 8).translate(0, 4.17, 0);
    const poleInst = new THREE.InstancedMesh(poleGeo, poleMat, lampMatrices.length);
    const globeInst = new THREE.InstancedMesh(globeGeo, createParkLampGlobeMaterial(), lampMatrices.length);
    lampMatrices.forEach((m, i) => {
      poleInst.setMatrixAt(i, m);
      globeInst.setMatrixAt(i, m);
    });
    poleInst.instanceMatrix.needsUpdate = true;
    globeInst.instanceMatrix.needsUpdate = true;
    poleInst.castShadow = true;
    poleInst.computeBoundingSphere();
    globeInst.computeBoundingSphere();
    group.add(poleInst, globeInst);

    // Warm pools of lamplight on the walks & bed copings after dusk (additive decal, black by day)
    const poolInst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), createParkLampPoolMaterial(), lampMatrices.length);
    const poolM = new THREE.Matrix4();
    lampMatrices.forEach((m, i) => {
      poolInst.setMatrixAt(i, poolM.makeScale(14, 1, 14).setPosition(m.elements[12], m.elements[13] + 0.17, m.elements[14]));
    });
    poolInst.instanceMatrix.needsUpdate = true;
    poolInst.computeBoundingSphere();
    group.add(poolInst);
  }

  // Park & plaza tree and lamp sites, read by street-details.js after the city grid is built
  parkTreeSites = treeSites;
  parkLampSites = lampMatrices.map((m) => ({ x: m.elements[12], y: m.elements[13] + 4.17, z: m.elements[14] }));
  pavedPlazaRects = pavedRects;
  sidewalkBlocks = blockSidewalks; // { cx, cz, w, d } raised sidewalk slabs (cross-street tree rows)

  // The seafront promenade, the beaches and the squares are built with the parks above; no shore highway runs at grade
  const highwayLanes = [];

  // Batch static sub-meshes by material to reduce per-frame WebGPU draw calls
  batchStaticGroupMeshes(group, new Set([waterMat, roadMat, cpLawnMat, cpMeadowMat]));

  scene.add(group);

  // Raised sidewalk blocks bound the roads (the planted medians down Gran Via, Diagonal & co. are obstacles in the
  // roadway, handed over with the footprints)
  const sidewalks = roadSidewalks;
  const colliders = [];
  return { group, sidewalks, footprints, highwayLanes, colliders };
}

export {
  buildCityGrid,
  batchStaticGroupMeshes,
  centralParkClearings,
  parkTreeSites,
  parkLampSites,
  pavedPlazaRects,
  sidewalkBlocks
};
