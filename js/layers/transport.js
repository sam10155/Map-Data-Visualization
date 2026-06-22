/**
 * Ports + Airports overlay.
 * Data: data/canada-ports-airports.js
 */

(function () {
  const TYPE_STYLE = {
    'seaport':          { glyph: '⚓', color: '#0e7490', label: 'Seaport' },
    'inland-port':      { glyph: '🚉', color: '#7c2d12', label: 'Inland Port' },
    'airport-intl':     { glyph: '✈',  color: '#1d4ed8', label: 'Intl Airport' },
    'airport-regional': { glyph: '✈',  color: '#64748b', label: 'Regional Airport' }
  };

  function makeIcon(type) {
    const s = TYPE_STYLE[type] || TYPE_STYLE['seaport'];
    const isAir = type.startsWith('airport');
    const shape = isAir
      ? `<rect x="2" y="2" width="22" height="22" rx="4" fill="${s.color}" stroke="white" stroke-width="2"/>`
      : `<circle cx="13" cy="13" r="11" fill="${s.color}" stroke="white" stroke-width="2"/>`;
    return L.divIcon({
      className: 'transport-icon',
      html: `<svg width="26" height="26" viewBox="0 0 26 26">${shape}
        <text x="13" y="17" text-anchor="middle" font-size="13" fill="white">${s.glyph}</text></svg>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
  }

  function legendHTML() {
    const rows = Object.entries(TYPE_STYLE).map(([k, s]) =>
      `<div class="legend-item"><span class="color-dot" style="background:${s.color}"></span>${s.glyph} ${s.label}</div>`
    ).join('');
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">⚓ Ports & ✈ Airports</div>${rows}</div>`;
  }

  MapModes.register({
    id: 'transport',
    label: 'Ports & Airports',
    icon: '⚓',
    build: () => {
      const data = window.CANADA_TRANSPORT;
      if (!data) throw new Error('canada-ports-airports.js not loaded');

      const group = L.layerGroup();
      let legendCtl = null;

      [...data.ports, ...data.airports].forEach(p => {
        const s = TYPE_STYLE[p.type] || TYPE_STYLE['seaport'];
        L.marker([p.lat, p.lon], { icon: makeIcon(p.type), keyboard: false })
          .bindTooltip(`<b>${p.name}</b><br>${s.label}${p.code ? ' • ' + p.code : ''}<br>${p.city}, ${p.province}`,
            { direction: 'top', offset: [0, -10] })
          .addTo(group);
      });

      return {
        mount(m) {
          group.addTo(m);
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => {
            const d = L.DomUtil.create('div');
            d.innerHTML = legendHTML();
            return d;
          };
          legendCtl.addTo(m);
        },
        unmount(m) {
          m.removeLayer(group);
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
        }
      };
    }
  });
})();
