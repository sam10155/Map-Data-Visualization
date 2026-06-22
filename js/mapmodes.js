/**
 * mapmodes.js
 * Generic map-overlay registry. Each mode supplies:
 *   { id, label, icon, build(): {mount(map), unmount(map), refresh?(map)} }
 * Modes are independent toggleable overlays that sit on top of the facility layer.
 */

window.MapModes = (function () {
  const registry = {};
  const active = {};

  function register(def) {
    registry[def.id] = def;
  }

  function isActive(id) {
    return !!active[id];
  }

  async function toggle(id) {
    const def = registry[id];
    if (!def) return;

    const btn = document.querySelector(`.mapmode-btn[data-mode="${id}"]`);

    if (active[id]) {
      try { active[id].unmount(map); } catch (e) { console.warn(`[${id}] unmount failed`, e); }
      delete active[id];
      btn?.classList.remove('active');
      document.getElementById(`mapmode-sub-${id}`)?.remove();
      return;
    }

    btn?.classList.add('loading');
    try {
      const inst = await def.build();
      active[id] = inst;
      btn?.classList.add('active');
      if (typeof inst.controls === 'function') {
        const sub = document.createElement('div');
        sub.className = 'mapmode-sub';
        sub.id = `mapmode-sub-${id}`;
        sub.appendChild(inst.controls());
        btn?.insertAdjacentElement('afterend', sub);
      }
      await inst.mount(map);
    } catch (e) {
      console.error(`[${id}] mount failed`, e);
      if (typeof showSaveNotification === 'function') {
        showSaveNotification(`${def.label}: ${e.message || 'failed to load'}`, false);
      }
    } finally {
      btn?.classList.remove('loading');
    }
  }

  function refreshAll() {
    Object.entries(active).forEach(([id, inst]) => {
      if (typeof inst.refresh === 'function') {
        try { inst.refresh(map); } catch (e) { console.warn(`[${id}] refresh failed`, e); }
      }
    });
  }

  function buildUI() {
    if (document.getElementById('mapModeBar')) return;
    const bar = document.createElement('div');
    bar.id = 'mapModeBar';
    bar.className = 'mapmode-bar';

    Object.values(registry).forEach(def => {
      const b = document.createElement('button');
      b.className = 'mapmode-btn';
      b.dataset.mode = def.id;
      b.title = def.label;
      b.innerHTML = `<span class="mapmode-icon">${def.icon || '◉'}</span><span class="mapmode-label">${def.label}</span>`;
      b.onclick = () => toggle(def.id);
      bar.appendChild(b);
    });

    document.body.appendChild(bar);

    map.on('moveend zoomend', refreshAll);
  }

  return { register, toggle, isActive, buildUI, refreshAll, _active: active };
})();
