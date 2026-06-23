function togglePanel() {
  const panel = document.getElementById('controlPanel');
  panel.classList.toggle('collapsed');
  document.getElementById('toggleIcon').textContent = panel.classList.contains('collapsed') ? '+' : '−';
}

function initializeFilters() {
  Object.values(markers).forEach(items => {
    const f = items[0].facility;
    filters.datasets[f.dataset] = true;
    filters.sectors[f.sector] = true;
    filters.subcategories[f.subcategory] = true;
  });
  STATUS_VALUES.forEach(s => { filters.statuses[s] = true; });
}

function buildUI() {
  if (window.Basemap && !document.getElementById('basemap-section')) {
    const panelContent = document.querySelector('#controlPanel .panel-content');
    if (panelContent) Basemap.buildControls(panelContent);
  }

  buildDatasetFilters();
  buildStatusFilters();
  buildCombinedSectorFilters();
  buildLegend();
  buildMetricControls();
  buildNewFacilityButton();

  document.getElementById('totalCount').textContent =
    Object.values(markers).reduce((sum, items) => sum + items.length, 0);
}

function buildStatusFilters() {
  const datasetSection = document.getElementById('datasetFilters')?.parentElement;
  if (!datasetSection || document.getElementById('statusFilters')) return;

  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = `<div class="section-title">🔘 Status</div><div id="statusFilters"></div>`;
  datasetSection.insertAdjacentElement('afterend', section);

  let html = '';
  STATUS_VALUES.forEach(s => {
    const style = STATUS_STYLES[s];
    html += `<label class="checkbox-item">
      <input type="checkbox" data-key="${s}" checked onchange="toggleStatus('${s}')">
      <span class="status-dot" style="background:${style.badge}"></span>
      <span>${s}</span>
    </label>`;
  });
  document.getElementById('statusFilters').innerHTML = html;
}

function buildMetricControls() {
  const controlPanel = document.getElementById('controlPanel');
  if (!controlPanel || document.getElementById('metric-section')) return;

  const section = document.createElement('div');
  section.id = 'metric-section';
  section.className = 'section';
  section.style.display = 'none';

  section.innerHTML = `
    <div class="aggregation-slider">
      <button id="metric-facilities" class="agg-option active" onclick="setMetric('facilities')">Facilities</button>
      <button id="metric-capacities" class="agg-option" onclick="setMetric('capacities')">Capacities</button>
      <button id="metric-workers" class="agg-option" onclick="setMetric('workers')">Workers</button>
    </div>
  `;

  const aggSection = controlPanel.querySelector('.aggregation-slider');
  if (aggSection && aggSection.parentElement.classList.contains('section')) {
    aggSection.parentElement.insertAdjacentElement('afterend', section);
  } else {
    controlPanel.querySelector('.panel-content').prepend(section);
  }
}

function buildDatasetFilters() {
  let html = `<label class="checkbox-item" style="font-weight:600;">
    <input type="checkbox" id="selectAll-datasets" checked onchange="toggleAll('datasets', this.checked)">
    <span>Select All</span></label>`;
  Object.keys(filters.datasets).sort().forEach(d => {
    const escaped = d.replace(/'/g, "\\'");
    html += `<label class="checkbox-item">
      <input type="checkbox" data-key="${d}" checked onchange="toggleDataset('${escaped}')">${d}</label>`;
  });
  document.getElementById('datasetFilters').innerHTML = html;
}

function buildCombinedSectorFilters() {
  const UNIT_HINTS = { 
    'Crude Tank Farm':'bbl','Refined Product Terminal':'m³','Underground Gas Storage':'Bcf',
    'LNG Storage':'m³','LPG/NGL Storage':'bbl','Gas Processing Plant':'MMcf/d',
    'Oilseed':'MTPA','Pulse':'MTPA','Ethanol':'MTPA','Feed':'MTPA',
    'Meat':'kMT/yr','Dairy':'kMT/yr','Seafood':'kMT/yr' 
  };

  const subcategoriesBySector = {};
  Object.keys(filters.subcategories).forEach(subcat => {
    let sector = null;
    Object.values(markers).forEach(items => {
      items.forEach(({ facility }) => {
        if (facility.subcategory === subcat) sector = facility.sector;
      });
    });
    if (sector) {
      if (!subcategoriesBySector[sector]) subcategoriesBySector[sector] = [];
      subcategoriesBySector[sector].push(subcat);
    }
  });

  let html = `<label class="checkbox-item" style="font-weight:600;">
    <input type="checkbox" id="selectAll-sectors" checked onchange="toggleAllSectorsAndSubs(this.checked)">
    <span>Select All</span></label>`;

  Object.keys(subcategoriesBySector).sort().forEach(sector => {
    const sectorColor = SECTOR_COLORS[sector] || '#555';
    const sectorId = sector.replace(/[^a-zA-Z0-9]/g, '-');
    const subcats = subcategoriesBySector[sector].sort();
    const escapedSector = sector.replace(/'/g, "\\'");
    
    html += `
      <div class="sector-group">
        <div class="checkbox-item sector-header">
          <input type="checkbox" data-key="${sector}" data-sector-id="${sectorId}" checked onchange="toggleSectorWithSubs('${escapedSector}', '${sectorId}', this.checked)">
          <span class="expand-icon" id="icon-${sectorId}" onclick="toggleSectorGroup('${sectorId}', event)">▶</span>
          <span class="color-dot" style="background:${sectorColor}"></span>
          <span style="font-weight:600;" onclick="toggleSectorGroup('${sectorId}', event)" style="cursor:pointer;">${sector}</span>
        </div>
        <div class="subcategory-group" id="group-${sectorId}" style="display:none;">`;
    
    subcats.forEach(subcat => {
      const color = SUBCATEGORY_COLORS[subcat] || sectorColor;
      const unit = UNIT_HINTS[subcat] ? `<span style="color:#6b7280;font-size:11px;">(${UNIT_HINTS[subcat]})</span>` : '';
      const escaped = subcat.replace(/'/g, "\\'");
      
      html += `<label class="checkbox-item subcat-item">
        <input type="checkbox" data-key="${subcat}" data-parent-sector="${sectorId}" checked onchange="toggleSubcategoryInSector('${escaped}', '${escapedSector}')">
        <span class="color-dot" style="background:${color}"></span>
        <span style="font-size:12px;">${subcat}</span> ${unit}
      </label>`;
    });
    
    html += `</div></div>`;
  });

  document.getElementById('sectorFilters').innerHTML = html;
}

function toggleSectorGroup(sectorId, event) {
  if (event) event.stopPropagation();
  
  const group = document.getElementById(`group-${sectorId}`);
  const icon = document.getElementById(`icon-${sectorId}`);
  
  if (group.style.display === 'none') {
    group.style.display = 'block';
    icon.textContent = '▼';
  } else {
    group.style.display = 'none';
    icon.textContent = '▶';
  }
}

function toggleSectorWithSubs(sector, sectorId, checked) {
  filters.sectors[sector] = checked;

  const group = document.getElementById(`group-${sectorId}`);
  if (group) {
    const subCheckboxes = group.querySelectorAll('input[type="checkbox"]');
    subCheckboxes.forEach(cb => {
      const subKey = cb.getAttribute('data-key');
      if (subKey) {
        filters.subcategories[subKey] = checked;
        cb.checked = checked;
      }
    });
  }
  
  syncSelectAllSectorsState();
  updateVisibility();
}

function toggleSubcategoryInSector(subcat, sector) {
  filters.subcategories[subcat] = !filters.subcategories[subcat];
  
  const cb = document.querySelector(`input[data-key="${CSS.escape(subcat)}"]`);
  if (cb) cb.checked = filters.subcategories[subcat];

  updateSectorCheckbox(sector);
  syncSelectAllSectorsState();
  updateVisibility();
}

function updateSectorCheckbox(sector) {
  const sectorId = sector.replace(/[^a-zA-Z0-9]/g, '-');
  const sectorCheckbox = document.querySelector(`input[data-sector-id="${sectorId}"]`);
  const group = document.getElementById(`group-${sectorId}`);
  
  if (sectorCheckbox && group) {
    const subCheckboxes = Array.from(group.querySelectorAll('input[type="checkbox"]'));
    const allChecked = subCheckboxes.every(cb => cb.checked);
    const noneChecked = subCheckboxes.every(cb => !cb.checked);
    
    sectorCheckbox.checked = allChecked;
    sectorCheckbox.indeterminate = !allChecked && !noneChecked;

    filters.sectors[sector] = allChecked || !noneChecked;
  }
}

function toggleAllSectorsAndSubs(checked) {
  Object.keys(filters.sectors).forEach(s => {
    filters.sectors[s] = checked;
  });
  
  Object.keys(filters.subcategories).forEach(s => {
    filters.subcategories[s] = checked;
  });
  
  const container = document.getElementById('sectorFilters');
  if (container) {
    const allCheckboxes = container.querySelectorAll('input[type="checkbox"]');
    allCheckboxes.forEach(cb => {
      if (cb.id !== 'selectAll-sectors') {
        cb.checked = checked;
        cb.indeterminate = false;
      }
    });
  }
  
  updateVisibility();
}

function syncSelectAllSectorsState() {
  const selectAll = document.getElementById('selectAll-sectors');
  if (!selectAll) return;
  
  const allSectorVals = Object.values(filters.sectors);
  const allSubVals = Object.values(filters.subcategories);
  const allVals = [...allSectorVals, ...allSubVals];
  
  const allChecked = allVals.every(Boolean);
  const noneChecked = allVals.every(v => !v);
  
  selectAll.checked = allChecked;
  selectAll.indeterminate = !allChecked && !noneChecked;
}

function buildNewFacilityButton() {
  if (document.getElementById("topToolbar")) return;

  // Relocate the table-view toggle to top-right (above map-mode bar).
  const oldToggle = document.getElementById("viewToggle");
  const toggleBtn = document.getElementById("toggleViewBtn");
  if (toggleBtn) {
    toggleBtn.className = "table-toggle-btn";
    document.body.appendChild(toggleBtn);
  }
  if (oldToggle) oldToggle.remove();

  // New Facility stays in its own toolbar beside the control panel.
  const bar = document.createElement("div");
  bar.id = "topToolbar";
  bar.className = "top-toolbar";

  const btn = document.createElement("button");
  btn.id = "newFacilityBtn";
  btn.className = "toolbar-btn toolbar-btn-primary";
  btn.textContent = "➕ New Facility";
  btn.onclick = () => {
    if (typeof createNewFacility === "function") createNewFacility();
    else console.error("createNewFacility() not found");
  };
  bar.appendChild(btn);

  document.body.appendChild(bar);
}

function buildLegend() {
  let html = '';
  Object.entries(SECTOR_COLORS).forEach(([s, c]) => {
    html += `<div class="legend-item"><span class="color-dot" style="background:${c}"></span>${s}</div>`;
  });
  html += `<div class="legend-title" style="margin-top:10px;">Status</div>`;
  STATUS_VALUES.forEach(s => {
    const st = STATUS_STYLES[s];
    html += `<div class="legend-item"><span class="status-dot" style="background:${st.badge}"></span>${s}</div>`;
  });
  document.getElementById('legendContent').innerHTML = html;
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("toggleViewBtn");
  const mapDiv = document.getElementById("map");
  const tableDiv = document.getElementById("tableView");
  const controlPanel = document.getElementById("controlPanel");
  const legend = document.querySelector(".legend");

  btn.addEventListener("click", () => {
  const isMapVisible = mapDiv.style.display !== "none";
  const editActions = document.getElementById("editActionsContainer");
  const mapModeBar = document.getElementById("mapModeBar");
  const topToolbar = document.getElementById("topToolbar");

  if (isMapVisible) {
      mapDiv.style.display = "none";
      controlPanel.style.display = "none";
      legend.style.display = "none";
      tableDiv.classList.remove("hidden");

      if (editActions) editActions.style.display = "none";
      if (mapModeBar) mapModeBar.style.display = "none";
      if (topToolbar) topToolbar.style.display = "none";

      btn.textContent = "🗺️ Map View";
    } else {
      mapDiv.style.display = "block";
      controlPanel.style.display = "block";
      legend.style.display = "block";
      tableDiv.classList.add("hidden");

      if (editActions) editActions.style.display = "";
      if (mapModeBar) mapModeBar.style.display = "";
      if (topToolbar) topToolbar.style.display = "";

      btn.textContent = "📊 Table View";
    }
  });
});