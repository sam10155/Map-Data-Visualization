#!/usr/bin/env python3
"""
Pre-bake per-station monthly percentile bands from ECCC's HYDAT archive
into data/canada-water-normals.json, used by fetch_water_levels.py to
classify current readings as very-low / low / normal / high / very-high.

HYDAT is a ~266 MB quarterly sqlite release. The filename is date-stamped,
so we scrape the index page for the latest Hydat_sqlite3_*.zip. Run this
once (and re-run quarterly if you care about drift) — the output JSON is
committed to the repo.

Levels are relative to each station's local datum, so percentile bands are
the only cross-station-comparable signal. Many long-running stations have
short LEVEL records but century-long DISCHARGE records, so bands are baked
for both; the fetcher prefers level bands and falls back to discharge.

Output shape (~1.3 MB):
  { "05BB001": { "L": {"6": [p05,p25,p50,p75,p95,n], ...},
                 "Q": {"6": [...], ...} }, ... }

Usage:
  python3 scripts/bake_water_normals.py [path/to/Hydat.sqlite3]
  (downloads to a temp dir if no local sqlite path is given)
"""
import json, math, pathlib, re, sqlite3, ssl, sys, tempfile, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-water-normals.json'
INDEX_URL = 'https://collaboration.cmc.ec.gc.ca/cmc/hydrometrics/www/'

MIN_SAMPLES = 150          # ≥ ~5 years of daily values per (station, month)
PCTS = (0.05, 0.25, 0.50, 0.75, 0.95)


def fetch_hydat(tmpdir):
    # This server's TLS chain fails default verification in some
    # environments; HYDAT is public data, so fall back to unverified.
    ctx = ssl.create_default_context()
    try:
        index = urllib.request.urlopen(INDEX_URL, timeout=60, context=ctx).read().decode()
    except ssl.SSLError:
        ctx = ssl._create_unverified_context()
        index = urllib.request.urlopen(INDEX_URL, timeout=60, context=ctx).read().decode()
    names = sorted(set(re.findall(r'Hydat_sqlite3_\d+\.zip', index)))
    if not names:
        sys.exit('no Hydat_sqlite3_*.zip found on index page')
    name = names[-1]
    zpath = pathlib.Path(tmpdir) / name
    print(f'downloading {name} (~266 MB)…')
    with urllib.request.urlopen(INDEX_URL + name, timeout=600, context=ctx) as r, open(zpath, 'wb') as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    print('unzipping…')
    with zipfile.ZipFile(zpath) as z:
        sq = [n for n in z.namelist() if n.lower().endswith('.sqlite3')][0]
        z.extract(sq, tmpdir)
    return pathlib.Path(tmpdir) / sq


def percentile(sorted_vals, p):
    """Linear-interpolated percentile on a pre-sorted list."""
    k = (len(sorted_vals) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return sorted_vals[lo]
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def bake(db, table, col_prefix, stations):
    """DLY_LEVELS/DLY_FLOWS are wide: one row per station-month with
    LEVEL1..LEVEL31 / FLOW1..FLOW31 day-columns to unpivot."""
    day_cols = ','.join(f'{col_prefix}{d}' for d in range(1, 32))
    rows = db.execute(
        f'SELECT STATION_NUMBER, MONTH, {day_cols} FROM {table}')
    acc = {}   # (station, month) -> [values]
    for row in rows:
        stn, month = row[0], row[1]
        if stn not in stations:
            continue
        vals = acc.setdefault((stn, month), [])
        vals.extend(v for v in row[2:] if v is not None)
    out = {}
    for (stn, month), vals in acc.items():
        if len(vals) < MIN_SAMPLES:
            continue
        vals.sort()
        band = [round(percentile(vals, p), 3) for p in PCTS] + [len(vals)]
        out.setdefault(stn, {})[str(month)] = band
    return out


def main():
    if len(sys.argv) > 1:
        sqlite_path = pathlib.Path(sys.argv[1])
        tmp = None
    else:
        tmp = tempfile.TemporaryDirectory()
        sqlite_path = fetch_hydat(tmp.name)

    db = sqlite3.connect(f'file:{sqlite_path}?mode=ro', uri=True)

    stations = {r[0] for r in db.execute(
        "SELECT STATION_NUMBER FROM STATIONS WHERE HYD_STATUS='A' AND REAL_TIME=1")}
    print(f'{len(stations)} active real-time stations')

    print('baking LEVEL bands…')
    levels = bake(db, 'DLY_LEVELS', 'LEVEL', stations)
    print(f'  {len(levels)} stations with usable level history')
    print('baking DISCHARGE bands…')
    flows = bake(db, 'DLY_FLOWS', 'FLOW', stations)
    print(f'  {len(flows)} stations with usable flow history')

    merged = {}
    for stn in sorted(set(levels) | set(flows)):
        entry = {}
        if stn in levels:
            entry['L'] = levels[stn]
        if stn in flows:
            entry['Q'] = flows[stn]
        merged[stn] = entry

    OUT.write_text(json.dumps(merged, separators=(',', ':')))
    print(f'wrote {OUT} ({OUT.stat().st_size/1e6:.1f} MB, {len(merged)} stations)')
    if tmp:
        tmp.cleanup()


if __name__ == '__main__':
    main()
