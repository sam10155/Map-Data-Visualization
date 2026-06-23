#!/usr/bin/env python3
"""
Build data/canada-livestock.js — census-division centroids with 2021
Census-of-Agriculture livestock headcounts. Rendered client-side as a
weighted heatmap (no polygons → no degenerate-island artefacts, tiny file).

Sources (Statistics Canada, open licence):
  • Centroids/area: geo.statcan.gc.ca 2021 Cartographic_boundary_files/4 (CD)
                    — geometry NOT fetched; only label-point + LANDAREA.
  • Cattle:  WDS 32-10-0370-01    • Sheep:   32-10-0371-01
  • Pigs:    32-10-0372-01        • Poultry: 32-10-0374-01

Output: window.CANADA_LIVESTOCK = { source, generated, divisions: [
  {id, name, prov, lat, lon, area, cattle, pigs, sheep, poultry}, … ] }
"""
import json, urllib.request, urllib.parse, time, sys, pathlib, datetime

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-livestock.js'
OLD_GEOJSON = ROOT / 'data' / 'canada-livestock.geojson'

CD_URL = ('https://geo.statcan.gc.ca/geo_wa/rest/services/2021/'
          'Cartographic_boundary_files/MapServer/4/query')
WDS = 'https://www150.statcan.gc.ca/t1/wds/rest'

TABLES = {
    32100370: ('cattle',  1),
    32100371: ('sheep',   1),
    32100372: ('pigs',    1),
    32100374: ('poultry', 1),
}
UOM_ANIMALS = 2

PROV = {'10':'NL','11':'PE','12':'NS','13':'NB','24':'QC','35':'ON',
        '46':'MB','47':'SK','48':'AB','59':'BC','60':'YT','61':'NT','62':'NU'}


def http_get(url, params=None, timeout=120):
    if params:
        url = url + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': 'canada-map-viz/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def http_post(url, body, timeout=120):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data,
        headers={'Content-Type': 'application/json',
                 'User-Agent': 'canada-map-viz/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_cd_centroids():
    """Page through CD layer; request only attributes + envelope, derive
    centroid from envelope (good enough for a national heatmap)."""
    out = {}
    offset = 0
    PAGE = 100
    while True:
        params = {
            'where': '1=1',
            'outFields': 'CDUID,CDNAME,PRUID,LANDAREA',
            'returnGeometry': 'true',
            'returnExtentOnly': 'false',
            'outSR': 4326,
            'geometryPrecision': 4,
            # request envelope geometry only — fast and tiny
            'returnTrueCurves': 'false',
            'maxAllowableOffset': 0.05,    # ~5 km in degrees → coarse hull, we only want bbox
            'f': 'json',
            'resultOffset': offset,
            'resultRecordCount': PAGE,
        }
        print(f'  CD attrs offset={offset}…', file=sys.stderr)
        for attempt in range(4):
            try:
                d = http_get(CD_URL, params, timeout=120)
                break
            except Exception as e:
                print(f'    retry {attempt+1}: {e}', file=sys.stderr)
                time.sleep(8)
        else:
            raise RuntimeError('CD attrs fetch failed')
        feats = d.get('features', [])
        for f in feats:
            a = f.get('attributes', {})
            cduid = str(a.get('CDUID') or '').strip()
            if not cduid:
                continue
            # centroid from rings bbox
            rings = (f.get('geometry') or {}).get('rings') or []
            xs, ys = [], []
            for ring in rings:
                for x, y in ring:
                    xs.append(x); ys.append(y)
            if not xs:
                continue
            out[cduid] = {
                'id': cduid,
                'name': a.get('CDNAME', ''),
                'prov': PROV.get(str(a.get('PRUID') or '')[:2], ''),
                'lat': round((min(ys)+max(ys))/2, 4),
                'lon': round((min(xs)+max(xs))/2, 4),
                'area': round(float(a.get('LANDAREA') or 0), 1) or None,
            }
        print(f'    +{len(feats)} (total {len(out)})', file=sys.stderr)
        if len(feats) < PAGE:
            break
        offset += PAGE
        time.sleep(1)
    print(f'  → {len(out)} census divisions', file=sys.stderr)
    return out


def cd_members_for(pid):
    meta = http_post(f'{WDS}/getCubeMetadata', [{'productId': pid}])
    geo = meta[0]['object']['dimension'][0]['member']
    out = {}
    for m in geo:
        if '[CD' not in m.get('memberNameEn', ''):
            continue
        cc = str(m.get('classificationCode') or '').strip()
        if len(cc) == 4 and cc.isdigit():
            out[cc] = m['memberId']
    return out


def fetch_table(pid, key, total_member):
    print(f'  table {pid} ({key})…', file=sys.stderr)
    cd_map = cd_members_for(pid)
    inv = {str(v): k for k, v in cd_map.items()}
    coords = [{'productId': pid,
               'coordinate': f'{mid}.{total_member}.{UOM_ANIMALS}' + '.0' * 7,
               'latestN': 1}
              for mid in cd_map.values()]
    values = {}
    BATCH = 250
    for i in range(0, len(coords), BATCH):
        chunk = coords[i:i+BATCH]
        for attempt in range(3):
            try:
                rows = http_post(f'{WDS}/getDataFromCubePidCoordAndLatestNPeriods', chunk)
                break
            except Exception as e:
                print(f'    retry {attempt+1}: {e}', file=sys.stderr)
                time.sleep(8)
        else:
            continue
        for row in rows:
            obj = row.get('object') or {}
            mid = obj.get('coordinate', '').split('.')[0]
            cduid = inv.get(mid)
            dps = obj.get('vectorDataPoint') or []
            v = dps[0].get('value') if dps else None
            if cduid and v not in (None, '..', '', 'x', 'F'):
                try: values[cduid] = int(float(v))
                except: pass
        time.sleep(0.4)
    print(f'    → {len(values)} CDs with data', file=sys.stderr)
    return values


def main():
    print('Fetching CD centroids…', file=sys.stderr)
    cds = fetch_cd_centroids()

    print('Fetching livestock tables…', file=sys.stderr)
    for pid, (key, tot) in TABLES.items():
        for cduid, v in fetch_table(pid, key, tot).items():
            if cduid in cds:
                cds[cduid][key] = v

    divisions = sorted(cds.values(), key=lambda d: d['id'])
    payload = {
        'source': 'Statistics Canada — 2021 Census of Agriculture '
                  '(32-10-0370/0371/0372/0374) + 2021 cartographic CD centroids',
        'generated': datetime.datetime.now(datetime.UTC).isoformat(timespec='seconds'),
        'divisions': divisions,
    }
    js = 'window.CANADA_LIVESTOCK = ' + json.dumps(payload, separators=(',', ':')) + ';\n'
    OUT.write_text(js, encoding='utf-8')
    if OLD_GEOJSON.exists():
        OLD_GEOJSON.unlink()
        print(f'  removed old {OLD_GEOJSON.name}', file=sys.stderr)
    print(f'wrote {OUT}: {len(divisions)} CDs, {OUT.stat().st_size/1024:.1f} KB',
          file=sys.stderr)


if __name__ == '__main__':
    main()
