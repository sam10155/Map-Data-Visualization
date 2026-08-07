#!/usr/bin/env python3
"""
Fetch accurate Canadian drainage polygons and write data/canada-basins.geojson
for js/layers/water.js (which prefers this file over the hand-drawn fallback
polygons in data/canada-water-basins.js).

Source: StatCan "Drainage regions of Canada" (25 regions, each tagged with
its ocean drainage area) via the geo.ca ArcGIS REST service — official
geometry, land-only, covers the whole landmass incl. the Arctic islands.
Open Government Licence – Canada.

The 25 regions are grouped into the basin ids used by the map layer. This
preserves the map's finer-than-ocean splits (Great Lakes–St. Lawrence
separate from Atlantic, Arctic islands separate from mainland Arctic,
Newfoundland–Labrador its own section).

Fallback source (5 ocean-level polygons, same licence):
  https://maps-cartes.ec.gc.ca/arcgis/rest/services/CESI_ICDE/
  Ocean_drainage_regions_R%C3%A9gion_de_drainage_oc%C3%A9anique/MapServer/0
"""
import json, pathlib, sys, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-basins.geojson'

STATCAN_URL = ('https://maps-cartes.services.geo.ca/server2_serveur2/rest/services/'
               'StatCan/Drainage_regions_Regions_de_drainage_en/MapServer/0/query')

# Drainage_region_code → basin id (ids must match data/canada-water-basins.js)
REGION_TO_BASIN = {
    '1': 'pacific', '2': 'pacific', '3': 'pacific', '4': 'pacific', '5': 'pacific',
    '6': 'arctic', '7': 'arctic',
    '8': 'arctic_islands',
    '9': 'gulfmexico',
    '10': 'hudson', '11': 'hudson', '12': 'hudson', '13': 'hudson', '14': 'hudson',
    '15': 'hudson', '16': 'hudson', '17': 'hudson', '18': 'hudson',
    '19': 'greatlakes', '20': 'greatlakes', '21': 'greatlakes',
    '22': 'atlantic', '23': 'atlantic', '24': 'atlantic',
    '25': 'newfoundland',
}


def fetch(offset_deg):
    params = {
        'where': '1=1',
        'outFields': 'Drainage_region_code,Drainage_region_name,Ocean_drainage_area_name',
        'returnGeometry': 'true',
        'outSR': 4326,
        'maxAllowableOffset': offset_deg,
        'geometryPrecision': 4,
        'f': 'geojson',
    }
    url = STATCAN_URL + '?' + urllib.parse.urlencode(params)
    print(f'GET maxAllowableOffset={offset_deg} …', file=sys.stderr)
    with urllib.request.urlopen(url, timeout=300) as r:
        return json.load(r)


MIN_RING_DEG2 = 0.02   # drop islets/holes smaller than ~0.02 deg² (~150 km²)


def ring_area_deg2(ring):
    a = 0.0
    for i in range(len(ring) - 1):
        a += ring[i][0] * ring[i+1][1] - ring[i+1][0] * ring[i][1]
    return abs(a) / 2


def slim(geom):
    """Drop sub-threshold islets and holes, round coords to 3 decimals
    (~100 m). The raw StatCan geometry has ~26k polygons, mostly tiny
    coastal islets — pointless at national scale and ruinous for the
    client's per-river point-in-polygon basin lookup."""
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    out = []
    for poly in polys:
        if ring_area_deg2(poly[0]) < MIN_RING_DEG2:
            continue
        rings = [poly[0]] + [h for h in poly[1:] if ring_area_deg2(h) >= MIN_RING_DEG2]
        out.append([[[round(x, 3), round(y, 3)] for x, y in ring] for ring in rings])
    return {'type': 'MultiPolygon', 'coordinates': out} if out else None


def split_region25(geom):
    """StatCan region 25 is 'Newfoundland–Labrador' combined. Split the
    multipolygon at the Strait of Belle Isle: island polygons → the map's
    separate 'newfoundland' basin, Labrador mainland → 'atlantic'.
    The island lies S of 51.7°N and E of -59.6°; Labrador polygons all
    centre N/W of that."""
    polys = geom['coordinates'] if geom['type'] == 'MultiPolygon' else [geom['coordinates']]
    island, mainland = [], []
    for poly in polys:
        outer = poly[0]
        clat = sum(pt[1] for pt in outer) / len(outer)
        clon = sum(pt[0] for pt in outer) / len(outer)
        (island if clat < 51.7 and clon > -59.6 else mainland).append(poly)
    out = []
    if island:
        out.append(('newfoundland', {'type': 'MultiPolygon', 'coordinates': island}))
    if mainland:
        out.append(('atlantic', {'type': 'MultiPolygon', 'coordinates': mainland}))
    return out


def main():
    gj = fetch(0.01)
    feats = gj.get('features', [])
    if len(feats) < 25:
        sys.exit(f'expected 25 drainage regions, got {len(feats)}')

    out = {'type': 'FeatureCollection', 'features': []}
    for f in feats:
        p = f.get('properties', {})
        code = str(p.get('Drainage_region_code', '')).strip().lstrip('0')
        basin = REGION_TO_BASIN.get(code)
        if not basin:
            print(f'! unmapped region code {code} ({p.get("Drainage_region_name")})',
                  file=sys.stderr)
            continue
        geoms = [(basin, f['geometry'])]
        if code == '25':
            geoms = split_region25(f['geometry'])
        for b, geom in geoms:
            geom = slim(geom)
            if not geom:
                continue
            out['features'].append({
                'type': 'Feature',
                'properties': {
                    'basin': b,
                    'region': p.get('Drainage_region_name'),
                    'ocean': p.get('Ocean_drainage_area_name'),
                },
                'geometry': geom,
            })

    OUT.write_text(json.dumps(out, separators=(',', ':')))
    print(f'wrote {OUT} ({len(out["features"])} regions, '
          f'{OUT.stat().st_size/1e6:.1f} MB)')


if __name__ == '__main__':
    main()
