#!/usr/bin/env python3
"""
Bake TransLink's static-GTFS route table into data/translink-routes.json
({route_id: short_name}). Their GTFS-Realtime feed carries only internal
numeric route_ids, so this map gives tooltips real route numbers and lets
the client identify West Coast Express (short name WCE) as regional rail.
Rerun occasionally — route ids change with service updates.
"""
import csv, io, json, pathlib, urllib.request, zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'data' / 'translink-routes.json'
URL = 'https://gtfs-static.translink.ca/gtfs/google_transit.zip'

data = urllib.request.urlopen(URL, timeout=120).read()
z = zipfile.ZipFile(io.BytesIO(data))
rows = csv.DictReader(io.TextIOWrapper(z.open('routes.txt'), 'utf-8-sig'))
m = {r['route_id']: r['route_short_name'] or r['route_long_name'][:12] for r in rows}
OUT.write_text(json.dumps(m, separators=(',', ':')))
print(f'wrote {OUT} ({len(m)} routes)')

