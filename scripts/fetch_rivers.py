#!/usr/bin/env python3
"""
Pre-bake detailed Canadian river geometry from OpenStreetMap into
data/canada-rivers.geojson so the browser doesn't need live Overpass calls.

Strategy: query Overpass once per major-river relation (members give true
centreline geometry), plus a sweep of all waterway=river ways inside Canada
in 5°×5° tiles. Output is a FeatureCollection of LineStrings with name + tags.
"""
import json, time, urllib.request, urllib.parse, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-rivers.geojson'

OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
]
CANADA_BBOX = (41.5, -141.0, 83.2, -52.5)


_mirror = 0
def post(query, tries=4):
    global _mirror
    body = ('data=' + urllib.parse.quote(query)).encode()
    last = None
    for attempt in range(tries):
        url = OVERPASS[(_mirror + attempt) % len(OVERPASS)]
        try:
            req = urllib.request.Request(url, data=body,
                headers={'Content-Type': 'application/x-www-form-urlencoded',
                         'User-Agent': 'canada-map-viz/1.0'})
            with urllib.request.urlopen(req, timeout=180) as r:
                _mirror = (_mirror + attempt) % len(OVERPASS)
                return json.load(r)
        except Exception as e:
            last = e
            print(f'  retry via {url.split("/")[2]} ({e})', file=sys.stderr)
            time.sleep(20 if '429' in str(e) else 5)
    raise last


def way_to_feature(el):
    if el.get('type') != 'way' or not el.get('geometry'):
        return None
    coords = [[g['lon'], g['lat']] for g in el['geometry']]
    if len(coords) < 2:
        return None
    return {
        'type': 'Feature',
        'properties': {'name': (el.get('tags') or {}).get('name', '')},
        'geometry': {'type': 'LineString', 'coordinates': coords},
    }


def simplify(coords, tol=0.002):
    """Drop intermediate points within tol° of the line through neighbours."""
    if len(coords) <= 2:
        return coords
    out = [coords[0]]
    for i in range(1, len(coords) - 1):
        ax, ay = out[-1]; bx, by = coords[i]; cx, cy = coords[i + 1]
        # perpendicular distance of b from line a-c (approx, equirectangular)
        dx, dy = cx - ax, cy - ay
        if dx == 0 and dy == 0:
            continue
        t = ((bx - ax) * dx + (by - ay) * dy) / (dx * dx + dy * dy)
        px, py = ax + t * dx, ay + t * dy
        if ((bx - px) ** 2 + (by - py) ** 2) ** 0.5 > tol:
            out.append(coords[i])
    out.append(coords[-1])
    return out


def main():
    features = []
    seen = set()
    s0, w0, n0, e0 = CANADA_BBOX

    tiles = []
    la = s0
    while la < n0:
        lo = w0
        while lo < e0:
            tiles.append((la, lo, min(la + 4, n0), min(lo + 4, e0)))
            lo += 4
        la += 4

    for i, (s, w, n, e) in enumerate(tiles, 1):
        q = (f'[out:json][timeout:120];'
             f'way["waterway"="river"]({s},{w},{n},{e});out tags geom;')
        print(f'[{i}/{len(tiles)}] tile {s},{w} → {n},{e}', file=sys.stderr)
        try:
            res = post(q)
        except Exception as ex:
            print(f'  ! tile failed permanently: {ex}', file=sys.stderr)
            continue
        added = 0
        for el in res.get('elements', []):
            wid = el.get('id')
            if wid in seen or el.get('type') != 'way' or not el.get('geometry'):
                continue
            seen.add(wid)
            coords = simplify([[g['lon'], g['lat']] for g in el['geometry']])
            if len(coords) < 2:
                continue
            features.append({
                'type': 'Feature',
                'properties': {'name': (el.get('tags') or {}).get('name', '')},
                'geometry': {'type': 'LineString', 'coordinates': coords},
            })
            added += 1
        print(f'  +{added} ways (total {len(features)})', file=sys.stderr)
        # incremental write so partial progress survives
        OUT.write_text(json.dumps({'type': 'FeatureCollection', 'features': features},
                                  separators=(',', ':')))
        time.sleep(3)

    print(f'wrote {OUT}: {len(features)} river segments, '
          f'{OUT.stat().st_size/1024/1024:.1f} MB')


if __name__ == '__main__':
    main()
