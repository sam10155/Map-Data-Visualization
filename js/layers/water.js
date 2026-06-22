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
    if (lon < -95)  return 48.9;          // Prairies / BC: 49th parallel
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

  function legendHTML(basins) {
    const rows = basins.map(b =>
      `<div class="legend-item"><span class="color-dot" style="background:${b.color}"></span>${b.name}</div>`
    ).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">💧 Drainage Basins & Rivers</div>
      ${rows}
      <div class="wx-row" style="margin-top:6px;">— line width ∝ √(mean discharge m³/s)</div>
      <div class="wx-row">Zoom ≥ ${OSM_ZOOM}: detailed rivers · ≥ ${STREAM_ZOOM}: tributary streams (OSM)</div>
      <div class="wx-row" id="water-osm-status" style="color:#9ca3af;"></div>
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
              `<b>${name || 'Unnamed river'}</b>` +
              (basin ? `<br>${basin.name}` : '') +
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
            `<b>${name || 'Unnamed river'}</b>` +
            (basin ? `<br>${basin.name}` : '') +
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
        if (z >= STREAM_ZOOM) {
          if (!m.hasLayer(streamGroup)) streamGroup.addTo(m);
          loadStreamsForViewport(m);
        } else if (m.hasLayer(streamGroup)) {
          // keep loaded but hide at low zoom (too noisy)
          m.removeLayer(streamGroup);
        }
        if (!staticRiversLoaded && z >= OSM_ZOOM) {
          if (!m.hasLayer(osmGroup)) osmGroup.addTo(m);
          loadOsmForViewport(m);
        }
      }

      return {
        mount(m) {
          mapRef = m;
          basinGroup.addTo(m);
          coarseGroup.addTo(m);
          osmGroup.addTo(m);
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(data.basins); return d; };
          legendCtl.addTo(m);
          tryLoadStaticRivers().then(() => refresh(m));
        },
        unmount(m) {
          [basinGroup, coarseGroup, osmGroup, streamGroup].forEach(g => { if (m.hasLayer(g)) m.removeLayer(g); });
          osmGroup.clearLayers();
          streamGroup.clearLayers();
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
