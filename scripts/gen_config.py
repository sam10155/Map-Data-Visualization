#!/usr/bin/env python3
"""Generate data/config.js from .env so browser-side code can read API keys.
Only whitelisted keys are exposed."""
import os, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
ENV = ROOT / '.env'
OUT = ROOT / 'data' / 'config.js'

WHITELIST = {
    'AISSTREAM_API_KEY': 'AISSTREAM_API_KEY',
    'OPENSKY_USERNAME':  'OPENSKY_USERNAME',
    'OPENSKY_PASSWORD':  'OPENSKY_PASSWORD',
    'TRACKING_PROXY':    'TRACKING_PROXY',
    'GFW_API_TOKEN':     'GFW_API_TOKEN',
    'GFW_API_KEY':       'GFW_API_TOKEN',
}

cfg = {}
if ENV.exists():
    for line in ENV.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        k = k.strip(); v = v.strip().strip('"').strip("'")
        if k in WHITELIST:
            cfg[WHITELIST[k]] = v

body = '// AUTO-GENERATED from .env by scripts/gen_config.py — do not edit.\n'
for k, v in cfg.items():
    body += f'window.{k} = {json.dumps(v)};\n'
if not cfg:
    body += '// (no whitelisted keys found in .env)\n'

OUT.write_text(body)
print(f'wrote {OUT} with keys: {list(cfg.keys())}')
