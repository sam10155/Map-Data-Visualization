#!/usr/bin/env python3
"""
Fetch current Canadian water levels into data/canada-water-levels.geojson
for the static Water Levels sub-layer. Designed to run every 6 h in a
GitHub Action (see .github/workflows/water-levels.yml) — stdlib only.

Sources (each isolated: one failing source never blanks the file):
  eccc  — ECCC MSC GeoMet hydrometric-realtime: one paged sweep of the
          last 6 h nationally (~14 pages), deduped to the latest reading
          per station. ~2,200 river & lake gauges incl. level + discharge.
  dfo   — DFO CHS IWLS /stations/data/latest: latest observed water level
          (wlo) for coastal / Great Lakes / St. Lawrence tide gauges,
          joined to a station list fetched in the same run.
  orrpb — Ottawa River Regulation Planning Board conditions pages
          (river + reservoir displays): server-rendered HTML, scraped.
          Includes Hull (Gatineau side) and principal reservoirs.

Each station is classified against data/canada-water-normals.json
(pre-baked HYDAT monthly percentile bands — scripts/bake_water_normals.py):
  < p05 very-low · < p25 low · ≤ p75 normal · ≤ p95 high · > p95 very-high
Level bands preferred, discharge bands as fallback (many stations have
short level records but long flow records). Levels are relative to local
station datums, so the class — never the raw level — is the only value
comparable across stations.
"""
import datetime as dt
import html
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-water-levels.geojson'
NORMALS = ROOT / 'data' / 'canada-water-normals.json'
RESERVOIRS = ROOT / 'data' / 'canada-reservoirs.json'

ECCC = 'https://api.weather.gc.ca/collections/hydrometric-realtime/items'
IWLS = 'https://api-iwls.dfo-mpo.gc.ca/api/v1'
ORRPB = 'https://www.ottawariver.ca/conditions/'
HQ = ('https://donnees.hydroquebec.com/api/explore/v2.1/catalog/datasets/'
      'donnees-hydrometeorologiques/exports/json')
QC_WFS = ('https://geoegl.msp.gouv.qc.ca/apis/mapserver-vigilance/ws/vigilance.fcgi'
          '?service=wfs&version=2.0.0&request=GetFeature&typenames=stations_igo2_public'
          '&outputFormat=geojson&srsName=EPSG:4326')

WINDOW_H = 6
UA = {'User-Agent': 'canada-map-viz-water-levels/1.0 (github action)'}

LAKE_RE = re.compile(r'\b(LAKE|LAC|RESERVOIR|RÉSERVOIR|LOCH)\b', re.I)
# "X RIVER ABOVE Y LAKE" is a river gauge — waterbody word must lead.
RIVER_RE = re.compile(r'\b(RIVER|RIVIÈRE|RIVIERE|CREEK|RUISSEAU|BROOK|FLEUVE|CHANNEL|CANAL)\b', re.I)


def get_json(url, timeout=90):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return json.load(r)


def station_kind(name):
    if not name:
        return 'river'
    m_lake, m_river = LAKE_RE.search(name), RIVER_RE.search(name)
    if m_lake and (not m_river or m_lake.start() < m_river.start()):
        return 'lake'
    return 'river'


# ---------------------------------------------------------------- ECCC
def fetch_eccc(now):
    since = (now - dt.timedelta(hours=WINDOW_H)).strftime('%Y-%m-%dT%H:%M:%SZ')
    props = 'STATION_NUMBER,STATION_NAME,PROV_TERR_STATE_LOC,DATETIME,LEVEL,DISCHARGE'
    best = {}
    offset = 0
    while True:
        url = (f'{ECCC}?f=json&limit=10000&offset={offset}'
               f'&datetime={urllib.parse.quote(since)}/..&properties={props}')
        page = get_json(url)
        feats = page.get('features', [])
        for f in feats:
            p = f.get('properties', {})
            stn, when = p.get('STATION_NUMBER'), p.get('DATETIME')
            if not stn or not when or (p.get('LEVEL') is None and p.get('DISCHARGE') is None):
                continue
            if stn not in best or when > best[stn]['properties']['DATETIME']:
                best[stn] = f
        if len(feats) < 10000:
            break
        offset += 10000
        if offset > 400000:   # backstop: 6 h should be ~140k records
            break
    out = []
    for stn, f in best.items():
        p = f['properties']
        # Exclude US-hosted border stations (PROV can be ME, MN, ND…)
        if p.get('PROV_TERR_STATE_LOC') not in (
                'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'):
            continue
        out.append({
            'id': stn,
            'name': (p.get('STATION_NAME') or '').title(),
            'prov': p.get('PROV_TERR_STATE_LOC'),
            'kind': station_kind(p.get('STATION_NAME')),
            'coords': f['geometry']['coordinates'],
            'level': p.get('LEVEL'),
            'discharge': p.get('DISCHARGE'),
            'time': p.get('DATETIME'),
            'src': 'eccc',
        })
    return out


# ----------------------------------------------------------------- DFO
def fetch_dfo():
    stations = get_json(f'{IWLS}/stations?time-series-code=wlo')
    meta = {s['id']: s for s in stations}
    # wlo time-series id → station, so we keep only observed-level readings
    ts_owner = {}
    for s in stations:
        for ts in s.get('timeSeries', []):
            if ts.get('code') == 'wlo':
                ts_owner[ts['id']] = s
    latest = get_json(f'{IWLS}/stations/data/latest')
    out = []
    for entry in latest:
        s = meta.get(entry.get('stationId'))
        if not s:
            continue
        obs = [d for d in entry.get('measurementDTOs', [])
               if d.get('timeSeriesId') in ts_owner and d.get('value') is not None]
        if not obs:
            continue
        newest = max(obs, key=lambda d: d.get('eventDate', ''))
        out.append({
            'id': s.get('code') or sid,
            'name': s.get('officialName') or '',
            'prov': '',
            'kind': 'coastal',
            'coords': [s['longitude'], s['latitude']],
            'level': round(float(newest['value']), 3),
            'discharge': None,
            'time': newest.get('eventDate'),
            'src': 'dfo',
        })
    return out


# --------------------------------------------------------------- ORRPB
MARKER_RE = re.compile(
    r'<div class="marker" data-lat="([\d.-]+)" data-lng="([\d.-]+)"'
    r' data-colors="([^"]*)" data-name="([^"]+)">(.*?)</div>\s*</div>\s*</div>',
    re.S)
CONDITION_RE = re.compile(
    r'<div class="label-cc"><strong>(.*?)<br><small>\((\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}\)</small>'
    r'.*?<div class="data-cc\s*(cat-[a-z]+)?">([\d,]+(?:\.\d+)?)</div>',
    re.S)
CAT_MAP = {'cat-low': 'low', 'cat-normal': 'normal', 'cat-high': 'high'}


def fetch_orrpb():
    out = []
    for display in ('river', 'reservoir'):
        req = urllib.request.Request(f'{ORRPB}?display={display}', headers=UA)
        with urllib.request.urlopen(req, timeout=60) as r:
            page = r.read().decode('utf-8', 'replace')
        for lat, lng, colors, name, body in MARKER_RE.findall(page):
            name = html.unescape(name).strip()
            slug = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
            level = flow = when = None
            cat = CAT_MAP.get(colors.strip())
            for label, ts, valcat, val in CONDITION_RE.findall(body):
                v = float(val.replace(',', ''))
                if 'level' in label.lower():
                    level, when = v, ts.replace(' ', 'T') + ':00Z'
                    if valcat in CAT_MAP:      # per-value class beats marker class
                        cat = CAT_MAP[valcat]
                elif 'flow' in label.lower():
                    flow = v
            out.append({
                'id': f'orrpb-{display}-{slug}',
                'name': name,
                'prov': 'ON/QC',
                'kind': 'reservoir' if display == 'reservoir' else 'river',
                'coords': [float(lng), float(lat)],
                'level': level,
                'discharge': flow,
                'time': when,
                'orrpb_cat': cat,
                'src': 'orrpb',
            })
    return out


# ----------------------------------------------------- Québec (HQ + MSP)
def fetch_hq():
    """Hydro-Québec open data: hourly levels at generating/reservoir
    stations (the only public source for northern QC reservoirs like the
    La Grande chain). One bulk export of the last 2 days, keep the newest
    reading per station."""
    where = urllib.parse.quote(
        'composition_depil_type_point_donnee like "Niveau" and date > now(days=-2)')
    rows = get_json(f'{HQ}?where={where}', timeout=180)
    best = {}
    for r in rows:
        sid, when = r.get('identifiant'), r.get('date')
        if not sid or not when or r.get('valeur') is None:
            continue
        if sid not in best or when > best[sid]['date']:
            best[sid] = r
    out = []
    for r in best.values():
        if r.get('xcoord') is None or r.get('ycoord') is None:
            continue
        name = r.get('nom') or r['identifiant']
        out.append({
            'id': f"hq-{r['identifiant']}",
            'name': name,
            'prov': 'QC',
            'kind': 'reservoir' if re.search(r'amont|réservoir|reservoir|lac|baie', name, re.I) else 'river',
            'coords': [r['xcoord'], r['ycoord']],
            'level': round(float(r['valeur']), 3),
            'discharge': None,
            'time': r['date'][:19] + 'Z' if 'T' in r['date'] else r['date'],
            'src': 'hq',
        })
    return out


QC_ETAT = {  # MSP Vigilance flood-status → our classes (no percentile
             # history for provincial stations, so trust their assessment)
    'État normal': 'normal',
    'Surveillance': 'high',
    'Inondation mineure': 'very-high',
    'Inondation moyenne': 'very-high',
    'Inondation majeure': 'very-high',
}


def fetch_qc(known_eccc_ids):
    """Québec MSP Vigilance WFS — provincial (MELCCFP) stations. Federal
    stations in the feed are dropped (already covered by ECCC)."""
    gj = get_json(QC_WFS, timeout=120)
    out = []
    for f in gj.get('features', []):
        p = f.get('properties', {})
        sid = (p.get('station') or '').strip()
        if not sid or sid in known_eccc_ids:
            continue
        if 'Environnement Canada' in (p.get('fournisseur_nom') or ''):
            continue
        level, flow = p.get('dern_valeur_niv'), p.get('dern_valeur_deb')
        if level is None and flow is None:
            continue
        when = p.get('dern_date_prise_valeur_utc')
        name = p.get('plan_deau') or sid
        desc = p.get('description') or ''
        out.append({
            'id': f'qc-{sid}',
            'name': f'{name} — {desc}' if desc else name,
            'prov': 'QC',
            'kind': station_kind(name),
            'coords': f['geometry']['coordinates'][:2],
            'level': round(float(level), 3) if level is not None else None,
            'discharge': round(float(flow), 2) if flow is not None else None,
            'time': (when + 'Z') if when and not when.endswith('Z') else when,
            'qc_etat': QC_ETAT.get((p.get('etat') or '').strip()),
            'src': 'qc',
        })
    return out


# ------------------------------------------------------ Alberta rivers
# rivers.alberta.ca publishes Level + Live-Storage + Percent-Full-Live as
# 30-min JSON for several managed reservoirs — the % is authoritative
# (no FSL/datum math needed on our side).
AB_URL = ('https://rivers.alberta.ca/apps/Basins/data/figures/river/'
          'abrivers/stationdata/L_HG_{stn}_table.json')
AB_RESERVOIRS = [
    ('05BJ008', 'Glenmore Reservoir', 51.0006, -114.0975),
    ('05AA032', 'Oldman River Dam Reservoir', 49.612, -114.0533),
    ('05AE025', 'St. Mary Reservoir', 49.363, -113.1146),
    ('05BE005', 'Ghost Lake Reservoir', 51.2167, -114.7167),
]


def fetch_ab():
    out = []
    for stn, name, lat, lon in AB_RESERVOIRS:
        try:
            req = urllib.request.Request(
                AB_URL.format(stn=stn),
                headers={**UA, 'Referer': 'https://rivers.alberta.ca/'})
            with urllib.request.urlopen(req, timeout=60) as r:
                doc = json.load(r)[0]
            cols = doc.get('columnarray', [])
            rows = [row for row in doc.get('data', []) if row and row[1] is not None]
            if not rows:
                continue
            last = rows[-1]
            def col(label):
                try:
                    return last[cols.index(label)]
                except (ValueError, IndexError):
                    return None
            level, pct = col('Level'), col('% Full')
            out.append({
                'id': f'ab-{stn}',
                'name': name,
                'prov': 'AB',
                'kind': 'reservoir',
                'coords': [lon, lat],
                'level': round(level, 3) if level is not None else None,
                'discharge': None,
                # timestamps are Alberta local (MT ≈ UTC-6); approximate UTC
                'time': (dt.datetime.fromisoformat(last[0]) +
                         dt.timedelta(hours=6)).strftime('%Y-%m-%dT%H:%M:%SZ'),
                'ab_pct': round(pct, 1) if pct is not None else None,
                'src': 'ab',
            })
        except Exception as e:
            print(f'ab {stn}: {e}', file=sys.stderr)
    return out


# ------------------------------------------------------- classification
def classify(value, band):
    p05, p25, _p50, p75, p95 = band[:5]
    if value < p05:
        return 'very-low'
    if value < p25:
        return 'low'
    if value <= p75:
        return 'normal'
    if value <= p95:
        return 'high'
    return 'very-high'


def add_class(stations, normals, month):
    m = str(month)
    for s in stations:
        s['class'] = None
        s['classBy'] = None
        s['p50'] = None
        if s.get('orrpb_cat'):          # ORRPB publishes its own status
            s['class'] = s.pop('orrpb_cat')
            s['classBy'] = 'orrpb'
            continue
        s.pop('orrpb_cat', None)
        if s.get('qc_etat'):            # MSP Vigilance flood status
            s['class'] = s.pop('qc_etat')
            s['classBy'] = 'qc-vigilance'
            continue
        s.pop('qc_etat', None)
        bands = normals.get(s['id'])
        if not bands:
            continue
        lb = bands.get('L', {}).get(m)
        qb = bands.get('Q', {}).get(m)
        if s['level'] is not None and lb:
            s['class'] = classify(s['level'], lb)
            s['classBy'] = 'level'
            s['p50'] = lb[2]
        elif s['discharge'] is not None and qb:
            s['class'] = classify(s['discharge'], qb)
            s['classBy'] = 'discharge'
            s['p50'] = qb[2]


# -------------------------------------------------- reservoir capacity
def static_reservoirs(stations):
    """Curated reservoirs with no live gauge (e.g. Sooke Lake — CRD
    publishes weekly PDFs only) still get a map marker with their static
    capacity facts, so major municipal supplies aren't invisible."""
    if not RESERVOIRS.exists():
        return []
    curated = json.loads(RESERVOIRS.read_text())
    live_ids = {s['id'] for s in stations}
    out = []
    for r in curated:
        if r.get('station') in live_ids:
            continue
        s = {
            'id': 'res-' + re.sub(r'[^a-z0-9]+', '-', r['name'].lower()).strip('-'),
            'name': r['name'],
            'prov': r.get('province', ''),
            'kind': 'reservoir',
            'coords': [r['lon'], r['lat']],
            'level': None,
            'discharge': None,
            'time': None,
            'resName': r['name'],
            'resOperator': r.get('operator'),
            'src': 'static',
        }
        if r.get('capacity_km3'):
            s['capacityKm3'] = r['capacity_km3']
        if r.get('fsl_m') is not None:
            s['fslM'] = r['fsl_m']
        if r.get('note'):
            s['resNote'] = r['note']
        out.append(s)
    return out


def add_capacity(stations):
    """Attach fill %% and estimated stored volume to stations that measure
    a curated major reservoir (data/canada-reservoirs.json: verified full
    supply level, min operating level, live capacity, station link).
    Fill %% = (level - min) / (FSL - min), clamped to [0, 1]. This is a
    linear approximation — real storage curves are non-linear in level —
    so it's presented as an estimate."""
    if not RESERVOIRS.exists():
        return
    curated = json.loads(RESERVOIRS.read_text())
    by_station = {}
    for r in curated:
        if r.get('station'):
            by_station[r['station']] = r
    for s in stations:
        r = by_station.get(s['id'])
        if not r:
            continue
        s['resName'] = r['name']
        s['resOperator'] = r.get('operator')
        s['kind'] = 'reservoir'
        if r.get('capacity_km3'):
            s['capacityKm3'] = r['capacity_km3']
        if r.get('fsl_m') is not None:
            s['fslM'] = r['fsl_m']
        # Source-published fill %% (Alberta rivers feed) beats our estimate
        if s.get('ab_pct') is not None:
            s['fillPct'] = min(100.0, s.pop('ab_pct'))
            if r.get('capacity_km3'):
                s['estStorageKm3'] = round(s['fillPct'] / 100 * r['capacity_km3'], 3)
            continue
        fsl, lo = r.get('fsl_m'), r.get('min_level_m')
        if s.get('level') is None or fsl is None or lo is None or fsl <= lo:
            continue
        # Datum sanity check: some WSC gauges report on a station-local
        # datum (e.g. Williston reads ~42 m vs a 672 m geodetic FSL).
        # Only compute fill % when the reading is plausibly on the same
        # datum as the operating range (within the range ± half its span).
        span = fsl - lo
        if not (lo - span/2 <= s['level'] <= fsl + span/2):
            continue
        frac = max(0.0, min(1.0, (s['level'] - lo) / span))
        s['fillPct'] = round(frac * 100, 1)
        if r.get('capacity_km3'):
            s['estStorageKm3'] = round(frac * r['capacity_km3'], 2)


# ---------------------------------------------------------------- main
def main():
    now = dt.datetime.now(dt.timezone.utc)
    normals = json.loads(NORMALS.read_text()) if NORMALS.exists() else {}

    all_stations, errors = [], []
    eccc_ids = set()
    for name, fn in (('eccc', lambda: fetch_eccc(now)),
                     ('dfo', fetch_dfo),
                     ('orrpb', fetch_orrpb),
                     ('hq', fetch_hq),
                     ('qc', lambda: fetch_qc(eccc_ids)),
                     ('ab', fetch_ab)):
        try:
            got = fn()
            print(f'{name}: {len(got)} stations')
            all_stations.extend(got)
            if name == 'eccc':
                eccc_ids = {s['id'] for s in got}
        except Exception as e:
            print(f'{name}: FAILED — {e}', file=sys.stderr)
            errors.append(name)

    if not all_stations:
        sys.exit('all sources failed — keeping previous data file')

    add_class(all_stations, normals, now.month)
    add_capacity(all_stations)
    all_stations.extend(static_reservoirs(all_stations))

    features = []
    for s in all_stations:
        features.append({
            'type': 'Feature',
            'geometry': {'type': 'Point',
                         'coordinates': [round(s['coords'][0], 5), round(s['coords'][1], 5)]},
            'properties': {k: v for k, v in s.items() if k != 'coords' and v is not None},
        })

    gj = {
        'type': 'FeatureCollection',
        'generated': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'sources_failed': errors,
        'attribution': ('Data: Environment and Climate Change Canada · '
                        'Fisheries and Oceans Canada (CHS) · '
                        'Ottawa River Regulation Planning Board · '
                        'Hydro-Québec · Québec MSP/MELCCFP. Provisional data.'),
        'features': features,
    }
    OUT.write_text(json.dumps(gj, separators=(',', ':')))
    classed = sum(1 for f in features if f['properties'].get('class'))
    print(f'wrote {OUT} ({OUT.stat().st_size/1e3:.0f} KB, '
          f'{len(features)} stations, {classed} classified)')


if __name__ == '__main__':
    main()
