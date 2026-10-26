import assert from 'node:assert/strict';
import test from 'node:test';

// The generated geography (js/bcn-geodata.js, tools/build-bcn-geodata.mjs) in the frame the city is built in
const { GEO } = await import('../js/bcn-geodata.js');
const { BLOCKS, ROADS, LANDMARK_SITES, TELEPORT_LOCATIONS, blockAt, onLand, lonLatToWorld, districtAt } = await import('../js/city-config.js');

test('the frame is turned to the Cerdà grid and centred on Plaça de Catalunya', () => {
  assert.ok(GEO.frame.bearingDeg > -46 && GEO.frame.bearingDeg < -43.5, `grid north bearing ${GEO.frame.bearingDeg}°`);
  const origin = lonLatToWorld(GEO.frame.lon0, GEO.frame.lat0);
  assert.ok(Math.hypot(origin.x, origin.z) < 0.01);
  // Carrer d'Aragó runs along grid x, Carrer de Balmes along grid z (through the Eixample, below the Diagonal)
  for (const [name, along] of [["Carrer d'Aragó", 'x'], ['Carrer de Balmes', 'z']]) {
    let ax = 0, az = 0;
    for (const r of ROADS.filter((road) => road.name === name)) {
      for (let i = 1; i < r.pts.length; i++) {
        if (r.pts[i].z < -1100 || r.pts[i - 1].z < -1100) continue;
        ax += Math.abs(r.pts[i].x - r.pts[i - 1].x);
        az += Math.abs(r.pts[i].z - r.pts[i - 1].z);
      }
    }
    const ratio = along === 'x' ? az / ax : ax / az;
    assert.ok(ratio < 0.06, `${name} runs along the grid's ${along} axis (cross ratio ${ratio.toFixed(3)})`);
  }
});

test('the Eixample is built of chamfered illes on a 133 m pitch', () => {
  const illes = BLOCKS.filter((b) => b.illa);
  assert.ok(illes.length > 200, `${illes.length} illes`);
  let off = 0;
  for (const b of illes) {
    const [x0, x1, z0, z1, c] = b.illa;
    assert.ok(x1 - x0 > 50 && x1 - x0 < 140 && z1 - z0 > 50 && z1 - z0 < 140, 'a building-line square');
    assert.ok(c > 10 && c < 20, 'the xamfrà');
    if (blockAt((x0 + x1) / 2, (z0 + z1) / 2) !== b) off++;
  }
  // (a passage cut into the odd illa's middle — Passatge Permanyer & co. — takes its centre off it)
  assert.ok(off < illes.length * 0.02, `${off} illes' centres lie off their own curb island`);
  // the regular blocks of the Esquerra de l'Eixample repeat every ~133.3 m (113.3 m blocks, 20 m streets)
  const row = illes.filter((b) => Math.abs((b.illa[2] + b.illa[3]) / 2 + 640) < 50).map((b) => (b.illa[0] + b.illa[1]) / 2).sort((a, b) => a - b);
  // (Passeig de Gràcia, Rambla de Catalunya & the wider streets widen their gaps: the typical step is the pitch)
  const steps = row.slice(1).map((x, i) => x - row[i]).filter((d) => d < 150).sort((a, b) => a - b);
  assert.ok(steps.length > 5);
  const median = steps[steps.length >> 1];
  assert.ok(Math.abs(median - 133.3) < 1.5, `pitch ${median.toFixed(1)} m`);
});

test('the road graph links real nodes, and every link keeps to the land', () => {
  const { nodes, links, names } = GEO.roadGraph;
  const n = nodes.length / 2;
  assert.ok(links.length > 3000);
  for (const [a, b, name, w, , dir] of links) {
    assert.ok(a >= 0 && a < n && b >= 0 && b < n && a !== b);
    assert.ok(name >= 0 && name < names.length);
    assert.ok(w >= 2 && w <= 60, `width ${w}`);
    assert.ok([-1, 0, 1].includes(dir));
  }
});

test('landmarks, teleports & districts sit where they are', () => {
  for (const name of ['Basílica de la Sagrada Família', 'Casa Batlló', 'Casa Milà', 'Torre Glòries', 'Arc de Triomf', 'Monument a Colom']) {
    assert.ok(LANDMARK_SITES[name], name);
    assert.ok(onLand(LANDMARK_SITES[name].x, LANDMARK_SITES[name].z), `${name} stands on the detailed city's land`);
  }
  const sf = LANDMARK_SITES['Basílica de la Sagrada Família'];
  const expected = lonLatToWorld(2.17436, 41.40363);
  assert.ok(Math.hypot(sf.x - expected.x, sf.z - expected.z) < 40, 'the basilica at its real coordinates');
  for (const [name, p] of Object.entries(TELEPORT_LOCATIONS)) assert.ok(onLand(p.x, p.z), `${name} lands on land`);
  assert.equal(districtAt(LANDMARK_SITES['Catedral de la Santa Creu i Santa Eulàlia'].x, LANDMARK_SITES['Catedral de la Santa Creu i Santa Eulàlia'].z), 'gotic');
  assert.equal(districtAt(sf.x, sf.z), 'eixample');
  // the sea off the Barceloneta is not land
  const sea = lonLatToWorld(2.2, 41.37);
  assert.equal(onLand(sea.x, sea.z), false);
});
