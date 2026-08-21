/**
 * Static rail network overlay.
 *  • CN red · CPKC orange · VIA/other grey.
 *  • Data: data/canada-rail.geojson, pre-baked from OSM by
 *    scripts/fetch_rail.py (mainline + branch only, no yards/spurs).
 *  • No live positions — CN/CPKC do not publish train locations.
 */

(function () {
  const RR_STYLE = {
    cn:    { color: '#dc2626', label: 'CN',            weight: 2   },
    cpkc:  { color: '#ea580c', label: 'CPKC',          weight: 2   },
    via:   { color: '#6b7280', label: 'VIA / shared',  weight: 1.5 },
    // QNS&L / Cartier / Arnaud / Tshiuetin — Labrador-trough iron-ore
    // corridors; among the heaviest-tonnage lines in Canada.
    ore:   { color: '#7c2d12', label: 'Iron ore (QNS&L·Cartier·Arnaud)', weight: 2 },
    other: { color: '#94a3b8', label: 'Other / shortline', weight: 1.2 },
  };

  function legendHTML() {
    const rows = Object.values(RR_STYLE).map(s =>
      `<div class="legend-item"><span class="kv-swatch" style="background:${s.color};height:4px;"></span>${s.label}</div>`
    ).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">🛤️ Rail Network</div>
      ${rows}
      <div class="wx-row" style="margin-top:6px;">mainlines + branches (OSM)</div>
      <div class="wx-row">freight positions aren't public — see 🚆 VIA in Live Tracking</div>
    </div>`;
  }

  MapModes.register({
    id: 'rail',
    label: 'Rail Network',
    icon: '🛤️',
    build: () => {
      const group = L.layerGroup();
      // ~25k polylines: SVG would mean 25k DOM nodes; canvas draws them all
      // in one element and stays smooth.
      const renderer = L.canvas({ padding: 0.3 });
      let legendCtl = null;
      let loaded = false;

      async function load() {
        if (loaded) return;
        loaded = true;
        const res = await fetch('data/canada-rail.geojson?v=' + (window.APP_VERSION || '1'));
        if (!res.ok) throw new Error(`canada-rail.geojson: HTTP ${res.status} — run scripts/fetch_rail.py`);
        const fc = await res.json();
        fc.features.forEach(f => {
          const s = RR_STYLE[f.properties.rr] || RR_STYLE.other;
          const latlngs = f.geometry.coordinates.map(c => [c[1], c[0]]);
          const line = L.polyline(latlngs, {
            color: s.color, weight: s.weight, opacity: 0.85,
            interactive: true, renderer,
          });
          const name = f.properties.name || '';
          const op = f.properties.operator || '';
          line.bindTooltip(
            `<b>🛤️ ${eh(s.label)}</b>` +
            (name ? `<br>${eh(name)}` : '') +
            (op && op !== name ? `<br><span style="font-size:10px;color:#6b7280;">${eh(op)}</span>` : ''),
            { sticky: true }
          );
          line.addTo(group);
        });
      }

      return {
        mount(m) {
          group.addTo(m);
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
          legendCtl.addTo(m);
          load().catch(e => console.warn('[rail]', e));
        },
        unmount(m) {
          if (m.hasLayer(group)) m.removeLayer(group);
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
        }
      };
    }
  });
})();
