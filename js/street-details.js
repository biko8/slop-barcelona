import * as THREE from 'three/webgpu';
import { Fn, float, color, positionWorld, uniform, mod, fract, step, smoothstep, mix } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SIGNAL_TIMING, blockAt, BLOCKS } from './city-config.js';
import { GEO } from './bcn-geodata.js';
import { cityUniforms, createTreeGrateMaterial, createGodRayMaterial } from './tsl-materials.js';
import { createTreeField } from './trees.js';
import { pavedPlazaRects, parkTreeSites, sidewalkBlocks, parkLampSites } from './city-grid.js';

// Instanced street furniture, traffic signals, trees and nearby light pools.

function createStreetSignBladeTexture(label) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0d6b3f';
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, 248, 56);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 30px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * TSL 3-Aspect Traffic Signal Lens Material (Red y=5.78, Amber y=5.42, Green y=5.06)
 * Driven by the shared signal clock and SIGNAL_TIMING (city-config.js), which js/traffic.js obeys.
 */
function createTrafficSignalLensMaterial(isAvenueHead, clock) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const wy = positionWorld.y;
    const isTopRed = step(5.60, wy);
    const isBottomGreen = float(1.0).sub(step(5.24, wy));
    const isMidAmber = float(1.0).sub(isTopRed).mul(float(1.0).sub(isBottomGreen));

    // Avenue phase: Green, then Amber from avenueAmber, Red from avenueRed
    // Street phase: Red until avenueRed, then Green, Amber from streetAmber
    const greenActive = isAvenueHead
      ? float(1.0).sub(step(avenueAmber, t))
      : step(avenueRed, t).mul(float(1.0).sub(step(streetAmber, t)));
    const amberActive = isAvenueHead
      ? step(avenueAmber, t).mul(float(1.0).sub(step(avenueRed, t)))
      : step(streetAmber, t);
    const redActive = isAvenueHead
      ? step(avenueRed, t)
      : float(1.0).sub(step(avenueRed, t));

    const activeMask = isTopRed.mul(redActive)
      .add(isMidAmber.mul(amberActive))
      .add(isBottomGreen.mul(greenActive));

    const lensHue = mix(
      mix(color(0x18ff68), color(0xffaa10), isMidAmber),
      color(0xff2424),
      isTopRed
    );
    return mix(color(0x14181e), lensHue.mul(1.35), activeMask);
  })();
  return mat;
}

// Pedestrian signal for crossing alongside the avenue: WALK, then a flashing hand until the avenue's amber, then a
// steady hand
function createWalkSignalMaterial(clock) {
  const { cycle, avenueAmber, walk } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const isWalk = float(1.0).sub(step(walk, t));
    const isFlashing = step(walk, t).mul(float(1.0).sub(step(avenueAmber, t)));
    const handLit = float(1.0).sub(isFlashing.mul(step(0.5, fract(t))));
    const hand = mix(color(0x14181e), color(0xff5518), handLit);
    return mix(hand, color(0xf4f9ff), isWalk);
  })();
  return mat;
}

function buildStreetDetails(scene) {
  const group = new THREE.Group();
  group.name = 'StreetDetails';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);

  // Ground footprints of street furniture that traffic and pedestrians must keep clear of
  const footprints = [];
  const addFootprint = (x, z, w, d, pedestrianOnly = false) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, pedestrianOnly });

  // Signal clock (seconds), set every frame by main.js
  const signalClock = uniform(0);

  // Shared materials
  const poleMetalMat = new THREE.MeshStandardNodeMaterial({
    color: 0x3b4046,
    roughness: 0.45,
    metalness: 0.78
  });
  const signalHousingMat = new THREE.MeshStandardNodeMaterial({
    color: 0x2b2d2f, // Barcelona's dark grey signal housings
    roughness: 0.38,
    metalness: 0.35,
    side: THREE.DoubleSide // the tunnel visors are open half-tubes
  });
  const aveSignalLensMat = createTrafficSignalLensMaterial(true, signalClock);
  const streetSignalLensMat = createTrafficSignalLensMaterial(false, signalClock);
  const walkSignalGlow = createWalkSignalMaterial(signalClock);
  // Cobra-head LED streetlight lens & pedestrian post-top globe: pale diffuser by day, warm white after dusk
  const lampBulbGlow = new THREE.MeshBasicNodeMaterial();
  lampBulbGlow.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const pedGlobeGlow = new THREE.MeshBasicNodeMaterial();
  pedGlobeGlow.colorNode = mix(color(0xd4d2c8), color(0xffe4b0).mul(1.95), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const streetBladeMat = new THREE.MeshStandardNodeMaterial({
    map: createStreetSignBladeTexture('5TH AVE · 42 ST'),
    roughness: 0.32
  });

  // 12-inch three-section signal head (origin at its centre, y = 5.42): yellow housing, a tunnel visor over each lens
  // and a hanger to the mast arm, lenses on both faces (+-z) so it reads from both approaches; the lens material
  // picks red / amber / green from each lens's world height (5.78 / 5.42 / 5.06)
  const HEAD_W = 0.4;
  const HEAD_H = 1.12;
  const HEAD_D = 0.28;
  const LENS_R = 0.145;
  const LENS_Y = [0.36, 0, -0.36];
  const bothFaces = (geo) => [geo, geo.clone().rotateY(Math.PI)];
  const signalHousingGeo = mergeGeometries([
    new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D),
    new THREE.BoxGeometry(0.07, 0.2, 0.07).translate(0, HEAD_H / 2 + 0.1, 0),
    ...LENS_Y.flatMap((ly) => bothFaces(
      new THREE.CylinderGeometry(LENS_R + 0.03, LENS_R + 0.03, 0.24, 14, 1, true, Math.PI / 2, Math.PI)
        .rotateX(Math.PI / 2).translate(0, ly, HEAD_D / 2 + 0.12)
    ))
  ].map((g) => g.toNonIndexed()));
  const signalLensGeo = mergeGeometries(LENS_Y.flatMap((ly) => bothFaces(new THREE.CircleGeometry(LENS_R, 18).translate(0, ly, HEAD_D / 2 + 0.004))));
  // Pedestrian signal: housing with the WALK / hand face lit on both sides (+-z, toward the crosswalk's far end)
  const walkHousingGeo = new THREE.BoxGeometry(0.34, 0.4, 0.24);
  const walkPanelGeo = mergeGeometries(bothFaces(new THREE.PlaneGeometry(0.27, 0.31).translate(0, 0, 0.125)));
  // Cobra-head luminaire on the end of the arm: flattened grey housing, flat lens underneath
  const lampHousingGeo = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.7, 0.2, 0.3);
  const lampLensGeo = new THREE.CircleGeometry(1, 16).rotateX(Math.PI / 2).scale(0.6, 1, 0.24).translate(0, -0.005, 0);
  // Classic cast-iron pedestrian post-top globe lightpole (fluted base + shaft + decorative capital + opal globe)
  const pedLampPostGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.11, 0.16, 0.85, 10).translate(0, 0.425, 0),
    new THREE.CylinderGeometry(0.065, 0.085, 2.75, 10).translate(0, 2.22, 0),
    new THREE.CylinderGeometry(0.14, 0.07, 0.16, 10).translate(0, 3.62, 0)
  ].map((g) => g.toNonIndexed()));
  const pedGlobeGeo = new THREE.SphereGeometry(0.23, 8, 6).translate(0, 3.84, 0);

  // =========================================================================
  // 1. TRAFFIC SIGNALS & PEDESTRIAN SIGNALS
  // =========================================================================
  const poleMatrices = [];
  const armMatrices = [];
  const yellowBoxMatrices = [];
  const aveLensMatrices = [];
  const streetLensMatrices = [];
  const streetBladeMatrices = [];
  const walkBoxMatrices = [];
  const audioSignals = [];
  const signalIntersections = [];
  const lampHeadMatrices = [];
  const pedPostMatrices = [];
  const cobraLampSites = [];
  const streetPointSites = [];
  // Only nearby poles can conflict, even with street furniture across the whole island.
  const POLE_CELL = 8;
  const poleCells = new Map();
  function addPole(x, z, width) {
    const key = Math.floor(x / POLE_CELL) + ',' + Math.floor(z / POLE_CELL);
    let cell = poleCells.get(key);
    if (!cell) poleCells.set(key, cell = []);
    cell.push({ x, z });
    // Poles stand on curbs: pedestrians avoid them, but they must not narrow the inferred road gaps.
    addFootprint(x, z, width, width, true);
  }

  const plazaRects = pavedPlazaRects || [];
  const inPlaza = (x, z, m = 1.0) =>
    plazaRects.some((r) => x > r.minX - m && x < r.maxX + m && z > r.minZ - m && z < r.maxZ + m);

  // True only when (x, z) and its surrounding pad-meter footprint sit on a real curb island (never in a road or median)
  const isOnCurbIsland = (x, z, pad = 0.55) => {
    const b = blockAt(x, z);
    if (!b || b.median) return false;
    if (pad <= 0) return true;
    const b1 = blockAt(x - pad, z);
    const b2 = blockAt(x + pad, z);
    const b3 = blockAt(x, z - pad);
    const b4 = blockAt(x, z + pad);
    return !!(b1 && !b1.median && b2 && !b2.median && b3 && !b3.median && b4 && !b4.median);
  };

  // True only when (x, z) is on a non-park, non-median, non-plaza sidewalk with `pad` clearance from all curbs
  const isOnSidewalk = (x, z, pad = 0.55) => {
    if (!isOnCurbIsland(x, z, pad)) return false;
    const b = blockAt(x, z);
    return !(b.park > 0.6) && !inPlaza(x, z, 1.0);
  };

  const isClearOfPoles = (x, z, minDist = 6.0) => {
    const md2 = minDist * minDist;
    for (let ix = Math.floor((x - minDist) / POLE_CELL); ix <= Math.floor((x + minDist) / POLE_CELL); ix++) {
      for (let iz = Math.floor((z - minDist) / POLE_CELL); iz <= Math.floor((z + minDist) / POLE_CELL); iz++) {
        for (const p of poleCells.get(ix + ',' + iz) || []) {
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < md2) return false;
        }
      }
    }
    return true;
  };

  // Signalised junctions (bcn-geodata.js furniture.signals: OpenStreetMap's signals at the road graph's junctions).
  // Barcelona's are poles on the corners — on the xamfrà's curb at the Eixample's crossings — with a short arm over
  // the roadway: the heads for traffic along the grid's z axis hang near the pole, those for traffic along x further
  // out, and the pedestrian head on the pole. Two diagonally opposite corners of each junction get one.
  const S = GEO.furniture.signals;
  const DIAG = [[1, -1], [-1, 1], [1, 1], [-1, -1]];
  for (let k = 0; k < S.length; k += 2) {
    const nx = S[k];
    const nz = S[k + 1];
    // the corners: the first curb island met walking out along each diagonal, the pole a metre onto it
    const corners = [];
    for (const [dx, dz] of DIAG) {
      const ux = dx * Math.SQRT1_2, uz = dz * Math.SQRT1_2;
      for (let r = 4; r <= 32; r += 1) {
        const b = blockAt(nx + ux * r, nz + uz * r);
        if (!b) continue;
        if (b.median) break;
        const px = nx + ux * (r + 1.1), pz = nz + uz * (r + 1.1);
        if (isOnCurbIsland(px, pz, 0.45) && !inPlaza(px, pz, 0.5)) corners.push({ px, pz, ux: -ux, uz: -uz, r });
        break;
      }
    }
    const pair = corners.length >= 2 && corners[0].ux === -corners[1].ux ? corners.slice(0, 2) : corners.slice(0, 2);
    let placedSignal = false;
    for (const { px, pz, ux, uz, r } of pair) {
      if (!isClearOfPoles(px, pz, 5.0)) continue;
      addPole(px, pz, 0.5);
      if (!placedSignal) {
        signalIntersections.push({ x: nx, z: nz });
        placedSignal = true;
      }
      const yaw = Math.atan2(-uz, ux); // the arm's local +x runs from the pole toward the junction
      const reach = Math.min(4.2, Math.max(2.4, r * 0.35));

      // Pole (5.2 m), arm over the roadway
      dummy.position.set(px, 2.7, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(0.13, 5.4, 0.13);
      dummy.updateMatrix();
      poleMatrices.push(dummy.matrix.clone());
      dummy.position.set(px + ux * reach * 0.5, 5.2, pz + uz * reach * 0.5);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(reach, 0.1, 0.1);
      dummy.updateMatrix();
      armMatrices.push(dummy.matrix.clone());

      // Pedestrian head on the pole, facing across the street
      dummy.position.set(px, 2.9, pz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      walkBoxMatrices.push(dummy.matrix.clone());
      audioSignals.push({ x: px, y: 2.9, z: pz, isAvenue: true });

      // Traffic heads: on the pole for the z-axis road, out on the arm for the x-axis one
      for (const [along, rotY, lenses] of [[0.35, 0, aveLensMatrices], [reach - 0.3, Math.PI / 2, streetLensMatrices]]) {
        dummy.position.set(px + ux * along, 4.5, pz + uz * along);
        dummy.rotation.set(0, rotY, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        yellowBoxMatrices.push(dummy.matrix.clone());
        lenses.push(dummy.matrix.clone());
      }
      dummy.rotation.set(0, 0, 0);
    }
  }

  // =========================================================================
  // 2. MID-BLOCK AVENUE & STREET ORNAMENTAL ACORN & COBRA STREETLIGHTS
  //    Placed directly along the true curb edges of every city block (BLOCKS)
  //    and verified with blockAt(x, z) so no pole ever stands in any roadway.
  // =========================================================================
  const allBlocks = BLOCKS || [];

  for (const b of allBlocks) {
    if (!b || !b.poly || b.poly.length < 3 || b.median || b.park > 0.6) continue;

    const poly = b.poly;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 24) continue;

      const ux = dx / len;
      const uz = dz / len;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;

      // Determine inward normal (into the sidewalk block) and outward normal (into the street roadway)
      let inx = -uz;
      let inz = ux;
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) {
        inx = uz;
        inz = -ux;
      }
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) continue;
      const outX = -inx;
      const outZ = -inz;
      // Confirm this curb edge fronts an open roadway
      if (blockAt(mx + outX * 2.5, mz + outZ * 2.5)) continue;

      const isAvenueEdge = Math.abs(uz) > 0.65;
      if (isAvenueEdge) {
        const armYaw = Math.atan2(-outZ, outX);
        const cobraFracs = inx > 0 ? [0.26, 0.72] : [0.32, 0.78];
        for (const f of cobraFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const lx = cx + inx * 1.08;
          const lz = cz + inz * 1.08;
          const headX = lx + outX * 2.6;
          const headZ = lz + outZ * 2.6;
          if (
            !isOnSidewalk(lx, lz, 0.55) ||
            blockAt(cx + outX * 2.5, cz + outZ * 2.5) ||
            blockAt(headX, headZ) ||
            !isClearOfPoles(lx, lz, 6.5)
          ) {
            continue;
          }
          addPole(lx, lz, 0.45);

          // Tall ornamental streetlight pole
          dummy.position.set(lx, 4.3, lz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(0.12, 8.4, 0.12);
          dummy.updateMatrix();
          poleMatrices.push(dummy.matrix.clone());

          // Upper luminaire bracket arm overhanging the street
          dummy.position.set(lx + outX * 1.15, 8.2, lz + outZ * 1.15);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(2.3, 0.09, 0.09);
          dummy.updateMatrix();
          armMatrices.push(dummy.matrix.clone());

          // Cobra-head LED luminaire on the end of the arm, lens facing the street
          dummy.position.set(headX, 8.08, headZ);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          lampHeadMatrices.push(dummy.matrix.clone());
          dummy.rotation.set(0, 0, 0);

          cobraLampSites.push({
            x: headX,
            y: 8.02,
            z: headZ,
            tx: lx + outX * 3.4,
            tz: lz + outZ * 3.4
          });
        }

        // Cast-iron pedestrian post-top globe lightpoles along the sidewalks (with PointLights)
        const pedFracs = len >= 48 ? [0.16, 0.50, 0.84] : [0.24, 0.76];
        for (const f of pedFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.42;
          const pz = cz + inz * 1.42;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.2)
          ) {
            continue;
          }
          addPole(px, pz, 0.4);

          dummy.position.set(px, 0.18, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          pedPostMatrices.push(dummy.matrix.clone());
          streetPointSites.push({
            x: px,
            y: 4.02,
            z: pz,
            color: 0xffe0aa,
            intensity: 30,
            dist: 14.5
          });
        }
      } else if (len >= 36) {
        // Cross-street cast-iron pedestrian post-top globe lightpoles along north and south block curbs
        const crossFracs = len >= 115 ? [0.20, 0.40, 0.60, 0.80] : [0.24, 0.50, 0.76];
        for (const f of crossFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.22;
          const pz = cz + inz * 1.22;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.5)
          ) {
            continue;
          }
          addPole(px, pz, 0.4);

          dummy.position.set(px, 0.18, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          pedPostMatrices.push(dummy.matrix.clone());
          streetPointSites.push({
            x: px,
            y: 4.02,
            z: pz,
            color: 0xffe0aa,
            intensity: 28,
            dist: 14.0
          });
        }
      }
    }
  }

  function addMatrixArrayInstanced(geo, mat, matrices, castShadow = true) {
    if (matrices.length === 0) return;
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    if (castShadow && !mat.isMeshBasicNodeMaterial && mat.type !== 'MeshBasicNodeMaterial' && !mat.transparent) {
      inst.castShadow = true;
      inst.receiveShadow = true;
    }
    for (let i = 0; i < matrices.length; i++) {
      inst.setMatrixAt(i, matrices[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
  }

  addMatrixArrayInstanced(unitCyl, poleMetalMat, poleMatrices);
  addMatrixArrayInstanced(unitBox, poleMetalMat, armMatrices);
  addMatrixArrayInstanced(signalHousingGeo, signalHousingMat, yellowBoxMatrices);
  addMatrixArrayInstanced(signalLensGeo, aveSignalLensMat, aveLensMatrices, false);
  addMatrixArrayInstanced(signalLensGeo, streetSignalLensMat, streetLensMatrices, false);
  addMatrixArrayInstanced(unitBox, streetBladeMat, streetBladeMatrices);
  addMatrixArrayInstanced(walkHousingGeo, signalHousingMat, walkBoxMatrices);
  addMatrixArrayInstanced(walkPanelGeo, walkSignalGlow, walkBoxMatrices, false);
  addMatrixArrayInstanced(lampHousingGeo, poleMetalMat, lampHeadMatrices);
  addMatrixArrayInstanced(lampLensGeo, lampBulbGlow, lampHeadMatrices, false);
  addMatrixArrayInstanced(pedLampPostGeo, poleMetalMat, pedPostMatrices);
  addMatrixArrayInstanced(pedGlobeGeo, pedGlobeGlow, pedPostMatrices, false);

  // =========================================================================
  // 2B. VOLUMETRIC GOLDEN-HOUR CANYON SUN SHAFTS (GOD RAYS)
  // =========================================================================
  const godRayMat = createGodRayMaterial();
  const godRayGeo = new THREE.PlaneGeometry(54, 92);
  // Down the Eixample's long straight streets & Passeig de Gràcia (the Cerdà grid's axes run ~45° to the sun's path)
  const P = GEO.points;
  const canyonShafts = [
    { x: P.casaBatllo[0] - 30, y: 40, z: P.casaBatllo[1] + 40, rotY: 0.32, rotZ: -0.46 },
    { x: P.pedrera[0] - 30, y: 42, z: P.pedrera[1] + 60, rotY: 0.28, rotZ: -0.44 },
    { x: P.universitat[0] + 60, y: 38, z: P.universitat[1] - 70, rotY: 0.25, rotZ: -0.45 },
    { x: P.sagradaFamilia[0] - 200, y: 40, z: P.sagradaFamilia[1] + 70, rotY: 0.3, rotZ: -0.44 }
  ];
  for (const cs of canyonShafts) {
    const shaft = new THREE.Mesh(godRayGeo, godRayMat);
    shaft.position.set(cs.x, cs.y, cs.z);
    shaft.rotation.set(0.12, cs.rotY, cs.rotZ);
    group.add(shaft);
  }

  // =========================================================================
  // 3. METRO DE BARCELONA ENTRANCES: the stair's railing & the red rhombus "M" on its post (OpenStreetMap entrances)
  // =========================================================================
  const subwayRailingMat = new THREE.MeshStandardNodeMaterial({
    color: 0x3b3e40,
    roughness: 0.5,
    metalness: 0.65
  });
  const subwayGlobeMat = new THREE.MeshBasicNodeMaterial({ color: 0xe0281e });

  const subwayRailMatrices = [];
  const subwayPostMatrices = [];
  const subwayGlobeMatrices = [];

  const snapToCurbIsland = (x, z, pad = 1.1) => {
    if (isOnCurbIsland(x, z, pad)) return { x, z };
    for (let r = 2; r <= 18; r += 2) {
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const nx = x + Math.cos(ang) * r;
        const nz = z + Math.sin(ang) * r;
        if (isOnCurbIsland(nx, nz, pad)) return { x: nx, z: nz };
      }
    }
    return { x, z };
  };

  for (const [mx, mz] of GEO.furniture.metro) {
    const { x: subX, z: subZ } = snapToCurbIsland(mx, mz, 1.2);
    if (!isOnCurbIsland(subX, subZ, 1.0)) continue;
    // Iron railing enclosure around sidewalk stairs
    dummy.position.set(subX, 0.8, subZ);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(2.1, 1.15, 6.2);
    dummy.updateMatrix();
    subwayRailMatrices.push(dummy.matrix.clone());
    addFootprint(subX, subZ, 2.1, 6.2);

    // The post with the lit red rhombus "M" at the stair's head
    dummy.position.set(subX + 0.9, 1.5, subZ + 2.9);
    dummy.scale.set(0.08, 3.0, 0.08);
    dummy.updateMatrix();
    subwayPostMatrices.push(dummy.matrix.clone());
    dummy.position.set(subX + 0.9, 3.15, subZ + 2.9);
    dummy.rotation.set(0, 0, Math.PI / 4);
    dummy.scale.set(0.55, 0.55, 0.08);
    dummy.updateMatrix();
    subwayGlobeMatrices.push(dummy.matrix.clone());
    dummy.rotation.set(0, 0, 0);
    streetPointSites.push({ x: subX + 0.9, y: 3.15, z: subZ + 2.9, color: 0xff5040, intensity: 14, dist: 7.5 });
  }
  addMatrixArrayInstanced(unitBox, subwayRailingMat, subwayRailMatrices);
  addMatrixArrayInstanced(unitCyl, subwayRailingMat, subwayPostMatrices);
  addMatrixArrayInstanced(unitBox, subwayGlobeMat, subwayGlobeMatrices, false);

  // =========================================================================
  // 4. BICING DOCKS: a row of docks & red-and-white bikes on the sidewalk (OpenStreetMap stations)
  // =========================================================================
  const dockMat = new THREE.MeshStandardNodeMaterial({ color: 0x8d9295, roughness: 0.4, metalness: 0.7 });
  const bikeMat = new THREE.MeshStandardNodeMaterial({ color: 0xd2232a, roughness: 0.45, metalness: 0.2 });
  const dockMatrices = [];
  const bikeMatrices = [];
  const B = GEO.furniture.bicing;
  for (let k = 0; k < B.length; k += 2) {
    const { x: bx, z: bz } = snapToCurbIsland(B[k], B[k + 1], 1.6);
    if (!isOnSidewalk(bx, bz, 1.2) || !isClearOfPoles(bx, bz, 3)) continue;
    // along the nearer curb: the row runs along x when the roadway is north or south of it
    const alongX = !blockAt(bx, bz - 3) || !blockAt(bx, bz + 3);
    addFootprint(bx, bz, alongX ? 9 : 1.4, alongX ? 1.4 : 9);
    dummy.position.set(bx, 0.62, bz);
    dummy.rotation.set(0, alongX ? 0 : Math.PI / 2, 0);
    dummy.scale.set(8.5, 0.16, 0.22);
    dummy.updateMatrix();
    dockMatrices.push(dummy.matrix.clone());
    for (let i = -3; i <= 3; i++) {
      if (hashPos(bx + i, bz, 3.3) < 0.35) continue;
      const ox = alongX ? i * 1.2 : 0;
      const oz = alongX ? 0 : i * 1.2;
      dummy.position.set(bx + ox, 0.75, bz + oz);
      dummy.rotation.set(0, alongX ? Math.PI / 2 : 0, 0);
      dummy.scale.set(0.12, 0.9, 1.7);
      dummy.updateMatrix();
      bikeMatrices.push(dummy.matrix.clone());
    }
  }
  addMatrixArrayInstanced(unitBox, dockMat, dockMatrices);
  addMatrixArrayInstanced(unitBox, bikeMat, bikeMatrices);

  // =========================================================================
  // 5. CORREOS' YELLOW MAILBOXES on a corner of every few blocks
  // =========================================================================
  const mailboxPositions = [];
  for (const b of BLOCKS) {
    if (b.median || b.park > 0.6 || b.area < 2500 || hashPos(b.cx, b.cz, 5.1) > 0.18) continue;
    // a metre in from the curb, a few metres along from the block's first corner
    const p0 = b.poly[0];
    const p1 = b.poly[1 % b.poly.length];
    const L = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
    const t = Math.min(0.5, 6 / L);
    const mx = p0.x + (p1.x - p0.x) * t + (b.cx - p0.x) * (1.2 / Math.hypot(b.cx - p0.x, b.cz - p0.z));
    const mz = p0.z + (p1.z - p0.z) * t + (b.cz - p0.z) * (1.2 / Math.hypot(b.cx - p0.x, b.cz - p0.z));
    if (isOnSidewalk(mx, mz, 0.45) && isClearOfPoles(mx, mz, 2.5)) mailboxPositions.push([mx, mz]);
  }
  const correosMat = new THREE.MeshStandardNodeMaterial({ color: 0xf2c200, roughness: 0.45, metalness: 0.3 });
  const mailboxInst = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.32, 0.32, 1.1, 12), correosMat, mailboxPositions.length);
  mailboxPositions.forEach(([mx, mz], i) => {
    dummy.position.set(mx, 0.77, mz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    mailboxInst.setMatrixAt(i, dummy.matrix);
    addFootprint(mx, mz, 0.8, 0.8);
  });
  mailboxInst.instanceMatrix.needsUpdate = true;
  group.add(mailboxInst);

  // =========================================================================
  // 6. TREES: PARKS & SQUARES, STREET TREES
  //    Plane trees (plàtans), nettle trees (lledoners) & elms (one unified trunk + crown instanced mesh per species & band)
  // =========================================================================
  const treePositions = []; // { x, y, z, scale, species (0 plane, 1 honey locust, 2 elm / oak) }
  const mixSpecies = (r, plane, locust) => (r < plane ? 0 : (r < plane + locust ? 1 : 2));


  // A. The squares, the parks & the plazas (sites laid out by city-grid.js)
  for (const s of parkTreeSites || []) treePositions.push(s);

  // C & D. Street trees on the raised sidewalks of every real block (city-config.js BLOCKS via the slabs city-grid.js
  //        laid): along every curb — plane trees mostly, nettle trees on the narrow streets, with random missing trees
  //        & the odd unplanted stretch. Never in plazas or parks, nor in the old town's narrow streets.
  const sidewalkTreePositions = [];
  const SIDEWALK_Y = 0.22;
  const swBlocks = sidewalkBlocks || [];
  const onSidewalk = (x, z) => {
    const b = blockAt(x, z);
    return !!b && !(b.park > 0.6) && !b.median;
  };
  // Street trees turn in 90° steps with the crown squeezed across the sidewalk, away from the facades
  function addStreetTree(x, z, scale, species, acrossX, extra = {}) {
    if (!onSidewalk(x, z) || inPlaza(x, z, 1.5) || !isClearOfPoles(x, z, 2.2)) return;
    const q = Math.floor(hashPos(x, 8.8, z) * 3.999);
    const t = { x, y: SIDEWALK_Y, z, scale, species, yaw: q * Math.PI * 0.5, tier: acrossX ? 1 : 2, ...extra };
    if (acrossX === (q % 2 === 0)) t.sx = extra.squeeze || 0.82;
    else t.sz = extra.squeeze || 0.82;
    treePositions.push(t);
    sidewalkTreePositions.push(t);
  }
  // Plane trees line nearly every street of the Eixample & the newer districts; the old town's narrow streets have none
  const NO_TREES = new Set(['gotic', 'raval', 'born', 'barceloneta']);
  const RESIDENTIAL = { has: (d) => !NO_TREES.has(d) };
  const COMMERCIAL = new Set(['glories', 'vila_olimpica']);
  const AVE_SP = 10;
  const CROSS_SP = 10;
  for (const s of swBlocks) {
    const b = s.block;
    if (!b || b.median || b.park > 0.6) continue;
    const res = RESIDENTIAL.has(b.district);
    const x0 = s.cx - s.w * 0.5;
    const x1 = s.cx + s.w * 0.5;
    const z0 = s.cz - s.d * 0.5;
    const z1 = s.cz + s.d * 0.5;
    // C. avenue fronts (the slab's short w / e edges on a grid block)
    if (s.d >= 20 && res) {
      const thin = COMMERCIAL.has(b.district) ? 0.4 : 0.15;
      for (const [x, side] of [[x0 + 1.3, -1], [x1 - 1.3, 1]]) {
        const n = Math.floor((s.d - 10) / AVE_SP) + 1;
        const zs = z0 + (s.d - (n - 1) * AVE_SP) * 0.5;
        for (let i = 0; i < n; i++) {
          const tz = zs + i * AVE_SP;
          if (hashPos(x, 3.1, tz) < thin) continue;
          addStreetTree(x, tz, 0.66 + hashPos(tz, 3.1, x) * 0.14, mixSpecies(hashPos(x, side, tz), 0.78, 0.12), true);
        }
      }
    }
    // D. side-street curbs (residential neighbourhoods)
    if (!res || s.w < 24 || hashPos(s.cx, 4.2, s.cz) < 0.08) continue;
    for (const side of [-1, 1]) {
      const edge = side < 0 ? z0 : z1;
      const narrow = !!blockAt(s.cx, edge + side * 14); // a block across within ~14 m: a narrow side street
      const z = edge - side * (narrow ? 0.9 : 1.25);
      const n = Math.floor((s.w - 7) / CROSS_SP) + 1;
      const xs = s.cx - ((n - 1) * CROSS_SP) * 0.5;
      for (let i = 0; i < n; i++) {
        const x = xs + i * CROSS_SP + (hashPos(i, s.cz, side) - 0.5) * 1.6;
        const r = hashPos(x, 6.1, z);
        if (r < 0.15) continue;
        const species = narrow ? 1 : mixSpecies(hashPos(z, 2.9, x), 0.78, 0.12);
        const scale = narrow ? 0.54 + r * 0.1 : 0.6 + r * 0.24;
        addStreetTree(x, z, scale, species, false, { pitRot: Math.PI / 2, grate: false, pitS: narrow ? 0.7 : 1, squeeze: narrow ? 0.7 : 0.82 });
      }
    }
  }
  console.info(`[streetDetails] ${treePositions.length} trees (${sidewalkTreePositions.length} street trees)`);

  const grateMat = createTreeGrateMaterial();
  const pitCurbMat = new THREE.MeshStandardNodeMaterial({ color: 0x484642, roughness: 0.88 });
  const pitSoilMat = new THREE.MeshStandardNodeMaterial({ color: 0x241c14, roughness: 0.96 });

  // Curbside tree pit surrounds & dark soil beds, with concentric cast-iron grates on the Midtown avenues
  // (pits run along the curb: t.pitRot = PI/2 on cross streets)
  const pitCurbGeo = new THREE.BoxGeometry(1.7, 0.22, 2.6);
  const pitSoilGeo = new THREE.BoxGeometry(1.35, 0.23, 2.25);
  const pitGrateGeo = new THREE.RingGeometry(0.24, 0.82, 12, 1).rotateX(-Math.PI / 2);
  const gratedTrees = sidewalkTreePositions.filter((t) => t.grate !== false);

  const pitCurbInst = new THREE.InstancedMesh(pitCurbGeo, pitCurbMat, sidewalkTreePositions.length);
  const pitSoilInst = new THREE.InstancedMesh(pitSoilGeo, pitSoilMat, sidewalkTreePositions.length);
  const pitGrateInst = new THREE.InstancedMesh(pitGrateGeo, grateMat, Math.max(1, gratedTrees.length));
  pitCurbInst.receiveShadow = true;
  pitSoilInst.receiveShadow = true;
  pitGrateInst.receiveShadow = true;
  pitGrateInst.count = gratedTrees.length;

  sidewalkTreePositions.forEach((t, i) => {
    dummy.rotation.set(0, t.pitRot || 0, 0);
    dummy.scale.set(t.pitS || 1, 1, 1);
    dummy.position.set(t.x, 0.19, t.z);
    dummy.updateMatrix();
    pitCurbInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(t.x, 0.20, t.z);
    dummy.updateMatrix();
    pitSoilInst.setMatrixAt(i, dummy.matrix);
  });
  gratedTrees.forEach((t, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(t.x, 0.225, t.z);
    dummy.updateMatrix();
    pitGrateInst.setMatrixAt(i, dummy.matrix);
  });
  pitCurbInst.instanceMatrix.needsUpdate = true;
  pitSoilInst.instanceMatrix.needsUpdate = true;
  pitGrateInst.instanceMatrix.needsUpdate = true;
  for (const pit of [pitCurbInst, pitSoilInst, pitGrateInst]) pit.computeBoundingSphere();
  group.add(pitCurbInst, pitSoilInst, pitGrateInst);

  function hashPos(x, y, z) {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }

  // Procedural trees (js/trees.js): species skeletons with leaf-spray cards, one instanced mesh per species, variant &
  // level of detail, each tree's level following the camera
  const treeField = createTreeField(scene, treePositions);
  group.add(treeField.group);

  // =========================================================================
  // 7. CLUSTERED STREETLIGHTS & STREET FURNITURE LIGHT POOLS
  // =========================================================================
  for (const s of parkLampSites || []) {
    streetPointSites.push({ x: s.x, y: s.y, z: s.z, color: 0xffe4b4, intensity: 32, dist: 14.0 });
  }

  const STREETLIGHT_SPOT_POOL = 36;
  const STREET_POINT_POOL = 48;
  const STREETLIGHT_DIST = 115;
  const STREET_POINT_DIST = 110;

  const streetLightsGroup = new THREE.Group();
  streetLightsGroup.name = 'StreetClusteredLights';
  scene.add(streetLightsGroup);

  const streetlightSpotPool = [];
  for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
    // Cobra-head LED luminaire: wide downward spread (0.96 rad half-angle) illuminating both road and sidewalk
    const spot = new THREE.SpotLight(0xffe8c2, 0, 25, 0.96, 0.82, 1.25);
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    streetLightsGroup.add(spot, spot.target);
    streetlightSpotPool.push(spot);
  }

  const streetPointPool = [];
  for (let i = 0; i < STREET_POINT_POOL; i++) {
    const pt = new THREE.PointLight(0xffe4b4, 0, 12, 1.35);
    pt.position.set(0, -1000, 0);
    streetLightsGroup.add(pt);
    streetPointPool.push(pt);
  }

  // Source positions are static. Query nearby cells instead of scanning the island every frame.
  const LIGHT_CELL = 128;
  function indexLights(sites) {
    const cells = new Map();
    for (const s of sites) {
      const key = Math.floor(s.x / LIGHT_CELL) + ',' + Math.floor(s.z / LIGHT_CELL);
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = []);
      cell.push(s);
    }
    return cells;
  }
  const cobraCells = indexLights(cobraLampSites);
  const pointCells = indexLights(streetPointSites);

  function nearbyLights(cells, camera, range, active) {
    const { x: cx, y: cy, z: cz } = camera.position;
    const me = camera.matrixWorld.elements;
    const fwdX = -me[8], fwdZ = -me[10];
    let count = 0;
    for (let ix = Math.floor((cx - range) / LIGHT_CELL); ix <= Math.floor((cx + range) / LIGHT_CELL); ix++) {
      for (let iz = Math.floor((cz - range) / LIGHT_CELL); iz <= Math.floor((cz + range) / LIGHT_CELL); iz++) {
        for (const s of cells.get(ix + ',' + iz) || []) {
          const dx = s.x - cx, dz = s.z - cz;
          const d2 = dx * dx + dz * dz + cy * cy;
          if (d2 > range * range) continue;
          const effDist = Math.sqrt(d2) + Math.max(0, 6.0 - dx * fwdX - dz * fwdZ) * 2.8;
          if (effDist >= range) continue;
          s._effDist = effDist;
          active[count++] = s;
        }
      }
    }
    active.length = count;
    if (count > 1) active.sort((a, b) => a._effDist - b._effDist);
    return count;
  }

  const activeCobras = [];
  const activePoints = [];

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function update(camera) {
    if (!camera) return;
    const glow = cityUniforms.uInteriorGlow.value;
    // Increase streetlight intensity toward dusk.
    const lampScale = Math.min(1.25, Math.max(0.0, (glow - 0.36) * 1.15));
    if (lampScale <= 0.001) {
      for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
        streetlightSpotPool[i].intensity = 0;
        streetlightSpotPool[i].position.set(0, -1000, 0);
      }
      for (let i = 0; i < STREET_POINT_POOL; i++) {
        streetPointPool[i].intensity = 0;
        streetPointPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const cobraCount = nearbyLights(cobraCells, camera, STREETLIGHT_DIST, activeCobras);

    const cobraCutoff = cobraCount > STREETLIGHT_SPOT_POOL
      ? Math.min(STREETLIGHT_DIST, activeCobras[STREETLIGHT_SPOT_POOL]._effDist)
      : STREETLIGHT_DIST;
    const spotUsed = Math.min(cobraCount, STREETLIGHT_SPOT_POOL);
    for (let i = 0; i < spotUsed; i++) {
      const s = activeCobras[i];
      const fade = smoothFade(s._effDist, cobraCutoff * 0.62, cobraCutoff);
      const spot = streetlightSpotPool[i];
      spot.position.set(s.x, s.y, s.z);
      spot.target.position.set(s.tx, 0.0, s.tz);
      spot.target.updateMatrixWorld();
      spot.intensity = 88.0 * lampScale * fade;
    }
    for (let i = spotUsed; i < STREETLIGHT_SPOT_POOL; i++) {
      streetlightSpotPool[i].intensity = 0;
      streetlightSpotPool[i].position.set(0, -1000, 0);
    }

    const ptCount = nearbyLights(pointCells, camera, STREET_POINT_DIST, activePoints);

    const ptCutoff = ptCount > STREET_POINT_POOL
      ? Math.min(STREET_POINT_DIST, activePoints[STREET_POINT_POOL]._effDist)
      : STREET_POINT_DIST;
    const ptUsed = Math.min(ptCount, STREET_POINT_POOL);
    for (let i = 0; i < ptUsed; i++) {
      const s = activePoints[i];
      const fade = smoothFade(s._effDist, ptCutoff * 0.62, ptCutoff);
      const pt = streetPointPool[i];
      pt.color.setHex(s.color);
      pt.position.set(s.x, s.y, s.z);
      pt.distance = s.dist;
      pt.intensity = s.intensity * lampScale * fade;
    }
    for (let i = ptUsed; i < STREET_POINT_POOL; i++) {
      streetPointPool[i].intensity = 0;
      streetPointPool[i].position.set(0, -1000, 0);
    }
  }

  scene.add(group);
  return { group, footprints, signalClock, signalIntersections, audioSignals, update };
}

export { buildStreetDetails };
