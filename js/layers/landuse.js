/**
 * Land-use overlay.
 *
 * Sources (sub-toggle radio):
 *  • AAFC Annual Crop Inventory (default) — 30 m, 75 crop/land-use classes
 *    (wheat, canola, corn, soy, lentils, potatoes, pasture, forest, …).
 *    ESRI ImageServer exportImage, web-mercator. Updated annually.
 *  • NRCan Land Cover 2020 — 30 m, broad classes (forest, cropland,
 *    grassland, wetland, urban, water). WMS, web-mercator.
 *
 * Both are image-tile services → no CORS issues, work on GitHub Pages.
 *
 * Click-to-identify: AAFC `identify` returns the pixel value → crop class
 * name shown in a popup.
 */

(function () {
  const ACI_YEAR = 2024;
  const ACI_BASE = `https://agriculture.canada.ca/imagery-images/rest/services/annual_crop_inventory/${ACI_YEAR}/ImageServer`;
  const NRCAN_WMS = 'https://datacube.services.geo.ca/ows/landcover';

  // ---- Custom Leaflet layers --------------------------------------------

  // ESRI ImageServer exportImage as a single dynamic image per viewport.
  // (ImageServer isn't pre-tiled, so L.tileLayer doesn't apply.)
  const EsriImageLayer = L.Layer.extend({
    initialize(url, opts) {
      this._url = url;
      L.setOptions(this, Object.assign({ opacity: 0.65, format: 'png8' }, opts));
    },
    onAdd(map) {
      this._map = map;
      this._img = L.DomUtil.create('img', 'leaflet-image-layer landuse-img');
      this._img.style.opacity = this.options.opacity;
      this._img.style.pointerEvents = 'none';
      map.getPane('overlayPane').appendChild(this._img);
      map.on('moveend zoomend resize', this._update, this);
      this._update();
    },
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

  // ---- ACI class lookup (value → label/colour) for click-identify --------
  // Lazy-loaded from the ImageServer legend endpoint.
  let aciLegend = null;
  async function loadAciLegend() {
    if (aciLegend) return aciLegend;
    try {
      const r = await fetch(`${ACI_BASE}/legend?f=json`);
      const j = await r.json();
      aciLegend = {};
      (j.layers?.[0]?.legend || []).forEach(item => {
        // values come as "10", "20", "146", etc.
        (item.values || []).forEach(v => { aciLegend[String(v)] = item.label; });
        if (item.label && !item.values) aciLegend[item.label] = item.label;
      });
    } catch (e) {
      console.warn('[landuse] legend fetch failed', e);
      aciLegend = {};
    }
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
    const val = j.value ?? (j.properties?.Values?.[0]) ?? (j.results?.[0]?.value);
    return val;
  }

  // Curated short legend for the panel (full 75-class legend is in the
  // ImageServer GetLegendGraphic; here we show the major buckets).
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

  function legendHTML(source) {
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
      ${source === 'aci' ? '<div class="wx-row" style="margin-top:6px;">Click map to identify exact crop class</div>' : ''}
    </div>`;
  }

  MapModes.register({
    id: 'landuse',
    label: 'Land Use',
    icon: '🌾',
    build: () => {
      let mapRef = null, legendCtl = null, clickHandler = null;
      let current = 'aci';

      const aciLayer = new EsriImageLayer(ACI_BASE, { opacity: 0.65 });
      const nrcanLayer = L.tileLayer.wms(NRCAN_WMS, {
        layers: 'landcover-2020', format: 'image/png', transparent: true,
        version: '1.3.0', crs: L.CRS.EPSG3857, opacity: 0.65,
        attribution: 'NRCan Land Cover 2020',
      });

      function setSource(src) {
        if (!mapRef) { current = src; return; }
        if (src === current) return;
        if (current === 'aci') mapRef.removeLayer(aciLayer); else mapRef.removeLayer(nrcanLayer);
        current = src;
        (src === 'aci' ? aciLayer : nrcanLayer).addTo(mapRef);
        rebuildLegend();
      }

      function setOpacity(o) {
        aciLayer.setOpacity(o);
        nrcanLayer.setOpacity(o);
      }

      function rebuildLegend() {
        if (!legendCtl || !mapRef) return;
        mapRef.removeControl(legendCtl);
        legendCtl = L.control({ position: 'bottomleft' });
        legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(current); return d; };
        legendCtl.addTo(mapRef);
      }

      async function onClick(e) {
        if (current !== 'aci') return;
        try {
          const [val, leg] = await Promise.all([identifyAci(e.latlng), loadAciLegend()]);
          const label = (val != null && leg[String(val)]) ? leg[String(val)] : null;
          L.popup({ closeButton: true })
            .setLatLng(e.latlng)
            .setContent(
              `<b>🌾 Crop Inventory ${ACI_YEAR}</b><br>` +
              (label ? `<b>${label}</b>` : (val != null ? `Class value: ${val}` : 'No data')) +
              `<br><small>${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}</small>`
            )
            .openOn(mapRef);
        } catch (err) {
          console.warn('[landuse] identify failed', err);
        }
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
          (current === 'aci' ? aciLayer : nrcanLayer).addTo(m);
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(current); return d; };
          legendCtl.addTo(m);
          clickHandler = onClick;
          m.on('click', clickHandler);
          loadAciLegend();
        },
        unmount(m) {
          if (m.hasLayer(aciLayer)) m.removeLayer(aciLayer);
          if (m.hasLayer(nrcanLayer)) m.removeLayer(nrcanLayer);
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
          if (clickHandler) { m.off('click', clickHandler); clickHandler = null; }
          mapRef = null;
        },
        controls,
      };
    }
  });
})();
