// Barcelona's drivable street centrelines as a graph (js/road-network.js builds the traffic lanes from it): every
// OpenStreetMap way is cut at the nodes it shares with another drivable way (the intersections) and at its ends; the
// pieces become links between merged nodes, with their curb-to-curb width, travel lanes and direction of travel.
import { geo, rdp, pointInRing, log } from './bcn-base.mjs';
import { ways } from './bcn-ways.mjs';

const MERGE = 1.0; // m: piece ends this close are the same node
const DRIVE = new Set(['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'busway']);

export function buildRoadGraph() {
  const D = geo.DETAIL;
  const inDetail = ([x, z]) => x > D.x0 && x < D.x1 && z > D.z0 && z < D.z1 && pointInRing(geo.land, x, z);
  const drive = ways.filter((w) => DRIVE.has(w.t.highway) && w.t.access !== 'no' && w.pts.some(inDetail));
  // vertices shared by two drivable ways (or twice by one) are intersections
  const key = ([x, z]) => `${Math.round(x * 100)},${Math.round(z * 100)}`;
  const uses = new Map();
  for (const w of drive) for (const p of w.pts) uses.set(key(p), (uses.get(key(p)) || 0) + 1);

  const nodes = [];
  const cells = new Map();
  const cellKey = (ix, iz) => ix * 100003 + iz;
  function nodeAt(x, z) {
    const ix = Math.floor(x / MERGE), iz = Math.floor(z / MERGE);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const id of cells.get(cellKey(ix + dx, iz + dz)) || []) {
          if (Math.hypot(nodes[id][0] - x, nodes[id][1] - z) <= MERGE) return id;
        }
      }
    }
    const id = nodes.length;
    nodes.push([x, z]);
    const k = cellKey(ix, iz);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(id);
    return id;
  }
  const names = [];
  const nameIds = new Map();
  const nameId = (n) => {
    if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); }
    return nameIds.get(n);
  };
  const links = [];
  for (const w of drive) {
    const t = w.t;
    const oneway = t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1' || (t.junction === 'roundabout' && t.oneway !== 'no')
      ? 1 : t.oneway === '-1' || t.oneway === 'reverse' ? -1 : 0;
    const lanes = w.lanes ? Math.round(w.lanes) : 0;
    let piece = [w.pts[0]];
    const flush = () => {
      if (piece.length < 2) return;
      if (!piece.some(inDetail)) return;
      const a = nodeAt(...piece[0]);
      const b = nodeAt(...piece[piece.length - 1]);
      if (a === b) return;
      links.push([a, b, nameId(t.name || ''), Math.round(w.w * 10) / 10, lanes, oneway, rdp(piece, 0.4)]);
    };
    for (let i = 1; i < w.pts.length; i++) {
      piece.push(w.pts[i]);
      if (i < w.pts.length - 1 && uses.get(key(w.pts[i])) > 1) {
        flush();
        piece = [w.pts[i]];
      }
    }
    flush();
  }
  // keep only the nodes the links use, renumbered
  const used = new Map();
  const outNodes = [];
  const idOf = (i) => {
    if (!used.has(i)) { used.set(i, outNodes.length / 2); outNodes.push(Math.round(nodes[i][0] * 10) / 10, Math.round(nodes[i][1] * 10) / 10); }
    return used.get(i);
  };
  const outLinks = links.map(([a, b, n, w, lanes, dir, line]) => {
    const ia = idOf(a), ib = idOf(b);
    const inner = line.slice(1, -1).flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
    return [ia, ib, n, w, lanes, dir, inner];
  });
  log(`road graph: ${outNodes.length / 2} nodes, ${outLinks.length} links from ${drive.length} drivable ways`);
  return { nodes: outNodes, links: outLinks, names };
}
