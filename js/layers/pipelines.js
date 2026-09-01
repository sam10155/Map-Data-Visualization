/**
 * Oil & gas pipeline overlay.
 *  • Lines coloured by commodity (crude/products/gas/NGL).
 *  • Stroke width ∝ √(capacity).
 *  • Animated flow droplet travels along each line in flow direction.
 *
 * Data: data/canada-pipelines.js
 */

(function () {
  const COMMODITY = {
    crude:    { color: '#7f1d1d', label: 'Crude Oil',        glyph: '🛢' },
    products: { color: '#ea580c', label: 'Refined Products', glyph: '⛽' },
    ngl:      { color: '#a855f7', label: 'NGL / Condensate', glyph: '💠' },
    gas:      { color: '#0d9488', label: 'Natural Gas',      glyph: '🔥' },
  };

  function capWidth(p) {
    // gas Bcf/d ≈ ~170 kbbl/d energy-equiv per Bcf/d → put on similar visual scale
    const k = p.unit === 'Bcf/d' ? p.cap * 170 : p.cap;
    return Math.max(1.5, Math.min(8, 0.18 * Math.sqrt(Math.max(0, k))));
  }

  function buildPulse(latlngs, color, glyph) {
    const segs = [];
    let total = 0;
    for (let i = 1; i < latlngs.length; i++) {
      const a = latlngs[i - 1], b = latlngs[i];
      const dy = (b[0] - a[0]);
      const dx = (b[1] - a[1]) * Math.cos((a[0] + b[0]) * Math.PI / 360);
      const d = Math.sqrt(dx * dx + dy * dy);
      segs.push({ a, b, d, start: total });
      total += d;
    }
    if (total === 0) total = 1;

    const icon = L.divIcon({
      className: 'pipe-pulse',
      html: `<div class="pipe-pulse-dot" style="background:${color}" title="${glyph}"></div>`,
      iconSize: [10, 10], iconAnchor: [5, 5]
    });
    const marker = L.marker(latlngs[0], { icon, interactive: false, keyboard: false });

    function at(f) {
      const target = f * total;
      let seg = segs[segs.length - 1];
      for (const s of segs) { if (target <= s.start + s.d) { seg = s; break; } }
      const t = seg.d ? (target - seg.start) / seg.d : 0;
      return [seg.a[0] + (seg.b[0] - seg.a[0]) * t, seg.a[1] + (seg.b[1] - seg.a[1]) * t];
    }
    return { marker, at, total };
  }

  function legendHTML() {
    const rows = Object.values(COMMODITY).map(c =>
      `<div class="legend-item"><span class="kv-swatch" style="background:${c.color};height:5px;"></span>${c.glyph} ${c.label}</div>`
    ).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">🛢️ Pipelines</div>
      ${rows}
      <div class="wx-row" style="margin-top:6px;">line width ∝ √(capacity)</div>
      <div class="wx-row">⚪ pulse = flow direction · dashed = idle / not built</div>
      <div class="legend-item" style="margin-top:4px;"><span class="color-dot" style="background:#374151;border:2px solid #eab308;"></span>Storage hub (shell capacity)</div>
      <div class="wx-row" id="pipe-stocks-status" style="color:#9ca3af;"></div>
    </div>`;
  }

  // ---- crude storage hubs -------------------------------------------------
  // Tank-farm shell capacities aggregated by city from the facility data.
  // No free hub-level utilization feed exists (commercial satellite-tracker
  // territory), so hubs show verified shell capacity; the provincial
  // monthly StatCan "held by transporters" gauge gives regional context.
  const HUB_MIN_BBL = 3e6;   // only major hubs get a marker

  function buildHubs() {
    const all = window.canadaIndustrialData?.all || [];
    const byCity = {};
    all.forEach(f => {
      if (f.subcategory !== 'Crude Tank Farm' || !f.capacity) return;
      if (normalizeStatus(f.status) !== 'Active') return;
      const key = `${f.city}|${f.province}`;
      const h = byCity[key] || (byCity[key] = {
        city: f.city, prov: f.province, bbl: 0, lat: 0, lon: 0, ops: [] });
      h.bbl += f.capacity;
      h.lat += f.lat * f.capacity;   // capacity-weighted centroid
      h.lon += f.lon * f.capacity;
      h.ops.push({ name: f.name, op: f.operator, bbl: f.capacity, notes: f.notes });
    });
    return Object.values(byCity)
      .filter(h => h.bbl >= HUB_MIN_BBL)
      .map(h => ({ ...h, lat: h.lat / h.bbl, lon: h.lon / h.bbl,
                   ops: h.ops.sort((a, b) => b.bbl - a.bbl) }));
  }

  function fmtMbbl(bbl) { return (bbl / 1e6).toFixed(1) + ' Mbbl'; }

  // Month-over-month change line + 5-yr sparkline from reg.series
  // ([['YYYY-MM', bbl], …], oldest → newest; absent in pre-history JSONs).
  function stocksHistoryHTML(reg, width) {
    const s = reg.series;
    if (!Array.isArray(s) || s.length < 2) return '';
    const [prevMonth, prevBbl] = s[s.length - 2];
    const d = reg.bbl - prevBbl;
    const up = d >= 0;
    const delta = `<div style="font-size:11px;margin-top:2px;color:${up ? '#b91c1c' : '#15803d'};">` +
      `${up ? '▲' : '▼'} ${up ? '+' : '−'}${fmtMbbl(Math.abs(d))} vs ${eh(prevMonth)}</div>`;
    const w = width || 170, hgt = 26;
    const vals = s.map(p => p[1]);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pt = (v, i) =>
      `${(i / (s.length - 1) * w).toFixed(1)},${(hgt - 3 - (v - lo) / span * (hgt - 6)).toFixed(1)}`;
    const line = vals.map((v, i) => pt(v, i)).join(' ');
    const last = pt(vals[vals.length - 1], vals.length - 1).split(',');
    return delta +
      `<svg width="${w}" height="${hgt}" style="display:block;margin-top:2px;">` +
      `<polyline points="${line}" fill="none" stroke="#7f1d1d" stroke-width="1.3"/>` +
      `<circle cx="${last[0]}" cy="${last[1]}" r="2" fill="#7f1d1d"/></svg>` +
      `<span style="font-size:10px;color:#6b7280;">${eh(s[0][0])} → ${eh(reg.month)} monthly</span>`;
  }

  async function loadStocks() {
    try {
      const res = await fetch('data/canada-crude-stocks.json?v=' + (window.APP_VERSION || '1'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.info('[pipelines] no crude-stocks data:', e.message);
      return null;
    }
  }

  function hubPopupHTML(h, stocks) {
    const rows = h.ops.map(o =>
      `<tr><td style="padding-right:8px;">${eh(o.op || '')}</td>` +
      `<td style="text-align:right;">${fmtMbbl(o.bbl)}</td></tr>`).join('');
    const reg = stocks?.regions?.[h.prov];
    let gauge = '';
    if (reg) {
      const pct = reg.pctOfRange;
      const color = pct == null ? '#9ca3af' : pct < 25 ? '#22c55e' : pct < 75 ? '#f59e0b' : '#b91c1c';
      gauge = `<div style="margin-top:6px;border-top:1px solid #e5e7eb;padding-top:4px;">` +
        `<b>${eh(h.prov)}</b> crude in pipelines &amp; tank farms (${eh(reg.month)}): ` +
        `<b>${fmtMbbl(reg.bbl)}</b>` +
        (pct != null
          ? `<div style="width:170px;height:7px;background:#e5e7eb;border-radius:4px;overflow:hidden;">` +
            `<div style="width:${pct}%;height:100%;background:${color};"></div></div>` +
            `<span style="font-size:10px;color:#6b7280;">${pct}% of 5-yr range ` +
            `(${fmtMbbl(reg.min5y)}–${fmtMbbl(reg.max5y)}) · StatCan 25-10-0063, provincial</span>`
          : '') + stocksHistoryHTML(reg, 170) + `</div>`;
    }
    return `<b>🛢 ${eh(h.city)} storage hub</b>` +
      `<div>Total shell capacity: <b>${fmtMbbl(h.bbl)}</b></div>` +
      `<table style="font-size:11px;margin-top:3px;">${rows}</table>` +
      `<div style="font-size:10px;color:#6b7280;margin-top:3px;">Shell capacity ≠ current fill — no public per-hub fill data exists.</div>` +
      gauge;
  }

  MapModes.register({
    id: 'pipelines',
    label: 'Pipelines',
    icon: '🛢️',
    build: () => {
      const data = window.CANADA_PIPELINES;
      if (!data) throw new Error('canada-pipelines.js not loaded');

      const lineGroup  = L.layerGroup();
      const pulseGroup = L.layerGroup();
      const hubGroup   = L.layerGroup();
      const pulses = [];
      let legendCtl = null;
      let raf = null;

      // ---- storage-hub markers (gold ring, same convention as the water
      //      layer's capacity reservoirs) ----
      loadStocks().then(stocks => {
        const hubs = buildHubs();
        hubs.forEach(h => {
          L.circleMarker([h.lat, h.lon], {
            radius: Math.max(7, Math.min(13, 3.5 * Math.sqrt(h.bbl / 1e6))),
            color: '#eab308', weight: 2,
            fillColor: '#374151', fillOpacity: 0.9,
          })
          .bindTooltip(`<b>🛢 ${eh(h.city)}</b><br>${fmtMbbl(h.bbl)} shell capacity · ` +
                       `${h.ops.length} terminal${h.ops.length > 1 ? 's' : ''}<br>click for breakdown`,
                       { sticky: true })
          .bindPopup(hubPopupHTML(h, stocks), { minWidth: 260 })
          .addTo(hubGroup);
        });
        const el = document.getElementById('pipe-stocks-status');
        if (el) {
          const ca = stocks?.regions?.CA;
          let mom = '';
          if (Array.isArray(ca?.series) && ca.series.length >= 2) {
            const d = ca.bbl - ca.series[ca.series.length - 2][1];
            mom = ` · ${d >= 0 ? '▲+' : '▼−'}${(Math.abs(d)/1e6).toFixed(1)} Mbbl m/m`;
          }
          el.textContent = ca
            ? `CA transporter stocks ${(ca.bbl/1e6).toFixed(0)} Mbbl (${ca.month}) · ${ca.pctOfRange}% of 5-yr range${mom}`
            : 'crude-stocks data unavailable';
        }
      });

      data.pipelines.forEach(p => {
        const c = COMMODITY[p.commodity] || COMMODITY.crude;
        const st = normalizeStatus(p.status);
        const dash = st !== 'Active' ? '6,6' : null;

        L.polyline(p.path, {
          color: c.color, weight: capWidth(p), opacity: st === 'Active' ? 0.9 : 0.5,
          dashArray: dash, interactive: true
        })
        .bindTooltip(
          `<b>${eh(p.name)}</b><br>${c.label} · ${p.cap} ${eh(p.unit)}` +
          `<br>${eh(p.op || '')}${st !== 'Active' ? ' · ' + st : ''}`,
          { sticky: true }
        )
        .addTo(lineGroup);

        if (st === 'Active') {
          const pulse = buildPulse(p.path, c.color, c.glyph);
          pulse.marker.addTo(pulseGroup);
          // slow, length-normalised; bigger pipes a touch faster.
          pulse.speed = (0.0012 + capWidth(p) / 4000) / Math.max(0.3, pulse.total);
          pulse.f = Math.random();
          pulses.push(pulse);
        }
      });

      function tick() {
        pulses.forEach(p => {
          p.f += p.speed;
          if (p.f >= 1) p.f -= 1;
          p.marker.setLatLng(p.at(p.f));
        });
        raf = requestAnimationFrame(tick);
      }

      return {
        mount(m) {
          lineGroup.addTo(m);
          pulseGroup.addTo(m);
          hubGroup.addTo(m);
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
          legendCtl.addTo(m);
          raf = requestAnimationFrame(tick);
        },
        unmount(m) {
          if (raf) { cancelAnimationFrame(raf); raf = null; }
          [lineGroup, pulseGroup, hubGroup].forEach(g => { if (m.hasLayer(g)) m.removeLayer(g); });
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
        }
      };
    }
  });
})();

