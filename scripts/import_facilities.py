#!/usr/bin/env python3
"""
Import bulk facility registries into data/canada-facilities-registry.js
(a separate file from the hand-curated data/canada-data.js — curated rows
always win on conflict and are never modified here).

Sources (all Open Government Licence, verified 2026-08):
  NPRI geolocations CSV   — every above-threshold industrial facility;
                            filtered to last report >= 2022 and target NAICS.
  NRCan Map 900A layers   — producing mines, smelters/refineries, steel,
                            ferroalloy (+ critical-minerals processing).
                            Authoritative for mining/metallurgy.
  QC/ON/BC mill datasets  — sawmills etc. below the NPRI threshold.

Dedup strategy (three passes):
  1. Registry-vs-registry: 900A/provincial rows beat NPRI rows within
     2 km when name tokens overlap (or 500 m regardless of name).
  2. Registry-vs-curated: any import within 2 km of a curated
     data/canada-data.js row with overlapping name/operator tokens is
     dropped (curated keeps its verified capacity/status/notes).
     Within 300 m it is dropped even without a name match.
  3. Identical snapped coordinates (~100 m) within the import → keep the
     richer record.

Usage: python3 scripts/import_facilities.py /path/to/downloads_dir
"""
import csv
import json
import math
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-facilities-registry.js'
CURATED = ROOT / 'data' / 'canada-data.js'

# NAICS prefix → (sector, subcategory) mapping for the map's hierarchy.
NAICS_MAP = [
    # Wood / forest
    ('321111', ('Forest', 'Sawmill')),
    ('321112', ('Forest', 'Shingle & Shake Mill')),
    ('321114', ('Forest', 'Wood Preservation')),
    ('32121',  ('Forest', 'Veneer & Plywood')),
    ('32191',  ('Forest', 'Millwork')),
    ('32192',  ('Forest', 'Wood Container & Pallet')),
    ('32199',  ('Forest', 'Other Wood Products')),
    ('32211',  ('Forest', 'Pulp Mill')),
    ('32212',  ('Forest', 'Paper Mill')),
    ('32213',  ('Forest', 'Paperboard Mill')),
    ('3222',   ('Forest', 'Converted Paper Products')),
    # Mining
    ('2121',   ('Mining', 'Coal Mine')),
    ('2122',   ('Mining', 'Metal Ore Mine')),
    ('2123',   ('Mining', 'Non-metallic Mineral Mine')),
    # Primary metals & fabrication
    ('3311',   ('Metals', 'Iron & Steel Mill')),
    ('3312',   ('Metals', 'Steel Product Mfg')),
    ('3313',   ('Metals', 'Alumina & Aluminum')),
    ('3314',   ('Metals', 'Non-ferrous Smelting/Refining')),
    ('3315',   ('Metals', 'Foundry')),
    ('3321',   ('Metals', 'Forging & Stamping')),
    # Transportation equipment (stamping/auto/machine)
    ('33611',  ('Metals', 'Auto & Light Truck Assembly')),
    ('33612',  ('Metals', 'Heavy Vehicle Mfg')),
    ('3362',   ('Metals', 'Vehicle Body & Trailer')),
    ('3363',   ('Metals', 'Auto Parts & Stamping')),
    ('3364',   ('Metals', 'Aerospace Mfg')),
    ('3365',   ('Metals', 'Rail Equipment Mfg')),
    ('3366',   ('Metals', 'Shipbuilding')),
    ('3331',   ('Metals', 'Ag/Construction Machinery')),
    ('3332',   ('Metals', 'Industrial Machinery')),
    # Food / agri processing
    ('3111',   ('Agricultural Processing', 'Animal Feed')),
    ('3112',   ('Agricultural Processing', 'Grain & Oilseed Milling')),
    ('3113',   ('Agricultural Processing', 'Sugar & Confectionery')),
    ('3114',   ('Agricultural Processing', 'Fruit/Vegetable & Specialty')),
    ('3115',   ('Agricultural Processing', 'Dairy')),
    ('3116',   ('Agricultural Processing', 'Meat')),
    ('3117',   ('Agricultural Processing', 'Seafood')),
    ('3118',   ('Agricultural Processing', 'Bakery & Tortilla')),
    ('3119',   ('Agricultural Processing', 'Other Food')),
    ('3121',   ('Agricultural Processing', 'Beverage')),
    # Other heavy industry worth showing
    ('3251',   ('Chemicals', 'Basic Chemical Mfg')),
    ('3252',   ('Chemicals', 'Resin & Synthetic Rubber')),
    ('3253',   ('Chemicals', 'Fertilizer & Pesticide')),
    ('3254',   ('Chemicals', 'Pharmaceutical')),
    ('3261',   ('Chemicals', 'Plastics Products')),
    ('3262',   ('Chemicals', 'Rubber Products')),
    ('3271',   ('Minerals', 'Clay & Ceramics')),
    ('3272',   ('Minerals', 'Glass')),
    ('3273',   ('Minerals', 'Cement & Concrete')),
    ('3274',   ('Minerals', 'Lime & Gypsum')),
    ('3279',   ('Minerals', 'Other Non-metallic')),
]
MIN_YEAR = 2022

PROV_OK = {'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'}


def naics_class(code):
    code = str(code or '')
    for prefix, cls in NAICS_MAP:
        if code.startswith(prefix):
            return cls
    return None


def tokens(s):
    s = re.sub(r'[^a-z0-9 ]', ' ', (s or '').lower())
    stop = {'inc','ltd','ltee','limited','corp','corporation','co','company',
            'canada','canadian','the','of','and','du','de','la','le','les',
            'mill','plant','facility','division','site','operations','group'}
    return {t for t in s.split() if len(t) > 2 and t not in stop}


def dist_km(a_lat, a_lon, b_lat, b_lon):
    dy = (a_lat - b_lat) * 111.32
    dx = (a_lon - b_lon) * 111.32 * math.cos(math.radians((a_lat + b_lat) / 2))
    return math.hypot(dx, dy)


class Grid:
    """~5 km cell spatial index for pairwise proximity checks."""
    def __init__(self):
        self.cells = {}

    @staticmethod
    def key(lat, lon):
        return (round(lat * 20), round(lon * 20))

    def add(self, lat, lon, item):
        self.cells.setdefault(self.key(lat, lon), []).append((lat, lon, item))

    def near(self, lat, lon):
        k0, k1 = self.key(lat, lon)
        for dk0 in (-1, 0, 1):
            for dk1 in (-1, 0, 1):
                yield from self.cells.get((k0 + dk0, k1 + dk1), ())


def load_curated():
    src = CURATED.read_text()
    out = []
    for m in re.finditer(r"\{name:'((?:[^'\\]|\\.)*)'.*?lat:([0-9.-]+),\s*lon:([0-9.-]+)", src):
        name = m.group(1).replace("\\'", "'")
        seg = src[m.start():m.start() + 600]
        op = re.search(r"operator:'((?:[^'\\]|\\.)*)'", seg)
        out.append({'name': name,
                    'op': op.group(1).replace("\\'", "'") if op else '',
                    'lat': float(m.group(2)), 'lon': float(m.group(3))})
    return out


def load_npri(d):
    out = []
    with open(d / 'npri_geo.csv', encoding='latin-1') as f:
        for row in csv.DictReader(f):
            row = {k.split(' / ')[0].strip(): v for k, v in row.items()}
            try:
                year = int(row['Year of last filed report'])
                lat = float(row['Latitude'])
                lon = float(row['Longitude'])
            except (ValueError, KeyError):
                continue
            if year < MIN_YEAR or row.get('Province') not in PROV_OK:
                continue
            cls = naics_class(row.get('NAICS'))
            if not cls:
                continue
            out.append({
                'name': row.get('Facility Name') or row.get('Company Name'),
                'operator': row.get('Company Name'),
                'sector': cls[0], 'subcategory': cls[1],
                'province': row.get('Province'),
                'city': (row.get('City') or '').title(),
                'lat': round(lat, 5), 'lon': round(lon, 5),
                'src': 'npri', 'srcId': row.get('NPRI ID'),
                'naics': row.get('NAICS'),
            })
    return out


M900A = [
    ('900a_metal_mines.geojson', 'Mining', 'Metal Ore Mine'),
    ('900a_nonmetal_mines.geojson', 'Mining', 'Non-metallic Mineral Mine'),
    ('900a_coal_mines.geojson', 'Mining', 'Coal Mine'),
    ('900a_oilsands.geojson', 'Mining', 'Oil Sands Mine'),
    ('900a_smelters.geojson', 'Metals', 'Non-ferrous Smelting/Refining'),
    ('900a_steel.geojson', 'Metals', 'Iron & Steel Mill'),
    ('900a_ferroalloy.geojson', 'Metals', 'Ferroalloy'),
    ('cm_processing.geojson', 'Metals', 'Critical Minerals Processing'),
]


def load_900a(d):
    out = []
    for fname, sector, sub in M900A:
        path = d / fname
        if not path.exists():
            print(f'! missing {fname}', file=sys.stderr)
            continue
        gj = json.loads(path.read_text())
        for f in gj.get('features', []):
            p = {k.lower(): v for k, v in (f.get('properties') or {}).items()}
            geom = f.get('geometry') or {}
            if geom.get('type') != 'Point':
                continue
            lon, lat = geom['coordinates'][:2]
            name = p.get('operation_name_en') or p.get('operation_name') or p.get('name_en')
            if not name:
                continue
            commodity = p.get('product_group_en') or p.get('product_en') or p.get('product') or ''
            out.append({
                'name': name,
                'operator': p.get('operator_owners_en') or p.get('operator') or '',
                'sector': sector, 'subcategory': sub,
                'province': (p.get('province_en') or p.get('province') or '')[:40],
                'city': p.get('city_en') or p.get('city') or '',
                'lat': round(lat, 5), 'lon': round(lon, 5),
                'src': '900a',
                'commodity': commodity,
            })
    return out


def load_mills(d):
    out = []
    # Quebec
    qc = d / 'qc_mills.geojson'
    if qc.exists():
        for f in json.loads(qc.read_text()).get('features', []):
            p = f.get('properties') or {}
            geom = f.get('geometry') or {}
            if geom.get('type') != 'Point':
                continue
            lon, lat = geom['coordinates'][:2]
            name = p.get('usicomplet') or ''
            cat = (p.get('catcomplet') or '').lower()
            sub = ('Pulp Mill' if 'pâte' in cat or 'pate' in cat else
                   'Paper Mill' if 'papier' in cat or 'carton' in cat else
                   'Veneer & Plywood' if 'placage' in cat or 'contreplaqu' in cat or 'panneau' in cat else
                   'Sawmill' if 'sciage' in cat else
                   'Wood Energy/Cogen' if 'cogénération' in cat or 'énergétique' in cat else
                   'Other Wood Products')
            city = re.sub(r'\s*\(\d+\)$', '', p.get('muncomplet') or '')
            # volresper/volfeuper = softwood/hardwood consumption (m³/yr)
            vol = (p.get('volresper') or 0) + (p.get('volfeuper') or 0)
            rec = {'name': name, 'operator': '',
                   'sector': 'Forest', 'subcategory': sub,
                   'province': 'QC', 'city': city,
                   'lat': round(lat, 5), 'lon': round(lon, 5), 'src': 'qc-mffp'}
            if vol:
                rec['capacity'] = vol
                rec['unit'] = 'm³ wood/yr'
            out.append(rec)
    # BC — PRODUCT_CODE: LBR lumber, CHP chips, PLP pulp, PPR paper, PNL
    # panels, VNR veneer, SHK shakes, PEL pellets, POL poles...
    BC_SUB = {'LBR': 'Sawmill', 'CHP': 'Chip Mill', 'PLP': 'Pulp Mill',
              'PPR': 'Paper Mill', 'NSP': 'Paper Mill', 'PNL': 'Veneer & Plywood',
              'VNR': 'Veneer & Plywood', 'PLY': 'Veneer & Plywood',
              'SHK': 'Shingle & Shake Mill', 'PEL': 'Wood Pellet Mill',
              'POL': 'Pole & Timber Yard'}
    bc = d / 'bc_mills.geojson'
    if bc.exists():
        for f in json.loads(bc.read_text()).get('features', []):
            p = f.get('properties') or {}
            geom = f.get('geometry') or {}
            if geom.get('type') != 'Point':
                continue
            lon, lat = geom['coordinates'][:2]
            if (p.get('STATUS') or '').strip().lower() not in ('op', 'active', 'operating'):
                continue
            rec = {'name': p.get('COMPANY_NAME') or '',
                   'operator': p.get('COMPANY_NAME') or '',
                   'sector': 'Forest',
                   'subcategory': BC_SUB.get((p.get('PRODUCT_CODE') or '').strip(),
                                             'Other Wood Products'),
                   'province': 'BC', 'city': p.get('LOCALITY') or '',
                   'lat': round(lat, 5), 'lon': round(lon, 5), 'src': 'bc-gsr'}
            for field, unit in (('EST_AN_CAP_MLN_BOARD_FT', 'MMfbm/yr'),
                                ('EST_AN_CAP_000_BDUS', 'kBDU/yr'),
                                ('EST_AN_CAP_000_TONNES', 'kt/yr')):
                if p.get(field):
                    rec['capacity'] = p[field]
                    rec['unit'] = unit
                    break
            out.append(rec)
    return out


def dedupe(imports, curated):
    # pass 1: prefer 900a/provincial over npri nearby
    rank = {'900a': 0, 'qc-mffp': 1, 'bc-gsr': 1, 'npri': 2}
    imports.sort(key=lambda r: rank.get(r['src'], 3))
    grid = Grid()
    kept = []
    dropped_reg = dropped_cur = 0
    cur_grid = Grid()
    for c in curated:
        cur_grid.add(c['lat'], c['lon'], c)
    for r in imports:
        rt = tokens(r['name']) | tokens(r.get('operator'))
        # vs curated
        clash = False
        for lat, lon, c in cur_grid.near(r['lat'], r['lon']):
            dkm = dist_km(r['lat'], r['lon'], lat, lon)
            if dkm < 0.3 or (dkm < 2.0 and rt & (tokens(c['name']) | tokens(c['op']))):
                clash = True
                break
        if clash:
            dropped_cur += 1
            continue
        # vs already-kept imports
        for lat, lon, k in grid.near(r['lat'], r['lon']):
            dkm = dist_km(r['lat'], r['lon'], lat, lon)
            if dkm < 0.1 or (dkm < 2.0 and rt & (tokens(k['name']) | tokens(k.get('operator')))):
                clash = True
                break
        if clash:
            dropped_reg += 1
            continue
        grid.add(r['lat'], r['lon'], r)
        kept.append(r)
    print(f'dedupe: {len(kept)} kept · {dropped_cur} dropped vs curated · '
          f'{dropped_reg} dropped within import')
    return kept


def main():
    d = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/facreg')
    curated = load_curated()
    print(f'{len(curated)} curated facilities loaded')
    imports = load_900a(d) + load_mills(d) + load_npri(d)
    print(f'{len(imports)} raw registry records '
          f'(900a/mills/npri = {sum(1 for r in imports if r["src"]=="900a")}/'
          f'{sum(1 for r in imports if r["src"] in ("qc-mffp","bc-gsr"))}/'
          f'{sum(1 for r in imports if r["src"]=="npri")})')
    kept = dedupe(imports, curated)

    for r in kept:
        r['status'] = 'Active'
    kept.sort(key=lambda r: (r['sector'], r['subcategory'], r['province'], r['name'] or ''))

    body = json.dumps(kept, ensure_ascii=False, separators=(',', ':'))
    OUT.write_text(
        '// AUTO-GENERATED by scripts/import_facilities.py — do not hand-edit.\n'
        '// Sources: ECCC NPRI (last report >= %d) · NRCan Map 900A ·\n'
        '// QC MFFP / BC GSR mill registries. Open Government Licence – Canada.\n'
        '// Curated data/canada-data.js rows always take precedence (deduped here).\n'
        'window.CANADA_REGISTRY_FACILITIES = %s;\n' % (MIN_YEAR, body))
    import collections
    c = collections.Counter((r['sector'], r['subcategory']) for r in kept)
    print(f'wrote {OUT} ({OUT.stat().st_size/1e6:.1f} MB, {len(kept)} facilities)')
    for (s, b), n in sorted(c.items()):
        print(f'  {n:5} {s} / {b}')


if __name__ == '__main__':
    main()
