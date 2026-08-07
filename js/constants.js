// HTML-escape for any string that flows into innerHTML / bindTooltip /
// bindPopup. ALL external-feed values (AIS, ADS-B, GFW, Overpass, AAFC,
// adsbdb) and user-editable facility fields MUST go through this.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;
const eh = escapeHtml;

const STATUS_VALUES = ['Active', 'Idle', 'Closed', 'Under Construction', 'Proposed'];

const STATUS_STYLES = {
  'Active':             { fillOpacity: 0.70, opacity: 1.0, weight: 1, dashArray: null,    badge: '#10b981' },
  'Idle':               { fillOpacity: 0.35, opacity: 0.9, weight: 2, dashArray: '4,4',   badge: '#f59e0b' },
  'Under Construction': { fillOpacity: 0.45, opacity: 1.0, weight: 2, dashArray: '2,3',   badge: '#3b82f6' },
  'Proposed':           { fillOpacity: 0.15, opacity: 0.7, weight: 1, dashArray: '1,4',   badge: '#8b5cf6' },
  'Closed':             { fillOpacity: 0.15, opacity: 0.6, weight: 1, dashArray: '3,6',   badge: '#6b7280' }
};

function normalizeStatus(s) {
  if (!s) return 'Active';
  const v = String(s).trim();
  if (STATUS_STYLES[v]) return v;
  const low = v.toLowerCase();
  if (low.includes('idle') || low.includes('care')) return 'Idle';
  if (low.includes('closed') || low.includes('decommission') || low.includes('shut')) return 'Closed';
  if (low.includes('construction')) return 'Under Construction';
  if (low.includes('proposed') || low.includes('planned') || low.includes('not built')) return 'Proposed';
  return 'Active';
}

const SECTOR_COLORS = {
  'Oil Storage': '#b22222',
  'Oil Processing': '#8b0000',
  'Gas Storage': '#006400',
  'Gas Processing': '#228b22',
  'Agricultural Storage': '#daa520',
  'Agricultural Processing': '#cd853f',
  'Bulk Commodities': '#1e3a5f',
  'Container & Intermodal': '#1e90ff',
  'Metals': '#6b7280',
  'Forest': '#8b4513',
  'Minerals': '#7c3aed',
  'Mining': '#44403c',
  'Chemicals': '#0d9488',
  'Power Generation': '#f59e0b'
};

const POWER_SUBCATEGORIES = {
  hydro: 'Hydro', nuclear: 'Nuclear', gas: 'Natural Gas', coal: 'Coal',
  wind: 'Wind', solar: 'Solar', battery: 'Battery (BESS)', other: 'Other Generation'
};

const SUBCATEGORY_COLORS = {
  // Oil Storage subcategories (reds)
  'Crude Tank Farm': '#b22222',
  'Refined Product Terminal': '#dc143c',
  'Refined Product Marine Terminal': '#ff6347',
  'Fuel Oil Terminal': '#cd5c5c',
  
  // Oil Processing subcategories (dark reds/oranges)
  'Domestic Crude Refinery': '#8b0000',
  'Bitumen Upgrader': '#a52a2a',
  'Offshore Crude Refinery': '#b8860b',
  'Oil Processing Plant': '#d2691e',
  'Petrochemical/Feedstock': '#ff8c00',
  'Petrochemical/Polypropylene': '#ffa500',
  'Petrochemical/PDH+PP': '#ffb347',
  'Renewables': '#9acd32',
  
  // Gas Storage subcategories (greens)
  'Underground Gas Storage': '#006400',
  'LNG Storage': '#228b22',
  'LPG/NGL Storage': '#32cd32',
  
  // Gas Processing subcategories (greens)
  'Gas Processing Plant': '#2e8b57',
  'NGL Fractionation': '#3cb371',
  'LNG Processing': '#66cdaa',
  
  // Agricultural Storage subcategories (golds/browns)
  'Grain Elevator': '#daa520',
  'Fertilizer Terminal': '#b8860b',
  'Fertilizer Mill': '#cd853f',
  
  // Agricultural Processing subcategories (browns/tans)
  'Oilseed': '#d2691e',
  'Oilseed (Canola Crushing)': '#c19a6b',
  'Fertilizer (Potash)': '#deb887',
  'Fertilizer (Nitrogen)': '#f4a460',
  'Pulse': '#cd853f',
  'Ethanol': '#d2b48c',
  'Feed': '#bc8f8f',
  'Flour Milling': '#e3c59f',
  'Sugar/Starch': '#c8b08a',
  'Meat': '#a0826d',
  'Meat/Poultry': '#987654',
  'Dairy': '#c4a57b',
  'Dairy Products': '#d9c7a5',
  'Seafood': '#8fbc8f',
  'Seafood Storage': '#90c695',
  'Seafood Packaging': '#a8d8a8',
  'Beverage': '#e6d0a5',
  'Frozen Food (Potato Processing)': '#b89968',
  'Potato Processing': '#c9a86a',
  'Cereal/Grain Processing': '#d4af6f',
  'Snacks (Potato/Corn)': '#b8956e',
  
  // Bulk Commodities subcategories (dark blues)
  'Coal/Ore Stockyard': '#1e3a5f',
  'Steel Raw Material Dock': '#2c4f7c',
  'Iron Ore Stockyard': '#3a5f8f',
  'Wood Pellet Storage': '#4a6fa5',
  'Copper Concentrate Storage': '#5a7fb8',
  'Potash/Cement Storage': '#6a8fc8',
  'General Bulk Terminal': '#7a9fd8',
  'Transload Facility': '#8aafe8',
  'Aluminum/Raw Materials': '#9abff8',
  'Iron Ore Terminal': '#426b8e',
  'Salt Export Terminal': '#527b9e',
  'Salt Terminal': '#628bae',
  'Salt Mine': '#729bbe',
  'Lime/Aggregate': '#82abce',
  
  // Container & Intermodal subcategories (blues)
  'Seaport Container Terminal': '#1e90ff',
  'Seaport Vehicle/Container': '#4169e1',
  'Inland Intermodal Terminal': '#6495ed',
  
  // Metals subcategories (greys)
  'Steel': '#6b7280',
  'Steel Finishing': '#7b8290',
  'Steel (Rebar/Merchant)': '#8b92a0',
  'Steel Wire Rod': '#9ba2b0',
  'Steel Pipe': '#abb2c0',
  'Heavy Manufacturing': '#bbc2d0',
  'Aluminum': '#9ca3af',
  'Copper/Nickel': '#b4b9c4',
  'Copper/Nickel Smelter': '#a5aab5',
  'Copper Concentrator': '#95999f',
  'Titanium/Iron Smelter': '#858a90',
  'Iron Ore Concentrator': '#757b85',
  'Gold': '#d4af37',
  'Gold Processing Plant': '#c5a028',
  'Diamonds': '#e0e7ff',
  'Uranium': '#c7d2fe',
  'Silver/Lead/Zinc': '#cbd5e1',
  'Zinc/Lead': '#a8b4c9',
  'Nickel/Copper/Cobalt Processing': '#8896a5',
  
  // Forest subcategories (browns)
  'Pulp': '#8b4513',
  'Pulp/Paper': '#a0522d',
  'Sawmills': '#8b5a3c',
  'Panels': '#a0653f',
  'Pellet Plant': '#b57042',
  'Wood Treatment Yard': '#c97d45',
  
  // Minerals subcategories (purples)
  'Cement': '#7c3aed',
  'Lime': '#8b5cf6',
  'Glass': '#9333ea',
  'Other': '#a855f7',

  // Power Generation subcategories
  'Hydro': '#0ea5e9',
  'Nuclear': '#facc15',
  'Natural Gas': '#f97316',
  'Coal': '#1f2937',
  'Wind': '#10b981',
  'Solar': '#eab308',
  'Battery (BESS)': '#8b5cf6',
  'Other Generation': '#6b7280'
};