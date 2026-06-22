/**
 * search.js
 * Text-based search: filters visible markers by name, operator, city, province, sector, or subcategory.
 * When a query is active, only matching facilities remain visible.
 */

let searchIndex = [];
let lastSearch = '';

function buildSearchIndex() {
  searchIndex = [];
  Object.values(markers).forEach(items => {
    items.forEach(({ facility }) => {
      const { name, operator, city, province, sector, subcategory } = facility;
      searchIndex.push({
        text: `${name} ${operator || ''} ${city || ''} ${province || ''} ${sector} ${subcategory}`.toLowerCase(),
        facility,
      });
    });
  });
}

function handleSearchInput() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();

  if (query === lastSearch) return;
  lastSearch = query;

  if (!query) {
    // Reset to normal view
    updateVisibility();
    return;
  }

  let visible = 0;

  Object.entries(markers).forEach(([key, items]) => {
    items.forEach(({ marker, facility }) => {
      const combinedText = `${facility.name} ${facility.operator || ''} ${facility.city || ''} ${facility.province || ''} ${facility.sector} ${facility.subcategory}`.toLowerCase();
      const match = combinedText.includes(query);
      const passesFilters =
        filters.datasets[facility.dataset] &&
        filters.sectors[facility.sector] &&
        filters.subcategories[facility.subcategory] &&
        filters.statuses[normalizeStatus(facility.status)] !== false;

      if (match && passesFilters) {
        if (!map.hasLayer(marker)) marker.addTo(map);
        visible++;
      } else if (map.hasLayer(marker)) {
        map.removeLayer(marker);
      }
    });
  });

  document.getElementById('visibleCount').textContent = visible;
}

function attachSearchUI() {
  const statsBox = document.querySelector('.stats-box');
  const searchBox = document.createElement('input');
  searchBox.id = 'searchInput';
  searchBox.type = 'text';
  searchBox.placeholder = '🔍 Search name, city, operator...';
  searchBox.style.cssText =
    'width:100%;margin-top:8px;padding:6px 8px;font-size:13px;border:1px solid #ccc;border-radius:4px;';
  statsBox.appendChild(searchBox);

  searchBox.addEventListener('input', handleSearchInput);

  searchBox.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      searchBox.value = '';
      handleSearchInput();
    }
  });
}
