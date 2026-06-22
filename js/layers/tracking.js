/**
 * Live aircraft + ship tracking overlay.
 *
 * Aircraft:
 *   • Primary:  adsb.lol (https://api.adsb.lol/) — CORS-open, no key.
 *               Tiled by /v2/point/{lat}/{lon}/250 over a Canada-covering grid.
 *   • Fallback: OpenSky /states/all (anonymous, heavily rate-limited).
 *   Filter: keep flights whose registration is Canadian (C-xxxx), or whose
 *   route (when known) departs/arrives at a Canadian ICAO (CYxx / CZxx).
 *
 * Ships: AISStream.io WebSocket (free key required).
 *   Filter: AIS Destination matches a Canadian port name/UN-LOCODE.
 *   Set window.AISSTREAM_API_KEY or localStorage 'aisstream_key' to enable.
 *
 * Both feeds report status into the legend so the user can see why a
 * sub-layer is empty.
 */

(function () {
  const CANADA_BBOX = { lamin: 41.5, lamax: 83.2, lomin: -141.0, lomax: -52.5 };
  const AIRCRAFT_POLL_MS = 15000;

  // Optional proxy (e.g. a Cloudflare Worker) for GitHub-Pages deployments.
  // If set, requests go to `${TRACKING_PROXY}<host>/<path>`. Configure via
  // window.TRACKING_PROXY in data/config.js.
  const PROXY = window.TRACKING_PROXY || null;

  // 250 nm circles — six covers the populated corridor; the north has so
  // little traffic that omitting it costs ~nothing and avoids rate-limits.
  const ADSB_CENTRES = [
    [49.3,-123.1],   // Vancouver / Pacific NW
    [51.1,-114.0],   // Calgary / Edmonton corridor
    [50.4,-104.6],   // Regina / SK-MB
    [49.9,-97.1],    // Winnipeg / NW ON
    [43.7,-79.6],    // GTA / SW ON
    [45.5,-73.6],    // Montréal / QC / Maritimes reach
  ];
  const ADSB_RADIUS_NM = 250;
  const TILE_GAP_MS = 250;

  function buildLookups() {
    const data = window.CANADA_TRANSPORT || { ports: [], airports: [] };
    const airportICAO = new Set(data.airports.map(a => a.code).filter(Boolean));
    const portTokens = [];
    data.ports.forEach(p => {
      if (p.code) portTokens.push(p.code.toUpperCase());
      const city = (p.city || '').toUpperCase().replace(/[^A-Z ]/g, '').trim();
      if (city && city.length >= 4) portTokens.push(city);
      const short = (p.name || '').toUpperCase()
        .replace(/^PORT (OF|DE) /, '').replace(/[^A-Z ]/g, '').trim();
      if (short && short.length >= 4) portTokens.push(short);
    });
    return { airportICAO, portTokens: [...new Set(portTokens)] };
  }

  function isCanadianICAO(code) {
    return typeof code === 'string' && /^C[YZ][A-Z0-9]{2}$/i.test(code);
  }
  function isCanadianReg(reg) {
    return typeof reg === 'string' && /^C-?[FGI][A-Z]{3}$/i.test(reg.replace(/\s/g, ''));
  }
  function shipDestMatchesCanada(dest, tokens) {
    if (!dest) return false;
    const d = dest.toUpperCase();
    if (/^CA[A-Z]{3}/.test(d) || /\bCANADA\b/.test(d) || /\bCA\b/.test(d)) return true;
    return tokens.some(t => d.includes(t));
  }

  // ---- Aircraft fetchers ---------------------------------------------------

  function buildUrl(host, path) {
    return PROXY ? `${PROXY}${host}/${path}` : `https://${host}/${path}`;
  }

  function tfetch(url, ms = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { signal: ctl.signal })
      .finally(() => clearTimeout(t))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function normalizeAc(a) {
    if (a.lat == null || a.lon == null) return null;
    const id = (a.hex || a.icao || '').toLowerCase();
    if (!id) return null;
    if (a.lat < CANADA_BBOX.lamin || a.lat > CANADA_BBOX.lamax ||
        a.lon < CANADA_BBOX.lomin || a.lon > CANADA_BBOX.lomax) return null;
    if (a.alt_baro === 'ground') return null;
    return {
      id, callsign: (a.flight || '').trim(), reg: a.r,
      lat: a.lat, lon: a.lon, alt: a.alt_geom ?? a.alt_baro,
      gs: a.gs, track: a.track ?? a.true_heading ?? a.nav_heading,
      type: a.t, category: a.category, opIcao: a.ownOp,
    };
  }

  // ---- Route lookup (dep/arr airports) ------------------------------------
  // Primary: adsbdb.com /v0/callsign/<cs> (CORS-enabled, free, no key).
  // Fallback: adsb.lol /api/0/route/<cs> (302→JSON).
  const ROUTE_CACHE = new Map();
  let routeBackoffUntil = 0;
  const ROUTE_CONCURRENCY = 4;

  // Airline callsigns are ICAO-3-letters + flight number (e.g. ACA123, DAL47).
  // Registrations-as-callsign (CGHAZ, N353LD, GBXYZ, etc.) and ad-hoc tags
  // (PHGOV, SUT2101) won't have filed routes — skip to avoid 404 noise.
  function looksLikeAirlineCallsign(cs) {
    return /^[A-Z]{3}\d{1,4}[A-Z]?$/.test(cs);
  }

  async function qfetch(url, ms = 6000) {
    // quiet fetch: returns null on 404/error instead of logging to console
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
    finally { clearTimeout(t); }
  }

  async function lookupRouteOne(cs) {
    // adsbdb
    {
      const r = await qfetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`);
      const fr = r?.response?.flightroute;
      if (fr?.origin && fr?.destination) {
        return {
          from: fr.origin.iata_code || fr.origin.icao_code,
          fromName: `${fr.origin.municipality || ''} (${fr.origin.name || ''})`.trim(),
          to: fr.destination.iata_code || fr.destination.icao_code,
          toName: `${fr.destination.municipality || ''} (${fr.destination.name || ''})`.trim(),
          airline: fr.airline?.name || '',
        };
      }
    }
    // adsb.lol fallback
    {
      const j = await qfetch(buildUrl('api.adsb.lol', `api/0/route/${encodeURIComponent(cs)}`));
      if (!j) return null;
      const codes = (j._airport_codes_iata || j.airport_codes || '').split(/[-\s>]+/).filter(Boolean);
      const aps = j._airports || [];
      if (codes.length >= 2) {
        return {
          from: codes[0], to: codes[codes.length - 1],
          fromName: aps[0] ? `${aps[0].location || ''} (${aps[0].name || ''})` : '',
          toName: aps[aps.length-1] ? `${aps[aps.length-1].location || ''} (${aps[aps.length-1].name || ''})` : '',
          airline: j.airline_code || '',
        };
      }
    }
    return null;
  }

  async function fetchRoutes(items) {
    if (!items.length || Date.now() < routeBackoffUntil) return;
    let i = 0;
    const workers = Array.from({ length: ROUTE_CONCURRENCY }, async () => {
      while (i < items.length) {
        const a = items[i++];
        if (ROUTE_CACHE.has(a.callsign)) continue;
        try {
          ROUTE_CACHE.set(a.callsign, await lookupRouteOne(a.callsign));
        } catch (e) {
          if (String(e).includes('429')) { routeBackoffUntil = Date.now() + 60000; return; }
          ROUTE_CACHE.set(a.callsign, null);
        }
      }
    });
    await Promise.allSettled(workers);
  }

  async function fetchTiledFeed(host, pathFn, label) {
    const seen = {};
    let okCount = 0, lastErr = null;
    for (const [la, lo] of ADSB_CENTRES) {
      try {
        const json = await tfetch(buildUrl(host, pathFn(la, lo)));
        okCount++;
        (json.ac || json.aircraft || []).forEach(a => {
          const n = normalizeAc(a);
          if (n && !seen[n.id]) seen[n.id] = n;
        });
      } catch (e) { lastErr = e; }
      await sleep(TILE_GAP_MS);
    }
    if (okCount === 0) throw new Error(`${label}: ${lastErr?.message || 'unreachable'}`);
    return Object.values(seen);
  }

  const fetchAirplanesLive = () => fetchTiledFeed(
    'api.airplanes.live', (la,lo) => `v2/point/${la}/${lo}/${ADSB_RADIUS_NM}`, 'airplanes.live');
  const fetchAdsbLol = () => fetchTiledFeed(
    'api.adsb.lol', (la,lo) => `v2/point/${la}/${lo}/${ADSB_RADIUS_NM}`, 'adsb.lol');
  const fetchAdsbFi = () => fetchTiledFeed(
    'opendata.adsb.fi', (la,lo) => `api/v2/lat/${la}/lon/${lo}/dist/${ADSB_RADIUS_NM}`, 'adsb.fi');

  async function fetchOpenSky() {
    const url = buildUrl('opensky-network.org',
      `api/states/all?lamin=${CANADA_BBOX.lamin}&lamax=${CANADA_BBOX.lamax}&lomin=${CANADA_BBOX.lomin}&lomax=${CANADA_BBOX.lomax}`);
    const json = await tfetch(url, 10000);
    return (json.states || []).filter(s => s[5] != null && s[6] != null && !s[8]).map(s => ({
      id: s[0], callsign: (s[1] || '').trim(), reg: null,
      lat: s[6], lon: s[5], alt: s[13] ?? s[7],
      gs: (s[9] || 0) * 1.94384, track: s[10],
      type: null, opIcao: s[2],
    }));
  }

  async function fetchAircraft(status) {
    const sources = [
      ['airplanes.live', fetchAirplanesLive],
      ['adsb.lol',       fetchAdsbLol],
      ['adsb.fi',        fetchAdsbFi],
      ['OpenSky',        fetchOpenSky],
    ];
    const errs = [];
    for (const [label, fn] of sources) {
      try {
        const list = await fn();
        status.air = `${label} · ${list.length} aircraft`;
        return list;
      } catch (e) {
        errs.push(`${label}: ${e.message || e}`);
        console.warn(`[tracking] ${label} failed`, e);
      }
    }
    status.air = `feed error — ${errs.join(' · ')}`;
    return [];
  }

  // ---- Aircraft classification --------------------------------------------
  // Maps ICAO type designator (a.t from ADS-B feed) → category.
  const AC_CATEGORY = {
    helicopter: /^(R22|R44|R66|EC[0-9]+|H[0-9]{3}|AS[0-9]{2,3}|B06|B407|B412|B429|S76|S92|A109|A119|A139|AW[0-9]+|BK17|CH47|UH[0-9]+|MD[0-9]{3})$/i,
    military:   /^(F1[5-8]|F22|F35|A10|B52|B1|B2|C17|C130|C5M?|KC[0-9]+|E3|E6|P3|P8|HAWK|TYPH|EUFI|TOR|HARR|GRIP|RFAL|MIR|SU[0-9]+|MIG[0-9]+|TEX2|T6|T38|GLOB|HERON|MQ[0-9])$/i,
    widebody:   /^(B74[0-9]|B77[0-9LW]+|B78[0-9]|A33[0-9]|A34[0-9]|A35[0-9KX]+|A38[0-9]|MD11|DC10|L101|IL96|B76[0-9])$/i,
    narrowbody: /^(B7[0-3][0-9]|B75[0-9]|A31[89]|A32[01N]+|A22[01]|E1[789][0-9]|E29[05]|CRJ[0-9X]?|DH8[A-D]|AT[47][0-9]|BCS[13]|C919|MD8[0-9]|MD90|F70|F100|RJ[0-9]+|SU9[05]|YK4[02])$/i,
  };
  function classifyAircraft(a) {
    const t = (a.type || '').toUpperCase();
    if (a.category === 'A7' || AC_CATEGORY.helicopter.test(t)) return 'helicopter';
    if (AC_CATEGORY.military.test(t)) return 'military';
    if (AC_CATEGORY.widebody.test(t)) return 'widebody';
    if (a.category === 'A5') return 'widebody';
    if (AC_CATEGORY.narrowbody.test(t)) return 'narrowbody';
    if (a.category === 'A3' || a.category === 'A4') return 'narrowbody';
    if (a.category === 'A1' || a.category === 'A2') return 'ga';
    // fallback: airliner-ish callsign vs short reg → guess
    if (t && /^[A-Z]{2,4}\d{1,4}$/.test(a.callsign || '')) return 'narrowbody';
    return 'ga';
  }

  const CAT_LABEL = {
    ga: 'Light / GA', narrowbody: 'Narrowbody airliner', widebody: 'Widebody airliner',
    helicopter: 'Helicopter', military: 'Military',
  };

  // ---- Icons ---------------------------------------------------------------

  const PLANE_SHAPES = {
    // small straight-wing prop
    ga: 'M0,-7 L1,-2 L8,-1 L8,1 L1,1 L1,5 L3,7 L-3,7 L-1,5 L-1,1 L-8,1 L-8,-1 L-1,-2 Z',
    // swept-wing single-aisle
    narrowbody: 'M0,-9 L1.5,-3 L9,1 L9,2.5 L1.5,1 L1,6 L4,8 L4,9 L0,8 L-4,9 L-4,8 L-1,6 L-1.5,1 L-9,2.5 L-9,1 L-1.5,-3 Z',
    // wide swept wings, larger fuselage
    widebody: 'M0,-11 L2,-4 L11,1 L11,3 L2,1.5 L1.5,7 L5,9 L5,10 L0,9 L-5,10 L-5,9 L-1.5,7 L-2,1.5 L-11,3 L-11,1 L-2,-4 Z',
    // rotor disc + tail boom
    helicopter: 'M0,-2 A2,2 0 1,1 0,2 A2,2 0 1,1 0,-2 M0,2 L0,8 L2,8 L2,9 L-2,9 L-2,8 L0,8 M-7,-7 L7,7 M-7,7 L7,-7',
    // delta-wing fast jet
    military: 'M0,-9 L7,6 L2,5 L2,8 L-2,8 L-2,5 L-7,6 Z',
  };
  const PLANE_SIZE = { ga: 18, narrowbody: 22, widebody: 28, helicopter: 22, military: 22 };

  function planeIcon(a, isCdn) {
    const cat = a._cat || 'narrowbody';
    const fill = a._cat === 'military' ? '#065f46'
               : isCdn ? '#dc2626' : '#475569';
    const sz = PLANE_SIZE[cat]; const hb = sz / 2;
    const stroke = cat === 'helicopter' ? `stroke="${fill}" stroke-width="1.5" fill="none"` :
                   `fill="${fill}" stroke="white" stroke-width="0.6"`;
    return L.divIcon({
      className: 'track-plane',
      html: `<svg width="${sz}" height="${sz}" viewBox="-${hb} -${hb} ${sz} ${sz}">
        <g transform="rotate(${a.track || 0})">
          <path d="${PLANE_SHAPES[cat]}" ${stroke}/>
        </g></svg>`,
      iconSize: [sz, sz], iconAnchor: [hb, hb]
    });
  }

  function shipIcon(heading, matched) {
    const fill = matched ? '#0e7490' : '#94a3b8';
    return L.divIcon({
      className: 'track-ship',
      html: `<svg width="20" height="20" viewBox="-10 -10 20 20">
        <g transform="rotate(${heading || 0})">
          <path d="M0,-8 L4,2 L2,7 L-2,7 L-4,2 Z" fill="${fill}" stroke="white" stroke-width="0.8"/>
        </g></svg>`,
      iconSize: [20, 20], iconAnchor: [10, 10]
    });
  }

  // When TRACKING_PROXY points at a deployed Cloudflare Worker (https://…),
  // the worker holds the keys and the browser never sees them.
  function proxyIsWorker() {
    return typeof PROXY === 'string' && /^https?:\/\//i.test(PROXY);
  }
  function aisWsUrl() {
    if (proxyIsWorker()) return PROXY.replace(/^http/i, 'ws').replace(/\/?$/, '/') + 'ais';
    return 'wss://stream.aisstream.io/v0/stream';
  }
  function gfwUrl(qs) {
    if (proxyIsWorker()) return PROXY.replace(/\/?$/, '/') + 'gfw/events' + qs;
    return 'https://gateway.api.globalfishingwatch.org/v3/events' + qs;
  }
  function getAisKey() {
    if (proxyIsWorker()) return '__via_worker__';
    return window.AISSTREAM_API_KEY ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('aisstream_key') : null);
  }
  function getGfwToken() {
    if (proxyIsWorker()) return '__via_worker__';
    return window.GFW_API_TOKEN ||
      (typeof localStorage !== 'undefined' ? localStorage.getItem('gfw_token') : null);
  }

  // ---- Global Fishing Watch ------------------------------------------------
  // Free token from globalfishingwatch.org/our-apis. Returns recent fishing
  // events (last positions, ~24-72h delayed) within Canada bbox.
  async function fetchGfwFishing(token, status) {
    const end = new Date();
    const start = new Date(end.getTime() - 7*24*3600*1000);
    const fmt = d => d.toISOString().slice(0,10);
    // v3 events API — POST with body filter (geometry must be in body, not query).
    const url = gfwUrl('?limit=500&offset=0');
    const body = {
      datasets: ['public-global-fishing-events:latest'],
      startDate: fmt(start),
      endDate: fmt(end),
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [CANADA_BBOX.lomin, CANADA_BBOX.lamin],
          [CANADA_BBOX.lomax, CANADA_BBOX.lamin],
          [CANADA_BBOX.lomax, CANADA_BBOX.lamax],
          [CANADA_BBOX.lomin, CANADA_BBOX.lamax],
          [CANADA_BBOX.lomin, CANADA_BBOX.lamin],
        ]],
      },
    };
    const headers = { 'Content-Type': 'application/json' };
    if (!proxyIsWorker()) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).messages?.[0]?.detail || ''; } catch {}
      status.fish = `GFW HTTP ${res.status}${detail ? ': ' + detail.slice(0,60) : ''}`;
      throw new Error(`GFW HTTP ${res.status}`);
    }
    const j = await res.json();
    const events = j.entries || j.events || [];
    status.fish = `GFW · ${events.length} fishing events (7d)`;
    return events.map(e => ({
      id: e.id || (e.vessel?.id) || `${e.position?.lat},${e.position?.lon}`,
      lat: e.position?.lat, lon: e.position?.lon,
      name: e.vessel?.name || e.vessel?.shipname || 'Fishing vessel',
      flag: e.vessel?.flag, mmsi: e.vessel?.ssvid || e.vessel?.mmsi,
      type: e.type, start: e.start, end: e.end,
    })).filter(v => v.lat != null && v.lon != null);
  }

  function fishIcon() {
    return L.divIcon({
      className: 'track-ship',
      html: `<svg width="18" height="18" viewBox="-9 -9 18 18">
        <path d="M-7,0 Q-3,-5 4,-3 L7,0 L4,3 Q-3,5 -7,0 Z" fill="#ea580c" stroke="white" stroke-width="0.8"/>
        <circle cx="2" cy="-1" r="1" fill="white"/></svg>`,
      iconSize: [18, 18], iconAnchor: [9, 9]
    });
  }

  // ---- Mode definition -----------------------------------------------------

  MapModes.register({
    id: 'tracking',
    label: 'Live Tracking',
    icon: '📡',
    build: () => {
      const planeGroup = L.layerGroup();
      const shipGroup = L.layerGroup();
      const fishGroup = L.layerGroup();
      const planeMarkers = {};
      const shipMarkers = {};
      let pollTimer = null;
      let fishTimer = null;
      let ws = null;
      let legendCtl = null;
      let mapRef = null;
      const lookups = buildLookups();
      const visible = { planes: true, ships: true, fishing: true };
      const status = {
        air: 'connecting…',
        ship: getAisKey() ? 'connecting…' : 'no key',
        fish: getGfwToken() ? 'loading…' : 'set GFW_API_TOKEN to enable',
      };

      function applyVisibility() {
        if (!mapRef) return;
        [['planes', planeGroup], ['ships', shipGroup], ['fishing', fishGroup]].forEach(([k, g]) => {
          if (visible[k]) { if (!mapRef.hasLayer(g)) g.addTo(mapRef); }
          else if (mapRef.hasLayer(g)) mapRef.removeLayer(g);
        });
      }

      function isCdnFlight(a) {
        if (isCanadianReg(a.reg)) return true;
        if (a.id && /^c0/i.test(a.id)) return true;        // ICAO24 'C0xxxx' = Canada
        if (a.opIcao === 'Canada') return true;
        return false;
      }

      function updateLegend() {
        const el = document.getElementById('tracking-status');
        if (el) el.innerHTML =
          `✈ ${status.air}<br>🚢 ${status.ship}<br>🐟 ${status.fish}`;
      }

      async function loadFishing() {
        const token = getGfwToken();
        if (!token) { status.fish = 'set GFW_API_TOKEN to enable'; updateLegend(); return; }
        try {
          const events = await fetchGfwFishing(token, status);
          fishGroup.clearLayers();
          events.forEach(v => {
            L.marker([v.lat, v.lon], { icon: fishIcon(), keyboard: false })
              .bindTooltip(
                `<b>🐟 ${v.name}</b>` +
                (v.flag ? ` · ${v.flag}` : '') + '<br>' +
                (v.mmsi ? `MMSI ${v.mmsi}<br>` : '') +
                `Fishing event ${v.start ? new Date(v.start).toISOString().slice(0,16).replace('T',' ') : ''}` +
                (v.end ? ` → ${new Date(v.end).toISOString().slice(0,16).replace('T',' ')}` : '') +
                `<br><span style="font-size:10px;color:#9ca3af;">Global Fishing Watch (delayed)</span>`,
                { direction: 'top', offset: [0, -8] }
              )
              .addTo(fishGroup);
          });
          updateLegend();
        } catch (e) {
          console.warn('[tracking] GFW failed', e);
          updateLegend();
        }
      }

      function planeTooltip(a, cdn) {
        const route = a.callsign ? ROUTE_CACHE.get(a.callsign) : undefined;
        let routeHtml = '';
        if (route) {
          routeHtml = `<b>${route.from} → ${route.to}</b>` +
            (route.airline ? ` · ${route.airline}` : '') + '<br>' +
            `<span style="font-size:10px;color:#6b7280;">${route.fromName || ''}<br>→ ${route.toName || ''}</span><br>`;
        } else if (route === undefined && a.callsign) {
          routeHtml = '<span style="font-size:10px;color:#9ca3af;">route: looking up…</span><br>';
        } else if (route === null) {
          routeHtml = '<span style="font-size:10px;color:#9ca3af;">route: unknown</span><br>';
        }
        return `<b>${a.callsign || a.reg || a.id}</b>` +
          (a.type ? ` · ${a.type}` : '') +
          ` <span style="font-size:10px;color:#6b7280;">${CAT_LABEL[a._cat]}</span><br>` +
          (a.reg ? `${a.reg}${cdn ? ' 🇨🇦' : ''}<br>` : '') +
          routeHtml +
          `Alt ${a.alt != null ? Math.round(a.alt).toLocaleString() + ' ft' : '—'} · ` +
          `${Math.round(a.gs || 0)} kt · hdg ${Math.round(a.track || 0)}°`;
      }

      async function pollPlanes() {
        const list = await fetchAircraft(status);
        updateLegend();
        if (!list.length) return;   // keep existing markers on failed poll
        const seen = new Set();
        const needRoute = [];

        list.forEach(a => {
          seen.add(a.id);
          a._cat = classifyAircraft(a);
          const cdn = isCdnFlight(a);
          let m = planeMarkers[a.id];
          if (!m) {
            m = L.marker([a.lat, a.lon], { icon: planeIcon(a, cdn), keyboard: false });
            planeMarkers[a.id] = m;
          } else {
            m.setLatLng([a.lat, a.lon]);
            m.setIcon(planeIcon(a, cdn));
          }
          m._a = a; m._cdn = cdn;
          m.bindTooltip(planeTooltip(a, cdn), { direction: 'top', offset: [0, -8] });
          if (!planeGroup.hasLayer(m)) m.addTo(planeGroup);

          if (a.callsign && !ROUTE_CACHE.has(a.callsign)) {
            if (looksLikeAirlineCallsign(a.callsign)) needRoute.push(a);
            else ROUTE_CACHE.set(a.callsign, null);  // GA/private — no filed route
          }
        });

        Object.keys(planeMarkers).forEach(id => {
          if (!seen.has(id)) {
            if (planeGroup.hasLayer(planeMarkers[id])) planeGroup.removeLayer(planeMarkers[id]);
            delete planeMarkers[id];
          }
        });

        // route lookups: cap per poll so backlog drains over successive polls
        if (needRoute.length) {
          await fetchRoutes(needRoute.slice(0, 40));
          Object.values(planeMarkers).forEach(m => {
            if (m._a) m.setTooltipContent(planeTooltip(m._a, m._cdn));
          });
        }
      }

      function startShips() {
        const key = getAisKey();
        if (!key) {
          status.ship = 'set localStorage aisstream_key to enable';
          updateLegend();
          return;
        }
        try { ws = new WebSocket(aisWsUrl()); }
        catch (e) { status.ship = `WS error: ${e.message}`; updateLegend(); return; }

        let connectedAt = 0;
        ws.onopen = () => {
          connectedAt = Date.now();
          status.ship = 'connected · waiting for data…'; updateLegend();
          const sub = {
            BoundingBoxes: [[[CANADA_BBOX.lamin, CANADA_BBOX.lomin], [CANADA_BBOX.lamax, CANADA_BBOX.lomax]]],
            FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
          };
          if (!proxyIsWorker()) sub.APIKey = key;  // worker injects it server-side
          ws.send(JSON.stringify(sub));
          // If no messages arrive within 15s, surface a hint (1-connection
          // limit, key not yet activated, or service outage).
          setTimeout(() => {
            if (rawCount === 0 && ws && ws.readyState === 1) {
              status.ship = 'connected · 0 msgs — likely AISStream outage (check github.com/aisstream/issues)';
              updateLegend();
            }
          }, 15000);
        };
        ws.onerror = () => { status.ship = 'WS error'; updateLegend(); };
        ws.onclose = (ev) => {
          status.ship = `disconnected (${ev.code}${ev.reason ? ': '+ev.reason : ''})`;
          updateLegend(); ws = null;
        };

        let rawCount = 0, plotted = 0, logged = 0;
        ws.onmessage = (ev) => {
          rawCount++;
          let msg; try { msg = JSON.parse(ev.data); } catch { return; }
          if (logged < 3) { console.debug('[tracking] AIS sample', msg); logged++; }

          const meta = msg.MetaData || msg.Metadata || msg.metaData || {};
          const body = msg.Message || msg.message || {};
          const pr = body.PositionReport || body.positionReport;
          const sd = body.ShipStaticData || body.shipStaticData;

          const mmsi = meta.MMSI || meta.mmsi || pr?.UserID || sd?.UserID;
          if (!mmsi) {
            if (rawCount <= 5 || rawCount % 100 === 0) {
              status.ship = `connected · ${rawCount} msgs · ${plotted} plotted (no MMSI?)`;
              updateLegend();
            }
            return;
          }

          let entry = shipMarkers[mmsi];
          if (!entry) entry = shipMarkers[mmsi] = { dest: null, name: meta.ShipName, marker: null };

          if (sd) {
            entry.dest = sd.Destination || sd.destination || entry.dest;
            entry.name = sd.Name || sd.name || entry.name;
          }

          let lat = meta.latitude ?? meta.Latitude;
          let lon = meta.longitude ?? meta.Longitude;
          if ((lat == null || lon == null) && pr) {
            lat = pr.Latitude ?? pr.latitude;
            lon = pr.Longitude ?? pr.longitude;
          }
          if (lat == null || lon == null) {
            if (rawCount % 50 === 0) {
              status.ship = `connected · ${rawCount} msgs · ${plotted} plotted`;
              updateLegend();
            }
            return;
          }

          let heading = 0, sog = 0;
          if (pr) {
            heading = (pr.TrueHeading != null && pr.TrueHeading !== 511) ? pr.TrueHeading : (pr.Cog || 0);
            sog = pr.Sog || 0;
          }

          const matched = shipDestMatchesCanada(entry.dest, lookups.portTokens);

          if (!entry.marker) {
            entry.marker = L.marker([lat, lon], { icon: shipIcon(heading, matched), keyboard: false });
            entry.marker.addTo(shipGroup);
            plotted++;
          } else {
            entry.marker.setLatLng([lat, lon]);
            entry.marker.setIcon(shipIcon(heading, matched));
          }
          entry.marker.bindTooltip(
            `<b>${(entry.name || meta.ShipName || 'Vessel').toString().trim()}</b><br>` +
            `MMSI ${mmsi}<br>` +
            (entry.dest ? `Dest: ${entry.dest}<br>` : '') +
            `${sog.toFixed(1)} kn · hdg ${Math.round(heading)}°`,
            { direction: 'top', offset: [0, -8] }
          );

          if (plotted <= 5 || plotted % 25 === 0 || rawCount % 200 === 0) {
            status.ship = `connected · ${rawCount} msgs · ${plotted} vessels`;
            updateLegend();
          }
        };
      }

      function legendHTML() {
        return `<div class="overlay-legend">
          <div class="overlay-legend-title">📡 Live Tracking</div>
          <div class="legend-item"><span class="color-dot" style="background:#dc2626"></span>✈ Canadian-registered</div>
          <div class="legend-item"><span class="color-dot" style="background:#475569"></span>✈ Foreign over Canada</div>
          <div class="legend-item"><span class="color-dot" style="background:#065f46"></span>✈ Military</div>
          <div class="wx-row" style="font-size:10px;color:#6b7280;">icon shape: GA · narrowbody · widebody · helicopter · jet</div>
          <div class="legend-item"><span class="color-dot" style="background:#0e7490"></span>🚢 Vessel (AIS) → CDN port</div>
          <div class="legend-item"><span class="color-dot" style="background:#ea580c"></span>🐟 Fishing vessel (GFW, 7d)</div>
          <div class="wx-row" style="margin-top:6px;" id="tracking-status">connecting…</div>
          <div class="wx-row">Refresh: ✈ ${AIRCRAFT_POLL_MS/1000}s · 🐟 1h</div>
        </div>`;
      }

      function controls() {
        const wrap = document.createElement('div');
        [['planes', '✈ Aircraft'], ['ships', '🚢 Ships (AIS)'], ['fishing', '🐟 Fishing (GFW)']]
          .forEach(([k, label]) => {
            const lab = document.createElement('label');
            lab.className = 'mapmode-sub-item';
            lab.innerHTML = `<input type="checkbox" ${visible[k] ? 'checked' : ''}> ${label}`;
            lab.querySelector('input').onchange = (e) => {
              visible[k] = e.target.checked;
              applyVisibility();
            };
            wrap.appendChild(lab);
          });
        return wrap;
      }

      return {
        mount(m) {
          mapRef = m;
          planeGroup.addTo(m);
          shipGroup.addTo(m);
          fishGroup.addTo(m);
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
          legendCtl.addTo(m);
          updateLegend();

          pollPlanes().catch(e => console.warn('[tracking] initial poll', e));
          pollTimer = setInterval(() => pollPlanes().catch(() => {}), AIRCRAFT_POLL_MS);
          startShips();
          loadFishing();
          fishTimer = setInterval(loadFishing, 60 * 60 * 1000);
        },
        controls,
        unmount(m) {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (fishTimer) { clearInterval(fishTimer); fishTimer = null; }
          if (ws) { try { ws.close(); } catch {} ws = null; }
          planeGroup.clearLayers(); if (m.hasLayer(planeGroup)) m.removeLayer(planeGroup);
          shipGroup.clearLayers(); if (m.hasLayer(shipGroup)) m.removeLayer(shipGroup);
          fishGroup.clearLayers(); if (m.hasLayer(fishGroup)) m.removeLayer(fishGroup);
          Object.keys(planeMarkers).forEach(k => delete planeMarkers[k]);
          Object.keys(shipMarkers).forEach(k => delete shipMarkers[k]);
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
          mapRef = null;
        }
      };
    }
  });
})();
