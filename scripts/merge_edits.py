#!/usr/bin/env python3
"""
merge_edits.py - Merge exported edits back into canada-data.js

Usage:
    python merge_edits.py edits.json

This script will:
1. Read your exported edits JSON file
2. Load the canada-data.js file
3. Apply position changes, attribute edits, and deletions
4. Add new facilities
5. Create a backup and write the updated file

The script preserves formatting and comments in the original file.
"""

import json
import re
import sys
from pathlib import Path
from datetime import datetime
import shutil

BASE_DIR = Path(__file__).resolve().parent.parent

def load_edits(edits_path):
    """Load the exported edits JSON file"""
    with open(edits_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def parse_facility_from_js(js_line):
    """
    Parse a single facility object from a JS line.
    Returns a dict with the facility data.
    """
    match = re.search(r'\{(.+?)\}', js_line)
    if not match:
        return None
    
    facility = {}
    content = match.group(1)
    
    fields = re.findall(r"(\w+):\s*([^,]+?)(?=,\w+:|$)", content)
    for key, value in fields:
        value = value.strip()
        if value.startswith("'") or value.startswith('"'):
            facility[key] = value[1:-1]
        elif value.replace('.', '').replace('-', '').isdigit():
            facility[key] = float(value) if '.' in value else int(value)
        else:
            facility[key] = value
    
    return facility


def facility_to_js_line(facility, indent='  '):
    return (
        f"{indent}{{name:'{facility.get('name','')}',"
        f"operator:'{facility.get('operator', '')}',"
        f"sector:'{facility.get('sector', '')}',"
        f"subcategory:'{facility.get('subcategory', '')}',"
        f"province:'{facility.get('province', '')}',"
        f"city:'{facility.get('city', '')}',"
        f"lat:{facility.get('lat',0):.5f},"
        f"lon:{facility.get('lon',0):.5f},"
        f"capacity:{facility.get('capacity', 0)},"
        f"unit:'{facility.get('unit', '')}'}}"
    )


def normalize_name(name):
    """Normalize facility names for comparison"""
    return re.sub(r'[^a-z0-9]', '', name.lower())


def apply_edits_to_file(data_path, edits):
    """Apply edits to the canada-data.js file"""
    
    backup_path = data_path.with_suffix('.js.backup')
    shutil.copy2(data_path, backup_path)
    print(f"✓ Created backup: {backup_path}")
    
    with open(data_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    stats = {
        'positions_updated': 0,
        'attributes_updated': 0,
        'deleted': 0,
        'new_facilities': 0
    }
    
    position_map = {normalize_name(name): data for name, data in edits['positions'].items()}
    attribute_map = {normalize_name(name): data for name, data in edits['attributes'].items()}
    delete_set = {normalize_name(name) for name in edits['deletes']}
    
    new_lines = []
    skip_next = False
    
    for i, line in enumerate(lines):
        if skip_next:
            skip_next = False
            continue
            
        if re.search(r'\{name:', line):
            facility = parse_facility_from_js(line)
            
            if facility and 'name' in facility:
                norm_name = normalize_name(facility['name'])
                
                if norm_name in delete_set:
                    stats['deleted'] += 1
                    if i + 1 < len(lines) and lines[i + 1].strip() == ',':
                        skip_next = True
                    continue
                
                if norm_name in position_map:
                    pos_data = position_map[norm_name]
                    facility['lat'] = pos_data['lat']
                    facility['lon'] = pos_data['lon']
                    stats['positions_updated'] += 1
                
                if norm_name in attribute_map:
                    attr_data = attribute_map[norm_name]
                    for key in ['name', 'operator', 'city', 'province', 'sector', 
                               'subcategory', 'capacity', 'unit']:
                        if key in attr_data:
                            facility[key] = attr_data[key]
                    stats['attributes_updated'] += 1
                
                indent = line[:len(line) - len(line.lstrip())]
                new_line = facility_to_js_line(facility, indent)
                
                if line.rstrip().endswith(','):
                    new_line += ','
                
                new_lines.append(new_line + '\n')
            else:
                new_lines.append(line)
        else:
            new_lines.append(line)
    
    if edits['attributes']:
        new_facilities = []
        for name, data in edits['attributes'].items():
            if data.get('_isNew'):
                new_facilities.append(data)
        
        if new_facilities:
            insert_point = None
            for i, line in enumerate(new_lines):
                if re.search(r'^\];', line):
                    insert_point = i
                    break
            
            if insert_point:
                for facility in new_facilities:
                    dataset = facility.get('dataset', 'Storage')
                    
                    array_start = None
                    for i in range(len(new_lines)):
                        if f"const {dataset.lower().replace(' ', '')}Data" in new_lines[i]:
                            array_start = i
                            break
                    
                    if array_start:
                        for i in range(array_start, len(new_lines)):
                            if new_lines[i].strip() == '];':
                                new_line = facility_to_js_line(facility, '  ') + ',\n'
                                new_lines.insert(i, '  \n')
                                new_lines.insert(i + 1, f'  // NEW FACILITY ADDED {datetime.now().strftime("%Y-%m-%d")}\n')
                                new_lines.insert(i + 2, new_line)
                                stats['new_facilities'] += 1
                                break
    
    with open(data_path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    
    return stats


def main():
    if len(sys.argv) < 2:
        print("Usage: python merge_edits.py <edits.json>")
        print("\nExample:")
        print("  python merge_edits.py canada-industrial-edits-2025-11-17.json")
        sys.exit(1)
    
    edits_path = Path(sys.argv[1]).resolve()
    if not edits_path.exists():
        print(f"Error: Edits file not found: {edits_path}")
        sys.exit(1)
    
    data_path = BASE_DIR / 'data/canada-data.js'
    if not data_path.exists():
        print(f"Error: Data file not found: {data_path}")
        print("Make sure you're running this script from the project root directory.")
        sys.exit(1)
    
    print(f"\n{'='*60}")
    print(f"  Canada Industrial Map - Edit Merger")
    print(f"{'='*60}\n")
    
    print(f"Loading edits from: {edits_path}")
    edits = load_edits(edits_path)
    
    print(f"\nEdit Summary:")
    print(f"  Position changes: {len(edits['positions'])}")
    print(f"  Attribute changes: {len(edits['attributes'])}")
    print(f"  Deletions: {len(edits['deletes'])}")
    print(f"  New facilities: {sum(1 for data in edits['attributes'].values() if data.get('_isNew'))}")
    
    print(f"\nProcessing {data_path}...")
    stats = apply_edits_to_file(data_path, edits)
    
    print(f"\n{'='*60}")
    print(f"  Results")
    print(f"{'='*60}\n")
    print(f"[-] Positions updated: {stats['positions_updated']}")
    print(f"[-] Attributes updated: {stats['attributes_updated']}")
    print(f"[-] Facilities deleted: {stats['deleted']}")
    print(f"[-] New facilities added: {stats['new_facilities']}")
    
    print(f"\n[+] Successfully updated {data_path}")
    print(f"[-] Backup saved to: {data_path.with_suffix('.js.backup')}")
    print(f"\nYou can now reload the web application to see your changes.\n")


if __name__ == '__main__':
    main()