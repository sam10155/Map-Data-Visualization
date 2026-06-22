/**
 * Power-generation overlay.
 *  • Generating stations: type-icon + capacity-scaled radius circle.
 *  • Transmission interties: voltage-class colour, with an animated
 *    "electron" pulse travelling along each line toward load.
 *
 * Data: data/canada-power.js
 */

(function () {
  const TYPE_STYLE = {
    hydro:   { glyph: '💧', color: '#0ea5e9', label: 'Hydro' },
    nuclear: { glyph: '☢',  color: '#facc15', label: 'Nuclear' },
    gas:     { glyph: '🔥', color: '#f97316', label: 'Natural Gas' },
    coal:    { glyph: '🪨', color: '#1f2937', label: 'Coal' },
    wind:    { glyph: '🌬', color: '#10b981', label: 'Wind' },
    solar:   { glyph: '☀',  color: '#eab308', label: 'Solar' },
    battery: { glyph: '🔋', color: '#8b5cf6', label: 'Battery (BESS)' },
    other:   { glyph: '⚙',  color: '#6b7280', label: 'Other' },
  };

  function kvClass(kv) {
    if (kv >= 500) return { color: '#fbbf24', weight: 4.0, label: '≥ 500 kV' };  // yellow
    if (kv >= 100) return { color: '#f97316', weight: 3.0, label: '100–499 kV' }; // orange
    return            { color: '#dc2626', weight: 2.0, label: '< 100 kV' };       // red
  }

  function plantIcon(type) {
    const s = TYPE_STYLE[type] || TYPE_STYLE.other;
    return L.divIcon({
      className: 'pwr-icon',
      html: `<svg width="26" height="26" viewBox="0 0 26 26">
        <circle cx="13" cy="13" r="11" fill="${s.color}" stroke="white" stroke-width="2"/>
        <text x="13" y="17" text-anchor="middle" font-size="12" fill="white">${s.glyph}</text></svg>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
  }

  function fmtMW(mw) {
    return mw >= 1000 ? (mw / 1000).toFixed(2).replace(/\.?0+$/, '') + ' GW' : mw + ' MW';
  }

  // ---- electron pulse animator -------------------------------------------
  // Pre-compute cumulative segment lengths once per line; on each frame,
  // place a divIcon at the interpolated lat/lon for fraction f∈[0,1).
  function buildPulse(latlngs, color) {
    const segs = [];
    let total = 0;
    for (let i = 1; i < latlngs.length; i++) {
      const a = latlngs[i - 1], b = latlngs[i];
      // simple equirectangular distance — good enough for animation pacing
      const dy = (b[0] - a[0]);
      const dx = (b[1] - a[1]) * Math.cos((a[0] + b[0]) * Math.PI / 360);
      const d = Math.sqrt(dx * dx + dy * dy);
      segs.push({ a, b, d, start: total });
      total += d;
    }
    if (total === 0) total = 1;

    const icon = L.divIcon({
      className: 'pwr-electron',
      html: `<div class="pwr-electron-dot" style="background:${color}"></div>`,
      iconSize: [12, 12], iconAnchor: [6, 6]
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
    const types = Object.entries(TYPE_STYLE).map(([k, s]) =>
      `<div class="legend-item"><span class="color-dot" style="background:${s.color}"></span>${s.glyph} ${s.label}</div>`
    ).join('');
    const kvRows = [kvClass(500), kvClass(230), kvClass(69)].map(c =>
      `<div class="legend-item"><span class="kv-swatch" style="background:${c.color}"></span>${c.label}</div>`
    ).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">⚡ Power Generation</div>
      ${types}
      <div class="wx-row" style="margin-top:4px;">circle radius ∝ √(MW capacity)</div>
      <div class="overlay-legend-title" style="margin-top:8px;">Transmission</div>
      ${kvRows}
      <div class="wx-row">⚪ pulse = power flow toward load</div>
    </div>`;
  }

  MapModes.register({
    id: 'power',
    label: 'Power Generation',
    icon: '⚡',
    build: () => {
      const data = window.CANADA_POWER;
      if (!data) throw new Error('canada-power.js not loaded');

      const iconGroup  = L.layerGroup();
      const lineGroup  = L.layerGroup();
      const pulseGroup = L.layerGroup();
      const pulses = [];
      let legendCtl = null;
      let mapRef = null;
      let raf = null;

      // ---- plant glyph badges (capacity circle is rendered by the main
      //      facility layer; this overlay just adds the cute type icon) ----
      data.plants.forEach(p => {
        const s = TYPE_STYLE[p.type] || TYPE_STYLE.other;
        L.marker([p.lat, p.lon], { icon: plantIcon(p.type), keyboard: false, interactive: false })
          .bindTooltip(
            `<b>${p.name}</b><br>${s.label} · ${fmtMW(p.mw)}<br>` +
            `${p.operator || ''}<br>${p.province} · ${normalizeStatus(p.status)}`,
            { direction: 'top', offset: [0, -12] }
          )
          .addTo(iconGroup);
      });

      // ---- transmission lines + pulses ----
      data.interties.forEach(t => {
        const cls = kvClass(t.kv);
        const dash = t.type === 'DC' ? '8,6' : null;
        L.polyline(t.path, {
          color: cls.color, weight: cls.weight, opacity: 0.9, dashArray: dash, interactive: true
        })
        .bindTooltip(`<b>${t.name}</b><br>${t.kv} kV ${t.type}${t.op ? ' · ' + t.op : ''}`, { sticky: true })
        .addTo(lineGroup);

        const pulse = buildPulse(t.path, cls.color);
        pulse.marker.addTo(pulseGroup);
        // fraction-per-frame: higher kV slightly faster, but overall slow.
        pulse.speed = (0.0015 + t.kv / 600000) / Math.max(0.3, pulse.total);
        pulse.f = Math.random();
        pulses.push(pulse);
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
          mapRef = m;
          lineGroup.addTo(m);
          pulseGroup.addTo(m);
          iconGroup.addTo(m);

          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
          legendCtl.addTo(m);

          raf = requestAnimationFrame(tick);
        },
        unmount(m) {
          if (raf) { cancelAnimationFrame(raf); raf = null; }
          [lineGroup, pulseGroup, iconGroup].forEach(g => { if (m.hasLayer(g)) m.removeLayer(g); });
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
          mapRef = null;
        }
      };
    }
  });
})();
