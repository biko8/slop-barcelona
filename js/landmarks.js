import * as THREE from 'three/webgpu';
import { Fn, float, color, mix, step, fract, atan, positionLocal, smoothstep } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANDMARK_SITES, nearestRoads, lonLatToWorld } from './city-config.js';
import { batchStaticGroupMeshes } from './city-grid.js';
import { ridgeHeightAt } from './boroughs.js';

// Barcelona's landmarks as procedural models on their real OpenStreetMap footprints (city-config.js LANDMARK_SITES):
// Gaudí's Sagrada Família, Casa Batlló & La Pedrera, Torre Glòries, the Arc de Triomf, the Columbus column, the W
// hotel's sail, the Olympic port's twin towers, the Gothic cathedral & Santa Maria del Mar, and Plaça d'Espanya's
// Venetian towers. Each stands in a group whose local -z faces the street it fronts.

// No lawn raised above the sidewalks (controllers.js reads one landmarks.js may lay out)
const bryantParkLawn = null;

function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'Landmarks';
  const colliders = [];

  const mat = (color, roughness = 0.8, metalness = 0.0, extra = {}) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness, ...extra });
  const M = {
    sandstone: mat(0xb9a27c, 0.9),
    sandstoneNew: mat(0xd5c8ad, 0.85),
    stone: mat(0xd8cbb0, 0.82),
    darkStone: mat(0x8f8270, 0.9),
    brick: mat(0xa65a3e, 0.88),
    bronze: mat(0x5a5040, 0.45, 0.7),
    gold: mat(0xc9a24a, 0.35, 0.8),
    iron: mat(0x2b2a28, 0.5, 0.6),
    glass: mat(0x5f8898, 0.12, 0.6),
    darkGlass: mat(0x2f4450, 0.1, 0.7),
    steel: mat(0xc9ced2, 0.3, 0.85),
    white: mat(0xf2efe8, 0.5),
    tileGreen: mat(0x3f8f86, 0.35, 0.1),
    tileOrange: mat(0xc86a3a, 0.4, 0.1),
    tileBlue: mat(0x3a5fa0, 0.35, 0.1),
    mosaic: mat(0x7fa8b8, 0.4, 0.1),
    cream: mat(0xe0d4ba, 0.85),
    fruit: mat(0xd84b3a, 0.45, 0.1),
    fruitGold: mat(0xe8c24c, 0.4, 0.2)
  };

  // Geometry helpers in a landmark's local frame
  const add = (g, geo, m, x = 0, y = 0, z = 0, cast = true) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  const box = (g, w, h, d, x, y0, z, m) => add(g, new THREE.BoxGeometry(w, h, d), m, x, y0 + h / 2, z);
  const cyl = (g, r0, r1, h, x, y0, z, m, seg = 16) => add(g, new THREE.CylinderGeometry(r1, r0, h, seg), m, x, y0 + h / 2, z);
  const lathe = (g, prof, x, y0, z, m, seg = 16) => add(g, new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg), m, x, y0, z);

  // A landmark's group on its footprint, turned so local -z faces `front` (a unit vector in world x, z)
  function place(name, fallback) {
    const s = LANDMARK_SITES[name] || fallback;
    if (!s) return null;
    const g = new THREE.Group();
    g.position.set(s.x, 0, s.z);
    g.name = name;
    group.add(g);
    return { g, s };
  }
  const faceToward = (g, fx, fz) => (g.rotation.y = Math.atan2(-fx, -fz));
  // The direction from (x, z) to the nearest stretch of the named street (or the nearest street at all)
  function toward(x, z, roadName) {
    const near = nearestRoads(x, z, 200);
    const r = (roadName && near.find((n) => n.road.name === roadName)) || near[0];
    if (!r) return [0, -1];
    let best = null;
    for (let i = 0; i + 1 < r.road.pts.length; i++) {
      const a = r.road.pts[i];
      const b = r.road.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const px = a.x + dx * t, pz = a.z + dz * t;
      const d = Math.hypot(px - x, pz - z);
      if (!best || d < best.d) best = { d, px, pz };
    }
    const dx = best.px - x, dz = best.pz - z;
    // snapped to the grid's axes when it is nearly along one (Eixample frontages)
    const L = Math.hypot(dx, dz) || 1;
    let ux = dx / L, uz = dz / L;
    if (Math.abs(ux) > 0.9) [ux, uz] = [Math.sign(ux), 0];
    else if (Math.abs(uz) > 0.9) [ux, uz] = [0, Math.sign(uz)];
    return [ux, uz];
  }
  function collide(g) {
    g.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(g);
    colliders.push({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z, minY: 0, maxY: b.max.y });
  }

  // Gaudí's bell-tower stone: the shaft's spiral of louvred openings (dark slits between ribs), fading out near the top
  function towerStone(base) {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88 });
    m.colorNode = Fn(() => {
      const p = positionLocal;
      const around = fract(atan(p.z, p.x).mul(16.0 / (Math.PI * 2)).add(p.y.mul(0.012)));
      const slit = step(around, 0.32).mul(step(0.35, fract(p.y.mul(0.55))));
      const fade = float(1.0).sub(smoothstep(0.55, 0.78, p.y.div(140.0)));
      return mix(color(base), color(0x2b2620), slit.mul(fade).mul(0.85));
    })();
    return m;
  }
  const towerOld = towerStone(0xb9a27c);
  const towerNew = towerStone(0xd5c8ad);

  // Gaudí's spindle towers: a parabolic shaft narrowing to a mosaic pinnacle
  function spindle(g, x, z, h, r, m, top = M.fruit) {
    const prof = [];
    const shaft = h * 0.82;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      prof.push([r * Math.max(0.05, 1 - Math.pow(t, 2.2) * 0.92), t * shaft]);
    }
    lathe(g, prof, x, 0, z, m === M.sandstone ? towerOld : m === M.sandstoneNew ? towerNew : m, 14);
    // the pinnacle: a bishop's-mitre crown of mosaic & a ball
    lathe(g, [[r * 0.32, 0], [r * 0.42, h * 0.07], [r * 0.18, h * 0.14], [0.01, h * 0.18]], x, shaft - h * 0.02, z, top, 10);
    add(g, new THREE.IcosahedronGeometry(Math.max(0.8, r * 0.24), 0), M.fruitGold, x, h, z);
  }

  // =========================================================================
  // SAGRADA FAMÍLIA: nave & transept, the Nativity (+x, Carrer de la Marina) & Passion (−x, Sardenya) facades with
  // four bell towers each, the Glory facade on Mallorca (+z), the four Evangelists, Mary's tower over the apse with its
  // star and Jesus' tower at the crossing (172.5 m)
  // =========================================================================
  {
    const p = place('Basílica de la Sagrada Família');
    if (p) {
      const { g } = p;
      const nave = M.sandstoneNew;
      // nave (z) & transept (x) with the aisles, buttressed walls & a clerestory
      box(g, 46, 30, 92, 0, 0, 0, nave);
      box(g, 22, 45, 90, 0, 0, 0, M.sandstoneNew);
      box(g, 62, 30, 30, 0, 0, 6, nave);
      box(g, 20, 45, 60, 0, 0, 6, M.sandstoneNew).rotation.y = Math.PI / 2;
      // the nave's & transept's steep gabled roofs
      const gable = (w, h, d) => {
        const shape = new THREE.Shape();
        shape.moveTo(-w / 2, 0);
        shape.lineTo(0, h);
        shape.lineTo(w / 2, 0);
        shape.closePath();
        return new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false }).translate(0, 0, -d / 2);
      };
      add(g, gable(23, 14, 90), M.sandstoneNew, 0, 45, 0);
      add(g, gable(21, 13, 60), M.sandstoneNew, 0, 45, 6).rotation.y = Math.PI / 2;
      for (let z = -38; z <= 38; z += 9.5) for (const x of [-23.5, 23.5]) spindle(g, x, z, 38 + (z % 2 ? 4 : 0), 1.6, M.sandstoneNew, M.tileOrange);
      // apse (Provença, −z): a semicircle of chapels crowned by pinnacles
      lathe(g, [[19, 0], [19, 30], [16, 36], [9, 44], [0.1, 48]], 0, 0, -46, M.sandstoneNew, 14);
      for (let k = 0; k < 7; k++) {
        const a = Math.PI * (0.15 + (0.7 * k) / 6);
        spindle(g, Math.cos(a) * 19.5, -46 - Math.sin(a) * 19.5, 40, 2.0, M.sandstoneNew, M.tileGreen);
      }
      // Nativity facade (+x) — the oldest stone, darker — and Passion facade (−x): four bell towers each
      for (const [x, m, hs, porch] of [[34, M.sandstone, [98, 107, 107, 98], M.sandstone], [-34, M.sandstoneNew, [107, 112, 112, 107], M.darkStone]]) {
        [-8, 1, 11, 20].forEach((z, i) => spindle(g, x, z, hs[i], i === 0 || i === 3 ? 4.2 : 4.8, m));
        box(g, 8, 36, 26, x - Math.sign(x) * 2, 0, 6, porch);
        for (const z of [-2, 6, 14]) lathe(g, [[3.2, 0], [3.2, 14], [1.8, 22], [0.1, 28]], x + Math.sign(x) * 2.5, 0, z, porch, 12);
      }
      // Glory facade (Mallorca, +z): its porch & the stumps of its four towers
      box(g, 52, 34, 10, 0, 0, 48, M.sandstoneNew);
      for (const x of [-18, -6, 6, 18]) cyl(g, 4.6, 4.2, 46, x, 0, 52, M.sandstoneNew, 14);
      // the four Evangelists (135 m) round the crossing, Mary's tower with its star (138 m), Jesus' tower (172.5 m)
      for (const [x, z] of [[-12, -6], [12, -6], [-12, 18], [12, 18]]) spindle(g, x, z, 135, 5.5, M.sandstoneNew, M.white);
      spindle(g, 0, -24, 138, 6.5, M.sandstoneNew, M.white);
      add(g, new THREE.OctahedronGeometry(3.4, 0), mat(0xfff4d0, 0.3, 0.2, { emissive: 0xffe9b0, emissiveIntensity: 0.6 }), 0, 140, -24);
      spindle(g, 0, 6, 166, 8.5, M.sandstoneNew, M.white);
      const cross = new THREE.Group();
      cross.position.set(0, 166, 6);
      box(cross, 1.6, 13, 1.6, 0, 0, 0, M.white);
      box(cross, 9, 1.6, 1.6, 0, 8, 0, M.white);
      box(cross, 1.6, 1.6, 9, 0, 8, 0, M.white);
      g.add(cross);
      collide(g);
    }
  }

  // =========================================================================
  // CASA BATLLÓ (Passeig de Gràcia 43): bone-like stone galleries on the ground floors, the mosaic facade above with
  // its skull-mask balconies, the dragon's-back roof of glazed scales and the turret's four-armed cross
  // =========================================================================
  {
    const p = place('Casa Batlló');
    if (p) {
      const { g, s } = p;
      const [fx, fz] = toward(s.x, s.z, 'Passeig de Gràcia');
      faceToward(g, fx, fz);
      const W = Math.min(s.w, s.d) || 15; // frontage
      const D = Math.max(s.w, s.d) || 50; // depth into the block
      const front = -D / 2;
      box(g, W, 22, D, 0, 0, 0, M.cream);
      // mosaic facade: a gently waving skin of broken tiles
      const skin = new THREE.PlaneGeometry(W, 15, 24, 10);
      const pos = skin.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 0.9) * 0.25 + Math.sin(pos.getY(i) * 1.3 + pos.getX(i)) * 0.18);
      skin.computeVertexNormals();
      add(g, skin, M.mosaic, 0, 14.5, front - 0.35).rotation.y = Math.PI;
      // the bones: columns of the main floor's gallery & the skull-mask balconies
      for (let x = -W / 2 + 1.5; x < W / 2 - 1; x += 2.4) lathe(g, [[0.35, 0], [0.22, 2.5], [0.4, 3.6], [0.18, 6.5]], x, 0, front - 0.8, M.cream, 8);
      box(g, W - 0.6, 1.2, 1.4, 0, 6.5, front - 0.6, M.cream);
      for (let y = 9; y < 20; y += 3.4) {
        for (let x = -W / 2 + 2.2; x < W / 2 - 1.5; x += 3.6) {
          const mask = add(g, new THREE.SphereGeometry(0.9, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.iron, x, y, front - 0.6);
          mask.scale.set(1, 0.9, 0.7);
          mask.rotation.x = Math.PI / 2;
        }
      }
      // the dragon's back: a ridge of glazed scales from blue through green to pink, and the turret with its cross
      const back = new THREE.CapsuleGeometry(2.6, W - 4.8, 6, 16);
      const ridge = add(g, back, M.tileGreen, 0, 23.4, front + 3.2);
      ridge.rotation.z = Math.PI / 2;
      ridge.scale.set(1, 1, 1.25);
      for (let i = 0; i < 9; i++) {
        const sc = add(g, new THREE.SphereGeometry(0.75, 8, 6), [M.tileBlue, M.tileGreen, M.tileOrange][i % 3], -W / 2 + 2.4 + i * ((W - 4.8) / 8), 26, front + 3.2);
        sc.scale.set(1, 0.6, 1.3);
      }
      cyl(g, 1.3, 1.1, 6.5, -W / 2 + 1.8, 22, front + 1.4, M.cream, 12);
      add(g, new THREE.SphereGeometry(1.25, 12, 10), M.fruitGold, -W / 2 + 1.8, 29.2, front + 1.4);
      box(g, 0.35, 2.6, 0.35, -W / 2 + 1.8, 30, front + 1.4, M.fruitGold);
      box(g, 1.8, 0.35, 0.35, -W / 2 + 1.8, 31.2, front + 1.4, M.fruitGold);
      collide(g);
    }
  }

  // =========================================================================
  // LA PEDRERA (Casa Milà): the rippling limestone cliff on the corner of Passeig de Gràcia & Provença, wrought-iron
  // kelp balconies, and the roof's stair towers & chimney warriors
  // =========================================================================
  {
    const p = place('Casa Milà');
    if (p) {
      const { g, s } = p;
      const [fx, fz] = toward(s.x, s.z, 'Passeig de Gràcia');
      faceToward(g, fx, fz);
      const W = Math.max(s.w, s.d) || 55;
      const D = Math.min(s.w, s.d) || 35;
      // each storey a slab of the plan with its street faces rippling in and out (the courtyards left open)
      const storeys = 7;
      const H = 3.3;
      for (let f = 0; f < storeys; f++) {
        const shape = new THREE.Shape();
        const n = 40;
        const wave = (t, k) => Math.sin(t * Math.PI * 6 + f * 0.9 + k) * 0.9 + Math.sin(t * Math.PI * 13 + f) * 0.3;
        shape.moveTo(-W / 2, D / 2);
        for (let i = 0; i <= n; i++) shape.lineTo(-W / 2 + (W * i) / n, -D / 2 + wave(i / n, 0)); // front (−z)
        for (let i = 0; i <= n / 2; i++) shape.lineTo(W / 2 + wave(i / (n / 2), 2) * 0.8, -D / 2 + (D * i) / (n / 2)); // side
        shape.lineTo(-W / 2, D / 2);
        const hole = new THREE.Path();
        hole.absellipse(-W * 0.18, 0, W * 0.13, D * 0.22, 0, Math.PI * 2);
        const hole2 = new THREE.Path();
        hole2.absellipse(W * 0.22, D * 0.05, W * 0.12, D * 0.2, 0, Math.PI * 2);
        shape.holes.push(hole, hole2);
        const geo = new THREE.ExtrudeGeometry(shape, { depth: H - 0.15, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.35, bevelSegments: 2, curveSegments: 8 });
        geo.rotateX(Math.PI / 2);
        add(g, geo, M.cream, 0, (f + 1) * H, 0);
        // the dark window band set back between the ledges
        if (f < storeys - 1) box(g, W - 2, 1.6, D - 2, 0, f * H + 0.9, 0, M.iron);
      }
      // the attic & the roof's warriors: twisted chimneys & stair towers in broken tile & stone
      box(g, W - 6, 2.4, D - 6, 0, storeys * H, 0, M.cream);
      const top = storeys * H + 2.4;
      for (let i = 0; i < 22; i++) {
        const x = -W / 2 + 4 + ((i * 7.3) % (W - 8));
        const z = -D / 2 + 4 + ((i * 5.1) % (D - 8));
        const h = 2.5 + (i % 4) * 0.8;
        const c = lathe(g, [[0.7, 0], [0.4, h * 0.5], [0.75, h * 0.8], [0.3, h]], x, top, z, i % 5 === 0 ? M.tileGreen : M.cream, 6);
        c.rotation.y = i;
      }
      collide(g);
    }
  }

  // =========================================================================
  // TORRE GLÒRIES (Jean Nouvel, 144 m): a rounded bullet of glass louvres over red & blue panels, lit up at night
  // =========================================================================
  {
    const p = place('Torre Glòries');
    if (p) {
      const { g } = p;
      const prof = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        prof.push([18.5 * Math.sqrt(Math.max(0, 1 - Math.pow(t, 3.2))) + 0.1, t * 144]);
      }
      lathe(g, prof, 0, 0, 0, mat(0x9a3b3a, 0.55, 0.2, { emissive: 0x401018, emissiveIntensity: 0.25 }), 40);
      const skin = prof.map(([r, y]) => [r + 0.6, y]);
      lathe(g, skin, 0, 0, 0, mat(0x9fb6c6, 0.1, 0.6, { transparent: true, opacity: 0.45 }), 40).castShadow = false;
      collide(g);
    }
  }

  // =========================================================================
  // ARC DE TRIOMF (1888): red brick arch with its stone friezes at the top of Passeig de Lluís Companys
  // =========================================================================
  {
    const p = place('Arc de Triomf');
    if (p) {
      const { g, s } = p;
      const [fx, fz] = s.w > s.d ? [0, 1] : [1, 0];
      faceToward(g, fx, fz);
      const W = Math.max(s.w, s.d) || 28;
      const D = Math.min(s.w, s.d) || 12;
      const pier = (W - 12) / 2;
      for (const x of [-(W - pier) / 2, (W - pier) / 2]) {
        box(g, pier, 20, D, x, 0, 0, M.brick);
        for (const z of [-D / 2 + 0.6, D / 2 - 0.6]) {
          box(g, 1.4, 22, 1.4, x - pier / 2 + 0.7, 0, z, M.brick);
          box(g, 1.4, 22, 1.4, x + pier / 2 - 0.7, 0, z, M.brick);
          add(g, new THREE.ConeGeometry(1.1, 3, 8), M.stone, x - pier / 2 + 0.7, 23.5, z);
          add(g, new THREE.ConeGeometry(1.1, 3, 8), M.stone, x + pier / 2 - 0.7, 23.5, z);
        }
      }
      const arch = new THREE.Shape();
      arch.moveTo(-6, 0);
      arch.absarc(0, 0, 6, Math.PI, 0, true);
      arch.lineTo(6, 8);
      arch.lineTo(-6, 8);
      arch.closePath();
      const archGeo = new THREE.ExtrudeGeometry(arch, { depth: D, bevelEnabled: false, curveSegments: 20 });
      archGeo.translate(0, 0, -D / 2);
      add(g, archGeo, M.brick, 0, 14, 0);
      box(g, W, 2.2, D + 0.6, 0, 21.5, 0, M.stone); // frieze
      box(g, W - 4, 4, D - 1, 0, 23.7, 0, M.brick); // attic
      box(g, W - 3, 0.6, D, 0, 27.7, 0, M.stone);
      collide(g);
    }
  }

  // =========================================================================
  // MONUMENT A COLOM (1888): Columbus on his iron column over the port, 57 m
  // =========================================================================
  {
    const p = place('Monument a Colom');
    if (p) {
      const { g } = p;
      cyl(g, 13, 12, 2, 0, 0, 0, M.stone, 8); // steps
      cyl(g, 9, 8.5, 6, 0, 2, 0, M.stone, 8); // plinth with the lions
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        box(g, 1.6, 1.8, 3, Math.cos(a) * 9.6, 2, Math.sin(a) * 9.6, M.bronze).rotation.y = -a;
      }
      cyl(g, 5.5, 4.2, 12, 0, 8, 0, M.stone, 8); // pedestal
      cyl(g, 1.7, 1.4, 26, 0, 20, 0, M.iron, 16); // column
      cyl(g, 3.2, 3.2, 2.5, 0, 46, 0, M.iron, 16); // capital & globe
      add(g, new THREE.SphereGeometry(2.4, 14, 10), M.gold, 0, 50.5, 0);
      cyl(g, 0.7, 0.6, 4.5, 0, 52.5, 0, M.bronze, 8); // Columbus pointing out to sea
      box(g, 2.6, 0.35, 0.35, 1.3, 55.6, 0, M.bronze);
      collide(g);
    }
  }

  // =========================================================================
  // HOTEL W (la Vela, 99 m): a glass sail on the end of the Barceloneta's new breakwater
  // =========================================================================
  {
    const s = LANDMARK_SITES['W Barcelona'];
    if (s) {
      const g = new THREE.Group();
      g.position.set(s.x, 0, s.z);
      group.add(g);
      // the sail's bow points out to sea (+z, grid south); the podium spreads round its foot
      const sail = new THREE.Shape();
      sail.moveTo(-34, 0);
      sail.quadraticCurveTo(-18, 70, 10, 99);
      sail.quadraticCurveTo(26, 50, 34, 0);
      sail.closePath();
      const sailGeo = new THREE.ExtrudeGeometry(sail, { depth: 24, bevelEnabled: true, bevelThickness: 3, bevelSize: 3, bevelSegments: 4, curveSegments: 24 });
      sailGeo.translate(0, 0, -12);
      const sm = add(g, sailGeo, M.darkGlass, 0, 0, 0);
      sm.rotation.y = Math.PI / 2;
      box(g, 70, 9, 70, 0, 0, 0, M.white);
      collide(g);
    }
  }

  // =========================================================================
  // HOTEL ARTS & TORRE MAPFRE (154 m): the Olympic port's twin towers, Arts' white steel frame showing outside its
  // glass, Mapfre's banded glass
  // =========================================================================
  for (const [name, frame] of [['Hotel Arts', true], ['Torre Mapfre', false]]) {
    const p = place(name);
    if (!p) continue;
    const { g, s } = p;
    const W = Math.min(34, Math.max(s.w, 28));
    const H = s.h || 154;
    box(g, W - 4, H, W - 4, 0, 0, 0, frame ? M.darkGlass : M.glass);
    if (frame) {
      // the exoskeleton: corner columns & a diagonal-braced grid every few floors
      const pole = new THREE.BoxGeometry(0.9, H, 0.9);
      const geos = [];
      for (let i = 0; i <= 4; i++) {
        const u = -W / 2 + (W * i) / 4;
        for (const v of [-W / 2, W / 2]) {
          geos.push(pole.clone().translate(u, H / 2, v), pole.clone().translate(v, H / 2, u));
        }
      }
      for (let y = 4; y < H; y += 12) {
        geos.push(new THREE.BoxGeometry(W, 0.7, 0.7).translate(0, y, -W / 2), new THREE.BoxGeometry(W, 0.7, 0.7).translate(0, y, W / 2));
        geos.push(new THREE.BoxGeometry(0.7, 0.7, W).translate(-W / 2, y, 0), new THREE.BoxGeometry(0.7, 0.7, W).translate(W / 2, y, 0));
      }
      add(g, mergeGeometries(geos), M.white, 0, 0, 0);
    } else {
      for (let y = 4; y < H; y += 4) box(g, W - 3.4, 0.5, W - 3.4, 0, y, 0, M.steel);
    }
    box(g, W + 18, 8, W + 18, 0, 0, 0, M.white); // podium
    collide(g);
  }

  // =========================================================================
  // CATEDRAL DE BARCELONA: the neo-Gothic facade with its central spire (70 m) & two side towers, the nave's
  // buttresses and the octagonal bell towers of the transept
  // =========================================================================
  {
    const p = place('Catedral de la Santa Creu i Santa Eulàlia');
    if (p) {
      const { g, s } = p;
      const [fx, fz] = toward(s.x, s.z, 'Pla de la Seu');
      faceToward(g, fx, fz);
      const W = Math.min(s.w, s.d, 50);
      const L = Math.max(s.w, s.d, 80) - 10;
      box(g, W * 0.55, 30, L, 0, 0, 0, M.darkStone);
      box(g, W, 20, L - 6, 0, 0, 3, M.darkStone);
      for (let z = -L / 2 + 8; z < L / 2 - 4; z += 7) for (const x of [-W / 2, W / 2]) box(g, 2, 24, 2.5, x, 0, z, M.darkStone);
      const roof = add(g, new THREE.CylinderGeometry(0.3, W * 0.4, 9, 4), M.darkStone, 0, 34.5, 0);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(1, 1, L / (W * 0.55));
      // facade on the square: the central spire & two side towers with their pinnacles
      const fz0 = -L / 2;
      box(g, W * 0.9, 34, 4, 0, 0, fz0, M.stone);
      for (const x of [-W * 0.32, W * 0.32]) {
        box(g, 7, 42, 7, x, 0, fz0 + 1, M.stone);
        add(g, new THREE.ConeGeometry(4.2, 14, 8), M.stone, x, 49, fz0 + 1);
      }
      box(g, 9, 48, 9, 0, 0, fz0 + 6, M.stone);
      add(g, new THREE.ConeGeometry(5.6, 24, 8), M.stone, 0, 60, fz0 + 6);
      for (const x of [-W * 0.42, W * 0.42]) cyl(g, 3.6, 3.4, 52, x, 0, 4, M.darkStone, 8);
      collide(g);
    }
  }

  // =========================================================================
  // SANTA MARIA DEL MAR (1329-1383): Catalan Gothic, sheer walls, a rose window & two octagonal towers
  // =========================================================================
  {
    const p = place('Basílica de Santa Maria del Mar');
    if (p) {
      const { g, s } = p;
      const W = Math.min(s.w, s.d, 34);
      const L = Math.max(s.w, s.d, 70) - 8;
      faceToward(g, ...(s.w > s.d ? [-1, 0] : [0, -1]));
      box(g, W, 30, L, 0, 0, 0, M.sandstone);
      const roof = add(g, new THREE.CylinderGeometry(0.3, W * 0.62, 6, 4), M.sandstone, 0, 33, 0);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(1, 1, L / W);
      lathe(g, [[W / 2, 0], [W / 2, 22], [W / 2 - 2, 30], [0.1, 30]], 0, 0, L / 2 - 2, M.sandstone, 14);
      add(g, new THREE.CircleGeometry(4.2, 24), mat(0x5a4a7a, 0.2, 0.3, { emissive: 0x3a2a5a, emissiveIntensity: 0.3 }), 0, 21, -L / 2 - 0.05).rotation.y = Math.PI;
      for (const x of [-W / 2 + 3, W / 2 - 3]) cyl(g, 3.6, 3.2, 42, x, 0, -L / 2 + 3, M.sandstone, 8);
      collide(g);
    }
  }

  // =========================================================================
  // PLAÇA D'ESPANYA: the two Venetian towers (47 m) framing the avenue up to Montjuïc
  // =========================================================================
  {
    const font = LANDMARK_SITES["Font de la Plaça d'Espanya"] || { x: -2184, z: -289 };
    const mnac = LANDMARK_SITES['Palau Nacional'] || { x: -2427, z: 505 };
    const ux = mnac.x - font.x;
    const uz = mnac.z - font.z;
    const L = Math.hypot(ux, uz) || 1;
    const along = [ux / L, uz / L];
    const across = [-along[1], along[0]];
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(font.x + along[0] * 120 + across[0] * side * 26, 0, font.z + along[1] * 120 + across[1] * side * 26);
      box(g, 7.5, 38, 7.5, 0, 0, 0, M.brick);
      for (let y = 6; y < 38; y += 8) box(g, 8.2, 0.7, 8.2, 0, y, 0, M.stone);
      box(g, 8.6, 3, 8.6, 0, 38, 0, M.stone);
      cyl(g, 2.6, 2.2, 3, 0, 41, 0, M.brick, 8);
      add(g, new THREE.ConeGeometry(2.6, 5, 8), M.tileGreen, 0, 46.5, 0);
      group.add(g);
      collide(g);
    }
    // the Font Màgica's basin & the monumental fountain in the roundabout
    const fm = LANDMARK_SITES['Font Màgica de Montjuïc'];
    if (fm) {
      const g = new THREE.Group();
      g.position.set(fm.x, 0, fm.z);
      cyl(g, 24, 24, 0.9, 0, 0, 0, M.stone, 32);
      add(g, new THREE.CylinderGeometry(22.5, 22.5, 0.2, 32), mat(0x3d6f86, 0.1, 0.4), 0, 0.85, 0);
      group.add(g);
    }
    const g = new THREE.Group();
    g.position.set(font.x, 0, font.z);
    cyl(g, 16, 16, 1.2, 0, 0, 0, M.stone, 24);
    cyl(g, 4, 3.4, 14, 0, 1.2, 0, M.stone, 12);
    add(g, new THREE.ConeGeometry(2.4, 8, 12), M.gold, 0, 19, 0);
    group.add(g);
    collide(g);
  }

  // The Torre de Collserola (Foster, 288 m to its mast) on its ridge above the city, at its real place on the hills
  // boroughs.js raises there
  {
    const t = LANDMARK_SITES['Torre de Collserola'] || lonLatToWorld(2.1142, 41.4172);
    const g = new THREE.Group();
    g.position.set(t.x, ridgeHeightAt(t.x, t.z) - 2, t.z);
    g.name = 'Torre de Collserola';
    cyl(g, 2.4, 2.0, 288, 0, 0, 0, M.white, 12);
    for (let i = 0; i < 13; i++) box(g, 30 - i * 0.4, 1.6, 30 - i * 0.4, 0, 84 + i * 4.6, 0, M.steel).rotation.y = Math.PI / 4;
    group.add(g);
  }

  // (the bell towers' stone reads its openings from each tower's own frame: they stay separate meshes)
  batchStaticGroupMeshes(group, new Set([towerOld, towerNew]));
  scene.add(group);
  return { group, colliders };
}

export { buildLandmarks, bryantParkLawn };
