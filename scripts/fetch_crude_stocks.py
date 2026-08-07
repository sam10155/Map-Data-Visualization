#!/usr/bin/env python3
"""
Fetch monthly provincial crude-oil inventory held by TRANSPORTERS
(pipelines + tank farms) from Statistics Canada table 25-10-0063 into
data/canada-crude-stocks.json, for the Pipelines layer's storage-hub view.

This is the only free storage-utilization signal that exists: hub-level
live tank data is commercial (Wood Mackenzie/Ursa satellite tracking),
and CER publishes no storage statistics at all. StatCan is monthly with
~2-month lag; we normalize each province against its own 5-year min–max
band (same philosophy as the water layer's percentile classes — there is
no official shell-capacity denominator).

New Brunswick is suppressed by StatCan (single holder, Irving).
"""
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'canada-crude-stocks.json'

WDS = 'https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods'

# Closing inventory · Transporters · barrels — table 25-10-0063
VECTORS = {
    'CA': 107757113,
    'AB': 107757779,
    'SK': 107757705,
    'MB': 107757631,
    'BC': 107757853,
    'ON': 107757557,
    'QC': 107757483,
}
BAND_MONTHS = 60   # 5-year min–max band


def main():
    body = json.dumps([{'vectorId': v, 'latestN': BAND_MONTHS}
                       for v in VECTORS.values()]).encode()
    req = urllib.request.Request(WDS, data=body,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.load(r)

    by_vector = {}
    for item in resp:
        if item.get('status') != 'SUCCESS':
            continue
        obj = item['object']
        pts = [(p['refPer'], p['value']) for p in obj.get('vectorDataPoint', [])
               if p.get('value') is not None]
        if pts:
            by_vector[obj['vectorId']] = sorted(pts)

    # No run timestamp on purpose: output must be byte-identical between
    # StatCan releases so the workflow's commit-if-changed step no-ops.
    out = {'source': 'Statistics Canada table 25-10-0063, closing inventory held by transporters (pipelines + tank farms), barrels',
           'regions': {}}
    for prov, vec in VECTORS.items():
        pts = by_vector.get(vec)
        if not pts:
            print(f'{prov}: no data', file=sys.stderr)
            continue
        vals = [v for _, v in pts]
        ref, latest = pts[-1]
        lo, hi = min(vals), max(vals)
        pct = round(100 * (latest - lo) / (hi - lo), 1) if hi > lo else None
        out['regions'][prov] = {
            'month': ref[:7],
            'bbl': round(latest),
            'min5y': round(lo),
            'max5y': round(hi),
            'pctOfRange': pct,
        }

    OUT.write_text(json.dumps(out, separators=(',', ':')))
    print(f'wrote {OUT} ({len(out["regions"])} regions, '
          f'latest month {out["regions"].get("CA", {}).get("month")})')


if __name__ == '__main__':
    main()
