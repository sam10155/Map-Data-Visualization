/**
 * Water-systems overlay.
 *
 *  Layers (always stacked, never blanked on zoom):
 *    1. Basin polygons — from data/canada-basins.geojson if present
 *       (real NRCan/HydroSHEDS-derived boundaries via scripts/fetch_basins.py),
 *       else falls back to the simplified polygons in canada-water-basins.js.
 *    2. Coarse named-river backbone — always shown (gives context while
 *       detailed geometry loads).
 *    3. Detailed river geometry — fetched on demand from OSM Overpass for
 *       the viewport at zoom ≥ OSM_ZOOM, **restricted to Canada** via the
 *       Overpass area filter (relation 1428 → area 3600001428), so no US
 *       rivers are returned.  Cached per 2°×2° cell.
 *
 *  Stroke width ∝ √(mean discharge m³/s) where known.
 */

(function () {
  const OSM_ZOOM = 7;          // start fetching detailed rivers
  const STREAM_ZOOM = 10;      // add tributary streams (waterway=stream)
  const CELL_DEG = 1.0;
  const STREAM_CELL_DEG = 0.25;
  const MAX_CELLS_PER_FETCH = 2;
  const REQUEST_GAP_MS = 1500;
  const OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://z.overpass-api.de/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter',
  ];

  // Southern extent of Canada by longitude band — keeps Overpass tiles
  // from sweeping deep into the US.  West of the Lakehead the border is
  // 49°N; only the ON peninsula, QC and Maritimes dip lower.
  function southBoundAt(lon) {
    if (lon < -123.3) return 48.2;        // Vancouver Island dips to ~48.3
    if (lon < -95)  return 48.9;          // Prairies / mainland BC: 49th parallel
    if (lon < -88)  return 47.5;          // Lake Superior wedge
    if (lon < -83)  return 41.6;          // SW Ontario peninsula
    if (lon < -79)  return 41.6;          // Niagara / Erie shore
    if (lon < -74)  return 43.5;          // E Ontario / Ottawa valley
    if (lon < -71)  return 44.9;          // S Québec
    if (lon < -67)  return 44.5;          // NB / Bay of Fundy
    if (lon < -59)  return 43.3;          // NS south shore
    return 46.5;                          // NL
  }
  function inCanadaEnvelope(lat, lon) {
    return lon >= -141 && lon <= -52 && lat <= 83.2 && lat >= southBoundAt(lon);
  }

  // Water-level classes are percentiles of each station's own history for
  // the current month (levels use station-local datums, so raw metres are
  // never comparable across stations).
  const LEVEL_COLORS = {
    'very-low': '#b91c1c', 'low': '#f59e0b', 'normal': '#22c55e',
    'high': '#3b82f6', 'very-high': '#7c3aed',
  };
  const LEVEL_LABELS = {
    'very-low': 'Very low (&lt;p05)', 'low': 'Low (&lt;p25)', 'normal': 'Normal',
    'high': 'High (&gt;p75)', 'very-high': 'Very high (&gt;p95)',
  };
  const KIND_ICON = { river: '🏞', lake: '🌊', reservoir: '🪣', coastal: '⚓' };

  function legendHTML(basins) {
    const rows = basins.map(b =>
      `<div class="legend-item"><span class="color-dot" style="background:${b.color}"></span>${b.name}</div>`
    ).join('');
    const lvlRows = ['very-high', 'high', 'normal', 'low', 'very-low'].map(k =>
      `<div class="legend-item"><span class="color-dot" style="background:${LEVEL_COLORS[k]}"></span>${LEVEL_LABELS[k]}</div>`
    ).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">💧 Drainage Basins & Rivers</div>
      ${rows}
      <div class="wx-row" style="margin-top:6px;">— line width ∝ √(mean discharge m³/s)</div>
      <div class="wx-row">Zoom ≥ ${OSM_ZOOM}: detailed rivers · ≥ ${STREAM_ZOOM}: tributary streams (OSM)</div>
      <div class="wx-row" id="water-osm-status" style="color:#9ca3af;"></div>
      <div class="overlay-legend-title" style="margin-top:6px;" id="water-levels-legend">📏 Water Levels vs monthly norms</div>
      ${lvlRows}
      <div class="legend-item"><span class="color-dot" style="background:#9ca3af"></span>No historical baseline</div>
      <div class="legend-item"><span class="color-dot" style="background:#6b7280;border:2px solid #eab308;"></span>Gold ring: reservoir w/ capacity est.</div>
      <div class="wx-row" id="water-levels-status" style="color:#9ca3af;"></div>
      <div class="wx-row">Data: ECCC · DFO-CHS · ORRPB (provisional)</div>
    </div>`;
  }

  function pip(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const yi = poly[i][0], xi = poly[i][1];
      const yj = poly[j][0], xj = poly[j][1];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function basinFor(lat, lon, basins) {
    for (const b of basins) {
      const polys = b._polys || (b.polygon ? [b.polygon] : []);
      for (const p of polys) if (pip(lat, lon, p)) return b;
    }
    return null;
  }

  function flowWidth(q) {
    if (!q || q <= 0) return 1.4;
    return Math.max(1.2, Math.min(9, 0.18 * Math.sqrt(q)));
  }

  function nameMatchDischarge(name, table) {
    if (!name) return null;
    if (table[name] != null) return table[name];
    const n = name.toLowerCase().replace(/\briver\b|\brivière\b|\bfleuve\b/g, '').trim();
    for (const [k, v] of Object.entries(table)) {
      const kk = k.toLowerCase().replace(/\s*\(.*\)\s*/, '').trim();
      if (kk && (n === kk || n.includes(kk) || kk.includes(n))) return v;
    }
    return null;
  }

  function setStatus(msg) {
    const el = document.getElementById('water-osm-status');
    if (el) el.textContent = msg || '';
  }

  // Convert a GeoJSON Feature/MultiPolygon coords ([lon,lat]) into [[lat,lon]] rings.
  function ringsFromGeo(geom) {
    const out = [];
    const walk = (coords, depth) => {
      if (depth === 0) { out.push(coords.map(c => [c[1], c[0]])); return; }
      coords.forEach(c => walk(c, depth - 1));
    };
    if (geom.type === 'Polygon') walk(geom.coordinates, 1);
    else if (geom.type === 'MultiPolygon') walk(geom.coordinates, 2);
    return out;
  }

  async function loadBasinGeoJSON(simplifiedBasins) {
    try {
      const res = await fetch('data/canada-basins.geojson?v=' + (window.APP_VERSION || '1'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const gj = await res.json();
      if (!gj.features || gj.features.length === 0) throw new Error('empty');
      const colorById = Object.fromEntries(simplifiedBasins.map(b => [b.id, b.color]));
      const nameById  = Object.fromEntries(simplifiedBasins.map(b => [b.id, b.name]));
      return (gj.features || []).map(f => {
        const id = f.properties?.basin || f.properties?.OCEAN || f.id;
        const rings = ringsFromGeo(f.geometry);
        return {
          id,
          name: f.properties?.name || nameById[id] || id,
          color: colorById[id] || f.properties?.color || '#1d4ed8',
          _polys: rings,
        };
      });
    } catch (e) {
      console.info('[water] no canada-basins.geojson — using simplified polygons (', e.message, ')');
      return simplifiedBasins.map(b => ({ ...b, _polys: [b.polygon] }));
    }
  }

  MapModes.register({
    id: 'water',
    label: 'Water Systems',
    icon: '💧',
    build: async () => {
      const data = window.CANADA_WATER;
      if (!data) throw new Error('canada-water-basins.js not loaded');

      const basins = await loadBasinGeoJSON(data.basins);

      const basinGroup  = L.layerGroup();
      const coarseGroup = L.layerGroup();
      const osmGroup    = L.layerGroup();
      let legendCtl = null;
      let mapRef = null;

      const colorById = Object.fromEntries(basins.map(b => [b.id, b.color]));
      const cellCache = {};       // 2° river tiles
      const streamCache = {};     // 0.5° stream tiles
      const streamGroup = L.layerGroup();
      let inflight = 0;
      let staticRiversLoaded = false;

      async function tryLoadStaticRivers() {
        try {
          const res = await fetch('data/canada-rivers.geojson?v=' + (window.APP_VERSION || '1'));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const gj = await res.json();
          let n = 0;
          (gj.features || []).forEach(f => {
            if (f.geometry?.type !== 'LineString') return;
            const ll = f.geometry.coordinates.map(c => [c[1], c[0]]);
            if (ll.length < 2) return;
            const mid = ll[Math.floor(ll.length/2)];
            if (!inCanadaEnvelope(mid[0], mid[1])) return;
            const basin = basinFor(mid[0], mid[1], basins);
            const name = f.properties?.name || '';
            const q = nameMatchDischarge(name, data.discharge || {});
            L.polyline(ll, {
              color: basin ? basin.color : '#1d4ed8',
              weight: flowWidth(q), opacity: 0.9, interactive: true
            }).bindTooltip(
              `<b>${eh(name) || 'Unnamed river'}</b>` +
              (basin ? `<br>${eh(basin.name)}` : '') +
              (q ? `<br>~${q.toLocaleString()} m³/s mean flow` : ''),
              { sticky: true }
            ).addTo(osmGroup);
            n++;
          });
          staticRiversLoaded = true;
          setStatus(`${n.toLocaleString()} river segments (pre-baked)`);
        } catch (e) {
          console.info('[water] no pre-baked rivers — will use live Overpass at zoom ≥ ' + OSM_ZOOM, e.message);
        }
      }

      // ---- water-level station markers (📏 sub-toggle) ----
      const levelGroup = L.layerGroup();
      let levelsLoaded = false;

      function ageLabel(iso) {
        if (!iso) return '';
        const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
        if (!isFinite(mins) || mins < 0) return '';
        return mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
      }

      async function levelSparkline(id, container) {
        try {
          const url = 'https://api.weather.gc.ca/collections/hydrometric-realtime/items' +
            `?f=json&STATION_NUMBER=${encodeURIComponent(id)}&sortby=-DATETIME&limit=288&properties=DATETIME,LEVEL`;
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const pts = (await res.json()).features
            .map(f => [Date.parse(f.properties.DATETIME), f.properties.LEVEL])
            .filter(p => p[1] != null)
            .sort((a, b) => a[0] - b[0]);
          if (pts.length < 2) { container.textContent = 'no recent level data'; return; }
          const W = 220, H = 48, PAD = 3;
          const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs);
          const y0 = Math.min(...ys), y1 = Math.max(...ys);
          const sx = t => PAD + (W - 2*PAD) * (t - x0) / ((x1 - x0) || 1);
          const sy = v => H - PAD - (H - 2*PAD) * (v - y0) / ((y1 - y0) || 1);
          const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
          container.innerHTML =
            `<svg width="${W}" height="${H}" style="display:block;">` +
            `<path d="${d}" fill="none" stroke="#3b82f6" stroke-width="1.5"/></svg>` +
            `<div style="font-size:10px;color:#6b7280;">last 24 h · ${y0.toFixed(2)}–${y1.toFixed(2)} m</div>`;
        } catch (e) {
          container.textContent = `history unavailable (${e.message})`;
        }
      }

      async function loadLevels() {
        if (levelsLoaded) return;
        levelsLoaded = true;
        const setLvlStatus = msg => {
          const el = document.getElementById('water-levels-status');
          if (el) el.textContent = msg || '';
        };
        try {
          const res = await fetch('data/canada-water-levels.geojson?v=' + (window.APP_VERSION || '1'));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const gj = await res.json();
          (gj.features || []).forEach(f => {
            const p = f.properties, [lon, lat] = f.geometry.coordinates;
            // Reservoirs with a curated operating range are coloured by
            // fill % (red=empty → blue=full); everything else by
            // percentile class vs its own history.
            let color = LEVEL_COLORS[p.class] || '#9ca3af';
            if (p.fillPct != null) {
              color = p.fillPct < 25 ? '#b91c1c' : p.fillPct < 50 ? '#f59e0b'
                    : p.fillPct < 75 ? '#22c55e' : '#3b82f6';
            }
            const isLake = p.kind === 'lake' || p.kind === 'reservoir';
            const hasCapacity = p.fillPct != null || p.capacityKm3 != null;
            const mk = L.circleMarker([lat, lon], {
              radius: p.fillPct != null ? 8 : isLake ? 6 : 4,
              // gold outline = curated reservoir with capacity info
              color: hasCapacity ? '#eab308' : '#ffffff',
              weight: hasCapacity ? 2 : 1,
              fillColor: color, fillOpacity: 0.92,
              pane: 'markerPane',
            });
            let capBar = '';
            if (p.fillPct != null) {
              capBar = `<div style="margin:3px 0;">Est. capacity: <b>${p.fillPct}%</b>` +
                (p.estStorageKm3 != null ? ` (~${p.estStorageKm3} of ${p.capacityKm3} km³)` : '') +
                `<div style="width:140px;height:7px;background:#e5e7eb;border-radius:4px;overflow:hidden;">` +
                `<div style="width:${p.fillPct}%;height:100%;background:${color};"></div></div>` +
                `<span style="font-size:10px;color:#6b7280;">linear estimate of live-storage range</span></div>`;
            } else if (p.resName && (p.capacityKm3 != null || p.fslM != null || p.resNote)) {
              // matched reservoir but no computable fill % (missing min
              // level or gauge on a different datum) — show static facts
              capBar = `<div style="margin:3px 0;color:#6b7280;">` +
                (p.capacityKm3 != null ? `Storage capacity: ${p.capacityKm3} km³` : '') +
                (p.capacityKm3 != null && p.fslM != null ? ' · ' : '') +
                (p.fslM != null ? `Full supply: ${p.fslM} m` : '') +
                (p.resNote ? `<div style="font-size:10px;">${eh(p.resNote)}</div>` : '') +
                `</div>`;
            }
            const lines = [
              `<b>${KIND_ICON[p.kind] || ''} ${eh(p.resName || p.name || p.id)}</b>` +
                (p.resOperator ? ` <span style="color:#6b7280;">· ${eh(p.resOperator)}</span>` : ''),
              capBar || null,
              p.level != null ? `Level: ${p.level.toLocaleString()} m${p.p50 != null && p.classBy === 'level' ? ` (median ${p.p50.toLocaleString()} m)` : ''}` : null,
              p.discharge != null ? `Flow: ${p.discharge.toLocaleString()} m³/s` : null,
              p.class ? `Status: <b style="color:${LEVEL_COLORS[p.class]}">${LEVEL_LABELS[p.class] || p.class}</b>` +
                        (p.classBy === 'discharge' ? ' (by flow)' : '') :
                        (p.fillPct == null ? 'Status: no baseline' : null),
              ageLabel(p.time),
            ].filter(Boolean);
            mk.bindTooltip(lines.join('<br>'), { sticky: true });
            if (p.src === 'eccc' || capBar) {
              mk.on('click', () => {
                const div = document.createElement('div');
                div.innerHTML =
                  `<b>${eh(p.resName || p.name || p.id)}</b>` +
                  (p.resOperator ? `<div style="color:#6b7280;font-size:11px;">${eh(p.resOperator)}</div>` : '') +
                  capBar +
                  (p.level != null ? `<div>Level: ${p.level.toLocaleString()} m</div>` : '') +
                  (p.src === 'eccc' ? `<div class="spark">loading 24 h history…</div>` : '');
                mk.bindPopup(div, { minWidth: 230 }).openPopup();
                const spark = div.querySelector('.spark');
                if (spark) levelSparkline(p.id, spark);
              });
            }
            mk.addTo(levelGroup);
          });
          const when = gj.generated ? new Date(gj.generated).toLocaleString() : '?';
          const failed = (gj.sources_failed || []).length
            ? ` · ${gj.sources_failed.join(',')} unavailable` : '';
          setLvlStatus(`${(gj.features || []).length.toLocaleString()} stations · updated ${when}${failed}`);
        } catch (e) {
          levelsLoaded = false;
          setLvlStatus(`water levels: ${e.message}`);
          console.warn('[water] levels load failed', e);
        }
      }

      // ---- sub-toggle state (Rivers / Water levels) ----
      const visible = { rivers: true, levels: true };
      function applyVisibility() {
        if (!mapRef) return;
        [coarseGroup, osmGroup].forEach(g => {
          if (visible.rivers && !mapRef.hasLayer(g)) g.addTo(mapRef);
          if (!visible.rivers && mapRef.hasLayer(g)) mapRef.removeLayer(g);
        });
        if (visible.rivers && mapRef.getZoom() >= STREAM_ZOOM) {
          if (!mapRef.hasLayer(streamGroup)) streamGroup.addTo(mapRef);
        } else if (mapRef.hasLayer(streamGroup)) {
          mapRef.removeLayer(streamGroup);
        }
        if (visible.levels) {
          if (!mapRef.hasLayer(levelGroup)) levelGroup.addTo(mapRef);
          loadLevels();
        } else if (mapRef.hasLayer(levelGroup)) {
          mapRef.removeLayer(levelGroup);
        }
      }

      // ---- basin polygons (always visible) ----
      basins.forEach(b => {
        b._polys.forEach(poly => {
          L.polygon(poly, {
            color: b.color, weight: 1.2, opacity: 0.85,
            fillColor: b.color, fillOpacity: 0.14,
            interactive: true, pane: 'overlayPane'
          }).bindTooltip(b.name, { sticky: true }).addTo(basinGroup);
        });
      });

      // ---- coarse named-river backbone (always visible) ----
      data.rivers.forEach(r => {
        const c = colorById[r.basin] || '#1d4ed8';
        const q = data.discharge?.[r.name];
        L.polyline(r.path, {
          color: c, weight: flowWidth(q), opacity: 0.6, interactive: true
        })
        .bindTooltip(`<b>${r.name} River</b>${q ? `<br>~${q.toLocaleString()} m³/s mean flow` : ''}`, { sticky: true })
        .addTo(coarseGroup);
      });

      // ---- OSM detailed geometry (Canada-only via area filter) ----
      function tileCells(m, deg, prefix) {
        const b = m.getBounds();
        const s = Math.floor(b.getSouth() / deg) * deg;
        const n = Math.ceil(Math.min(b.getNorth(), 83.2) / deg) * deg;
        const w = Math.floor(Math.max(b.getWest(), -141) / deg) * deg;
        const e = Math.ceil(Math.min(b.getEast(), -52) / deg) * deg;
        const cells = [];
        for (let la = s; la < n; la += deg) {
          for (let lo = w; lo < e; lo += deg) {
            // Skip tiles whose centre falls outside the stepped Canada envelope.
            if (!inCanadaEnvelope(la + deg/2, lo + deg/2)) continue;
            // Clip tile's south edge up to the local border.
            const ts = Math.max(la, southBoundAt(lo + deg/2) - 0.2);
            cells.push({ s: ts, w: lo, n: la + deg, e: lo + deg, key: `${prefix}${la}_${lo}` });
          }
        }
        const c = m.getCenter();
        cells.sort((a, b) =>
          (Math.abs((a.s+a.n)/2 - c.lat) + Math.abs((a.w+a.e)/2 - c.lng)) -
          (Math.abs((b.s+b.n)/2 - c.lat) + Math.abs((b.w+b.e)/2 - c.lng)));
        return cells;
      }
      const viewportCells = m => tileCells(m, CELL_DEG, 'r');

      let backoffUntil = 0;
      let mirrorIdx = 0;

      async function overpass(query) {
        let lastErr;
        for (let attempt = 0; attempt < OVERPASS_URLS.length; attempt++) {
          const url = OVERPASS_URLS[(mirrorIdx + attempt) % OVERPASS_URLS.length];
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: 'data=' + encodeURIComponent(query)
            });
            if (res.status === 429 || res.status === 504) {
              lastErr = new Error(`HTTP ${res.status}`);
              lastErr.status = res.status;
              continue;  // try next mirror
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            mirrorIdx = (mirrorIdx + attempt) % OVERPASS_URLS.length;  // stick with working mirror
            return await res.json();
          } catch (e) { lastErr = e; }
        }
        if (lastErr?.status === 429) backoffUntil = Date.now() + 30000;
        throw lastErr || new Error('Overpass unreachable');
      }

      const sleep = ms => new Promise(r => setTimeout(r, ms));

      function renderOsmElements(elements) {
        let added = 0;
        elements.forEach(el => {
          if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) return;
          const latlngs = el.geometry.map(g => [g.lat, g.lon]);
          const mid = latlngs[Math.floor(latlngs.length / 2)];
          if (!inCanadaEnvelope(mid[0], mid[1])) return;
          const basin = basinFor(mid[0], mid[1], basins);
          const color = basin ? basin.color : '#1d4ed8';
          const name = el.tags?.name || el.tags?.['name:en'] || '';
          const q = nameMatchDischarge(name, data.discharge || {});
          L.polyline(latlngs, {
            color, weight: flowWidth(q), opacity: 0.92, interactive: true
          })
          .bindTooltip(
            `<b>${eh(name) || 'Unnamed river'}</b>` +
            (basin ? `<br>${eh(basin.name)}` : '') +
            (q ? `<br>~${q.toLocaleString()} m³/s mean flow` : ''),
            { sticky: true }
          )
          .addTo(osmGroup);
          added++;
        });
        return added;
      }

      async function loadOsmForViewport(m) {
        if (Date.now() < backoffUntil) {
          setStatus(`Overpass rate-limited — retry in ${Math.ceil((backoffUntil-Date.now())/1000)}s`);
          return;
        }
        const cells = viewportCells(m).filter(c => !cellCache[c.key]).slice(0, MAX_CELLS_PER_FETCH);
        if (!cells.length || inflight > 0) return;
        inflight++;
        try {
          for (const c of cells) {
            setStatus(`Loading rivers ${c.key}… (${osmGroup.getLayers().length} segments)`);
            const q = `[out:json][timeout:40];` +
                      `way["waterway"="river"](${c.s},${c.w},${c.n},${c.e});out tags geom;`;
            try {
              const json = await overpass(q);
              renderOsmElements(json.elements || []);
              cellCache[c.key] = true;
            } catch (e) {
              console.warn('[water] Overpass cell failed', c.key, e.message);
              setStatus(`Overpass: ${e.message} — will retry`);
              if (e.status === 429) break;
            }
            await sleep(REQUEST_GAP_MS);
          }
          setStatus(`${osmGroup.getLayers().length.toLocaleString()} river segments · ` +
                    `${streamGroup.getLayers().length.toLocaleString()} streams`);
        } finally {
          inflight--;
        }
      }

      const streamCells = m => tileCells(m, STREAM_CELL_DEG, 's');

      async function loadStreamsForViewport(m) {
        if (Date.now() < backoffUntil) {
          setStatus(`Overpass rate-limited — retry in ${Math.ceil((backoffUntil-Date.now())/1000)}s`);
          return;
        }
        const cells = streamCells(m).filter(c => !streamCache[c.key]).slice(0, MAX_CELLS_PER_FETCH);
        if (!cells.length || inflight > 0) return;
        inflight++;
        try {
          for (const c of cells) {
            setStatus(`Loading streams ${c.key}…`);
            const q = `[out:json][timeout:40];` +
                      `way["waterway"~"^(river|stream)$"](${c.s},${c.w},${c.n},${c.e});out tags geom;`;
            try {
              const json = await overpass(q);
              (json.elements || []).forEach(el => {
                if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) return;
                const ll = el.geometry.map(g => [g.lat, g.lon]);
                const mid = ll[Math.floor(ll.length / 2)];
                if (!inCanadaEnvelope(mid[0], mid[1])) return;
                const basin = basinFor(mid[0], mid[1], basins);
                const isStream = (el.tags?.waterway === 'stream');
                L.polyline(ll, {
                  color: basin ? basin.color : '#1d4ed8',
                  weight: isStream ? 0.8 : flowWidth(nameMatchDischarge(el.tags?.name, data.discharge || {})),
                  opacity: isStream ? 0.6 : 0.92, interactive: !isStream
                }).addTo(isStream ? streamGroup : osmGroup);
              });
              streamCache[c.key] = true;
            } catch (e) {
              console.warn('[water] stream cell failed', c.key, e.message);
              setStatus(`Overpass: ${e.message} — will retry`);
              if (e.status === 429) break;
            }
            await sleep(REQUEST_GAP_MS);
          }
          setStatus(`${osmGroup.getLayers().length.toLocaleString()} rivers · ` +
                    `${streamGroup.getLayers().length.toLocaleString()} streams`);
        } finally { inflight--; }
      }

      function refresh(m) {
        const z = m.getZoom();
        if (visible.rivers && z >= STREAM_ZOOM) {
          if (!m.hasLayer(streamGroup)) streamGroup.addTo(m);
          loadStreamsForViewport(m);
        } else if (m.hasLayer(streamGroup)) {
          // keep loaded but hide at low zoom (too noisy)
          m.removeLayer(streamGroup);
        }
        if (visible.rivers && !staticRiversLoaded && z >= OSM_ZOOM) {
          if (!m.hasLayer(osmGroup)) osmGroup.addTo(m);
          loadOsmForViewport(m);
        }
      }

      return {
        controls() {
          const wrap = document.createElement('div');
          [['rivers', '🏞 Rivers'], ['levels', '📏 Water levels']].forEach(([k, label]) => {
            const lab = document.createElement('label');
            lab.className = 'mapmode-sub-item';
            lab.innerHTML = `<input type="checkbox" ${visible[k] ? 'checked' : ''}> ${label}`;
            lab.querySelector('input').onchange = e => { visible[k] = e.target.checked; applyVisibility(); };
            wrap.appendChild(lab);
          });
          return wrap;
        },
        mount(m) {
          mapRef = m;
          basinGroup.addTo(m);
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(data.basins); return d; };
          legendCtl.addTo(m);
          applyVisibility();
          tryLoadStaticRivers().then(() => refresh(m));
        },
        unmount(m) {
          [basinGroup, coarseGroup, osmGroup, streamGroup, levelGroup].forEach(g => { if (m.hasLayer(g)) m.removeLayer(g); });
          osmGroup.clearLayers();
          streamGroup.clearLayers();
          levelGroup.clearLayers();
          levelsLoaded = false;
          Object.keys(cellCache).forEach(k => delete cellCache[k]);
          Object.keys(streamCache).forEach(k => delete streamCache[k]);
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
          mapRef = null;
        },
        refresh
      };
    }
  });
})();
