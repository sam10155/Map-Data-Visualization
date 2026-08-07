#!/usr/bin/env python3
"""
Drop non-Canadian segments from data/canada-rivers.geojson.

The original bake (fetch_rivers.py) used rectangular Overpass tiles that
sweep deep into the US. A stepped-latitude border approximation isn't
enough here — any step coarse enough to keep SW Ontario (41.6°N) or
southern New Brunswick also keeps most of Michigan and Maine. So this
trims by true point-in-polygon against the Natural Earth 50m Canada
boundary (data/canada-boundary.geojson, public domain, includes islands).

A segment is kept if its midpoint is inside Canada. Border-following
rivers (e.g. St. Clair, Niagara) sit on the line; a small tolerance keeps
a segment whose midpoint is within ~2 km of the boundary by also testing
4 offset probes.
"""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATH = ROOT / 'data' / 'canada-rivers.geojson'
BOUNDARY = ROOT / 'data' / 'canada-boundary.geojson'
TOL_DEG = 0.02   # ~2 km probe offset for border-hugging rivers


def load_polys():
    gj = json.loads(BOUNDARY.read_text())
    polys = []
    for f in gj['features']:
        g = f['geometry']
        coords = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        for poly in coords:
            outer = poly[0]
            # precompute bbox for a fast reject
            xs = [p[0] for p in outer]; ys = [p[1] for p in outer]
            polys.append((min(xs), min(ys), max(xs), max(ys), outer))
    return polys


def pip(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and \
           lon < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def in_canada(lon, lat, polys):
    for x0, y0, x1, y1, ring in polys:
        if x0 <= lon <= x1 and y0 <= lat <= y1 and pip(lon, lat, ring):
            return True
    return False


def keep(coords, polys):
    mid = coords[len(coords) // 2]
    lon, lat = mid[0], mid[1]
    # Straight-line border sections need no polygon or tolerance — the
    # treaty line is exact. Natural Earth draws the 49th parallel ~800 m
    # south of 49.0°N and the ±TOL_DEG probes add ~2.2 km more, which
    # together admit a 3 km ribbon of US rivers (Milk, Belly, St. Mary…).
    # Hard-clamp instead: 49°N prairie section and 141°W Yukon meridian.
    if -123.03 <= lon <= -95.15 and lat < 49.0:
        return False
    if lon < -141.0 and lat < 69.65:
        return False
    if in_canada(lon, lat, polys):
        return True
    # border-hugging tolerance elsewhere (St. Clair, Niagara, coastal):
    # any offset probe inside → keep
    for dx, dy in ((TOL_DEG, 0), (-TOL_DEG, 0), (0, TOL_DEG), (0, -TOL_DEG)):
        if in_canada(lon + dx, lat + dy, polys):
            return True
    return False


def main():
    polys = load_polys()
    gj = json.loads(PATH.read_text())
    feats = gj.get('features', [])
    kept = [f for f in feats
            if f.get('geometry', {}).get('type') == 'LineString'
            and len(f['geometry'].get('coordinates', [])) >= 2
            and keep(f['geometry']['coordinates'], polys)]
    before = PATH.stat().st_size
    gj['features'] = kept
    PATH.write_text(json.dumps(gj, separators=(',', ':')))
    after = PATH.stat().st_size
    print(f'{len(feats)} → {len(kept)} segments '
          f'({len(feats)-len(kept)} dropped) · {before/1e6:.1f} → {after/1e6:.1f} MB')


if __name__ == '__main__':
    main()
