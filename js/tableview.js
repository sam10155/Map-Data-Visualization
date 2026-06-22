// ===== TABLE VIEW HANDLER =====

const tableBody = document.querySelector("#dataTable tbody");
const headerRow = document.getElementById("tableHeader");
const provinceSelect = document.getElementById("provinceFilter");
const sectorSelect = document.getElementById("sectorFilter");
const subcategorySelect = document.getElementById("subcategoryFilter");
const searchBox = document.getElementById("searchBox");
const exportBtn = document.getElementById("exportCsv");

const columns = ["name", "operator", "sector", "subcategory", "status", "province", "city", "capacity", "unit", "location"];
let sortState = { column: null, ascending: true };
let filteredData = [];

function populateTableFilters() {
  const provinces = [...new Set(canadaIndustrialData.all.map(d => d.province))].sort();
  const sectors = [...new Set(canadaIndustrialData.all.map(d => d.sector))].sort();
  const subcats = [...new Set(canadaIndustrialData.all.map(d => d.subcategory))].sort();

  [provinceSelect, sectorSelect, subcategorySelect].forEach(sel => sel.innerHTML = `<option value="">All</option>`);

  provinces.forEach(v => provinceSelect.insertAdjacentHTML('beforeend', `<option value="${v}">${v}</option>`));
  sectors.forEach(v => sectorSelect.insertAdjacentHTML('beforeend', `<option value="${v}">${v}</option>`));
  subcats.forEach(v => subcategorySelect.insertAdjacentHTML('beforeend', `<option value="${v}">${v}</option>`));
}

function renderTable() {
  tableBody.innerHTML = "";
  filteredData.forEach((d) => {
    const cells = columns.map(c => {
      if (c === "location") {
        const lat = d.lat?.toFixed(4) ?? "";
        const lon = d.lon?.toFixed(4) ?? "";
        if (!lat || !lon) return `<td></td>`;
        return `<td><a href="#" class="coord-link" data-lat="${lat}" data-lon="${lon}" data-name="${d.name}">${lat};${lon}</a></td>`;
      }
      if (c === "status") {
        const st = normalizeStatus(d.status);
        const badge = (STATUS_STYLES[st] || STATUS_STYLES['Active']).badge;
        return `<td><span class="status-pill" style="background:${badge}">${st}</span></td>`;
      }
      return `<td>${d[c] ?? ""}</td>`;
    }).join("");
    tableBody.insertAdjacentHTML("beforeend", `<tr>${cells}</tr>`);
  });

  document.querySelectorAll(".coord-link").forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      const lat = parseFloat(e.target.dataset.lat);
      const lon = parseFloat(e.target.dataset.lon);
      const name = e.target.dataset.name;
      switchToMapAndHighlight(lat, lon, name);
    });
  });
}

function switchToMapAndHighlight(lat, lon, name) {
  const mapDiv = document.getElementById("map");
  const tableDiv = document.getElementById("tableView");
  const controlPanel = document.getElementById("controlPanel");
  const legend = document.querySelector(".legend");
  const btn = document.getElementById("toggleViewBtn");

  // Switch view back to map
  mapDiv.style.display = "block";
  controlPanel.style.display = "block";
  legend.style.display = "block";
  tableDiv.classList.add("hidden");
  btn.textContent = "📊 Table View";

  // Wait for the map to render again
  setTimeout(() => {
    if (typeof map?.setView !== "function") return;

    // Center and zoom
    map.setView([lat, lon], 10, { animate: true });

    // Find the corresponding marker in your global markers object
    let matched = null;
    for (const arr of Object.values(markers || {})) {
      for (const { marker, facility } of arr) {
        const nearSameSpot =
          Math.abs(facility.lat - lat) < 0.002 &&
          Math.abs(facility.lon - lon) < 0.002;
        if (nearSameSpot || facility.name?.trim() === name?.trim()) {
          matched = marker;
          break;
        }
      }
      if (matched) break;
    }

    if (matched) {
      matched.openPopup();
      const origColor = matched.options.color;

      // Apply flash highlight (red → original)
      matched.setStyle({ color: "#ff0000", fillColor: "#ff0000" });
      if (matched.bringToFront) matched.bringToFront();

      // Add quick flash animation (fade)
      let flashCount = 0;
      const flashInterval = setInterval(() => {
        matched.setStyle({
          color: flashCount % 2 ? "#ff0000" : origColor,
          fillColor: flashCount % 2 ? "#ff0000" : origColor,
        });
        flashCount++;
        if (flashCount > 4) {
          clearInterval(flashInterval);
          matched.setStyle({ color: origColor, fillColor: origColor });
        }
      }, 250);
    } else {
      console.warn("No matching marker found for:", name, lat, lon);
    }
  }, 400);
}

function sortTableBy(column) {
  const ascending = sortState.column === column ? !sortState.ascending : true;
  sortState = { column, ascending };

  filteredData.sort((a, b) => {
    const va = a[column] ?? "";
    const vb = b[column] ?? "";
    if (typeof va === "number" && typeof vb === "number")
      return ascending ? va - vb : vb - va;
    return ascending
      ? va.toString().localeCompare(vb.toString())
      : vb.toString().localeCompare(va.toString());
  });

  document.querySelectorAll("#tableHeader th").forEach(th => {
    th.textContent = th.dataset.key;
  });
  const header = document.querySelector(`#tableHeader th[data-key="${column}"]`);
  if (header) header.textContent += ascending ? " ▲" : " ▼";

  renderTable();
}

function applyTableFilters() {
  const prov = provinceSelect.value;
  const sect = sectorSelect.value;
  const sub = subcategorySelect.value;
  const search = searchBox.value.toLowerCase();

  filteredData = canadaIndustrialData.all.filter(d =>
    (!prov || d.province === prov) &&
    (!sect || d.sector === sect) &&
    (!sub || d.subcategory === sub) &&
    (!search || d.name.toLowerCase().includes(search) || (d.city ?? "").toLowerCase().includes(search))
  );
  renderTable();
}

function initTableView() {
  headerRow.innerHTML = columns.map(c => `<th data-key="${c}">${c === "location" ? "Location" : c.charAt(0).toUpperCase() + c.slice(1)}</th>`).join("");
  populateTableFilters();
  filteredData = canadaIndustrialData.all;
  renderTable();

  [provinceSelect, sectorSelect, subcategorySelect].forEach(sel => sel.onchange = applyTableFilters);
  searchBox.oninput = applyTableFilters;

  exportBtn.onclick = () => {
    const csv = [columns.join(",")].concat(
      filteredData.map(d => columns.map(c => `"${d[c] ?? ""}"`).join(","))
    ).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "canada-data-export.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  document.querySelectorAll("#tableHeader th").forEach(th => {
    th.addEventListener("click", () => sortTableBy(th.dataset.key));
  });
}

document.addEventListener("DOMContentLoaded", initTableView);