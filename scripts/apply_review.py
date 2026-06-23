#!/usr/bin/env python3
"""
Apply verification-workflow findings to data/canada-data.js.

For every facility line:
  - if a finding marks it "Does Not Exist" with high confidence → comment it out
    (preserved as `// REMOVED (does not exist): {...}`).
  - apply correctedFields (operator/province/city/lat/lon/capacity/unit/name).
  - inject `status:'…'` from recommendedStatus (mapped to viewer's STATUS_VALUES);
    facilities with no finding get `status:'Active'`.
  - inject `notes:'…'` summarising the issues (so they surface in the popup later).

Also writes a human-readable REVIEW_REPORT.md (corrections + duplicates + gaps).
"""
import json, re, sys, os, html
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data' / 'canada-data.js'
RESULTS = Path('/tmp/wf_results.json')
EXTRA = Path('/tmp/wf_refined_terminals.json')   # re-run of stalled chunk, optional
REPORT = ROOT / 'REVIEW_REPORT.md'

STATUS_MAP = {
    'Active': 'Active',
    'Idle/Care&Maintenance': 'Idle',
    'Idle': 'Idle',
    'Closed/Decommissioned': 'Closed',
    'Closed': 'Closed',
    'Under Construction': 'Under Construction',
    'Proposed/Not Built': 'Proposed',
    'Proposed': 'Proposed',
    'Unknown': 'Active',
}


def load_results():
    r = json.loads(RESULTS.read_text())
    if EXTRA.exists():
        try:
            extra = json.loads(EXTRA.read_text())
            r['verify'].append({'label': 'Refined Product Terminals', **extra})
        except Exception as e:
            print(f'! failed to merge {EXTRA}: {e}', file=sys.stderr)
    return r


def js_str(s):
    """Single-quoted JS string literal with full escaping (newlines and
    line-separator chars would otherwise produce unterminated literals)."""
    if s is None:
        return "''"
    s = str(s)
    s = (s.replace('\\', '\\\\')
           .replace("'", "\\'")
           .replace('\r', '\\r')
           .replace('\n', '\\n')
           .replace(' ', '\\u2028')
           .replace(' ', '\\u2029'))
    return "'" + s + "'"


def set_field(line, key, val):
    """Replace or insert `key:val` inside a single-line JS object literal."""
    if isinstance(val, str):
        rep = js_str(val)
    elif isinstance(val, bool):
        rep = 'true' if val else 'false'
    elif isinstance(val, float):
        rep = f'{val:.5f}'.rstrip('0').rstrip('.') if '.' in f'{val:.5f}' else str(val)
    else:
        rep = str(val)

    pat = re.compile(rf'(\b{re.escape(key)}\s*:\s*)([^,}}]+)')
    if pat.search(line):
        return pat.sub(lambda m: m.group(1) + rep, line, count=1)
    # insert before closing `}` of the object literal
    idx = line.rfind('}')
    if idx == -1:
        return line
    sep = '' if line[:idx].rstrip().endswith(',') or line[:idx].rstrip().endswith('{') else ','
    return line[:idx] + f'{sep}{key}:{rep}' + line[idx:]


FACILITY_RE = re.compile(r"^\s*\{\s*name\s*:\s*'")


def main():
    res = load_results()
    findings_by_line = {}
    for sec in res['verify']:
        for f in sec.get('findings', []):
            findings_by_line.setdefault(f['line'], []).append({**f, '_section': sec['label']})

    src = DATA.read_text(encoding='utf-8').splitlines()
    out = []
    counts = {'removed': 0, 'corrected': 0, 'status_set': 0, 'untouched_active': 0}

    for i, line in enumerate(src, start=1):
        if not FACILITY_RE.match(line):
            out.append(line)
            continue

        finds = findings_by_line.get(i, [])
        # take the highest-confidence finding if multiple
        finds.sort(key=lambda x: {'high': 0, 'medium': 1, 'low': 2}.get(x.get('confidence', 'low'), 3))
        primary = finds[0] if finds else None

        if primary and primary.get('recommendedStatus') == 'Does Not Exist' \
           and primary.get('confidence') == 'high':
            issue = '; '.join(primary.get('issues', []))[:160]
            out.append(f"  // REMOVED (does not exist · {primary['_section']}): {issue}")
            out.append('  // ' + line.strip())
            counts['removed'] += 1
            continue

        new = line
        notes_parts = []
        status = 'Active'

        for f in finds:
            cf = f.get('correctedFields') or {}
            for k, v in cf.items():
                if k in ('name', 'operator', 'province', 'city', 'lat', 'lon', 'capacity', 'unit'):
                    new = set_field(new, k, v)
                    counts['corrected'] += 1
            rs = f.get('recommendedStatus')
            if rs and rs != 'Does Not Exist':
                status = STATUS_MAP.get(rs, 'Active')
            if f.get('issues'):
                notes_parts.extend(f['issues'])

        new = set_field(new, 'status', status)
        counts['status_set'] += 1
        if not finds:
            counts['untouched_active'] += 1

        if notes_parts:
            note = ' | '.join(notes_parts)
            note = html.unescape(note)
            if len(note) > 280:
                note = note[:277] + '…'
            new = set_field(new, 'notes', note)

        out.append(new)

    DATA.write_text('\n'.join(out) + '\n', encoding='utf-8')

    # ---- write report ----
    rep = ['# Canada Industrial Data — Verification Report',
           '',
           f'Generated by scripts/apply_review.py from {len(res["verify"])} verification sections '
           f'and {len(res["gaps"])} gap-analysis sections.',
           '',
           f'- Records removed (Does Not Exist, high confidence): **{counts["removed"]}**',
           f'- Field corrections applied: **{counts["corrected"]}**',
           f'- Records given `status`: **{counts["status_set"]}** '
           f'(of which {counts["untouched_active"]} default to Active with no flagged issues)',
           '',
           '---',
           '## Findings by section',
           '']
    for sec in res['verify']:
        if not sec.get('findings') and not sec.get('duplicates'):
            continue
        rep.append(f"### {sec['label']}")
        if sec.get('sectionNotes'):
            rep.append(f"> {html.unescape(sec['sectionNotes'])}")
        rep.append('')
        for f in sec.get('findings', []):
            iss = '; '.join(html.unescape(x) for x in f.get('issues', []))
            cf = f.get('correctedFields') or {}
            cfs = ', '.join(f'{k}→{v}' for k, v in cf.items()) if cf else ''
            rep.append(f"- **L{f['line']}** `{f['name']}` — *{f.get('recommendedStatus','?')}* "
                       f"({f.get('confidence','?')}) — {iss}"
                       + (f" — corrected: {cfs}" if cfs else ''))
        for d in sec.get('duplicates', []):
            rep.append(f"- 🔁 duplicate: {html.unescape(d)}")
        rep.append('')

    rep.append('---')
    rep.append('## Suggested missing facilities (gaps)')
    rep.append('')
    for g in res['gaps']:
        if not g.get('missing'):
            continue
        rep.append(f"### {g['label']}")
        for m in g['missing']:
            cap = m.get('approxCapacity', '')
            rep.append(f"- **{m['name']}** ({m.get('operator','?')}) — {m.get('city','?')}, "
                       f"{m.get('province','?')}{' — '+cap if cap else ''} — "
                       f"{m.get('status','')} — {m.get('whyNotable','')} "
                       f"[{m.get('confidence','?')}]")
        rep.append('')

    REPORT.write_text('\n'.join(rep) + '\n', encoding='utf-8')

    print(f"✓ wrote {DATA}")
    print(f"✓ wrote {REPORT}")
    print(f"  removed={counts['removed']} corrected_fields={counts['corrected']} "
          f"status_set={counts['status_set']} default_active={counts['untouched_active']}")


if __name__ == '__main__':
    main()
