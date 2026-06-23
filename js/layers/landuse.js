/**
 * Land-use overlay.
 *
 * Sources (sub-toggle radio):
 *  • AAFC Annual Crop Inventory (default) — 30 m, 75 crop/land-use classes.
 *    ESRI ImageServer exportImage. Click-to-identify pixel class.
 *  • NRCan Land Cover 2020 — 30 m, broad classes. WMS.
 *  • Livestock density — 2021 Census of Agriculture choropleth by census
 *    division (cattle / pigs / sheep / poultry; head or head/km²).
 *    Static data/canada-livestock.geojson built by scripts/fetch_livestock.py.
 *
 * All work on GitHub Pages (image tiles or static GeoJSON).
 */

(function () {
  const ACI_YEAR = 2024;
  const ACI_BASE = `https://agriculture.canada.ca/imagery-images/rest/services/annual_crop_inventory/${ACI_YEAR}/ImageServer`;
  const NRCAN_WMS = 'https://datacube.services.geo.ca/ows/landcover';

  // ---- ACI image layer ----------------------------------------------------

  const EsriImageLayer = L.Layer.extend({
    initialize(url, opts) {
      this._url = url;
      L.setOptions(this, Object.assign({ opacity: 0.65, format: 'png8' }, opts));
    },
    onAdd(map) {
      this._map = map;
      this._img = L.DomUtil.create('img', 'leaflet-image-layer landuse-img');
      this._img.crossOrigin = 'anonymous';
      this._img.style.opacity = this.options.opacity;
      this._img.style.pointerEvents = 'none';
      map.getPane('overlayPane').appendChild(this._img);
      map.on('moveend zoomend resize', this._update, this);
      this._update();
    },
    getImage() { return this._img; },
    onRemove(map) {
      map.off('moveend zoomend resize', this._update, this);
      if (this._img && this._img.parentNode) this._img.parentNode.removeChild(this._img);
      this._img = null;
    },
    setOpacity(o) { this.options.opacity = o; if (this._img) this._img.style.opacity = o; },
    _update() {
      if (!this._map || !this._img) return;
      const m = this._map, sz = m.getSize(), b = m.getBounds();
      const sw = L.CRS.EPSG3857.project(b.getSouthWest());
      const ne = L.CRS.EPSG3857.project(b.getNorthEast());
      const url = `${this._url}/exportImage?f=image&format=${this.options.format}` +
        `&transparent=true&bboxSR=3857&imageSR=3857` +
        `&size=${sz.x},${sz.y}&bbox=${sw.x},${sw.y},${ne.x},${ne.y}`;
      const tl = m.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._img, tl);
      this._img.style.width = sz.x + 'px';
      this._img.style.height = sz.y + 'px';
      this._img.src = url;
    },
  });

  let aciLegend = null;
  async function loadAciLegend() {
    if (aciLegend) return aciLegend;
    try {
      const r = await fetch(`${ACI_BASE}/legend?f=json`);
      const j = await r.json();
      aciLegend = {};
      (j.layers?.[0]?.legend || []).forEach(item => {
        (item.values || []).forEach(v => { aciLegend[String(v)] = item.label; });
        if (item.label && !item.values) aciLegend[item.label] = item.label;
      });
    } catch (e) { console.warn('[landuse] legend fetch failed', e); aciLegend = {}; }
    return aciLegend;
  }

  async function identifyAci(latlng) {
    const p = L.CRS.EPSG3857.project(latlng);
    const url = `${ACI_BASE}/identify?f=json&geometryType=esriGeometryPoint` +
      `&geometry={"x":${p.x},"y":${p.y},"spatialReference":{"wkid":3857}}` +
      `&returnPixelValues=true&returnCatalogItems=false`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return j.value ?? (j.properties?.Values?.[0]) ?? (j.results?.[0]?.value);
  }

  // ---- Livestock heatmap --------------------------------------------------

  const LIVESTOCK_METRICS = {
    cattle:  { label: '🐄 Cattle',  glyph: '🐄',
               gradient: { 0.10:'#fef3c7', 0.25:'#fde68a', 0.45:'#fbbf24', 0.65:'#f59e0b', 0.82:'#d97706', 1:'#7c2d12' } },
    pigs:    { label: '🐖 Pigs',    glyph: '🐖',
               gradient: { 0.10:'#fce7f3', 0.25:'#fbcfe8', 0.45:'#f472b6', 0.65:'#ec4899', 0.82:'#db2777', 1:'#831843' } },
    sheep:   { label: '🐑 Sheep',   glyph: '🐑',
               gradient: { 0.10:'#e0e7ff', 0.25:'#c7d2fe', 0.45:'#818cf8', 0.65:'#6366f1', 0.82:'#4f46e5', 1:'#1e1b4b' } },
    poultry: { label: '🐔 Poultry', glyph: '🐔',
               gradient: { 0.10:'#fef9c3', 0.25:'#fef08a', 0.45:'#fde047', 0.65:'#facc15', 0.82:'#ca8a04', 1:'#713f12' } },
  };

  function fmtNum(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
    return n.toLocaleString();
  }

  // ---- Cursor-following tooltip ------------------------------------------

  function makeCursorTip() {
    const el = document.createElement('div');
    el.className = 'lu-cursor-tip';
    el.style.display = 'none';
    document.body.appendChild(el);
    return {
      el,
      show(x, y, html) {
        el.innerHTML = html;
        el.style.left = (x + 14) + 'px';
        el.style.top = (y + 14) + 'px';
        el.style.display = 'block';
      },
      hide() { el.style.display = 'none'; },
      remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    };
  }

  // Pixel-colour sampler for raster overlays (ACI/NRCan).
  // Reads the overlay's pixel under the cursor; matches to nearest legend
  // colour. Falls back to a debounced ImageServer `identify` for ACI when
  // the canvas can't be read (cross-origin taint).
  function makeRasterSampler(getKey, getOverlayEl, identifyFn) {
    let canvas = null, ctx = null, lastImg = null;
    let identifyTimer = null, lastIdentLatLng = null, lastIdentLabel = null;

    function ensureCanvas(img) {
      if (lastImg === img && canvas) return true;
      try {
        canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        // probe — throws if tainted
        ctx.getImageData(0, 0, 1, 1);
        lastImg = img;
        return true;
      } catch (e) {
        canvas = null; ctx = null; lastImg = null;
        return false;
      }
    }

    function hexToRgb(h) {
      const n = parseInt(h.replace('#',''), 16);
      return [(n>>16)&255, (n>>8)&255, n&255];
    }
    function nearestLabel(r, g, b, key) {
      let best = null, bestD = Infinity;
      for (const [hex, label] of key) {
        const [hr, hg, hb] = hexToRgb(hex);
        const d = (r-hr)*(r-hr) + (g-hg)*(g-hg) + (b-hb)*(b-hb);
        if (d < bestD) { bestD = d; best = { hex, label, d }; }
      }
      return best;
    }

    return {
      sample(containerPoint, latlng, cb) {
        const img = getOverlayEl();
        if (img && img.tagName === 'IMG' && img.complete && ensureCanvas(img)) {
          // Map container px → image px (image fills the map container 1:1)
          const x = Math.round(containerPoint.x * (canvas.width / img.clientWidth));
          const y = Math.round(containerPoint.y * (canvas.height / img.clientHeight));
          if (x >= 0 && y >= 0 && x < canvas.width && y < canvas.height) {
            const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
            if (a < 20) { cb(null); return; }
            const m = nearestLabel(r, g, b, getKey());
            cb(m ? { label: m.label, hex: m.hex, via: 'pixel' } : null);
            return;
          }
        }
        // Fallback: debounced identify (ACI only)
        if (identifyFn) {
          if (lastIdentLatLng && Math.abs(lastIdentLatLng.lat - latlng.lat) < 1e-4 &&
              Math.abs(lastIdentLatLng.lng - latlng.lng) < 1e-4) {
            cb(lastIdentLabel ? { label: lastIdentLabel, via: 'identify' } : null);
            return;
          }
          if (identifyTimer) clearTimeout(identifyTimer);
          cb({ label: '…', via: 'pending' });
          identifyTimer = setTimeout(async () => {
            try {
              const label = await identifyFn(latlng);
              lastIdentLatLng = latlng; lastIdentLabel = label;
              cb(label ? { label, via: 'identify' } : null);
            } catch { cb(null); }
          }, 220);
        } else {
          cb(null);
        }
      },
      reset() { canvas = null; ctx = null; lastImg = null; lastIdentLabel = null; },
    };
  }

  function makeLivestockLayer() {
    const data = window.CANADA_LIVESTOCK;
    const enabled = { cattle: true, pigs: false, sheep: false, poultry: false };
    let useDensity = false;
    let intensity = 0.7;
    let mapRef = null;
    let zoomHandler = null;

    // One heatLayer per animal so they can stack with distinct gradients.
    const layers = {};         // metric → L.heatLayer
    const maxVal = {};         // metric → max value (for legend)
    const pointCache = {};     // `${metric}|${useDensity}` → [[lat,lon,w],…]

    // Deterministic sunflower scatter inside an ellipse approximating the
    // CD's footprint. Spreading each CD's weight across many sub-points
    // makes neighbouring CDs' kernels overlap → continuous surface that
    // holds together when you zoom in, instead of isolated centroid dots.
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    function scatter(d, weight) {
      const area = d.area || 2000;                         // km²
      const rKm = Math.min(220, Math.sqrt(area / Math.PI)); // equivalent-circle radius
      const dLat = rKm / 111;
      const dLon = rKm / (111 * Math.cos(d.lat * Math.PI / 180) || 1);
      // 8–40 sub-points scaled by area; weight is split evenly.
      const n = Math.max(8, Math.min(40, Math.round(area / 1500) + 8));
      const w = weight / n;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const r = Math.sqrt((i + 0.5) / n);
        const th = i * GOLDEN;
        pts.push([d.lat + r * Math.sin(th) * dLat, d.lon + r * Math.cos(th) * dLon, w]);
      }
      return pts;
    }

    function value(d, metric) {
      const v = d[metric];
      if (v == null) return null;
      return useDensity && d.area ? v / d.area : v;
    }

    function buildPoints(metric) {
      const cacheKey = `${metric}|${useDensity?1:0}`;
      if (pointCache[cacheKey]) return pointCache[cacheKey];
      const vals = data.divisions.map(d => value(d, metric)).filter(v => v != null && v > 0);
      maxVal[metric] = vals.length ? Math.max(...vals) : 1;
      const exp = 0.6;
      const pts = [];
      data.divisions.forEach(d => {
        const v = value(d, metric);
        if (v == null || v <= 0) return;
        const w = Math.pow(v / maxVal[metric], exp);
        scatter(d, w).forEach(p => pts.push(p));
      });
      pointCache[cacheKey] = pts;
      return pts;
    }

    function radiusForZoom(z) {
      // Larger kernel + more overlap from scatter → continuous field.
      return Math.max(22, Math.min(90, 16 + (z - 3) * 10));
    }

    function heatOptions(metric, z) {
      const r = radiusForZoom(z);
      // Scatter splits weight across n sub-points but their kernels overlap,
      // so the accumulated peak at a CD centroid ≈ its total weight (≤1 after
      // pow-scaling). Neighbour bleed adds a bit more. Setting `max` slightly
      // above 1 lets only the very top CDs saturate; everything else falls
      // along the gradient. The intensity slider compresses `max` to push
      // more area into the bright end.
      return {
        radius: r,
        blur: Math.max(8, r * 0.45),
        max: 1.4 - 0.7 * intensity,         // 0.7 → max≈0.91; slider→1 → max≈0.7
        minOpacity: 0.08 + 0.12 * intensity,
        maxZoom: 12,
        gradient: LIVESTOCK_METRICS[metric].gradient,
      };
    }

    function ensureLayer(metric) {
      if (layers[metric]) return layers[metric];
      if (!window.L || !L.heatLayer) return null;
      const z = mapRef.getZoom();
      const h = L.heatLayer(buildPoints(metric), heatOptions(metric, z));
      h.on('add', () => { if (h._canvas) h._canvas.classList.add('livestock-heat-canvas'); });
      layers[metric] = h;
      return h;
    }

    function syncLayers() {
      if (!mapRef) return;
      Object.keys(LIVESTOCK_METRICS).forEach(k => {
        const h = ensureLayer(k);
        if (!h) return;
        if (enabled[k]) { if (!mapRef.hasLayer(h)) h.addTo(mapRef); }
        else if (mapRef.hasLayer(h)) mapRef.removeLayer(h);
      });
    }

    function rebuildAll() {
      if (!mapRef) return;
      const z = mapRef.getZoom();
      Object.keys(LIVESTOCK_METRICS).forEach(k => {
        const h = layers[k];
        if (!h) return;
        h.setLatLngs(buildPoints(k));
        h.setOptions(heatOptions(k, z));
      });
    }

    function nearestCD(lat, lon) {
      if (!data) return null;
      let best = null, bestD = Infinity;
      for (const d of data.divisions) {
        if (!d.cattle && !d.pigs && !d.sheep && !d.poultry) continue;
        const dy = (d.lat - lat);
        const dx = (d.lon - lon) * Math.cos(lat * Math.PI / 180);
        const dist = dx*dx + dy*dy;
        if (dist < bestD) { bestD = dist; best = d; }
      }
      // Only return if cursor is plausibly within / near the CD's footprint
      if (!best) return null;
      const rDeg = Math.min(2.2, Math.sqrt((best.area || 2000) / Math.PI) / 111) + 0.3;
      return Math.sqrt(bestD) <= rDeg ? best : null;
    }

    function tooltipFor(d) {
      const rows = Object.entries(LIVESTOCK_METRICS)
        .filter(([k]) => enabled[k])
        .map(([k, m]) => {
          const v = d[k];
          const dens = (v != null && d.area) ? (v / d.area) : null;
          return `<div>${m.glyph} <b>${fmtNum(v)}</b>` +
            (dens != null ? ` <span style="opacity:0.7;font-size:10px;">(${dens.toFixed(1)}/km²)</span>` : '') +
            `</div>`;
        }).join('');
      return `<b>${eh(d.name)}</b> <span style="opacity:0.6;font-size:10px;">${eh(d.prov)} · CD ${eh(d.id)}</span>` +
             `<div style="margin-top:2px;">${rows || '<span style="opacity:0.6;">no enabled types</span>'}</div>`;
    }

    return {
      hoverInfo(latlng) {
        const d = nearestCD(latlng.lat, latlng.lng);
        return d ? tooltipFor(d) : null;
      },
      addTo(map) {
        if (!data) {
          console.warn('[landuse] CANADA_LIVESTOCK not loaded');
          if (typeof showSaveNotification === 'function')
            showSaveNotification('Livestock data not loaded', false);
          return;
        }
        mapRef = map;
        syncLayers();
        zoomHandler = () => {
          const z = map.getZoom();
          Object.entries(layers).forEach(([k, h]) => {
            const r = radiusForZoom(z);
            h.setOptions({ radius: r, blur: Math.max(8, r * 0.45) });
          });
        };
        map.on('zoomend', zoomHandler);
      },
      removeFrom(map) {
        if (zoomHandler) { map.off('zoomend', zoomHandler); zoomHandler = null; }
        Object.values(layers).forEach(h => { if (map.hasLayer(h)) map.removeLayer(h); });
        mapRef = null;
      },
      setEnabled(metric, on) { enabled[metric] = !!on; syncLayers(); },
      setDensity(d) {
        useDensity = d;
        Object.keys(pointCache).forEach(k => delete pointCache[k]);
        rebuildAll();
      },
      setOpacity(o) { intensity = o; rebuildAll(); },
      legendHTML() {
        const unit = useDensity ? 'head / km²' : 'head';
        const on = Object.keys(LIVESTOCK_METRICS).filter(k => enabled[k]);
        const ramps = (on.length ? on : ['cattle']).map(k => {
          const m = LIVESTOCK_METRICS[k];
          const stops = Object.entries(m.gradient)
            .map(([t, c]) => `<span style="background:${c}"></span>`).join('');
          return `<div style="margin:4px 0;">
            <div style="font-size:11px;">${m.glyph} ${m.label.replace(/^[^ ]+ /, '')}
              <span style="float:right;color:#6b7280;">max ${fmtNum(maxVal[k] ?? 0)}</span></div>
            <div class="temp-ramp">${stops}</div>
          </div>`;
        }).join('');
        return `<div class="overlay-legend">
          <div class="overlay-legend-title">🐄 Livestock ${useDensity ? 'density' : 'inventory'}
            <small>(StatCan 2021 CoA · ${unit})</small></div>
          ${ramps}
          <div class="wx-row" style="margin-top:6px;">Hover a hotspot for census-division counts</div>
        </div>`;
      },
      get enabled() { return enabled; },
      get useDensity() { return useDensity; },
    };
  }

  // ---- Static legend keys -------------------------------------------------

  const ACI_KEY = [
    ['#3b8ec4', 'Water'],          ['#a6a6a6', 'Urban / developed'],
    ['#cc6699', 'Shrubland'],      ['#e1e1e1', 'Exposed / barren'],
    ['#7aab76', 'Wetland / peat'], ['#ffff00', 'Pasture / forage'],
    ['#ffd37f', 'Cereals (wheat/barley/oats)'],
    ['#a87000', 'Spring wheat'],   ['#896054', 'Winter wheat'],
    ['#ffff7e', 'Corn'],           ['#cc9933', 'Soybeans'],
    ['#d6ff70', 'Canola / rapeseed'],
    ['#8c8cff', 'Pulses (lentils/peas/beans)'],
    ['#ff8a8a', 'Potatoes'],       ['#7d4c00', 'Fallow'],
    ['#d2b48c', 'Hay / alfalfa'],  ['#ff00ff', 'Orchard / vineyard / berry'],
    ['#006400', 'Coniferous forest'],
    ['#00a000', 'Broadleaf forest'],
    ['#00cc00', 'Mixed forest'],
  ];
  const NRCAN_KEY = [
    ['#003d00', 'Needleleaf forest'], ['#148c3d', 'Broadleaf forest'],
    ['#5c752b', 'Mixed forest'],      ['#b38a33', 'Shrubland'],
    ['#e1cf8a', 'Grassland'],         ['#e6ad58', 'Cropland'],
    ['#a6a6a6', 'Barren'],            ['#db2126', 'Urban'],
    ['#4c70a3', 'Water'],             ['#6ba38d', 'Wetland'],
    ['#ffffff', 'Snow / ice'],
  ];

  function rasterLegendHTML(source) {
    const key = source === 'aci' ? ACI_KEY : NRCAN_KEY;
    const rows = key.map(([c, l]) =>
      `<div class="legend-item"><span class="color-dot" style="background:${c}"></span>${l}</div>`
    ).join('');
    const title = source === 'aci'
      ? `🌾 Crop Inventory ${ACI_YEAR} <small>(AAFC, 30 m)</small>`
      : `🌳 Land Cover 2020 <small>(NRCan, 30 m)</small>`;
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">${title}</div>
      ${rows}
      <div class="wx-row" style="margin-top:6px;">Hover map to identify class under cursor</div>
    </div>`;
  }

  // ---- Mode definition ----------------------------------------------------

  MapModes.register({
    id: 'landuse',
    label: 'Land Use',
    icon: '🌾',
    build: () => {
      let mapRef = null, legendCtl = null;
      let current = 'aci';
      let livestockSubEl = null;
      let moveHandler = null, leaveHandler = null;

      const aciLayer = new EsriImageLayer(ACI_BASE, { opacity: 0.65 });
      const nrcanLayer = L.tileLayer.wms(NRCAN_WMS, {
        layers: 'landcover-2020', format: 'image/png', transparent: true,
        version: '1.3.0', crs: L.CRS.EPSG3857, opacity: 0.65,
        crossOrigin: 'anonymous',
        attribution: 'NRCan Land Cover 2020',
      });
      const livestock = makeLivestockLayer();
      const tip = makeCursorTip();

      const aciSampler = makeRasterSampler(
        () => ACI_KEY,
        () => aciLayer.getImage && aciLayer.getImage(),
        async (latlng) => {
          const [val, leg] = await Promise.all([identifyAci(latlng), loadAciLegend()]);
          return (val != null && leg[String(val)]) ? leg[String(val)] : (val != null ? `class ${val}` : null);
        }
      );

      // For NRCan WMS we sample the *composited* tile container element.
      // Leaflet WMS draws to <img> tiles in a positioned div; rather than
      // stitching them, we project the cursor lat/lon → which tile + offset.
      function nrcanSample(latlng, containerPoint, cb) {
        // Find the tile <img> covering this map point.
        const z = mapRef.getZoom();
        const tileSize = 256;
        const proj = mapRef.project(latlng, z);
        const tx = Math.floor(proj.x / tileSize), ty = Math.floor(proj.y / tileSize);
        const ox = Math.floor(proj.x - tx * tileSize), oy = Math.floor(proj.y - ty * tileSize);
        const key = `${tx}:${ty}:${z}`;
        const tiles = nrcanLayer._tiles || {};
        const t = tiles[key];
        if (!t || !t.el || !t.el.complete) { cb(null); return; }
        try {
          const c = document.createElement('canvas');
          c.width = c.height = tileSize;
          const cx = c.getContext('2d', { willReadFrequently: true });
          cx.drawImage(t.el, 0, 0);
          const [r, g, b, a] = cx.getImageData(ox, oy, 1, 1).data;
          if (a < 20) { cb(null); return; }
          // nearest in NRCAN_KEY
          let best = null, bestD = Infinity;
          for (const [hex, label] of NRCAN_KEY) {
            const n = parseInt(hex.slice(1), 16);
            const hr=(n>>16)&255, hg=(n>>8)&255, hb=n&255;
            const d = (r-hr)**2 + (g-hg)**2 + (b-hb)**2;
            if (d < bestD) { bestD = d; best = { hex, label }; }
          }
          cb(best);
        } catch (e) { cb(null); }
      }

      function legendHTML() {
        return current === 'livestock' ? livestock.legendHTML() : rasterLegendHTML(current);
      }

      function rebuildLegend() {
        if (!mapRef) return;
        if (legendCtl) mapRef.removeControl(legendCtl);
        legendCtl = L.control({ position: 'bottomleft' });
        legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
        legendCtl.addTo(mapRef);
      }

      function setSource(src) {
        if (!mapRef || src === current) { current = src; return; }
        if (current === 'aci') mapRef.removeLayer(aciLayer);
        else if (current === 'nrcan') mapRef.removeLayer(nrcanLayer);
        else if (current === 'livestock') livestock.removeFrom(mapRef);
        current = src;
        if (src === 'aci') { aciLayer.addTo(mapRef); aciSampler.reset(); }
        else if (src === 'nrcan') nrcanLayer.addTo(mapRef);
        else if (src === 'livestock') livestock.addTo(mapRef);
        if (livestockSubEl) livestockSubEl.style.display = (src === 'livestock') ? 'block' : 'none';
        tip.hide();
        rebuildLegend();
      }

      function onMouseMove(e) {
        const px = e.originalEvent.clientX, py = e.originalEvent.clientY;
        if (current === 'livestock') {
          const html = livestock.hoverInfo(e.latlng);
          if (html) tip.show(px, py, html); else tip.hide();
          return;
        }
        if (current === 'aci') {
          aciSampler.sample(e.containerPoint, e.latlng, (res) => {
            if (!res) { tip.hide(); return; }
            const sw = res.hex ? `<span class="lu-tip-swatch" style="background:${eh(res.hex)}"></span>` : '';
            tip.show(px, py, `${sw}${eh(res.label)}`);
          });
          return;
        }
        if (current === 'nrcan') {
          nrcanSample(e.latlng, e.containerPoint, (res) => {
            if (!res) { tip.hide(); return; }
            tip.show(px, py, `<span class="lu-tip-swatch" style="background:${eh(res.hex)}"></span>${eh(res.label)}`);
          });
          return;
        }
        tip.hide();
      }

      function setOpacity(o) {
        aciLayer.setOpacity(o);
        nrcanLayer.setOpacity(o);
        livestock.setOpacity(o);
      }


      function controls() {
        const wrap = document.createElement('div');
        const mkRadio = (val, label) => {
          const lab = document.createElement('label');
          lab.className = 'mapmode-sub-item';
          lab.innerHTML = `<input type="radio" name="lu-src" value="${val}" ${val===current?'checked':''}> ${label}`;
          lab.querySelector('input').onchange = () => setSource(val);
          return lab;
        };
        wrap.appendChild(mkRadio('aci', `🌾 Crops (AAFC ${ACI_YEAR})`));
        wrap.appendChild(mkRadio('nrcan', '🌳 Land cover (NRCan)'));
        wrap.appendChild(mkRadio('livestock', '🐄 Livestock (StatCan 2021)'));

        // Livestock sub-controls — checkboxes so layers can stack
        livestockSubEl = document.createElement('div');
        livestockSubEl.style.cssText = 'margin-left:18px;border-left:2px solid var(--panel-border);padding-left:8px;' +
          (current === 'livestock' ? '' : 'display:none;');
        Object.entries(LIVESTOCK_METRICS).forEach(([k, m]) => {
          const lab = document.createElement('label');
          lab.className = 'mapmode-sub-item';
          lab.innerHTML = `<input type="checkbox" value="${k}" ${livestock.enabled[k]?'checked':''}> ${m.label}`;
          lab.querySelector('input').onchange = (e) => {
            livestock.setEnabled(k, e.target.checked);
            rebuildLegend();
          };
          livestockSubEl.appendChild(lab);
        });
        const dlab = document.createElement('label');
        dlab.className = 'mapmode-sub-item';
        dlab.innerHTML = `<input type="checkbox" ${livestock.useDensity?'checked':''}> per km² (density)`;
        dlab.querySelector('input').onchange = (e) => { livestock.setDensity(e.target.checked); rebuildLegend(); };
        livestockSubEl.appendChild(dlab);
        wrap.appendChild(livestockSubEl);

        const opRow = document.createElement('div');
        opRow.className = 'mapmode-sub-item';
        opRow.innerHTML = `<span style="font-size:11px;width:50px;">Opacity</span>` +
          `<input type="range" min="0.2" max="1" step="0.05" value="0.65" style="flex:1;">`;
        opRow.querySelector('input').oninput = (e) => setOpacity(parseFloat(e.target.value));
        wrap.appendChild(opRow);
        return wrap;
      }

      return {
        mount(m) {
          mapRef = m;
          if (current === 'aci') aciLayer.addTo(m);
          else if (current === 'nrcan') nrcanLayer.addTo(m);
          else livestock.addTo(m);
          rebuildLegend();
          moveHandler = onMouseMove;
          leaveHandler = () => tip.hide();
          m.on('mousemove', moveHandler);
          m.on('mouseout', leaveHandler);
          m.on('movestart zoomstart', () => { tip.hide(); aciSampler.reset(); });
          loadAciLegend();
        },
        unmount(m) {
          if (m.hasLayer(aciLayer)) m.removeLayer(aciLayer);
          if (m.hasLayer(nrcanLayer)) m.removeLayer(nrcanLayer);
          livestock.removeFrom(m);
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
          if (moveHandler) { m.off('mousemove', moveHandler); moveHandler = null; }
          if (leaveHandler) { m.off('mouseout', leaveHandler); leaveHandler = null; }
          tip.hide();
          mapRef = null;
        },
        controls,
      };
    }
  });
})();
