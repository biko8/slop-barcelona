// Barcelona's streets from OpenStreetMap in the world frame, with the curb-to-curb roadway and sidewalk widths the
// blocks (bcn-blocks.mjs) and the road graph (bcn-roadgraph.mjs) share, and the Eixample's chamfered crossings.
import { roadsOSM, toWorld, log } from './bcn-base.mjs';

const DEG = Math.PI / 180;

// --- Roadways ----------------------------------------------------------------------------------------------------------
// Curb-to-curb width & sidewalk (building line in from the curb) by class, when OpenStreetMap gives no lanes
const CLASS = {
  motorway: [20, 3], motorway_link: [7, 2], trunk: [16, 5], trunk_link: [7, 3], primary: [14, 5], primary_link: [7, 3],
  secondary: [12, 5], secondary_link: [7, 3], tertiary: [10, 5], tertiary_link: [6, 3], unclassified: [8, 3],
  residential: [8, 4], living_street: [5, 1.2], pedestrian: [5, 0.8], busway: [7, 3]
};
// The great avenues mapped as one way: curb-to-curb roadway & sidewalk (their side carriageways are mapped apart)
const WIDE = {
  'Passeig de Gràcia': [34, 13], 'Rambla de Catalunya': [22, 4], 'Passeig de Sant Joan': [22, 8], "Carrer d'Aragó": [18, 6],
  'Avinguda Meridiana': [30, 6], 'Avinguda del Paral·lel': [28, 7], 'Ronda de Sant Antoni': [16, 6], 'Ronda de Sant Pau': [16, 6],
  'Ronda de la Universitat': [16, 6], 'Ronda de Sant Pere': [16, 6], 'Passeig de Lluís Companys': [20, 10], 'Via Laietana': [16, 5],
  'Passeig de Colom': [24, 6], 'Avinguda de Roma': [18, 6], "Avinguda d'Icària": [16, 8], 'Rambla del Poblenou': [16, 4],
  'Carrer de Pere IV': [10, 4], 'Passeig de Joan de Borbó': [16, 8]
};
const TOWN = new Set(['living_street', 'pedestrian']);
const num = (v) => {
  const n = parseFloat(String(v || '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Ways in world coordinates with their roadway (half width r) and sidewalk
const ways = [];
for (const w of roadsOSM) {
  const t = w.tags;
  if (!CLASS[t.highway]) continue;
  if (t.tunnel && t.tunnel !== 'no') continue;
  if (num(t.layer) < 0 || num(t.layer) > 0) continue; // trenches & viaducts (the Rondes) don't bound blocks
  const pts = w.pts.map(([lon, lat]) => toWorld(lon, lat));
  let [width, sidewalk] = CLASS[t.highway];
  const lanes = num(t.lanes);
  if (lanes && !TOWN.has(t.highway)) width = Math.max(width * 0.6, lanes * 3.1 + (lanes >= 2 ? 1.5 : 0.5));
  const tagged = num(t.width);
  if (tagged && tagged > 2 && tagged < 60) width = tagged;
  if (WIDE[t.name] && !(t.oneway === 'yes' && lanes && lanes <= 3)) [width, sidewalk] = WIDE[t.name];
  // Overall heading & length: Cerdà's streets run along the grid axes
  const [ax, az] = pts[0];
  const [bx, bz] = pts[pts.length - 1];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const ang = Math.atan2(bz - az, bx - ax);
  const off = Math.abs((((ang % (Math.PI / 2)) + Math.PI * 2.25) % (Math.PI / 2)) - Math.PI / 4);
  const axis = off < 4 * DEG && len > 12 ? (Math.abs(Math.cos(ang)) > 0.7 ? 'x' : 'z') : null;
  // Cerdà's 20 m streets: 10 m of roadway between 5 m sidewalks, whatever their lanes say
  // (the superilles' calmed & pedestrian streets too: the same 20 m between the building lines)
  const calmed = TOWN.has(t.highway) && axis && len > 60;
  if (axis && !WIDE[t.name] && ((['primary', 'secondary', 'tertiary', 'residential', 'unclassified'].includes(t.highway) && width > 9 && width < 17 && !(lanes > 4)) || calmed)) {
    width = 10;
    sidewalk = 5;
  }
  ways.push({ id: w.id, t, pts, r: width / 2, sidewalk, axis, len, town: TOWN.has(t.highway) && !calmed, w: width, lanes });
}
log(`${ways.length} at-grade ways bound the blocks`);

// --- Xamfrans: the chamfered corners where two of the grid's streets cross ---------------------------------------------
// A building line's corner (Ha, Hb from the crossing: half each street's width to it) is cut by a 45° face 20 m long,
// i.e. the line |dx| + |dz| = Ha + Hb + 14.1; the curb follows it 5 m in (5·√2 less)
const nodeWays = new Map();
for (const w of ways) {
  if (!w.axis || w.town) continue;
  w.pts.forEach(([x, z], i) => {
    const k = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    if (!nodeWays.has(k)) nodeWays.set(k, { x, z, list: [] });
    nodeWays.get(k).list.push(w);
  });
}
const chamfers = [];
for (const { x, z, list } of nodeWays.values()) {
  const ax = list.filter((w) => w.axis === 'x');
  const az = list.filter((w) => w.axis === 'z');
  if (!ax.length || !az.length) continue;
  const Ha = Math.min(...ax.map((w) => w.r + w.sidewalk));
  const Hb = Math.min(...az.map((w) => w.r + w.sidewalk));
  const line = Ha + Hb + 14.1;
  chamfers.push({ x, z, curb: line - 5 * Math.SQRT2, line });
}
log(`${chamfers.length} chamfered grid crossings`);

export { ways, chamfers, CLASS };
