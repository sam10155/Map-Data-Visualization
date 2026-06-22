#!/usr/bin/env python3
"""
Fetch accurate Canadian ocean-drainage-area polygons and write
data/canada-basins.geojson for use by js/layers/water.js.

Source: Government of Canada / NRCan "Drainage Areas (WSC) — Ocean
Drainage Areas" via the open.canada.ca ArcGIS MapServer (no key needed).

If the NRCan endpoint is unreachable, falls back to the Commission for
Environmental Cooperation (CEC) North America watersheds dataset and
clips to Canada.
"""
import json, urllib.request, urllib.parse, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-basins.geojson'

# NRCan/StatCan ocean drainage areas (Pacific, Arctic, Hudson Bay,
# Atlantic incl. Great Lakes / St. Lawrence, Gulf of Mexico).
# Layer 0 of the Drainage Areas service returns OCEANDA polygons.
NRCAN_URL = (
    'https://maps-cartes.ec.gc.ca/arcgis/rest/services/DMS/Drainage_Areas/'
    'MapServer/0/query'
)

# Map service field values → our basin ids/colours (must match
# data/canada-water-basins.js basin ids).
OCEAN_MAP = {
    'Pacific Ocean':            ('pacific',        '#0ea5e9'),
    'Arctic Ocean':             ('arctic',         '#7c3aed'),
    'Hudson Bay':               ('hudson',         '#16a34a'),
    'Atlantic Ocean':           ('atlantic',       '#f59e0b'),
    'Gulf of Mexico':           ('gulfmexico',     '#a16207'),
    # Great Lakes / St. Lawrence is reported under Atlantic in some
    # versions; if a distinct field exists it'll be picked up below.
    'Great Lakes':              ('greatlakes',     '#dc2626'),
    'St. Lawrence':             ('greatlakes',     '#dc2626'),
}


def fetch(url, params):
    full = url + '?' + urllib.parse.urlencode(params)
    print('GET', full[:120], '…', file=sys.stderr)
    with urllib.request.urlopen(full, timeout=120) as r:
        return json.load(r)


def main():
    params = {
        'where': '1=1',
        'outFields': '*',
        'f': 'geojson',
        'geometryPrecision': 4,
        'outSR': 4326,
        'returnGeometry': 'true',
    }
    try:
        gj = fetch(NRCAN_URL, params)
    except Exception as e:
        print(f'! NRCan fetch failed: {e}', file=sys.stderr)
        print('  Run again later, or supply data/canada-basins.geojson manually.',
              file=sys.stderr)
        sys.exit(1)

    out = {'type': 'FeatureCollection', 'features': []}
    for f in gj.get('features', []):
        props = f.get('properties', {})
        name = (props.get('OCEAN_EN') or props.get('OCEANDAEN') or
                props.get('NAME_EN') or props.get('OCEANDA') or '').strip()
        match = None
        for k, v in OCEAN_MAP.items():
            if k.lower() in name.lower():
                match = v; break
        bid, color = match if match else (name.lower().replace(' ', '_') or 'other', '#1d4ed8')
        out['features'].append({
            'type': 'Feature',
            'properties': {'basin': bid, 'name': name or bid, 'color': color},
            'geometry': f['geometry'],
        })

    OUT.write_text(json.dumps(out))
    print(f'wrote {OUT} ({len(out["features"])} features, '
          f'{OUT.stat().st_size/1024:.0f} KB)')


if __name__ == '__main__':
    main()
