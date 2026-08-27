/**
 * Shared forecast-timeline bar (Windy-style), bottom-centre of the map.
 * One instance, claimed by whichever layer shows it last (weather /
 * aviation). Steps are minutes-from-now; the owner formats labels and
 * receives onChange(stepMinutes) as the user scrubs or playback runs.
 */
window.WxTimeline = (function () {
  let el = null, cfg = null, owner = null, playTimer = null, idx = 0;

  function ensureEl(map) {
    if (el) return el;
    el = document.createElement('div');
    el.className = 'wx-timeline-bar';
    el.innerHTML = `
      <div class="wx-tl-row">
        <button class="wx-tl-btn" data-act="now">now</button>
        <button class="wx-tl-btn" data-act="play">▶</button>
        <span class="wx-tl-label"></span>
      </div>
      <input class="wx-tl-range" type="range" min="0" value="0">
      <div class="wx-tl-edges"><span class="wx-tl-left"></span><span class="wx-tl-right"></span></div>`;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    map.getContainer().appendChild(el);

    let deb = null;
    el.querySelector('.wx-tl-range').addEventListener('input', e => {
      idx = +e.target.value;
      updateLabel();
      clearTimeout(deb);
      deb = setTimeout(fire, 200);
    });
    el.querySelector('[data-act="now"]').addEventListener('click', () => {
      stop();
      idx = cfg.nowIndex || 0;
      el.querySelector('.wx-tl-range').value = idx;
      updateLabel(); fire();
    });
    el.querySelector('[data-act="play"]').addEventListener('click', () => {
      playTimer ? stop() : play();
    });
    return el;
  }

  function fire() { if (cfg?.onChange) cfg.onChange(cfg.steps[idx], idx); }

  function updateLabel() {
    if (!el || !cfg) return;
    const m = cfg.steps[idx];
    const when = new Date(Date.now() + m * 60000);
    const rel = m === 0 ? 'now'
      : m < 0 ? `−${Math.round(-m)} min`
      : m < 48 * 60 ? `+${Math.round(m / 60)} h`
      : `+${(m / 1440).toFixed(1)} d`;
    el.querySelector('.wx-tl-label').textContent =
      `${rel} · ${when.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }

  function play() {
    if (!cfg) return;
    el.querySelector('[data-act="play"]').textContent = '⏸';
    const loop = cfg.loopWhilePast && cfg.steps[idx] <= 0;
    playTimer = setInterval(() => {
      idx++;
      if (loop && (idx >= cfg.steps.length || cfg.steps[idx] > 0)) idx = 0;
      if (idx >= cfg.steps.length) { stop(); idx = cfg.steps.length - 1; }
      el.querySelector('.wx-tl-range').value = idx;
      updateLabel(); fire();
    }, cfg.playMs || 800);
  }

  function stop() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (el) el.querySelector('[data-act="play"]').textContent = '▶';
  }

  return {
    show(map, who, config) {
      ensureEl(map);
      stop();
      owner = who;
      cfg = config;
      idx = config.nowIndex || 0;
      const rng = el.querySelector('.wx-tl-range');
      rng.max = config.steps.length - 1;
      rng.value = idx;
      el.querySelector('.wx-tl-left').textContent = config.leftLabel || '';
      el.querySelector('.wx-tl-right').textContent = config.rightLabel || '';
      el.style.display = 'block';
      updateLabel(); fire();
    },
    hide(who) {
      if (owner !== who || !el) return;
      stop();
      owner = null; cfg = null;
      el.style.display = 'none';
    },
    stopPlay: stop,
    isPlaying: () => !!playTimer,
  };
})();
