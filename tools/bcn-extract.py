"""Extract the OpenStreetMap layers the Barcelona geodata generator needs from a .osm.pbf into tools/data/bcn_*.json.

usage: python3 tools/bcn-extract.py path/to/Barcelona.osm.pbf
       (needs pyosmium: pip install osmium; the BBBike extract is download.bbbike.org/osm/bbbike/Barcelona/)

Outputs (lon/lat, rounded to 1e-7), every feature clipped to the bounding box below by its vertices:
  bcn_roads.json      highway ways (roads, pedestrian streets) with the tags the road graph uses
  bcn_coast.json      natural=coastline ways
  bcn_areas.json      parks, gardens, grass, woods, beaches, water, pedestrian squares (ways & multipolygons)
  bcn_buildings.json  building footprints: [centroid lon, lat, area m², levels | null, height | null, name,
                      bearing of the long side (°), length & width of the oriented bounding box (m)]
  bcn_landmarks.json  named buildings & monuments the landmark builders look up (outline rings)
  bcn_points.json     street furniture points: metro entrances, traffic signals, Bicing docks, fountains
© OpenStreetMap contributors, ODbL 1.0.
"""
import json
import math
import os
import sys

import osmium

BBOX = (41.340, 2.090, 41.445, 2.245)  # lat0, lon0, lat1, lon1: the detailed grid rectangle (tools/bcn-base.mjs) and a margin
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

ROAD_TAGS = ('highway', 'name', 'oneway', 'lanes', 'width', 'junction', 'bridge', 'tunnel', 'layer', 'area', 'maxspeed', 'busway', 'cycleway')
SKIP_HIGHWAYS = {'steps', 'path', 'footway', 'cycleway', 'track', 'bridleway', 'corridor', 'proposed', 'construction',
                 'platform', 'raceway', 'elevator', 'bus_stop', 'services', 'rest_area', 'via_ferrata', 'escape'}
LANDMARK_NAMES = {
    'Basílica de la Sagrada Família', 'Casa Batlló', 'Casa Milà', 'La Pedrera', 'Arc de Triomf', 'Torre Glòries',
    'Monument a Colom', 'Hotel W Barcelona', 'W Barcelona', 'Catedral de Barcelona', 'Catedral de la Santa Creu i Santa Eulàlia',
    'Basílica de Santa Maria del Mar', 'Palau de la Música Catalana', 'Mercat de Sant Josep de la Boqueria',
    'Gran Teatre del Liceu', 'Palau Nacional', 'Museu Nacional d\'Art de Catalunya', 'Hotel Arts', 'Torre Mapfre',
    'Casa Amatller', 'Casa Lleó Morera', 'Universitat de Barcelona', 'Hospital de Sant Pau', 'Recinte Modernista de Sant Pau',
    'Estació de França', 'Mercat de Santa Caterina', 'Castell dels Tres Dragons', 'Torre de Collserola', 'Las Arenas',
    'Arenas de Barcelona', 'Mercat de Sant Antoni', 'Edifici Fòrum', 'Font Màgica de Montjuïc', 'Plaça de Catalunya',
}


def inside(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


def r7(v):
    return round(v, 7)


def ring_area_m2(pts):
    lat0 = math.radians(pts[0][1])
    kx = 111320 * math.cos(lat0)
    a = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        a += (x0 * kx) * (y1 * 111320) - (x1 * kx) * (y0 * 111320)
    return abs(a) / 2


def oriented_box(ring, cx, cy):
    """Bearing (degrees from north of its long side), length & width (m) of a footprint's minimum-area bounding box
    over its edge directions"""
    kx = 111320 * math.cos(math.radians(cy))
    pts = [((lon - cx) * kx, (lat - cy) * 111320) for lon, lat in ring]
    best = None
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 0.5:
            continue
        ux, uy = (x1 - x0) / L, (y1 - y0) / L
        us = [x * ux + y * uy for x, y in pts]
        vs = [-x * uy + y * ux for x, y in pts]
        a, b = max(us) - min(us), max(vs) - min(vs)
        if best is None or a * b < best[0]:
            ang = math.degrees(math.atan2(ux, uy))
            best = (a * b, ang, a, b) if a >= b else (a * b, ang + 90, b, a)
    if best is None:
        return 0.0, 1.0, 1.0
    return best[1] % 180, best[2], best[3]


def num(v):
    if v is None:
        return None
    try:
        return float(str(v).split(';')[0].replace(',', '.').replace('m', '').strip())
    except ValueError:
        return None


def area_kind(t):
    if t.get('leisure') in ('park', 'garden', 'playground', 'pitch', 'dog_park'):
        return t['leisure']
    if t.get('landuse') in ('grass', 'forest', 'meadow', 'village_green', 'recreation_ground', 'cemetery'):
        return t['landuse']
    if t.get('natural') in ('wood', 'scrub', 'grassland', 'beach', 'sand', 'water', 'heath'):
        return t['natural']
    if t.get('place') == 'square' or (t.get('highway') == 'pedestrian' and t.get('area') == 'yes'):
        return 'square'
    if t.get('man_made') in ('pier', 'breakwater'):
        return t['man_made']
    if t.get('landuse') == 'harbour' or t.get('harbour') == 'yes':
        return 'harbour'
    return None


class Extract(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.roads, self.coast, self.areas, self.buildings, self.landmarks = [], [], [], [], []
        self.points = []

    def node(self, n):
        t = {k: v for k, v in n.tags}
        kind = ('metro' if t.get('railway') == 'subway_entrance' else
                'signal' if t.get('highway') == 'traffic_signals' else
                'bicing' if t.get('amenity') == 'bicycle_rental' else
                'fountain' if t.get('amenity') == 'drinking_water' else None)
        if not kind or not inside(n.location.lat, n.location.lon):
            return
        self.points.append([kind, r7(n.location.lon), r7(n.location.lat), t.get('name', '')])

    def way(self, w):
        t = {k: v for k, v in w.tags}
        hw = t.get('highway')
        is_road = hw and hw not in SKIP_HIGHWAYS and t.get('area') != 'yes'
        is_coast = t.get('natural') == 'coastline'
        is_pier = t.get('man_made') in ('pier', 'breakwater') and not w.is_closed()
        if not (is_road or is_coast or is_pier):
            return
        try:
            g = [(r7(n.lon), r7(n.lat)) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if not any(inside(lat, lon) for lon, lat in g):
            return
        if is_coast:
            self.coast.append(g)
        elif is_pier:
            self.areas.append({'kind': t['man_made'], 'name': t.get('name', ''), 'line': g})
        else:
            self.roads.append({'id': w.id, 'tags': {k: t[k] for k in ROAD_TAGS if k in t}, 'pts': g})

    def area(self, a):
        t = {k: v for k, v in a.tags}
        kind = area_kind(t)
        bld = t.get('building') and t.get('building') != 'no'
        name = t.get('name', '')
        lm = name in LANDMARK_NAMES or t.get('historic') == 'monument' and name
        if not (kind or bld or lm):
            return
        rings = []
        try:
            for outer in a.outer_rings():
                ring = [(r7(n.lon), r7(n.lat)) for n in outer]
                holes = [[(r7(n.lon), r7(n.lat)) for n in inner] for inner in a.inner_rings(outer)]
                rings.append((ring, holes))
        except osmium.InvalidLocationError:
            return
        rings = [(r, h) for r, h in rings if len(r) > 3 and any(inside(lat, lon) for lon, lat in r)]
        if not rings:
            return
        if kind:
            for r, h in rings:
                self.areas.append({'kind': kind, 'name': name, 'ring': r, 'holes': h})
        if bld:
            for r, _ in rings:
                ar = ring_area_m2(r[:-1])
                cx = sum(p[0] for p in r[:-1]) / (len(r) - 1)
                cy = sum(p[1] for p in r[:-1]) / (len(r) - 1)
                bearing, length, width = oriented_box(r[:-1], cx, cy)
                self.buildings.append([r7(cx), r7(cy), round(ar), num(t.get('building:levels')), num(t.get('height')), name,
                                       round(bearing, 1), round(length, 1), round(width, 1)])
        if lm:
            r = max((r for r, _ in rings), key=lambda r: ring_area_m2(r[:-1]))
            self.landmarks.append({'name': name, 'height': num(t.get('height')), 'levels': num(t.get('building:levels')), 'ring': r})


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    if not src:
        sys.exit(__doc__)
    e = Extract()
    e.apply_file(src, locations=True)
    os.makedirs(OUT, exist_ok=True)
    meta = {'source': 'OpenStreetMap contributors (ODbL 1.0)', 'file': os.path.basename(src), 'bbox': BBOX}
    for name, data in (('roads', e.roads), ('coast', e.coast), ('areas', e.areas), ('buildings', e.buildings), ('landmarks', e.landmarks), ('points', e.points)):
        path = os.path.join(OUT, f'bcn_{name}.json')
        with open(path, 'w') as f:
            json.dump({**meta, 'elements': data}, f, separators=(',', ':'), ensure_ascii=False)
        print(f'{name}: {len(data)} -> {path} ({os.path.getsize(path) // 1024} KB)')


if __name__ == '__main__':
    main()
