#!/usr/bin/env python3
"""
Pre-bake the Canadian rail network from OpenStreetMap into
data/canada-rail.geojson for the static Rail Network layer.

Queries railway=rail ways with usage=main/branch (i.e. real corridors, not
yards/sidings/spurs) in 10°x10° tiles, keeps the operator tag, and
classifies each segment: cn / cpkc / via / other. Geometry is thinned to
~1 point per km — plenty for a national-scale line layer.

Post-pass: clips to the Canada–US boundary (same piecewise line as
js/layers/tracking.js) so US trackage swept in by the rectangular query
is dropped.
"""
import json, math, time, urllib.request, urllib.parse, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-rail.geojson'

OVERPASS = [
    'https://overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
]
CANADA_BBOX = (41.5, -141.0, 83.2, -52.5)

# Piecewise southern boundary (same as tracking.js): [westLon, minLat]
S_BOUNDARY = [
    (-141.0, 48.2), (-123.3, 48.9), (-95.2, 48.0), (-89.0, 46.0),
    (-84.5, 42.9), (-83.2, 41.6), (-78.9, 43.2), (-76.5, 44.0),
    (-74.5, 44.8), (-67.8, 44.4), (-66.5, 43.3),
]
def min_lat(lon):
    m = S_BOUNDARY[0][1]
    for w, lat in S_BOUNDARY:
        if lon >= w: m = lat
        else: break
    return m

_mirror = 0
def post(query, tries=4):
    global _mirror
    body = ('data=' + urllib.parse.quote(query)).encode()
    last = None
    for attempt in range(tries):
        url = OVERPASS[(_mirror + attempt) % len(OVERPASS)]
        try:
            req = urllib.request.Request(url, data=body,
                headers={'User-Agent': 'canada-map-viz-rail-bake/1.0'})
            with urllib.request.urlopen(req, timeout=300) as r:
                _mirror = (_mirror + attempt) % len(OVERPASS)
                return json.load(r)
        except Exception as e:
            last = e
            print(f'  mirror {url.split("/")[2]} failed: {e}', file=sys.stderr)
            time.sleep(10 * (attempt + 1))
    raise last

def classify(tags):
    op = ' '.join(filter(None, [
        tags.get('operator', ''), tags.get('owner', ''), tags.get('name', ''),
    ])).upper()
    # CPKC first: "Canadian Pacific" contains "CANADIAN" and CN's full name
    # is "Canadian National" — order the tests carefully. French spellings
    # (Canadien National / Chemin de fer Canadien Pacifique) included.
    if re.search(r'CPKC|KANSAS CITY|CANADIAN PACIFIC|CANADIEN PACIFIQUE|\bCP\b|\bCPR\b', op): return 'cpkc'
    if re.search(r'CANADIAN NATIONAL|CANADIEN NATIONAL|\bCN\b|\bCNR\b', op): return 'cn'
    if re.search(r'VIA RAIL|\bVIA\b', op): return 'via'
    return 'other'

def thin(coords, min_km=1.0):
    """Keep roughly one vertex per min_km (always keep endpoints)."""
    if len(coords) <= 2: return coords
    def dist(a, b):
        la1, lo1, la2, lo2 = map(math.radians, (a[1], a[0], b[1], b[0]))
        h = (math.sin((la2-la1)/2)**2 +
             math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2)
        return 6371 * 2 * math.asin(math.sqrt(h))
    out = [coords[0]]
    acc = 0.0
    for i in range(1, len(coords)-1):
        acc += dist(coords[i-1], coords[i])
        if acc >= min_km:
            out.append(coords[i]); acc = 0.0
    out.append(coords[-1])
    return out

def main():
    la0, lo0, la1, lo1 = CANADA_BBOX
    feats, seen = [], set()
    lat = la0
    while lat < la1:
        lon = lo0
        while lon < lo1:
            bbox = f'{lat},{lon},{min(lat+10, la1)},{min(lon+10, lo1)}'
            q = f"""[out:json][timeout:240];
way[railway=rail][usage~"^(main|branch)$"]({bbox});
out tags geom;"""
            print(f'tile {bbox} …', flush=True)
            try:
                j = post(q)
            except Exception as e:
                print(f'  TILE FAILED (skipping): {e}', file=sys.stderr)
                lon += 10; continue
            n = 0
            for el in j.get('elements', []):
                if el.get('type') != 'way' or el['id'] in seen: continue
                seen.add(el['id'])
                geom = el.get('geometry') or []
                if len(geom) < 2: continue
                coords = thin([[p['lon'], p['lat']] for p in geom])
                # Clip: keep only segments touching the Canadian side.
                mid = coords[len(coords)//2]
                if not any(c[1] >= min_lat(c[0]) for c in (mid, coords[0], coords[-1])):
                    continue
                tags = el.get('tags', {})
                feats.append({
                    'type': 'Feature',
                    'properties': {
                        'rr': classify(tags),
                        'name': tags.get('name', ''),
                        'operator': tags.get('operator', ''),
                        'usage': tags.get('usage', ''),
                    },
                    'geometry': {'type': 'LineString', 'coordinates': [
                        [round(c[0], 4), round(c[1], 4)] for c in coords]},
                })
                n += 1
            print(f'  +{n} ways ({len(feats)} total)', flush=True)
            time.sleep(5)
            lon += 10
        lat += 10

    fc = {'type': 'FeatureCollection', 'features': feats}
    OUT.write_text(json.dumps(fc, separators=(',', ':')))
    kb = OUT.stat().st_size // 1024
    by = {}
    for f in feats: by[f['properties']['rr']] = by.get(f['properties']['rr'], 0) + 1
    print(f'wrote {OUT} — {len(feats)} segments, {kb} KB, by railway: {by}')

if __name__ == '__main__':
    main()
