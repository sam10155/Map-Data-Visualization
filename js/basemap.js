/**
 * Basemap selector + UI dark-mode + solar terminator overlay.
 *
 * Basemaps:
 *   default     — OpenStreetMap standard
 *   satellite   — Esri World Imagery (+ reference labels)
 *   nightlights — NASA GIBS VIIRS Black Marble (Earth at Night city-lights)
 *                 over Esri Dark Gray base (Black Marble only goes to z8)
 *   dark UI     — swaps to Esri Dark Gray Canvas (keyless, attribution-only)
 *
 * Extras (independent toggles):
 *   • 🌙 Dark UI — restyles panels/popups/legend
 *   • ☀️ Day/night terminator — live solar shadow polygon, updated every
 *     minute, computed client-side from the subsolar point.
 *
 * Choices persist via localStorage.
 */

(function () {
  // Stadia "Alidade Smooth Dark" — the CARTO-Dark-Matter-style look.
  // Free non-commercial tier (200k tiles/mo) authenticated by DOMAIN, not
  // an API key: register the site's domain at stadiamaps.com (free
  // account → property → add domain). localhost works with no signup.
  // (CARTO ended anonymous access 2026-08 — key-only, no hobby tier.)
  const STADIA_DARK = {
    url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    opts: { maxZoom: 20, minZoom: 3,
            attribution: '© Stadia Maps, © OpenMapTiles, © OpenStreetMap contributors' },
  };

  // Esri Dark Gray Canvas — keyless fallback if Stadia 401s (domain not
  // registered); also the base under the Night Lights overlay so Black
  // Marble browsing doesn't burn Stadia's free-tier tile budget.
  const ESRI_DARK = {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 16, minZoom: 3,
            attribution: '© Esri, HERE, Garmin, © OpenStreetMap contributors' },
    labels: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      opts: { maxZoom: 16, minZoom: 3, pane: 'overlayPane', opacity: 0.9 },
    },
  };

  const BASEMAPS = {
    default: {
      label: 'Default',
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { maxZoom: 19, minZoom: 3, attribution: '© OpenStreetMap contributors' },
      // Dark UI swaps the light OSM tiles for Stadia's dark style;
      // falls back to Esri Dark Gray automatically if Stadia 401s.
      dark: { url: STADIA_DARK.url, opts: STADIA_DARK.opts,
              fallback: { url: ESRI_DARK.url, opts: ESRI_DARK.opts, overlay: ESRI_DARK.labels } },
    },
    satellite: {
      label: 'Satellite',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opts: { maxZoom: 19, minZoom: 3, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      overlay: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
        opts: { maxZoom: 19, pane: 'overlayPane', opacity: 0.9 },
      },
    },
    nightlights: {
      label: 'Night Lights',
      // Esri dark canvas provides context at all zooms; Black Marble overlays on top.
      url: ESRI_DARK.url,
      opts: ESRI_DARK.opts,
      overlay: {
        url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
        opts: {
          maxNativeZoom: 8, maxZoom: 19, minZoom: 3,
          opacity: 0.95, pane: 'tilePane',
          attribution: 'NASA EOSDIS GIBS — VIIRS Black Marble',
        },
      },
      autoDark: true,
    },
  };

  let mapRef = null;
  let baseLayer = null;
  let baseOverlay = null;
  let current = localStorage.getItem('basemap') || 'default';
  if (!BASEMAPS[current]) current = 'default';
  let darkUI = localStorage.getItem('darkUI') === '1';
  let showTerminator = localStorage.getItem('terminator') === '1';

  // ---- Solar terminator ---------------------------------------------------
  // Subsolar point from current UTC time → great-circle night polygon.
  // Adapted from the standard NOAA solar-position approximation.

  let termGroup = null;
  let termTimer = null;

  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }

  function subsolarPoint(date) {
    // Days since J2000.0
    const jd = date.getTime() / 86400000 + 2440587.5;
    const n = jd - 2451545.0;
    // Mean longitude & anomaly of the Sun (deg)
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = rad((357.528 + 0.9856003 * n) % 360);
    // Ecliptic longitude
    const lambda = rad(L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
    // Obliquity of the ecliptic
    const eps = rad(23.439 - 0.0000004 * n);
    // Declination = subsolar latitude
    const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
    // Equation of time (minutes) → subsolar longitude
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    let eot = 4 * (((L % 360) - deg(ra) + 540) % 360 - 180);  // minutes
    const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    const subLon = -((utcMin + eot) / 4 - 180);  // deg E
    return { lat: deg(decl), lon: ((subLon + 540) % 360) - 180 };
  }

  // Latitude (rad) where solar altitude equals `alt` at hour angle H:
  //   sin(alt) = sinδ·sinφ + cosδ·cosφ·cosH  →  φ = asin(sin alt / R) − ψ
  // with R = √(sin²δ + (cosδ·cosH)²), ψ = atan2(cosδ·cosH, sinδ).
  // (alt = 0 reduces to the classic tanφ = −cosH/tanδ terminator.)
  function isolineLat(H, decl, alt) {
    const A = Math.sin(decl), B = Math.cos(decl) * Math.cos(H);
    const R = Math.hypot(A, B), psi = Math.atan2(B, A);
    const s = Math.min(1, Math.max(-1, Math.sin(alt) / (R || 1e-12)));
    return Math.asin(s) - psi;
  }

  function twilightPolygon(sp, altDeg) {
    // Polygon covering the region where the sun is below altDeg.
    const decl = rad(sp.lat);
    const pts = [];
    const STEP = 2;
    for (let lon = -180; lon <= 180; lon += STEP) {
      const H = rad(lon - sp.lon);
      const lat = Math.max(-89.99, Math.min(89.99, deg(isolineLat(H, decl, rad(altDeg)))));
      pts.push([lat, lon]);
    }
    // Close the polygon over whichever pole is in night.
    const polarLat = sp.lat >= 0 ? -90 : 90;
    pts.push([polarLat, 180], [polarLat, -180]);
    return pts;
  }

  function drawTerminator() {
    if (!mapRef || !termGroup) return;
    termGroup.clearLayers();
    const subsolar = subsolarPoint(new Date());

    // HOI4-style soft shadow: stacked twilight bands (sunset → civil →
    // nautical → astronomical → deep night), each adding a little more
    // darkness, so the shadow visibly deepens away from the sun line.
    const BANDS = [0, -3, -6, -9, -12, -15, -18];
    BANDS.forEach((alt, i) => {
      L.polygon(twilightPolygon(subsolar, alt), {
        stroke: i === 0, color: '#fde047', weight: 1, opacity: 0.45,
        fill: true, fillColor: '#0b1220', fillOpacity: i === 0 ? 0.10 : 0.075,
        interactive: false, pane: 'overlayPane',
      }).addTo(termGroup);
    });

    L.circleMarker([subsolar.lat, subsolar.lon], {
      radius: 7, color: '#fbbf24', weight: 2,
      fillColor: '#fde047', fillOpacity: 1, interactive: true,
    }).bindTooltip(
      `☀️ Subsolar point<br>${subsolar.lat.toFixed(2)}°, ${subsolar.lon.toFixed(2)}°<br>` +
      `<span style="font-size:10px;color:#9ca3af;">${new Date().toUTCString()}</span>`,
      { direction: 'top' }
    ).addTo(termGroup);
  }

  function setTerminator(on) {
    showTerminator = !!on;
    localStorage.setItem('terminator', showTerminator ? '1' : '0');
    if (!mapRef) return;
    if (showTerminator) {
      if (!termGroup) termGroup = L.layerGroup().addTo(mapRef);
      else if (!mapRef.hasLayer(termGroup)) termGroup.addTo(mapRef);
      drawTerminator();
      if (!termTimer) termTimer = setInterval(drawTerminator, 60000);
    } else {
      if (termTimer) { clearInterval(termTimer); termTimer = null; }
      if (termGroup) { termGroup.clearLayers(); if (mapRef.hasLayer(termGroup)) mapRef.removeLayer(termGroup); }
    }
    const cb = document.getElementById('terminatorToggle');
    if (cb) cb.checked = showTerminator;
  }

  // ---- Dark UI / basemap switching ---------------------------------------

  function applyDarkUI(on) {
    darkUI = !!on;
    document.body.classList.toggle('dark', darkUI);
    localStorage.setItem('darkUI', darkUI ? '1' : '0');
    const cb = document.getElementById('darkModeToggle');
    if (cb) cb.checked = darkUI;
    // Re-apply the basemap so tiles follow the theme (if it has a dark variant).
    if (mapRef && resolveTiles(BASEMAPS[current]).url !== loadedTileUrl) setBasemap(current);
  }

  function resolveTiles(def) {
    return (darkUI && def.dark) ? def.dark : def;
  }

  let loadedTileUrl = null;

  function setBasemap(id) {
    if (!mapRef || !BASEMAPS[id]) return;
    if (baseLayer) mapRef.removeLayer(baseLayer);
    if (baseOverlay) { mapRef.removeLayer(baseOverlay); baseOverlay = null; }

    const def = BASEMAPS[id];
    const tiles = resolveTiles(def);
    loadedTileUrl = tiles.url;
    baseLayer = L.tileLayer(tiles.url, tiles.opts).addTo(mapRef);
    baseLayer.setZIndex(0);
    const ov = tiles.overlay || def.overlay;
    if (ov) {
      baseOverlay = L.tileLayer(ov.url, ov.opts).addTo(mapRef);
      baseOverlay.setZIndex(1);
    }

    // Auth-gated tile sources (Stadia): if tiles keep erroring, swap to
    // the declared keyless fallback instead of showing a blank map.
    if (tiles.fallback) {
      let errs = 0;
      baseLayer.on('tileerror', () => {
        if (++errs < 4 || loadedTileUrl !== tiles.url) return;
        console.warn('[basemap] dark tiles failing (domain not registered with Stadia?) — falling back');
        const fb = tiles.fallback;
        mapRef.removeLayer(baseLayer);
        if (baseOverlay) { mapRef.removeLayer(baseOverlay); baseOverlay = null; }
        loadedTileUrl = fb.url;
        baseLayer = L.tileLayer(fb.url, fb.opts).addTo(mapRef);
        baseLayer.setZIndex(0);
        if (fb.overlay) {
          baseOverlay = L.tileLayer(fb.overlay.url, fb.overlay.opts).addTo(mapRef);
          baseOverlay.setZIndex(1);
        }
      });
    }

    current = id;
    localStorage.setItem('basemap', id);

    if (def.autoDark && localStorage.getItem('darkUI') == null) applyDarkUI(true);

    document.querySelectorAll('.basemap-option').forEach(b =>
      b.classList.toggle('active', b.dataset.basemap === id));
  }

  function init(map) {
    mapRef = map;
    setBasemap(current);
    applyDarkUI(darkUI);
    setTerminator(showTerminator);
  }

  function buildControls(container) {
    const sec = document.createElement('div');
    sec.className = 'section';
    sec.id = 'basemap-section';

    const opts = Object.entries(BASEMAPS).map(([id, d]) =>
      `<button class="agg-option basemap-option${id === current ? ' active' : ''}" data-basemap="${id}">${d.label}</button>`
    ).join('');

    sec.innerHTML = `
      <div class="section-title">🗺️ Basemap</div>
      <div class="aggregation-slider">${opts}</div>
      <label class="checkbox-item" style="margin-top:8px;">
        <input type="checkbox" id="terminatorToggle" ${showTerminator ? 'checked' : ''}>
        <span>☀️ Day/night terminator (live)</span>
      </label>
      <label class="checkbox-item">
        <input type="checkbox" id="darkModeToggle" ${darkUI ? 'checked' : ''}>
        <span>🌙 Dark UI</span>
      </label>
    `;

    sec.querySelectorAll('.basemap-option').forEach(b => {
      b.onclick = () => setBasemap(b.dataset.basemap);
    });
    sec.querySelector('#darkModeToggle').onchange = (e) => applyDarkUI(e.target.checked);
    sec.querySelector('#terminatorToggle').onchange = (e) => setTerminator(e.target.checked);

    container.prepend(sec);
  }

  window.Basemap = { init, buildControls, setBasemap, applyDarkUI, setTerminator, BASEMAPS };
})();
