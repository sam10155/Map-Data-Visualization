/**
 * 🛩️ Aviation Wx — upper-level winds + aerodrome/en-route products.
 *
 *  • Upper winds/temp: ECCC GeoMet WMS pressure-level rasters (keyless,
 *    CORS-open tiles, fetched direct) — GDPS 15 km, levels 850/700/500/250
 *    mb (≈ 5,000 ft / 10,000 ft / FL180 / FL340), forecast to +144 h in
 *    3 h steps via the WMS TIME dimension (time slider below).
 *  • METARs: NOAA Aviation Weather Center (global incl. all Canadian
 *    aerodromes) via the proxy (no CORS upstream). Dots coloured by
 *    flight category (VFR/MVFR/IFR/LIFR); TAF fetched on click.
 *    NOTE: one whole-Canada bbox silently truncates results — fetched as
 *    three bbox tiles instead.
 *  • SIGMETs: AWC international SIGMETs filtered to Canadian FIRs (CZ*),
 *    hazard-coloured polygons.
 *
 *  GeoMet layer names verified 2026-08 (naming migrated: GDPS_15km_*,
 *  not the old GDPS.PRES_* convention). Invalid TIME values return XML
 *  exceptions, so slider times snap to the 3 h step.
 */

(function () {
  const METAR_POLL_MS = 5 * 60000;   // AWC caches 60 s; 5 min is polite
  const MAX_FCST_H = 144;            // GDPS 3-hourly extent
  const STEP_H = 3;

  const LEVELS = [
    { mb: 850, label: '850 mb · ~5,000 ft' },
    { mb: 700, label: '700 mb · ~10,000 ft' },
    { mb: 500, label: '500 mb · FL180' },
    { mb: 250, label: '250 mb · FL340 (jet)' },
  ];

  const FLTCAT = {
    VFR:  { color: '#22c55e', label: 'VFR' },
    MVFR: { color: '#3b82f6', label: 'MVFR' },
    IFR:  { color: '#dc2626', label: 'IFR' },
    LIFR: { color: '#c026d3', label: 'LIFR' },
    UNK:  { color: '#9ca3af', label: 'no category' },
  };

  const HAZARD_COLORS = {
    TURB: '#f59e0b', ICE: '#38bdf8', ICING: '#38bdf8',
    TS: '#dc2626', CONVECTIVE: '#dc2626', VA: '#78350f', MTW: '#a855f7',
  };

  // Canada in 3 tiles — a single big bbox truncates AWC results.
  const AWC_TILES = ['41,-141,84,-95', '41,-95,62,-52', '62,-95,84,-52'];

  const GEOMET = 'https://geo.weather.gc.ca/geomet';

  function proxyBase() {
    let p = window.TRACKING_PROXY || '/proxy/';
    if (p && !p.endsWith('/')) p += '/';
    return p;
  }

  // Snap a Date + offset hours to the layer's 3 h validity step.
  function snapTime(offsetH) {
    const t = new Date();
    t.setUTCMinutes(0, 0, 0);
    t.setUTCHours(Math.floor(t.getUTCHours() / STEP_H) * STEP_H + offsetH);
    return t.toISOString().slice(0, 19) + 'Z';
  }

  // Wind-speed ramp sampled from GeoMet's WindSpeed_knots_0-200 style so
  // the legend matches the raster (calm → 200 kt).
  const WIND_RAMP = ['#e9f9d4','#95e32e','#b9e905','#fdf407','#fed803','#fcb502',
                     '#f98b02','#fc4a05','#e51d19','#ac0244','#7b026b','#6c1c92','#9a5fb6'];

  function legendHTML() {
    const cats = ['VFR', 'MVFR', 'IFR', 'LIFR'].map(k =>
      `<span class="avn-cat"><span class="color-dot" style="background:${FLTCAT[k].color}"></span>${k}</span>`
    ).join('');
    const ramp = WIND_RAMP.map(c => `<span style="background:${c}"></span>`).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">🛩️ Aviation Wx</div>
      <div class="legend-item">${cats}</div>
      <div class="legend-item"><span class="avn-cat"><span class="color-dot" style="background:#f59e0b"></span>turb</span>
        <span class="avn-cat"><span class="color-dot" style="background:#38bdf8"></span>icing</span>
        <span class="avn-cat"><span class="color-dot" style="background:#dc2626"></span>convective</span>
        <span style="color:#6b7280;font-size:10px;">(SIGMET)</span></div>
      <div class="temp-ramp">${ramp}</div>
      <div class="temp-labels"><span>0 kt</span><span>100</span><span>200 kt</span></div>
      <div class="wx-row" id="avn-status" style="color:#9ca3af;">⚪ loading…</div>
      <div class="wx-row">GeoMet GDPS · NOAA AWC · not for navigation</div>
    </div>`;
  }

  MapModes.register({
    id: 'aviation',
    label: 'Aviation Wx',
    icon: '🛩️',
    build: () => {
      const metarGroup = L.layerGroup();
      const sigmetGroup = L.layerGroup();
      const renderer = L.canvas({ padding: 0.3 });
      let windRaster = null, windBarbs = null, tempRaster = null;
      let legendCtl = null, mapRef = null, timer = null;
      let unmounted = false;

      const state = {
        level: 250,
        offsetH: 0,
        wind: true, temp: false, metars: true, sigmets: true,
      };

      const setStatus = html => {
        const el = document.getElementById('avn-status');
        if (el) el.innerHTML = html || '';
      };

      // ---- WMS rasters ----
      function wmsLayer(name, style, opacity) {
        return L.tileLayer.wms(GEOMET, {
          layers: name, styles: style, format: 'image/png',
          transparent: true, version: '1.3.0', opacity,
          time: snapTime(state.offsetH),
          attribution: 'ECCC GeoMet (GDPS)',
        });
      }

      function rebuildRasters() {
        if (!mapRef) return;
        [windRaster, windBarbs, tempRaster].forEach(l => {
          if (l && mapRef.hasLayer(l)) mapRef.removeLayer(l);
        });
        windRaster = windBarbs = tempRaster = null;
        const lvl = state.level;
        if (state.wind) {
          windRaster = wmsLayer(`GDPS_15km_WindSpeed_${lvl}mb`, 'WindSpeed_knots_0-200', 0.55).addTo(mapRef);
          windBarbs = wmsLayer(`GDPS_15km_Winds_${lvl}mb`, 'WindBarbs_knots', 0.9).addTo(mapRef);
        }
        if (state.temp) {
          tempRaster = wmsLayer(`GDPS_15km_AirTemp_${lvl}mb`, 'TEMPERATURE', 0.5).addTo(mapRef);
        }
        updateStatus();
      }

      function retimeRasters() {
        const time = snapTime(state.offsetH);
        [windRaster, windBarbs, tempRaster].forEach(l => l && l.setParams({ time }));
        updateStatus();
      }

      function updateStatus(extra) {
        const t = snapTime(state.offsetH);
        const local = new Date(t).toLocaleString(undefined,
          { weekday: 'short', hour: '2-digit', minute: '2-digit' });
        setStatus(`🟢 ${state.level} mb · ${state.offsetH === 0 ? 'now' : '+' + state.offsetH + ' h'} (${local})` +
                  (extra ? `<br>${extra}` : `<br><span id="avn-status2"></span>`));
      }
      const setStatus2 = html => {
        const el = document.getElementById('avn-status2');
        if (el) el.innerHTML = html || '';
      };

      // ---- METARs (via proxy, 3-tile fetch) ----
      async function loadMetars() {
        if (!state.metars || unmounted) return;
        try {
          const results = await Promise.allSettled(AWC_TILES.map(async b => {
            const res = await fetch(`${proxyBase()}aviationweather.gov/api/data/metar?bbox=${b}&format=json`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          }));
          const seen = new Set();
          metarGroup.clearLayers();
          let n = 0;
          results.forEach(r => {
            if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
            r.value.forEach(m => {
              if (!m.icaoId || seen.has(m.icaoId) || m.lat == null) return;
              seen.add(m.icaoId);
              const cat = FLTCAT[m.fltCat] || FLTCAT.UNK;
              const mk = L.circleMarker([m.lat, m.lon], {
                renderer, radius: 5, color: '#ffffff', weight: 1,
                fillColor: cat.color, fillOpacity: 0.95,
              }).bindTooltip(
                `<b>🛩️ ${eh(m.icaoId)}</b> · <b style="color:${cat.color}">${cat.label}</b>` +
                (m.name ? `<br>${eh(String(m.name).split(',')[0])}` : '') +
                (m.temp != null ? `<br>${m.temp}°C` : '') +
                (m.wdir != null && m.wspd != null ? ` · wind ${m.wdir}°/${m.wspd} kt` : '') +
                (m.visib != null ? ` · vis ${eh(String(m.visib))} SM` : ''),
                { sticky: true });
              mk.on('click', () => openMetarPopup(mk, m));
              mk.addTo(metarGroup);
              n++;
            });
          });
          setStatus2(`🟢 ${n} METARs` + (state.sigmets ? '' : ' · SIGMETs off'));
        } catch (e) {
          setStatus2(`🔴 METARs: ${eh(e.message)}`);
        }
      }

      async function openMetarPopup(mk, m) {
        const div = document.createElement('div');
        div.innerHTML = `<b>${eh(m.icaoId)}${m.name ? ' — ' + eh(String(m.name).split(',')[0]) : ''}</b>` +
          `<div style="font-family:monospace;font-size:10px;max-width:280px;white-space:pre-wrap;">${eh(m.rawOb || '')}</div>` +
          `<div class="avn-taf" style="font-size:10px;color:#6b7280;">loading TAF…</div>`;
        mk.bindPopup(div, { minWidth: 260 }).openPopup();
        try {
          const res = await fetch(`${proxyBase()}aviationweather.gov/api/data/taf?ids=${encodeURIComponent(m.icaoId)}&format=json`);
          const tafs = await res.json();
          const raw = Array.isArray(tafs) && tafs[0]?.rawTAF;
          div.querySelector('.avn-taf').innerHTML = raw
            ? `<b>TAF</b><div style="font-family:monospace;white-space:pre-wrap;">${eh(raw)}</div>`
            : 'no TAF issued';
        } catch {
          div.querySelector('.avn-taf').textContent = 'TAF unavailable';
        }
      }

      // ---- SIGMETs (Canadian FIRs) ----
      async function loadSigmets() {
        if (!state.sigmets || unmounted) return;
        try {
          const res = await fetch(`${proxyBase()}aviationweather.gov/api/data/isigmet?format=json`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const all = await res.json();
          sigmetGroup.clearLayers();
          let n = 0;
          (Array.isArray(all) ? all : []).forEach(s => {
            if (!/^CZ/.test(s.firId || '') || !Array.isArray(s.coords) || s.coords.length < 3) return;
            const hazard = String(s.hazard || '').toUpperCase();
            const color = HAZARD_COLORS[hazard.split(' ').pop()] ||
                          HAZARD_COLORS[hazard] || '#f59e0b';
            L.polygon(s.coords.map(c => [c.lat, c.lon]), {
              color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.12,
            }).bindTooltip(
              `<b>⚠️ SIGMET ${eh(s.firId)}</b> · ${eh(s.hazard || '')}` +
              (s.base != null || s.top != null ? `<br>FL${s.base ?? '?'}–FL${s.top ?? '?'}` : '') +
              `<div style="font-family:monospace;font-size:9px;max-width:280px;white-space:pre-wrap;">${eh(s.rawSigmet || '')}</div>`,
              { sticky: true }).addTo(sigmetGroup);
            n++;
          });
          if (n === 0 && state.metars === false) setStatus2('⚪ no active Canadian SIGMETs');
        } catch (e) {
          setStatus2(`🔴 SIGMETs: ${eh(e.message)}`);
        }
      }

      function applyVisibility() {
        if (!mapRef) return;
        rebuildRasters();
        [[metarGroup, state.metars], [sigmetGroup, state.sigmets]].forEach(([g, on]) => {
          if (on && !mapRef.hasLayer(g)) g.addTo(mapRef);
          if (!on && mapRef.hasLayer(g)) mapRef.removeLayer(g);
        });
        if (state.metars && !metarGroup.getLayers().length) loadMetars();
        if (state.sigmets && !sigmetGroup.getLayers().length) loadSigmets();
      }

      return {
        controls() {
          const wrap = document.createElement('div');

          const lvlDiv = document.createElement('div');
          lvlDiv.className = 'mapmode-sub-item';
          const sel = document.createElement('select');
          sel.style.cssText = 'width:100%;font-size:11px;padding:2px;';
          LEVELS.forEach(l => {
            const o = document.createElement('option');
            o.value = l.mb; o.textContent = l.label;
            if (l.mb === state.level) o.selected = true;
            sel.appendChild(o);
          });
          sel.onchange = () => { state.level = +sel.value; rebuildRasters(); };
          lvlDiv.appendChild(sel);
          wrap.appendChild(lvlDiv);

          [['wind', '🌬 Winds aloft'], ['temp', '🌡 Temp aloft'],
           ['metars', '🛬 METARs'], ['sigmets', '⚠️ SIGMETs']].forEach(([k, label]) => {
            const lab = document.createElement('label');
            lab.className = 'mapmode-sub-item';
            lab.innerHTML = `<input type="checkbox" ${state[k] ? 'checked' : ''}> ${label}`;
            lab.querySelector('input').onchange = e => { state[k] = e.target.checked; applyVisibility(); };
            wrap.appendChild(lab);
          });

          return wrap;
        },
        mount(m) {
          mapRef = m;
          unmounted = false;
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
          legendCtl.addTo(m);
          WxTimeline.show(m, 'aviation', {
            steps: Array.from({ length: MAX_FCST_H / STEP_H + 1 }, (_, i) => i * STEP_H * 60),
            nowIndex: 0,
            leftLabel: 'now', rightLabel: `+${MAX_FCST_H} h (GDPS)`,
            onChange: tMin => { state.offsetH = tMin / 60; retimeRasters(); },
          });
          applyVisibility();
          timer = setInterval(() => { loadMetars(); loadSigmets(); }, METAR_POLL_MS);
        },
        unmount(m) {
          unmounted = true;
          WxTimeline.hide('aviation');
          if (timer) { clearInterval(timer); timer = null; }
          [windRaster, windBarbs, tempRaster].forEach(l => { if (l && m.hasLayer(l)) m.removeLayer(l); });
          windRaster = windBarbs = tempRaster = null;
          [metarGroup, sigmetGroup].forEach(g => { g.clearLayers(); if (m.hasLayer(g)) m.removeLayer(g); });
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
          mapRef = null;
        },
      };
    }
  });
})();
