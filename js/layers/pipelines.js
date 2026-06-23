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
      <div class="wx-row">⚪ pulse = flow direction · dashed = idle</div>
    </div>`;
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
      const pulses = [];
      let legendCtl = null;
      let raf = null;

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
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
          legendCtl.addTo(m);
          raf = requestAnimationFrame(tick);
        },
        unmount(m) {
          if (raf) { cancelAnimationFrame(raf); raf = null; }
          [lineGroup, pulseGroup].forEach(g => { if (m.hasLayer(g)) m.removeLayer(g); });
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
        }
      };
    }
  });
})();
