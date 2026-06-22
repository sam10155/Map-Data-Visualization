/**
 * aggregate.js
 * Groups nearby facilities with multiple aggregation modes:
 * - none: No aggregation
 * - 50km: Spatial clustering within 50km
 * - provinces: Group by province
 * - regions: Group by major regions
 */
let clusterMarkers = [];
const CLUSTER_RADIUS_KM = 50;
const PIE_ZOOM_THRESHOLD = 8;
let aggregationMode = 'none';

const PROVINCE_REGIONS = {
  'YT': { name: 'Yukon', lat: 64.0, lon: -135.0, region: 'Northern Territories' },
  'NT': { name: 'Northwest Territories', lat: 64.0, lon: -120.0, region: 'Northern Territories' },
  'NU': { name: 'Nunavut', lat: 70.0, lon: -95.0, region: 'Northern Territories' },
  'BC': { name: 'British Columbia', lat: 54.0, lon: -125.0, region: 'West Coast' },
  'AB': { name: 'Alberta', lat: 54.0, lon: -115.0, region: 'Prairies' },
  'SK': { name: 'Saskatchewan', lat: 54.0, lon: -106.0, region: 'Prairies' },
  'MB': { name: 'Manitoba', lat: 54.0, lon: -98.0, region: 'Prairies' },
  'ON': { name: 'Ontario', lat: 50.0, lon: -85.0, region: 'Central' },
  'QC': { name: 'Quebec', lat: 52.0, lon: -72.0, region: 'Central' },
  'NB': { name: 'New Brunswick', lat: 46.5, lon: -66.0, region: 'Atlantic' },
  'NS': { name: 'Nova Scotia', lat: 45.0, lon: -63.0, region: 'Atlantic' },
  'PE': { name: 'Prince Edward Island', lat: 46.5, lon: -63.5, region: 'Atlantic' },
  'NL': { name: 'Newfoundland and Labrador', lat: 53.0, lon: -60.0, region: 'Atlantic' }
};

const REGIONS = {
  'Northern Territories': { lat: 66.0, lon: -116.0 },
  'West Coast': { lat: 54.0, lon: -125.0 },
  'Prairies': { lat: 54.0, lon: -106.0 },
  'Central': { lat: 51.0, lon: -78.5 },
  'Atlantic': { lat: 46.0, lon: -63.0 }
};

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getFilteredFacilities() {
  return Object.values(markers)
    .flatMap(items => items.map(i => i.facility))
    .filter(f =>
      filters.datasets[f.dataset] &&
      filters.sectors[f.sector] &&
      filters.subcategories[f.subcategory] &&
      filters.statuses[normalizeStatus(f.status)] !== false
    );
}

function computeSpatialClusters() {
  const facilities = getFilteredFacilities();
  const clusters = [];

  facilities.forEach(fac => {
    let cluster = clusters.find(
      c => haversine(c.lat, c.lon, fac.lat, fac.lon) < CLUSTER_RADIUS_KM
    );
    if (!cluster) {
      clusters.push({
        lat: fac.lat,
        lon: fac.lon,
        members: [fac],
      });
    } else {
      cluster.members.push(fac);
      cluster.lat =
        cluster.members.reduce((sum, m) => sum + m.lat, 0) / cluster.members.length;
      cluster.lon =
        cluster.members.reduce((sum, m) => sum + m.lon, 0) / cluster.members.length;
    }
  });

  return clusters.filter(c => c.members.length >= 3);
}

function computeProvinceClusters() {
  const facilities = getFilteredFacilities();
  const provinceGroups = {};

  facilities.forEach(f => {
    const prov = f.province.split('/')[0].trim();
    
    if (!provinceGroups[prov]) {
      const info = PROVINCE_REGIONS[prov] || { name: prov, lat: f.lat, lon: f.lon };
      provinceGroups[prov] = {
        lat: info.lat,
        lon: info.lon,
        members: [],
        name: info.name
      };
    }
    provinceGroups[prov].members.push(f);
  });

  return Object.values(provinceGroups).filter(c => c.members.length >= 1);
}

function computeRegionClusters() {
  const facilities = getFilteredFacilities();
  const regionGroups = {};

  facilities.forEach(f => {
    const firstProv = f.province.split('/')[0].trim();
    const provInfo = PROVINCE_REGIONS[firstProv];
    const region = provInfo ? provInfo.region : 'Other';
    
    if (!regionGroups[region]) {
      const info = REGIONS[region] || { lat: f.lat, lon: f.lon };
      regionGroups[region] = {
        lat: info.lat,
        lon: info.lon,
        members: [],
        name: region
      };
    }
    regionGroups[region].members.push(f);
  });

  return Object.values(regionGroups).filter(c => c.members.length >= 1);
}

function createPieSVG(sectorCounts, size = 70, overrideColor = null) {
  const total = Object.values(sectorCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return '';

  const r = size / 2;
  const entries = Object.entries(sectorCounts).filter(([, c]) => c > 0);
  const fontSize = Math.max(10, Math.min(size * 0.25, 20));

  const metric = window.currentMetric || 'facilities';
  let centerText;
  
  if (metric === 'workers') {
    if (total >= 10000) centerText = Math.round(total / 1000) + 'k';
    else if (total >= 1000) centerText = (total / 1000).toFixed(1) + 'k';
    else centerText = Math.round(total).toString();
  } else if (metric === 'capacities') {
    if (total >= 1000) centerText = (total / 1000).toFixed(1) + 'k';
    else if (total < 10) centerText = total.toFixed(1);
    else centerText = Math.round(total).toString();
  } else {
    centerText = Math.round(total).toString();
  }

  if (overrideColor) {
    let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="pointer-events: all;">`;
    svg += `<circle cx="${r}" cy="${r}" r="${r}" fill="${overrideColor}" stroke="white" stroke-width="1.5" />`;
    svg += `<circle cx="${r}" cy="${r}" r="${r * 0.35}" fill="white" stroke="#444" stroke-width="1.5"/>`;
    svg += `<text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="middle"
                  font-size="${fontSize}" font-weight="bold" fill="#333"
                  style="pointer-events: none; user-select: none;">${centerText}</text>`;
    svg += `</svg>`;
    return svg;
  }

  let cumulative = 0;
  let sliceId = 0;
  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="pointer-events: all;">`;

  entries.forEach(([sector, count]) => {
    const portion = count / total;
    const [sx, sy] = polar(r, r, r, cumulative * 360);
    cumulative += portion;
    const [ex, ey] = polar(r, r, r, cumulative * 360);
    const large = portion > 0.5 ? 1 : 0;
    const color =
      (window.SECTOR_COLORS && window.SECTOR_COLORS[sector]) ||
      (typeof SECTOR_COLORS !== 'undefined' ? SECTOR_COLORS[sector] : null) ||
      '#888';
    const percent = (portion * 100).toFixed(1);

    svg += `<path id="slice-${sliceId}" d="M${r},${r} L${sx},${sy} A${r},${r} 0 ${large},1 ${ex},${ey} Z"
              fill="${color}" stroke="white" stroke-width="1.5"
              style="cursor: pointer; transition: opacity 0.2s;"
              onmouseover="this.style.opacity='0.8'; showSliceTooltip(event, '${sector.replace(/'/g, "\\'")}', ${count}, '${percent}%')"
              onmouseout="this.style.opacity='1'; hideSliceTooltip()"
            />`;
    sliceId++;
  });

  svg += `<circle cx="${r}" cy="${r}" r="${r * 0.35}" fill="white" stroke="#444" stroke-width="1.5"/>`;
  svg += `<text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="middle"
                font-size="${fontSize}" font-weight="bold" fill="#333"
                style="pointer-events: none; user-select: none;">${centerText}</text>`;
  svg += `</svg>`;
  return svg;
}

function polar(cx, cy, r, angle) {
  const rad = (angle - 90) * Math.PI / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

let aggregationPieTooltip = null;

function showSliceTooltip(event, sector, count, percent) {
  if (!aggregationPieTooltip) {
    aggregationPieTooltip = document.createElement('div');
    aggregationPieTooltip.style.cssText = `
      position: fixed;
      background: rgba(0,0,0,0.85);
      color: white;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      z-index: 10000;
      white-space: nowrap;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(aggregationPieTooltip);
  }
  
  const metric = window.currentMetric || 'facilities';
  const displayValue = window.formatMetricValue ? window.formatMetricValue(count, metric) : count;
  aggregationPieTooltip.innerHTML = `<strong>${sector}</strong><br>${displayValue} (${percent})`;
  aggregationPieTooltip.style.display = 'block';
  aggregationPieTooltip.style.left = (event.clientX + 10) + 'px';
  aggregationPieTooltip.style.top = (event.clientY + 10) + 'px';
}

function hideSliceTooltip() {
  if (aggregationPieTooltip) {
    aggregationPieTooltip.style.display = 'none';
  }
}

function formatLargeNumber(value) {
  if (!isFinite(value)) return '0';
  const abs = Math.abs(value);
  const clean = Math.round((+value + Number.EPSILON) * 1000) / 1000;

  const fmt1 = (n) => {
    const s = (Math.round(n * 10) / 10).toFixed(1);
    return s.replace(/\.0$/, '');
  };

  if (abs >= 1_000_000) {
    return fmt1(clean / 1_000_000) + 'M';
  } else if (abs >= 1_000) {
    return fmt1(clean / 1_000) + 'k';
  } else {
    return Math.round(clean).toString();
  }
}

function drawAggregatedPies(clusters, labelKey = null) {
  clearSpatialPies();

  clusters.forEach(c => {
    const metric = window.currentMetric || 'facilities';
    const sectorCounts = {};
    const sectorSet = new Set();
    const subcatSet = new Set();

    c.members.forEach(f => {
      const sector = (f.sector || '').trim();
      const value = window.calculateMetricValue ? window.calculateMetricValue(f, metric) : 1;
      sectorCounts[sector] = (sectorCounts[sector] || 0) + value;
      sectorSet.add(sector);
      subcatSet.add((f.subcategory || '').trim());
    });

    const total = Object.values(sectorCounts).reduce((a, b) => a + b, 0);
    const entries = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]);
    const dominant = entries.length ? entries[0] : null;
    const dominantRatio = dominant ? dominant[1] / Math.max(1, total) : 0;

    let overrideColor = null;
    if (entries.length === 1 || dominantRatio >= 0.999) {
      if (subcatSet.size === 1) {
        const subcat = Array.from(subcatSet)[0];
        overrideColor =
          (window.SUBCATEGORY_COLORS && window.SUBCATEGORY_COLORS[subcat]) ||
          (typeof SUBCATEGORY_COLORS !== 'undefined' ? SUBCATEGORY_COLORS[subcat] : null);
      }
      if (!overrideColor && dominant) {
        const sector = dominant[0];
        overrideColor =
          (window.SECTOR_COLORS && window.SECTOR_COLORS[sector]) ||
          (typeof SECTOR_COLORS !== 'undefined' ? SECTOR_COLORS[sector] : null) ||
          '#888';
      }
    }

    const size = Math.min(50 + c.members.length * 2, 120);
    const svg = createPieSVG(sectorCounts, size, overrideColor);

    const icon = L.divIcon({
      html: svg,
      className: 'pie-icon',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });

    let tooltipHtml = `<div style="font-size: 13px;">`;
    if (c.name) tooltipHtml += `<strong>${c.name}</strong><br>`;
    tooltipHtml += `<strong>${c.members.length} facilities</strong><br>`;
    
    const metricLabel = window.getMetricLabel ? window.getMetricLabel(metric) : 'Count';
    tooltipHtml += `<em>By ${metricLabel}</em><br><br>`;
    
    entries.forEach(([sector, count]) => {
      const percent = ((count / Math.max(1, total)) * 100).toFixed(1);
      const color =
        (window.SECTOR_COLORS && window.SECTOR_COLORS[sector]) ||
        (typeof SECTOR_COLORS !== 'undefined' ? SECTOR_COLORS[sector] : null) ||
        '#888';
      const displayValue = window.formatMetricValue ? window.formatMetricValue(count, metric) : count;
      tooltipHtml += `<span style="display:inline-block;width:10px;height:10px;background:${color};margin-right:5px;"></span>${sector}: ${displayValue} (${percent}%)<br>`;
    });
    tooltipHtml += `</div>`;

    const m = L.marker([c.lat, c.lon], { icon }).bindTooltip(tooltipHtml, {
      permanent: false,
      direction: 'top',
      offset: [0, -size / 2],
    });
    m.addTo(map);
    clusterMarkers.push(m);
  });
}

function clearSpatialPies() {
  clusterMarkers.forEach(m => map.removeLayer(m));
  clusterMarkers = [];
}

function applyAggregation() {
  clearSpatialPies();
  
  if (aggregationMode === 'none') {
    updateVisibility();
    return;
  }

  Object.values(markers).forEach(items =>
    items.forEach(({ marker }) => {
      if (map.hasLayer(marker)) {
        map.removeLayer(marker);
      }
    })
  );

  let clusters = [];
  
  switch(aggregationMode) {
    case '50km':
      clusters = computeSpatialClusters();
      drawAggregatedPies(clusters);
      break;
    case 'provinces':
      clusters = computeProvinceClusters();
      drawAggregatedPies(clusters);
      break;
    case 'regions':
      clusters = computeRegionClusters();
      drawAggregatedPies(clusters);
      break;
  }
}

function setAggregationMode(mode) {
  aggregationMode = mode;
  window.aggregationMode = mode;

  const metricSection = document.getElementById('metric-section');
  if (metricSection) {
    if (mode === 'none') {
      metricSection.style.display = 'none';
      metricSection.style.visibility = 'hidden';
      metricSection.style.opacity = '0';
    } else {
      metricSection.style.display = 'block';
      metricSection.style.visibility = 'visible';
      metricSection.style.opacity = '1';
    }
  } else {
    console.warn('[setAggregationMode] metric-section not found at call time');
  }

  applyAggregation();

  const options = ['none', '50km', 'provinces', 'regions'];
  options.forEach(opt => {
    const btn = document.getElementById(`agg-${opt}`);
    if (btn) btn.classList.toggle('active', opt === mode);
  });
}

window.attachAggregationEvents = attachAggregationEvents;

function attachAggregationEvents() {
  if (!window.map) return;

  map.on('zoomend', () => {
    const zoom = map.getZoom();

    if (zoom > PIE_ZOOM_THRESHOLD) {
      clearSpatialPies();
      updateVisibility();
      return;
    }

    if (aggregationMode !== 'none') {
      applyAggregation();
    } else {
      updateVisibility();
    }
  });
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getFilteredFacilities() {
  return Object.values(markers)
    .flatMap(items => items.map(i => i.facility))
    .filter(f =>
      filters.datasets[f.dataset] &&
      filters.sectors[f.sector] &&
      filters.subcategories[f.subcategory] &&
      filters.statuses[normalizeStatus(f.status)] !== false
    );
}

function computeSpatialClusters() {
  const facilities = getFilteredFacilities();
  const clusters = [];

  facilities.forEach(fac => {
    let cluster = clusters.find(
      c => haversine(c.lat, c.lon, fac.lat, fac.lon) < CLUSTER_RADIUS_KM
    );
    if (!cluster) {
      clusters.push({
        lat: fac.lat,
        lon: fac.lon,
        members: [fac],
      });
    } else {
      cluster.members.push(fac);
      cluster.lat =
        cluster.members.reduce((sum, m) => sum + m.lat, 0) / cluster.members.length;
      cluster.lon =
        cluster.members.reduce((sum, m) => sum + m.lon, 0) / cluster.members.length;
    }
  });

  return clusters.filter(c => c.members.length >= 3);
}

function computeProvinceClusters() {
  const facilities = getFilteredFacilities();
  const provinceGroups = {};

  facilities.forEach(f => {
    const prov = f.province;
    if (!provinceGroups[prov]) {
      const info = PROVINCE_REGIONS[prov] || { name: prov, lat: f.lat, lon: f.lon };
      provinceGroups[prov] = {
        lat: info.lat,
        lon: info.lon,
        members: [],
        name: info.name
      };
    }
    provinceGroups[prov].members.push(f);
  });

  return Object.values(provinceGroups).filter(c => c.members.length >= 1);
}

function computeRegionClusters() {
  const facilities = getFilteredFacilities();
  const regionGroups = {};

  facilities.forEach(f => {
    const provInfo = PROVINCE_REGIONS[f.province];
    const region = provInfo ? provInfo.region : 'Other';
    
    if (!regionGroups[region]) {
      const info = REGIONS[region] || { lat: f.lat, lon: f.lon };
      regionGroups[region] = {
        lat: info.lat,
        lon: info.lon,
        members: [],
        name: region
      };
    }
    regionGroups[region].members.push(f);
  });

  return Object.values(regionGroups).filter(c => c.members.length >= 1);
}

function createPieSVG(sectorCounts, size = 70) {
  const total = Object.values(sectorCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return '';

  const r = size / 2;
  let cumulative = 0;
  let sliceId = 0;
  const entries = Object.entries(sectorCounts);
  const singleColor = entries.length === 1 ? (SECTOR_COLORS[entries[0][0]] || '#888') : null;

  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="pointer-events: all;">`;

  if (entries.length === 1) {
    svg += `<circle cx="${r}" cy="${r}" r="${r}" fill="${singleColor}" stroke="white" stroke-width="1.5" />`;
  } else {
    for (const [sector, count] of entries) {
      const portion = count / total;
      const [sx, sy] = polar(r, r, r, cumulative * 360);
      cumulative += portion;
      const [ex, ey] = polar(r, r, r, cumulative * 360);
      const large = portion > 0.5 ? 1 : 0;
      const color = SECTOR_COLORS[sector] || '#888';
      const percent = (portion * 100).toFixed(1);

      svg += `<path id="slice-${sliceId}" d="M${r},${r} L${sx},${sy} A${r},${r} 0 ${large},1 ${ex},${ey} Z"
                fill="${color}" stroke="white" stroke-width="1.5"
                style="cursor:pointer;transition:opacity 0.2s;"
                onmouseover="this.style.opacity='0.8'; showSliceTooltip(event, '${sector.replace(/'/g, "\\'")}', ${count}, '${percent}%')"
                onmouseout="this.style.opacity='1'; hideSliceTooltip()" />`;
      sliceId++;
    }
  }

  svg += `<circle cx="${r}" cy="${r}" r="${r * 0.5}" fill="white" stroke="#444" stroke-width="1.5"/>`;
  const fontSize = Math.max(11, Math.min(size * 0.25, 22));
  const centerText = formatLargeNumber(total);

  svg += `<text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="middle"
                font-size="${fontSize}" font-weight="bold" fill="#333"
                style="pointer-events:none;user-select:none;">${centerText}</text>`;
  svg += `</svg>`;

  return svg;
}

function polar(cx, cy, r, angle) {
  const rad = (angle - 90) * Math.PI / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

let pieTooltip = null;

function showSliceTooltip(event, sector, count, percent) {
  if (!pieTooltip) {
    pieTooltip = document.createElement('div');
    pieTooltip.style.cssText = `
      position: fixed;
      background: rgba(0,0,0,0.85);
      color: white;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      z-index: 10000;
      white-space: nowrap;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(pieTooltip);
  }
  
  const metric = window.currentMetric || 'facilities';
  const displayValue = window.formatMetricValue ? window.formatMetricValue(count, metric) : (count === 1 ? '1 facility' : `${count} facilities`);
  pieTooltip.innerHTML = `<strong>${sector}</strong><br>${displayValue} (${percent})`;
  pieTooltip.style.display = 'block';
  pieTooltip.style.left = (event.clientX + 10) + 'px';
  pieTooltip.style.top = (event.clientY + 10) + 'px';
}

function hideSliceTooltip() {
  if (pieTooltip) {
    pieTooltip.style.display = 'none';
  }
}

function drawAggregatedPies(clusters, labelKey = null) {
  clearSpatialPies();

  clusters.forEach(c => {

    const sectorCounts = computeMetricCounts(c.members, currentMetric);

    const total = Object.values(sectorCounts).reduce((a, b) => a + b, 0);
    const entries = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]);


    const subcatSet = new Set(c.members.map(f => (f.subcategory || '').trim()));
    const dominant = entries.length ? entries[0] : null;
    const dominantRatio = dominant ? dominant[1] / Math.max(1, total) : 0;
    let overrideColor = null;

    if (entries.length === 1 || dominantRatio >= 0.999) {
      if (subcatSet.size === 1) {
        const subcat = Array.from(subcatSet)[0];
        overrideColor =
          (window.SUBCATEGORY_COLORS && window.SUBCATEGORY_COLORS[subcat]) ||
          (typeof SUBCATEGORY_COLORS !== 'undefined' ? SUBCATEGORY_COLORS[subcat] : null);
      }
      if (!overrideColor && dominant) {
        const sector = dominant[0];
        overrideColor =
          (window.SECTOR_COLORS && window.SECTOR_COLORS[sector]) ||
          (typeof SECTOR_COLORS !== 'undefined' ? SECTOR_COLORS[sector] : null) ||
          '#888';
      }
    }

    const size = Math.min(50 + c.members.length * 2, 120);
    const svg = createPieSVG(sectorCounts, size, overrideColor);

    const icon = L.divIcon({
      html: svg,
      className: 'pie-icon',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });

    let tooltipHtml = `<div style="font-size: 13px;">`;
    if (c.name) tooltipHtml += `<strong>${c.name}</strong><br>`;

    const metricLabel = getMetricLabel(currentMetric);
    tooltipHtml += `<strong>${formatMetricValue(total, currentMetric)}</strong><br><em>${metricLabel}</em><br><br>`;

    entries.forEach(([sector, value]) => {
      const percent = ((value / Math.max(1, total)) * 100).toFixed(1);
      const color =
        (window.SECTOR_COLORS && window.SECTOR_COLORS[sector]) ||
        (typeof SECTOR_COLORS !== 'undefined' ? SECTOR_COLORS[sector] : null) ||
        '#888';
      tooltipHtml += `<span style="display:inline-block;width:10px;height:10px;background:${color};margin-right:5px;"></span>
        ${sector}: ${formatMetricValue(value, currentMetric)} (${percent}%)<br>`;
    });
    tooltipHtml += `</div>`;

    const m = L.marker([c.lat, c.lon], { icon }).bindTooltip(tooltipHtml, {
      permanent: false,
      direction: 'top',
      offset: [0, -size / 2],
    });
    m.addTo(map);
    clusterMarkers.push(m);
  });
}

function clearSpatialPies() {
  clusterMarkers.forEach(m => map.removeLayer(m));
  clusterMarkers = [];
}

function applyAggregation() {
  clearSpatialPies();

  if (aggregationMode === 'none') {
    updateVisibility();
    return;
  }

  Object.values(markers).forEach(items =>
    items.forEach(({ marker }) => {
      if (map.hasLayer(marker)) map.removeLayer(marker);
    })
  );

  let clusters = [];
  switch (aggregationMode) {
    case '50km':
      clusters = computeSpatialClusters();
      break;
    case 'provinces':
      clusters = computeProvinceClusters();
      break;
    case 'regions':
      clusters = computeRegionClusters();
      break;
  }

  drawAggregatedPies(clusters);
}

if (typeof window !== 'undefined') {
  const _originalUpdateVisibility = window.updateVisibility;
  window.currentMetric = window.currentMetric || 'facilities';
  window.showSliceTooltip = showSliceTooltip;
  window.hideSliceTooltip = hideSliceTooltip;
  window.setAggregationMode = setAggregationMode;
  window.updateVisibility = function () {
    if (
      aggregationMode !== 'none' &&
      map.getZoom() <= PIE_ZOOM_THRESHOLD
    ) {
      applyAggregation();
      return;
    }

    if (typeof _originalUpdateVisibility === 'function') {
      _originalUpdateVisibility();
    }
  };
}