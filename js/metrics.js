/**
 * metrics.js - Enhanced metrics system
 * Provides realistic worker estimates and proper capacity normalization
 */

let currentMetric = 'facilities';

const WORKER_BASE = {
  // -----------------------
  // OIL STORAGE (low staff)
  // -----------------------
  'Crude Tank Farm':              { base: 14,  perUnit: 0.000006 }, // per bbl storage
  'Refined Product Terminal':     { base: 12,  perUnit: 0.000006 }, // per bbl storage
  'Refined Product Marine Terminal': { base: 22, perUnit: 0.000007 }, // per bbl storage
  'Fuel Oil Terminal':            { base: 10,  perUnit: 0.000005 },

  // -----------------------
  // OIL PROCESSING
  // -----------------------
  'Domestic Crude Refinery':      { base: 250, perUnit: 2.8 },   // per kbbl/d
  'Offshore Crude Refinery':      { base: 280, perUnit: 3.0 },   // per kbbl/d
  'Bitumen Upgrader':             { base: 320, perUnit: 2.2 },   // per kbbl/d (upgraders scale a bit lower per kbpd)
  'Oil Processing Plant':         { base: 80,  perUnit: 1.6 },   // per kbbl/d equiv
  'Petrochemical/Feedstock':      { base: 140, perUnit: 0.5 },   // per kT/yr (feedstock & utilities heavy)
  'Petrochemical/Polypropylene':  { base: 110, perUnit: 0.11 },  // per kT/yr PP
  'Petrochemical/PDH+PP':         { base: 120, perUnit: 0.13 },  // per kT/yr combined
  'Renewables':                   { base: 60,  perUnit: 1.2 },   // per kbbl/d (e.g., renewable diesel/HEFA)

  // -----------------------
  // GAS STORAGE
  // -----------------------
  'Underground Gas Storage':      { base: 8,   perUnit: 0.06 },     // per Bcf working gas
  'LNG Storage':                  { base: 18,  perUnit: 0.00012 },  // per m3 of LNG storage
  'LPG/NGL Storage':              { base: 10,  perUnit: 0.000004 }, // per bbl

  // -----------------------
  // GAS PROCESSING
  // -----------------------
  'Gas Processing Plant':         { base: 40,  perUnit: 0.10 },  // per MMcf/d
  'NGL Fractionation':            { base: 32,  perUnit: 0.18 },  // per MMcf/d equiv
  'LNG Processing':               { base: 220, perUnit: 28 },    // per MTPA  :contentReference[oaicite:1]{index=1}

  // -----------------------
  // AGRICULTURAL STORAGE
  // -----------------------
  'Grain Elevator':               { base: 9,   perUnit: 0.000010 }, // per tonne storage
  'Fertilizer Terminal':          { base: 12,  perUnit: 0.00006 },  // per tonne storage
  'Fertilizer Mill':              { base: 160, perUnit: 30 },       // per kT/yr product (milling/packaging is laboury)

  // -----------------------
  // AGRICULTURAL PROCESSING
  // -----------------------
  'Ethanol':                      { base: 30,  perUnit: 0.15 },   // per kT/yr
  'Oilseed':                      { base: 40,  perUnit: 0.10 },   // per kT/yr crush
  'Oilseed (Canola Crushing)':    { base: 45,  perUnit: 0.11 },   // per kT/yr
  'Fertilizer (Potash)':          { base: 180, perUnit: 60 },     // per kT/yr product
  'Fertilizer (Nitrogen)':        { base: 140, perUnit: 80 },     // per kT/yr ammonia/urea
  'Pulse':                        { base: 30,  perUnit: 0.06 },   // per kT/yr
  'Feed':                         { base: 28,  perUnit: 0.05 },   // per kT/yr
  'Flour Milling':                { base: 24,  perUnit: 0.06 },   // per kT/yr
  'Sugar/Starch':                 { base: 70,  perUnit: 0.15 },   // per kT/yr
  'Meat':                         { base: 260, perUnit: 0.9 },    // per kT/yr carcass-weight
  'Meat/Poultry':                 { base: 220, perUnit: 0.8 },    // per kT/yr
  'Dairy':                        { base: 110, perUnit: 0.5 },    // per kT/yr product
  'Dairy Products':               { base: 90,  perUnit: 0.45 },   // per kT/yr
  'Seafood':                      { base: 70,  perUnit: 1.2 },    // per kT/yr (seasonal peaks)
  'Seafood Storage':              { base: 14,  perUnit: 0.3 },    // per kT/yr throughput
  'Seafood Packaging':            { base: 55,  perUnit: 0.9 },    // per kT/yr
  'Beverage':                     { base: 130, perUnit: 0.7 },    // per kT/yr
  'Frozen Food (Potato Processing)': { base: 180, perUnit: 0.7 }, // per kT/yr
  'Potato Processing':            { base: 160, perUnit: 0.7 },    // per kT/yr
  'Cereal/Grain Processing':      { base: 110, perUnit: 0.5 },    // per kT/yr
  'Snacks (Potato/Corn)':         { base: 160, perUnit: 0.7 },    // per kT/yr

  // -----------------------
  // BULK/TERMINALS
  // -----------------------
  'Coal/Ore Stockyard':           { base: 32,  perUnit: 0.000035 },
  'Steel Raw Material Dock':      { base: 38,  perUnit: 0.00005  },
  'Iron Ore Stockyard':           { base: 28,  perUnit: 0.00003  },
  'Wood Pellet Storage':          { base: 24,  perUnit: 0.00005  }, // storage-only
  'Copper Concentrate Storage':   { base: 18,  perUnit: 0.00005  },
  'Potash/Cement Storage':        { base: 18,  perUnit: 0.00005  },
  'General Bulk Terminal':        { base: 42,  perUnit: 0.00005  },
  'Transload Facility':           { base: 48,  perUnit: 0.00007  },
  'Aluminum/Raw Materials':       { base: 38,  perUnit: 0.00005  },
  'Iron Ore Terminal':            { base: 55,  perUnit: 0.00002  },
  'Salt Export Terminal':         { base: 22,  perUnit: 0.00004  },
  'Salt Terminal':                { base: 18,  perUnit: 0.00003  },
  'Salt Mine':                    { base: 110, perUnit: 0.0005   },
  'Lime/Aggregate':               { base: 28,  perUnit: 0.00008  },

  // -----------------------
  // CONTAINER & INTERMODAL
  // -----------------------
  'Seaport Container Terminal':   { base: 140, perUnit: 0.00020 }, // ≈200 per 1M TEU + base
  'Seaport Vehicle/Container':    { base: 100, perUnit: 0.00018 }, // RoRo/auto mix
  'Inland Intermodal Terminal':   { base: 70,  perUnit: 0.00016 },

  // -----------------------
  // METALS & MINERALS
  // -----------------------
  'Steel':                        { base: 700, perUnit: 300 },   // per MTPA (i.e., 0.3 per kT/yr)
  'Steel Finishing':              { base: 360, perUnit: 220 },   // per MTPA
  'Steel (Rebar/Merchant)':       { base: 280, perUnit: 180 },   // per MTPA
  'Steel Wire Rod':               { base: 230, perUnit: 160 },   // per MTPA
  'Steel Pipe':                   { base: 180, perUnit: 140 },   // per MTPA
  'Heavy Manufacturing':          { base: 360, perUnit: 700 },   // per MTPA (varies widely)
  'Aluminum':                     { base: 520, perUnit: 2.0 },   // per kT/yr
  'Copper/Nickel':                { base: 320, perUnit: 260 },   // per MTPA
  'Copper/Nickel Smelter':        { base: 280, perUnit: 240 },   // per MTPA
  'Copper Concentrator':          { base: 220, perUnit: 180 },   // per MTPA
  'Titanium/Iron Smelter':        { base: 380, perUnit: 220 },   // per MTPA
  'Iron Ore Concentrator':        { base: 260, perUnit: 35 },    // per kT/yr
  'Gold':                         { base: 180, perUnit: 90 },    // per kT/yr doré equiv
  'Gold Processing Plant':        { base: 160, perUnit: 80 },    // per kT/yr
  'Diamonds':                     { base: 360, perUnit: 140 },   // per kT/yr
  'Uranium':                      { base: 140, perUnit: 70 },    // per kT/yr U3O8
  'Silver/Lead/Zinc':             { base: 170, perUnit: 110 },   // per kT/yr
  'Zinc/Lead':                    { base: 150, perUnit: 100 },   // per kT/yr
  'Nickel/Copper/Cobalt Processing': { base: 190, perUnit: 140 },// per kT/yr

  // -----------------------
  // FOREST 
  // -----------------------
  'Pulp':                         { base: 120, perUnit: 0.55 },   // per kT/yr pulp
  'Pulp/Paper':                   { base: 150, perUnit: 0.65 },   // per kT/yr integrated
  'Sawmills':                     { base: 40,  perUnit: 0.00020 },// per m³/yr
  'Panels':                       { base: 70,  perUnit: 0.00012 },// per m³/yr
  'Pellet Plant':                 { base: 30,  perUnit: 0.10 },   // per kT/yr
  'Wood Treatment Yard':          { base: 20,  perUnit: 0.003 },  // per m³/yr

  // -----------------------
  // OTHER MINERALS
  // -----------------------
  'Cement':                       { base: 160, perUnit: 100 },   // per kT/yr clinker/cement
  'Lime':                         { base: 90,  perUnit: 90 },    // per kT/yr
  'Glass':                        { base: 220, perUnit: 260 },   // per kT/yr
  'Other':                        { base: 50,  perUnit: 50 },

  // -----------------------
  // POWER GENERATION (per MW)
  // -----------------------
  'Hydro':                        { base: 30,  perUnit: 0.10 },
  'Nuclear':                      { base: 600, perUnit: 0.55 },
  'Natural Gas':                  { base: 25,  perUnit: 0.05 },
  'Coal':                         { base: 80,  perUnit: 0.25 },
  'Wind':                         { base: 6,   perUnit: 0.03 },
  'Solar':                        { base: 4,   perUnit: 0.02 },
  'Battery (BESS)':               { base: 4,   perUnit: 0.02 },
  'Other Generation':             { base: 15,  perUnit: 0.10 }
};


function estimateWorkers(facility) {
  const config = WORKER_BASE[facility.subcategory] || { base: 30, perUnit: 10 };
  const capacity = facility.capacity || 0;
  
  let workers = config.base + (capacity * config.perUnit);
  
  if (capacity > 0) {
    if (workers < 50) {
      workers = Math.max(workers, config.base * 0.7);
    }
    if (workers > 2000) {
      workers = 2000 + ((workers - 2000) * 0.8);
    }
  } else {
    workers = config.base;
  }
  
  if (workers < 50) return Math.ceil(workers / 5) * 5;
  if (workers < 200) return Math.ceil(workers / 10) * 10;
  if (workers < 1000) return Math.ceil(workers / 25) * 25;
  return Math.ceil(workers / 100) * 100;
}

function normalizeCapacity(facility) {
  const capacity = facility.capacity || 0;
  if (capacity === 0) return 0;
  
  switch(facility.unit) {
    case 'bbl': return capacity / 1000000;
    case 'kbbl/d': return (capacity * 365) / 1000;
    
    case 'Bcf': return capacity * 5;
    case 'MMcf/d': return (capacity * 365) / 100;
    case 'm3': return capacity / 150000; 

    case 'tonnes': return capacity / 100000;
    case 'MTPA': return capacity * 10;
    case 'kMT/yr': return capacity / 100;
    case 'kT/yr': return capacity / 100;

    case 'TEU/yr': return capacity / 50000;
    
    case 'm3/yr': return capacity / 200000;

    case 'MW': return capacity / 100;

    default:
      return capacity / 10000;
  }
}

function calculateMetricValue(facility, metric) {
  switch(metric) {
    case 'facilities':
      return 1;
    
    case 'capacities':
      const normalized = normalizeCapacity(facility);
      return Math.max(normalized, 0.1);
    
    case 'workers':
      return estimateWorkers(facility);
    
    default:
      return 1;
  }
}

function computeMetricCounts(facilities, metric) {
  const sectorCounts = {};
  
  facilities.forEach(f => {
    const sector = (f.sector || '').trim();
    const value = calculateMetricValue(f, metric);
    sectorCounts[sector] = (sectorCounts[sector] || 0) + value;
  });
  
  return sectorCounts;
}

function setMetric(metric) {
  if (!['facilities', 'capacities', 'workers'].includes(metric)) return;

  currentMetric = metric;
  window.currentMetric = metric;

  ['facilities', 'capacities', 'workers'].forEach(m => {
    const btn = document.getElementById(`metric-${m}`);
    if (btn) {
      if (m === metric) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    }
  });
  
  if (typeof applyAggregation === 'function') {
    applyAggregation();
  }
}

function formatMetricValue(value, metric) {
  const rounded = Math.round(value);
  
  switch(metric) {
    case 'facilities':
      return rounded.toLocaleString() + (rounded === 1 ? ' facility' : ' facilities');
    
    case 'capacities':
      if (rounded < 10) return rounded.toFixed(1) + ' units';
      return rounded.toLocaleString() + ' units';
    
    case 'workers':
      return '~' + rounded.toLocaleString() + ' workers';
    
    default:
      return rounded.toLocaleString();
  }
}

function getMetricLabel(metric) {
  switch(metric) {
    case 'facilities': return 'Facility Count';
    case 'capacities': return 'Total Capacity';
    case 'workers': return 'Estimated Workers';
    default: return 'Count';
  }
}

if (typeof window !== 'undefined') {
  window.currentMetric = currentMetric;
  window.setMetric = setMetric;
  window.calculateMetricValue = calculateMetricValue;
  window.computeMetricCounts = computeMetricCounts;
  window.formatMetricValue = formatMetricValue;
  window.getMetricLabel = getMetricLabel;
  window.estimateWorkers = estimateWorkers;
  window.normalizeCapacity = normalizeCapacity;
}