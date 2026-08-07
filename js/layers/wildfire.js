/**
 * 🔥 Wildfire overlay — live, client-side (no pre-baked data).
 *
 *  • Active fires: point markers coloured by control status
 *    (out of control / being held / under control), sized by area (ha).
 *  • Hotspots: last-24 h satellite thermal detections as small dots.
 *  • Fire danger: optional CWFIS WMS raster (image tiles — no CORS needed).
 *
 *  Source: NRCan Canadian Wildland Fire Information System (CWFIS).
 *  Refreshes hourly while mounted; data is fetched on mount, never
 *  committed to the repo (unlike the 6-hourly water levels).
 *  All endpoints verified CORS-enabled (Access-Control-Allow-Origin: *),
 *  so fetches go direct — no proxy involved.
 *  Licence: Open Government Licence – Canada.
 */

(function () {
  const REFRESH_MS = 60 * 60 * 1000;   // hourly

  const STATUS_STYLE = {
    // CWFIS stage_of_control codes
    OC:  { color: '#dc2626', label: 'Out of control' },
    BH:  { color: '#f59e0b', label: 'Being held' },
    UC:  { color: '#22c55e', label: 'Under control' },
    EX:  { color: '#9ca3af', label: 'Extinguished' },
    other: { color: '#a855f7', label: 'Unknown' },
  };

  function fireStyle(code) {
    return STATUS_STYLE[(code || '').trim().toUpperCase()] || STATUS_STYLE.other;
  }

  function fireRadius(ha) {
    if (!ha || ha <= 0) return 5;
    return Math.max(5, Math.min(22, 2.2 * Math.log2(1 + ha / 10)));
  }

  function legendHTML() {
    const rows = ['OC', 'BH', 'UC', 'EX'].map(k =>
      `<div class="legend-item"><span class="color-dot" style="background:${STATUS_STYLE[k].color}"></span>${STATUS_STYLE[k].label}</div>`
    ).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">🔥 Active Wildfires</div>
      ${rows}
      <div class="legend-item"><span class="color-dot" style="background:#7f1d1d;width:6px;height:6px;"></span>Satellite hotspot (24 h)</div>
      <div class="wx-row">marker size ∝ log(fire area)</div>
      <div class="wx-row">💨 Smoke — surface PM2.5, current hour (µg/m³)</div>
      <div style="display:flex;align-items:center;gap:4px;margin:2px 0;">
        <span style="font-size:10px;color:#6b7280;">0</span>
        <div style="flex:1;height:8px;border-radius:4px;overflow:hidden;display:flex;">
          ${['#1fbae6','#21c5f4','#1899c9','#0d6796','#fefc37','#fecb2e','#fd993f','#fc6769','#fe3b3b','#fe0101','#ca0713']
            .map(c => `<div style="flex:1;background:${c};"></div>`).join('')}
        </div>
        <span style="font-size:10px;color:#6b7280;">100+</span>
      </div>
      <div class="wx-row" id="wildfire-status" style="color:#9ca3af;"></div>
      <div class="wx-row">Data: NRCan CWFIS · ECCC FireWork · provisional</div>
    </div>`;
  }

  function setStatus(msg) {
    const el = document.getElementById('wildfire-status');
    if (el) el.textContent = msg || '';
  }

  // CSV parser tolerant of quoted fields (fire names contain commas).
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQ = false;
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field.trim()); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field || row.length) { row.push(field.trim()); rows.push(row); }
    const head = rows.shift()?.map(h => h.trim().toLowerCase()) || [];
    return rows.filter(r => r.length > 1).map(r =>
      Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }

  MapModes.register({
    id: 'wildfire',
    label: 'Wildfires',
    icon: '🔥',
    build: () => {
      const fireGroup = L.layerGroup();
      const hotspotGroup = L.layerGroup();
      let dangerLayer = null;          // WMS raster, created lazily
      let smokeLayer = null;           // ECCC FireWork WMS, created lazily
      let legendCtl = null;
      let mapRef = null;
      let timer = null;

      const visible = { fires: true, hotspots: true, smoke: true, danger: false };

      // ---- data endpoints (all verified CORS-enabled 2026-08) ----
      // NOTE: downloads/reportedfires/activefires.csv looks right but goes
      // STALE (weeks old) — the live feed is the WFS below.
      const FEEDS = {
        activefires: 'https://geoserver.cwfif.nrcan.gc.ca/geoserver/wfs' +
          '?service=WFS&version=2.0.0&request=GetFeature' +
          '&outputFormat=application/json' +
          '&typeName=public:cwfif_national_activefires&srsName=EPSG:4326' +
          '&CQL_FILTER=' + encodeURIComponent('now()>=record_start AND now()<=record_end'),
        // Daily hotspot CSV: URL is date-stamped UTC; fall back to
        // yesterday early in the UTC day before today's file exists.
        hotspotsFor: d => 'https://cwfis.cfs.nrcan.gc.ca/downloads/hotspots/' +
          d.toISOString().slice(0, 10).replace(/-/g, '') + '.csv',
        wms: 'https://cwfis.cfs.nrcan.gc.ca/geoserver/ows',
        dangerLayer: 'public:fdr',
        // ECCC FireWork smoke forecast (PM2.5 wildfire plume). The old
        // RAQDPS-FW.SFC_PM2.5 layer was retired — wildfire emissions now
        // live in the main RAQDPS. Omitting TIME serves the current hour.
        smokeWms: 'https://geo.weather.gc.ca/geomet',
        smokeLayer: 'RAQDPS.Sfc_PM2.5-WildfireSmokePlume',
        smokeStyle: 'PM2.5_0to100ugm3_Dis',
      };

      async function loadFires() {
        const res = await fetch(FEEDS.activefires);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const gj = await res.json();
        fireGroup.clearLayers();
        let n = 0;
        (gj.features || []).forEach(f => {
          const p = f.properties || {};
          const lat = parseFloat(p.latitude), lon = parseFloat(p.longitude);
          if (!isFinite(lat) || !isFinite(lon)) return;
          const ha = parseFloat(p.fire_size);
          const st = fireStyle(p.stage_of_control_status);
          const pc = parseFloat(p.percent_contained);
          L.circleMarker([lat, lon], {
            radius: fireRadius(ha),
            color: '#ffffff', weight: 1,
            fillColor: st.color, fillOpacity: 0.85,
          }).bindTooltip(
            `<b>🔥 ${eh(p.agency_fire_id || p.national_fire_id || 'Fire')}</b>` +
            ` <span style="color:#6b7280;">${eh((p.agency_code || '').toUpperCase())}</span>` +
            `<br>${st.label}${isFinite(pc) ? ` · ${pc}% contained` : ''}` +
            (isFinite(ha) ? `<br>${ha.toLocaleString()} ha` : '') +
            (p.status_date ? `<br>as of ${eh(String(p.status_date).slice(0, 10))}` : ''),
            { sticky: true }
          ).addTo(fireGroup);
          n++;
        });
        return n;
      }

      async function loadHotspots() {
        let res = await fetch(FEEDS.hotspotsFor(new Date()));
        if (res.status === 404) {   // today's file not created yet (early UTC)
          res = await fetch(FEEDS.hotspotsFor(new Date(Date.now() - 864e5)));
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = parseCSV(await res.text());
        hotspotGroup.clearLayers();
        let n = 0;
        rows.forEach(r => {
          const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
          if (!isFinite(lat) || !isFinite(lon)) return;
          L.circleMarker([lat, lon], {
            radius: 1.8, stroke: false,
            fillColor: '#7f1d1d', fillOpacity: 0.7,
            interactive: false,
          }).addTo(hotspotGroup);
          n++;
        });
        return n;
      }

      async function refresh() {
        setStatus('loading…');
        // Nudge the smoke WMS so it re-requests the current forecast hour
        // (GeoMet defaults TIME to "now" when omitted).
        if (smokeLayer && mapRef && mapRef.hasLayer(smokeLayer)) {
          smokeLayer.setParams({ _t: Date.now() });
        }
        const results = await Promise.allSettled([loadFires(), loadHotspots()]);
        const fires = results[0].status === 'fulfilled' ? results[0].value : null;
        const spots = results[1].status === 'fulfilled' ? results[1].value : null;
        const errs = results.filter(r => r.status === 'rejected');
        errs.forEach(r => console.warn('[wildfire]', r.reason?.message));
        setStatus(
          `${fires != null ? fires.toLocaleString() + ' fires' : 'fires unavailable'} · ` +
          `${spots != null ? spots.toLocaleString() + ' hotspots' : 'hotspots unavailable'} · ` +
          `updated ${new Date().toLocaleTimeString()} · refreshes hourly`);
      }

      function ensureDanger() {
        if (dangerLayer) return dangerLayer;
        dangerLayer = L.tileLayer.wms(FEEDS.wms, {
          layers: FEEDS.dangerLayer,
          format: 'image/png', transparent: true,
          opacity: 0.45, attribution: 'NRCan CWFIS',
        });
        return dangerLayer;
      }

      function ensureSmoke() {
        if (smokeLayer) return smokeLayer;
        smokeLayer = L.tileLayer.wms(FEEDS.smokeWms, {
          layers: FEEDS.smokeLayer,
          styles: FEEDS.smokeStyle,
          format: 'image/png', transparent: true, version: '1.3.0',
          opacity: 0.6,
          attribution: 'ECCC FireWork (RAQDPS)',
        });
        return smokeLayer;
      }

      function applyVisibility() {
        if (!mapRef) return;
        const want = [[fireGroup, visible.fires], [hotspotGroup, visible.hotspots]];
        want.forEach(([g, on]) => {
          if (on && !mapRef.hasLayer(g)) g.addTo(mapRef);
          if (!on && mapRef.hasLayer(g)) mapRef.removeLayer(g);
        });
        const s = visible.smoke ? ensureSmoke() : smokeLayer;
        if (s) {
          if (visible.smoke && !mapRef.hasLayer(s)) s.addTo(mapRef);
          if (!visible.smoke && mapRef.hasLayer(s)) mapRef.removeLayer(s);
        }
        const d = visible.danger ? ensureDanger() : dangerLayer;
        if (d) {
          if (visible.danger && !mapRef.hasLayer(d)) d.addTo(mapRef);
          if (!visible.danger && mapRef.hasLayer(d)) mapRef.removeLayer(d);
        }
      }

      return {
        controls() {
          const wrap = document.createElement('div');
          [['fires', '🔥 Active fires'], ['hotspots', '🌡 Hotspots'], ['smoke', '💨 Smoke (PM2.5)'], ['danger', '⚠️ Fire danger']].forEach(([k, label]) => {
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
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
          legendCtl.addTo(m);
          applyVisibility();
          refresh();
          timer = setInterval(refresh, REFRESH_MS);
        },
        unmount(m) {
          if (timer) { clearInterval(timer); timer = null; }
          [fireGroup, hotspotGroup].forEach(g => { g.clearLayers(); if (m.hasLayer(g)) m.removeLayer(g); });
          if (smokeLayer && m.hasLayer(smokeLayer)) m.removeLayer(smokeLayer);
          if (dangerLayer && m.hasLayer(dangerLayer)) m.removeLayer(dangerLayer);
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
          mapRef = null;
        },
      };
    }
  });
})();
