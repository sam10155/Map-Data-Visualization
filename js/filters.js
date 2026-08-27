window.filters = { datasets: {}, sectors: {}, subcategories: {}, statuses: {} };

function toggleStatus(s) {
  filters.statuses[s] = !filters.statuses[s];
  const cb = document.querySelector(`#statusFilters input[data-key="${CSS.escape(s)}"]`);
  if (cb) cb.checked = filters.statuses[s];
  updateVisibility();
}

function toggleDataset(d) {
  filters.datasets[d] = !filters.datasets[d];
  const cb = document.querySelector(`#datasetFilters input[data-key="${CSS.escape(d)}"]`);
  if (cb) cb.checked = filters.datasets[d];
  syncSelectAllState("datasets");
  updateVisibility();
}

function toggleSector(s) {
  filters.sectors[s] = !filters.sectors[s];
  const cb = document.querySelector(`#sectorFilters input[data-key="${CSS.escape(s)}"]`);
  if (cb) cb.checked = filters.sectors[s];
  syncSelectAllState("sectors");
  updateVisibility();
}

function toggleSubcategory(s) {
  filters.subcategories[s] = !filters.subcategories[s];
  const cb = document.querySelector(`#subcategoryFilters input[data-key="${CSS.escape(s)}"]`);
  if (cb) cb.checked = filters.subcategories[s];
  syncSelectAllState("subcategories");
  updateVisibility();
}

function getContainer(group) {
  const id =
    group === 'datasets' ? 'datasetFilters' :
    group === 'sectors' ? 'sectorFilters' :
    'subcategoryFilters';
  return document.getElementById(id);
}

function getSelectAllEl(group) {
  const id =
    group === 'datasets' ? 'selectAll-datasets' :
    group === 'sectors' ? 'selectAll-sectors' :
    'selectAll-subcategories';
  return document.getElementById(id);
}

function toggleAll(group, checked) {
  const target = filters[group];
  if (!target) return;

  Object.keys(target).forEach(k => { target[k] = checked; });

  const container = getContainer(group);
  const selectAll = getSelectAllEl(group);
  if (container && selectAll) {
    const subs = Array.from(container.querySelectorAll('input[type="checkbox"]'))
      .filter(cb => cb !== selectAll);
    subs.forEach(cb => { cb.checked = checked; });
  }

  updateVisibility();
}

function syncSelectAllState(group) {
  const target = filters[group];
  if (!target) return;

  const selectAll = getSelectAllEl(group);
  if (!selectAll) return;

  const vals = Object.values(target);
  const allChecked = vals.every(Boolean);
  const noneChecked = vals.every(v => !v);

  selectAll.checked = allChecked;
  selectAll.indeterminate = !allChecked && !noneChecked;
}

function isMarkerDeleted(marker) {
  if (marker._deleted) return true;
  
  if (marker._facility && window._deleteCache) {
    const safeKey = `delete:${window.sanitizeStorageKey(marker._facility.name)}`;
    return window._deleteCache[safeKey] === true;
  }
  
  return false;
}

function updateVisibility() {
  let visible = 0;

  // Sector Legend only earns its screen space when at least one dataset
  // is selected (they all start unchecked on a fresh load).
  const legendEl = document.querySelector('.legend');
  if (legendEl) {
    const anyDataset = Object.values(filters.datasets || {}).some(v => v);
    legendEl.style.display = anyDataset ? '' : 'none';
  }

  Object.entries(markers).forEach(([key, items]) => {
    items.forEach(({ marker, facility }) => {
      if (isMarkerDeleted(marker)) {
        if (map.hasLayer(marker)) {
          map.removeLayer(marker);
        }
        return;
      }

      const datasetOn = filters.datasets[facility.dataset];
      const sectorOn = filters.sectors[facility.sector];
      const subOn = filters.subcategories[facility.subcategory];
      const statusOn = filters.statuses[normalizeStatus(facility.status)] !== false;

      const show = datasetOn && sectorOn && subOn && statusOn;

      if (show) {
        if (!map.hasLayer(marker)) marker.addTo(map);
        visible++;
      } else if (map.hasLayer(marker)) {
        map.removeLayer(marker);
      }
    });
  });

  const el = document.getElementById("visibleCount");
  if (el) el.textContent = visible;
}