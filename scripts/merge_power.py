#!/usr/bin/env python3
"""
Merge power-audit workflow output (/tmp/power_audit.json) into
data/canada-power.js, deduping against existing entries by name
similarity and proximity. High/medium confidence only; low-confidence
entries are skipped.
"""
import json, re, html, math, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / 'data' / 'canada-power.js'
AUDIT = pathlib.Path('/tmp/power_audit.json')

CANADA = {'BC','AB','SK','MB','ON','QC','NB','NS','PE','NL','YT','NT','NU'}


def norm_name(n):
    n = html.unescape(n or '').lower()
    n = re.sub(r'\b(generating|power|energy|station|dam|plant|project|facility|hydro(electric)?|gs|complex|centre|center|wind farm|solar)\b', ' ', n)
    n = re.sub(r'[^a-z0-9]+', ' ', n)
    return ' '.join(n.split())


def parse_existing_plants(text):
    out = []
    m = re.search(r'plants:\s*\[(.*?)\n  \],', text, re.S)
    if not m:
        return out
    for ln in m.group(1).split('\n'):
        nm = re.search(r"name:'([^']+)'", ln)
        la = re.search(r'lat:(-?\d+\.?\d*)', ln)
        lo = re.search(r'lon:(-?\d+\.?\d*)', ln)
        if nm:
            out.append({
                'name': nm.group(1), 'norm': norm_name(nm.group(1)),
                'lat': float(la.group(1)) if la else None,
                'lon': float(lo.group(1)) if lo else None,
            })
    return out


def parse_existing_tx(text):
    out = []
    m = re.search(r'interties:\s*\[(.*?)\n  \]\n\};', text, re.S)
    if not m:
        return out
    for nm in re.findall(r"name:'([^']+)'", m.group(1)):
        out.append({'name': nm, 'norm': norm_name(nm)})
    return out


def haversine(a, b):
    if None in (a.get('lat'), a.get('lon'), b.get('lat'), b.get('lon')):
        return 9999
    R = 6371
    p1, p2 = math.radians(a['lat']), math.radians(b['lat'])
    dp = p2 - p1
    dl = math.radians(b['lon'] - a['lon'])
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2 * R * math.asin(math.sqrt(h))


def is_dup_plant(p, existing):
    pn = norm_name(p.get('name', ''))
    for e in existing:
        if pn and (pn == e['norm'] or pn in e['norm'] or e['norm'] in pn):
            return True
        if haversine(p, e) < 3 and p.get('mw') and e.get('lat'):
            # within 3km of an existing plant — likely same site
            if pn and e['norm'] and len(set(pn.split()) & set(e['norm'].split())) >= 1:
                return True
    return False


def is_dup_tx(t, existing):
    tn = norm_name(t.get('name', ''))
    for e in existing:
        if tn and (tn == e['norm'] or tn in e['norm'] or e['norm'] in tn):
            return True
    return False


def js_str(s):
    s = html.unescape(s or '')
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def fmt_plant(p):
    name = js_str(p['name'])
    op = js_str(p.get('operator', '') or '')
    prov = js_str(p['province'])
    city = js_str(p.get('city', '') or p['province'])
    lat = p.get('lat'); lon = p.get('lon')
    if lat is None or lon is None or not (-141 <= lon <= -52 and 41 <= lat <= 84):
        return None
    mw = p.get('mw', 0) or 0
    status = js_str(p.get('status', 'Active') or 'Active')
    return (f"    {{name:{name},type:'{p['type']}',operator:{op},province:{prov},"
            f"city:{city},lat:{lat:.3f},lon:{lon:.3f},mw:{mw},status:{status}}},")


def fmt_tx(t):
    name = js_str(t['name'])
    kv = t.get('kv', 0) or 0
    typ = js_str(t.get('type', 'AC') or 'AC')
    op = js_str(t.get('op', '') or '')
    path = t.get('path') or []
    if len(path) < 2:
        return None
    # validate path coords
    pts = []
    for pt in path:
        if len(pt) != 2:
            return None
        la, lo = pt
        if not (-90 <= la <= 90 and -180 <= lo <= 180):
            return None
        pts.append(f'[{la:.3f},{lo:.3f}]')
    return (f"    {{name:{name},kv:{kv},type:{typ},op:{op},\n"
            f"     path:[{','.join(pts)}]}},")


def main():
    src = SRC.read_text(encoding='utf-8')
    audit = json.loads(AUDIT.read_text())

    existing_plants = parse_existing_plants(src)
    existing_tx = parse_existing_tx(src)
    print(f'existing: {len(existing_plants)} plants, {len(existing_tx)} interties')

    new_plants = []
    skipped = {'dup': 0, 'lowconf': 0, 'badcoord': 0, 'badprov': 0}
    for p in audit['plants']:
        if p.get('confidence') == 'low':
            skipped['lowconf'] += 1; continue
        if p.get('province') not in CANADA:
            skipped['badprov'] += 1; continue
        if is_dup_plant(p, existing_plants):
            skipped['dup'] += 1; continue
        line = fmt_plant(p)
        if line is None:
            skipped['badcoord'] += 1; continue
        new_plants.append(line)
        existing_plants.append({'name': p['name'], 'norm': norm_name(p['name']),
                                 'lat': p.get('lat'), 'lon': p.get('lon')})

    new_tx = []
    tx_skipped = {'dup': 0, 'lowconf': 0, 'badpath': 0}
    for t in audit['transmission']:
        if t.get('confidence') == 'low':
            tx_skipped['lowconf'] += 1; continue
        if is_dup_tx(t, existing_tx):
            tx_skipped['dup'] += 1; continue
        line = fmt_tx(t)
        if line is None:
            tx_skipped['badpath'] += 1; continue
        new_tx.append(line)
        existing_tx.append({'name': t['name'], 'norm': norm_name(t['name'])})

    print(f'new plants: +{len(new_plants)} (skipped {skipped})')
    print(f'new interties: +{len(new_tx)} (skipped {tx_skipped})')

    # Insert before each closing bracket
    if new_plants:
        ins = '\n\n    // ---- Added from power-audit workflow (high/med confidence) ----\n' + '\n'.join(new_plants)
        src = re.sub(r'(\n  \],\n\n  // ---- Major transmission)',
                     ins + r'\1', src, count=1)
    if new_tx:
        ins = '\n\n    // ---- Added from power-audit workflow ----\n' + '\n'.join(new_tx)
        src = re.sub(r'(\n  \]\n\};)', ins + r'\1', src, count=1)

    SRC.write_text(src, encoding='utf-8')
    print(f'✓ wrote {SRC}')


if __name__ == '__main__':
    main()
