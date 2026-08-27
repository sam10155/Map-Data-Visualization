/**
 * Live aircraft + ship tracking overlay.
 * (Trains — VIA + city transit — live in js/layers/transit.js, the 🚏 tab.)
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
 *   NOTE: AISStream sends *binary* WebSocket frames — in a browser ev.data
 *   is a Blob/ArrayBuffer, not a string, and must be decoded before parsing.
 *
 * AIS API health: polled from the public AISStream-Uptime service
 *   (github.com/buttermilkgreen/AISStream-Uptime) so the legend can tell
 *   "AISStream is down for everyone" apart from "your key/connection is
 *   broken".
 *
 * Both feeds report status into the legend so the user can see why a
 * sub-layer is empty.
 */

(function () {
  const CANADA_BBOX = { lamin: 41.5, lamax: 83.2, lomin: -141.0, lomax: -52.5 };

  // Piecewise southern boundary approximating the Canada–US border, so we
  // don't subscribe to / draw traffic deep in Washington, New York, etc.
  // [westLon, minLat]: the min latitude applies from that longitude east
  // until the next entry. Border-hugging US cities (Detroit, Bellingham)
  // remain inside — the steps only cut areas well south of the border.
  const S_BOUNDARY = [
    [-141.0, 48.2],  // AK panhandle → Juan de Fuca Strait / Victoria
    [-123.3, 48.9],  // 49th parallel: BC interior → Lake of the Woods
    [-95.2, 48.0],   // Lake of the Woods → Lake Superior
    [-89.0, 46.0],   // Lake Superior → Sault Ste. Marie
    [-84.5, 42.9],   // Lake Huron shore → Sarnia
    [-83.2, 41.6],   // Windsor / Lake Erie / Pelee Island
    [-78.9, 43.2],   // Niagara → Lake Ontario
    [-76.5, 44.0],   // Thousand Islands / upper St. Lawrence
    [-74.5, 44.8],   // 45th parallel (QC / NY / VT / ME)
    [-67.8, 44.4],   // Bay of Fundy / Grand Manan
    [-66.5, 43.3],   // Nova Scotia south shore → Atlantic
  ];

  function minLatAt(lon) {
    let m = S_BOUNDARY[0][1];
    for (const [w, lat] of S_BOUNDARY) { if (lon >= w) m = lat; else break; }
    return m;
  }
  function inTrackingArea(lat, lon) {
    return lat <= CANADA_BBOX.lamax &&
           lon >= CANADA_BBOX.lomin && lon <= CANADA_BBOX.lomax &&
           lat >= minLatAt(lon);
  }
  // One [SW, NE] box per boundary band (AISStream / GeoJSON builders below).
  function boundaryBands() {
    return S_BOUNDARY.map(([w, lat], i) => {
      const e = i + 1 < S_BOUNDARY.length ? S_BOUNDARY[i + 1][0] : CANADA_BBOX.lomax;
      return { w, e, lat };
    });
  }
  // Stepped GeoJSON polygon of the tracking area (lon,lat order) for GFW.
  function trackingAreaPolygon() {
    const ring = [];
    boundaryBands().forEach(b => ring.push([b.w, b.lat], [b.e, b.lat]));
    ring.push([CANADA_BBOX.lomax, CANADA_BBOX.lamax], [CANADA_BBOX.lomin, CANADA_BBOX.lamax]);
    ring.push(ring[0]);
    return { type: 'Polygon', coordinates: [ring] };
  }
  // 32 tiles × ~1.1s gap (airplanes.live allows ~1 req/s) ≈ 40-50s per
  // sweep, so poll at 60s. The busy-guard in pollPlanes prevents overlap.
  const AIRCRAFT_POLL_MS = 60000;

  // Optional proxy (e.g. a Cloudflare Worker) for GitHub-Pages deployments.
  // If set, requests go to `${TRACKING_PROXY}<host>/<path>`. Configure via
  // window.TRACKING_PROXY in data/config.js.
  const PROXY = (function () {
    let p = window.TRACKING_PROXY || null;
    if (!p) return null;
    p = String(p).trim();
    // Local dev: serve.py's relative /proxy/ path — leave as-is.
    if (p.startsWith('/')) return p.replace(/\/?$/, '/');
    // Hosted worker: ensure protocol + trailing slash.
    if (!/^https?:\/\//i.test(p)) p = 'https://' + p;
    return p.replace(/\/?$/, '/');
  })();

  // 250 nm (~463 km) circles tiling the whole country, coast to coast to
  // coast — verified to cover every community from Windsor to Alert.
  // Traffic in the north is sparse but polar routes cross it constantly.
  const ADSB_CENTRES = [
    // southern corridor
    [49.3,-123.1],   // Vancouver / Pacific NW
    [51.1,-114.0],   // Calgary / Edmonton corridor
    [50.4,-104.6],   // Regina / SK-MB
    [49.9,-97.1],    // Winnipeg / NW ON
    [43.7,-79.6],    // GTA / SW ON
    [45.5,-73.6],    // Montréal / QC
    // east
    [46.5,-64.0],    // Moncton / Maritimes
    [48.4,-71.1],    // Saguenay / central QC
    [50.2,-66.4],    // Sept-Îles / North Shore
    [47.6,-52.7],    // St. John's / Newfoundland
    [53.3,-60.4],    // Goose Bay / Labrador
    // mid-north
    [48.4,-89.2],    // Thunder Bay / NW ON
    [50.0,-81.0],    // Timmins / James Bay
    [55.3,-77.8],    // Kuujjuarapik / E Hudson Bay
    [58.1,-68.4],    // Kuujjuaq / Nunavik
    [58.8,-94.2],    // Churchill / Thompson
    [55.1,-105.3],   // La Ronge / N SK
    [56.7,-111.4],   // Fort McMurray
    [53.9,-122.8],   // Prince George
    [54.4,-129.5],   // Terrace / Prince Rupert / BC coast
    [57.5,-122.5],   // Fort St. John / Fort Nelson
    // territories & Arctic
    [60.7,-135.1],   // Whitehorse / Yukon
    [64.1,-139.4],   // Dawson / Old Crow
    [68.4,-133.5],   // Inuvik / Beaufort
    [72.0,-125.0],   // Banks Island / W Arctic
    [62.5,-114.4],   // Yellowknife
    [64.3,-96.0],    // Baker Lake / Kivalliq
    [69.1,-105.1],   // Cambridge Bay / Kitikmeot
    [63.7,-68.5],    // Iqaluit / S Baffin
    [72.7,-78.0],    // Pond Inlet / N Baffin
    [74.7,-95.0],    // Resolute
    [81.2,-74.0],    // Eureka / Alert / high Arctic
  ];
  const ADSB_RADIUS_NM = 250;
  const TILE_GAP_MS = 1100;        // airplanes.live rate limit is ~1 req/s
  const FEED_COOLDOWN_MS = 5 * 60000;  // skip a feed for 5 min after it fails a sweep

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
    if (!inTrackingArea(a.lat, a.lon)) return null;
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
    // (No adsb.lol route fallback: that endpoint answers with a 302, which
    // browsers block on CORS and both proxies block as an SSRF guard.)
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

  // Per-host transport choice for the community ADS-B APIs: they now
  // block datacenter/Cloudflare IPs (the worker gets 403/429) while
  // remaining reachable from residential browsers — so try DIRECT first
  // and only fall back to the proxy per host. The winning transport is
  // remembered so a sweep doesn't double-request every tile.
  const adsbTransport = { 'adsbexchange-com1.p.rapidapi.com': 'proxy' };

  async function afetch(host, path) {
    const mode = adsbTransport[host];
    if (mode !== 'proxy') {
      try {
        const j = await tfetch(`https://${host}/${path}`);
        adsbTransport[host] = 'direct';
        return j;
      } catch (e) {
        if (mode === 'direct' || !PROXY) throw e;  // direct was fine before (or no proxy) — real error
        adsbTransport[host] = 'proxy';
      }
    }
    return tfetch(buildUrl(host, path));
  }

  async function fetchTiledFeed(host, pathFn, label, onProgress) {
    const seen = {};
    let okCount = 0, lastErr = null, consecFails = 0, i = 0;
    for (const [la, lo] of ADSB_CENTRES) {
      i++;
      try {
        const json = await afetch(host, pathFn(la, lo));
        okCount++;
        consecFails = 0;
        (json.ac || json.aircraft || []).forEach(a => {
          const n = normalizeAc(a);
          if (n && !seen[n.id]) seen[n.id] = n;
        });
      } catch (e) {
        lastErr = e;
        // 3 straight failures = the source is down or rate-limiting us;
        // abort the sweep instead of burning 30 more doomed requests.
        if (++consecFails >= 3) break;
      }
      onProgress?.(i, ADSB_CENTRES.length, Object.keys(seen).length);
      await sleep(TILE_GAP_MS);
    }
    if (okCount === 0) throw new Error(`${label}: ${lastErr?.message || 'unreachable'}`);
    return Object.values(seen);
  }

  // ---- ADS-B Exchange (paid, metered per request) ----
  // Only fetches the tiles nearest the current view (max 4) instead of the
  // 32-tile national sweep, so the RapidAPI bill tracks actual usage.
  // Requires the ADSBX_KEY worker secret (or ADSBX_KEY env for serve.py);
  // without it the worker answers 503 and the free chain takes over.
  const ADSBX_HOST = 'adsbexchange-com1.p.rapidapi.com';
  const ADSBX_MAX_TILES = 4;

  function nearestCentres(m, n) {
    const c = m ? m.getCenter() : { lat: 52, lng: -95 };
    return [...ADSB_CENTRES]
      .sort((a, b) =>
        (Math.abs(a[0]-c.lat)+Math.abs(a[1]-c.lng)) -
        (Math.abs(b[0]-c.lat)+Math.abs(b[1]-c.lng)))
      .slice(0, n);
  }

  async function fetchAdsbx(onProgress, m) {
    const seen = {};
    let okCount = 0, lastErr = null, i = 0;
    const tiles = nearestCentres(m, ADSBX_MAX_TILES);
    for (const [la, lo] of tiles) {
      i++;
      try {
        const json = await tfetch(buildUrl(ADSBX_HOST, `v2/point/${la}/${lo}/${ADSB_RADIUS_NM}/`));
        okCount++;
        (json.ac || []).forEach(a => {
          const n = normalizeAc(a);
          if (n && !seen[n.id]) seen[n.id] = n;
        });
      } catch (e) {
        lastErr = e;
        break;   // 503 = key not configured; 401/429 = key/quota problem — bail fast
      }
      onProgress?.(i, tiles.length, Object.keys(seen).length);
      await sleep(300);
    }
    if (okCount === 0) throw new Error(`adsbx: ${lastErr?.message || 'unreachable'}`);
    return Object.values(seen);
  }

  const fetchAirplanesLive = (p) => fetchTiledFeed(
    'api.airplanes.live', (la,lo) => `v2/point/${la}/${lo}/${ADSB_RADIUS_NM}`, 'airplanes.live', p);
  const fetchAdsbLol = (p) => fetchTiledFeed(
    'api.adsb.lol', (la,lo) => `v2/point/${la}/${lo}/${ADSB_RADIUS_NM}`, 'adsb.lol', p);
  const fetchAdsbFi = (p) => fetchTiledFeed(
    'opendata.adsb.fi', (la,lo) => `api/v2/lat/${la}/lon/${lo}/dist/${ADSB_RADIUS_NM}`, 'adsb.fi', p);

  async function fetchOpenSky() {
    const url = buildUrl('opensky-network.org',
      `api/states/all?lamin=${CANADA_BBOX.lamin}&lamax=${CANADA_BBOX.lamax}&lomin=${CANADA_BBOX.lomin}&lomax=${CANADA_BBOX.lomax}`);
    const json = await tfetch(url, 10000);
    return (json.states || [])
      .filter(s => s[5] != null && s[6] != null && !s[8] && inTrackingArea(s[6], s[5]))
      .map(s => ({
      id: s[0], callsign: (s[1] || '').trim(), reg: null,
      lat: s[6], lon: s[5], alt: s[13] ?? s[7],
      gs: (s[9] || 0) * 1.94384, track: s[10],
      type: null, opIcao: s[2],
    }));
  }

  const feedCooldown = {};   // label → timestamp until which the feed is skipped
  let updateLegendRef = null;  // set by the mode instance so sweeps can report progress

  async function fetchAircraft(status) {
    const sources = [
      // Paid, metered — first when its worker secret is configured; the
      // worker answers 503 instantly when it isn't, so the free chain
      // takes over with one cheap request wasted per 5-min cooldown.
      ['ADS-B Exchange', (p) => fetchAdsbx(p, window.map)],
      ['airplanes.live', fetchAirplanesLive],
      ['adsb.lol',       fetchAdsbLol],
      ['adsb.fi',        fetchAdsbFi],
      ['OpenSky',        fetchOpenSky],
    ];
    const errs = [];
    for (const [label, fn] of sources) {
      if ((feedCooldown[label] || 0) > Date.now()) continue;
      try {
        const list = await fn((done, total, found) => {
          status.air = `${label} · scanning ${done}/${total} tiles · ${found} aircraft`;
          updateLegendRef?.();
        });
        status.air = `${label} · ${list.length} aircraft`;
        return list;
      } catch (e) {
        feedCooldown[label] = Date.now() + FEED_COOLDOWN_MS;
        errs.push(`${label}: ${e.message || e}`);
        console.warn(`[tracking] ${label} failed — cooling down 5 min`, e);
      }
    }
    status.air = errs.length ? `feed error — ${errs.join(' · ')}` : status.air;
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

  // AIS ship-type code (ShipStaticData.Type) → colour.
  // https://api.vtexplorer.com/docs/ref-aistypes.html
  const SHIP_TYPE_COLORS = [
    { test: t => t >= 60 && t <= 69,             color: '#2563eb', label: 'Ferry / passenger' },
    { test: t => t >= 70 && t <= 79,             color: '#16a34a', label: 'Cargo / bulk' },
    { test: t => t >= 80 && t <= 89,             color: '#dc2626', label: 'Tanker (oil/gas/chem)' },
    { test: t => t === 36 || t === 37,           color: '#ec4899', label: 'Pleasure craft' },
    { test: t => t === 31 || t === 32 || t === 52, color: '#eab308', label: 'Tug / towing' },
    { test: t => t === 35 || t === 51 || t === 55, color: '#0f172a', label: 'Navy / SAR / law' },
  ];
  const SHIP_OTHER = { color: '#94a3b8', label: 'Other / unknown' };

  function shipClass(type, name) {
    const t = Number(type);
    if (Number.isFinite(t) && t > 0) {
      const c = SHIP_TYPE_COLORS.find(c => c.test(t));
      if (c) return c;
    }
    // No usable type code (static data not yet received, or type 0) —
    // fall back on the vessel name for the unmistakable cases.
    const n = (name || '').toUpperCase();
    if (/FERRY|SPIRIT OF|QUEEN OF|COASTAL (CELEBRATION|INSPIRATION|RENAISSANCE)|SEASPAN \w+ FERRY/.test(n))
      return SHIP_TYPE_COLORS[0];                       // ferry / passenger
    if (/\bTUG\b|TUGBOAT/.test(n)) return SHIP_TYPE_COLORS[4];  // tug
    if (/^(CCGS|HMCS|NCSM)\b/.test(n)) return SHIP_TYPE_COLORS[5]; // coast guard / navy
    return SHIP_OTHER;
  }

  // MMSI → {t: typeCode, n: name} cache persisted across reloads: static
  // data only broadcasts every ~6 min, so without this every visit starts
  // with a sea of grey ships.
  const SHIP_TYPE_CACHE_KEY = 'ais_type_cache_v1';
  const shipTypeCache = (() => {
    try { return JSON.parse(localStorage.getItem(SHIP_TYPE_CACHE_KEY)) || {}; }
    catch { return {}; }
  })();
  let typeCacheDirty = false;
  setInterval(() => {
    if (!typeCacheDirty) return;
    typeCacheDirty = false;
    try {
      const keys = Object.keys(shipTypeCache);
      // cap ~4000 entries to stay well under localStorage quotas
      if (keys.length > 4000) keys.slice(0, keys.length - 4000).forEach(k => delete shipTypeCache[k]);
      localStorage.setItem(SHIP_TYPE_CACHE_KEY, JSON.stringify(shipTypeCache));
    } catch {}
  }, 30000);

  function shipIcon(heading, type, name) {
    const fill = shipClass(type, name).color;
    return L.divIcon({
      className: 'track-ship',
      html: `<svg width="20" height="20" viewBox="-10 -10 20 20">
        <g transform="rotate(${heading || 0})">
          <path d="M0,-8 L4,2 L2,7 L-2,7 L-4,2 Z" fill="${fill}" stroke="white" stroke-width="0.8"/>
        </g></svg>`,
      iconSize: [20, 20], iconAnchor: [10, 10]
    });
  }

  // ---- AISStream API health (AISStream-Uptime monitor) ---------------------
  // Polls the public AISStream-Uptime service
  // (github.com/buttermilkgreen/AISStream-Uptime) for the upstream service
  // state: Up / Silent Failure / Auth Error / Down. CORS-open, no key needed.
  const AIS_UPTIME_BASE = 'https://aisuptime.buttermilkgreen.fyi';
  const AIS_UPTIME_POLL_MS = 60000;

  const AIS_API_STATE = {
    'Up':             { icon: '🟢', hint: 'AISStream API up' },
    'Silent Failure': { icon: '🟡', hint: 'AISStream connected but silent (upstream issue)' },
    'Auth Error':     { icon: '🟠', hint: 'monitor reports auth errors upstream' },
    'Down':           { icon: '🔴', hint: 'AISStream API down' },
  };

  async function fetchAisApiStatus() {
    // Via the proxy when configured — some networks/edges mangle the direct
    // call; the worker/serve.py fetch it server-side instead.
    const url = PROXY
      ? buildUrl('aisuptime.buttermilkgreen.fyi', 'api/v1/status?simple=true')
      : `${AIS_UPTIME_BASE}/api/v1/status?simple=true`;
    const j = await qfetch(url, 8000);
    if (!j || !j.state) return null;
    return {
      state: j.state,
      lastMessage: j.lastMessageReceived ? new Date(j.lastMessageReceived) : null,
      ...(AIS_API_STATE[j.state] || { icon: '⚪', hint: j.state }),
    };
  }

  // When TRACKING_PROXY points at a deployed Cloudflare Worker (https://…),
  // the worker holds the keys and the browser never sees them.
  function proxyIsWorker() {
    return typeof PROXY === 'string' && /^https?:\/\//i.test(PROXY);
  }
  // The browser always connects to AISStream directly: relaying the stream
  // through a Cloudflare Worker doesn't work (AISStream accepts the
  // subscription but never sends data to Workers-egress connections).
  // In worker mode the key is fetched from the worker's /ais/key instead.
  function aisWsUrl() {
    return 'wss://stream.aisstream.io/v0/stream';
  }
  let workerAisKey = null;
  async function fetchWorkerAisKey() {
    if (workerAisKey) return workerAisKey;
    const j = await qfetch(PROXY.replace(/\/?$/, '/') + 'ais/key', 8000);
    workerAisKey = j?.key || null;
    return workerAisKey;
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
      geometry: trackingAreaPolygon(),
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
      let apiTimer = null;
      let ws = null;
      let wsRetry = 0;
      let wsRetryTimer = null;
      let unmounted = false;
      let legendCtl = null;
      let mapRef = null;
      const lookups = buildLookups();
      const visible = { planes: true, ships: true, fishing: true };

      function applyVisibility() {
        if (!mapRef) return;
        [['planes', planeGroup], ['ships', shipGroup], ['fishing', fishGroup]].forEach(([k, g]) => {
          if (visible[k]) { if (!mapRef.hasLayer(g)) g.addTo(mapRef); }
          else if (mapRef.hasLayer(g)) mapRef.removeLayer(g);
        });
      }

      // Canadian airports: ICAO CYxx/CZxx, IATA Yxx (both letter systems
      // are reserved for Canada).
      function isCdnAirport(code) {
        if (!code) return false;
        const c = String(code).toUpperCase();
        return c.length === 4 ? /^C[YZ]/.test(c) : /^Y/.test(c);
      }
      function isCdnFlight(a) {
        if (isCanadianReg(a.reg)) return true;
        if (a.id && /^c[0-3]/i.test(a.id)) return true;     // ICAO24 C00000–C3FFFF = Canada
        if (a.opIcao === 'Canada') return true;
        // Route known and it departs/arrives in Canada
        const r = a.callsign ? ROUTE_CACHE.get(a.callsign) : null;
        if (r && (isCdnAirport(r.from) || isCdnAirport(r.to))) return true;
        return false;
      }

      function updateLegend() {
        const el = document.getElementById('tracking-status');
        if (!el) return;
        const api = status.api
          ? `${status.api.icon} AIS API: ${eh(status.api.state)}` +
            (status.api.lastMessage
              ? ` <span style="font-size:10px;color:#9ca3af;">(msg ${eh(agoStr(status.api.lastMessage))})</span>` : '')
          : '⚪ AIS API: checking…';
        el.innerHTML =
          `✈ ${eh(status.air)}<br>🚢 ${eh(status.ship)}<br>${api}<br>🐟 ${eh(status.fish)}`;
      }

      function agoStr(d) {
        const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
        if (s < 90) return `${s}s ago`;
        if (s < 5400) return `${Math.round(s / 60)}m ago`;
        return `${Math.round(s / 3600)}h ago`;
      }

      async function pollAisApi() {
        const r = await fetchAisApiStatus();
        // Keep the last good reading through a transient fetch failure;
        // only show "unreachable" if we've never gotten one.
        if (r) status.api = r;
        else if (!status.api) status.api = { state: 'monitor unreachable', icon: '⚪', hint: 'uptime monitor unreachable', lastMessage: null };
        updateLegend();
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
                `<b>🐟 ${eh(v.name)}</b>` +
                (v.flag ? ` · ${eh(v.flag)}` : '') + '<br>' +
                (v.mmsi ? `MMSI ${eh(v.mmsi)}<br>` : '') +
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
          routeHtml = `<b>${eh(route.from)} → ${eh(route.to)}</b>` +
            (route.airline ? ` · ${eh(route.airline)}` : '') + '<br>' +
            `<span style="font-size:10px;color:#6b7280;">${eh(route.fromName || '')}<br>→ ${eh(route.toName || '')}</span><br>`;
        } else if (route === undefined && a.callsign) {
          routeHtml = '<span style="font-size:10px;color:#9ca3af;">route: looking up…</span><br>';
        } else if (route === null) {
          routeHtml = '<span style="font-size:10px;color:#9ca3af;">route: unknown</span><br>';
        }
        return `<b>${eh(a.callsign || a.reg || a.id)}</b>` +
          (a.type ? ` · ${eh(a.type)}` : '') +
          ` <span style="font-size:10px;color:#6b7280;">${CAT_LABEL[a._cat] || ''}</span><br>` +
          (a.reg ? `${eh(a.reg)}${cdn ? ' 🇨🇦' : ''}<br>` : '') +
          routeHtml +
          `Alt ${a.alt != null ? Math.round(a.alt).toLocaleString() + ' ft' : '—'} · ` +
          `${Math.round(a.gs || 0)} kt · hdg ${Math.round(a.track || 0)}°`;
      }

      let planePollBusy = false;
      async function pollPlanes() {
        if (planePollBusy) return;   // a slow tile sweep can outlast the interval
        planePollBusy = true;
        try { await pollPlanesInner(); }
        finally { planePollBusy = false; }
      }

      async function pollPlanesInner() {
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
            // Hover with no cached route → look it up immediately rather
            // than waiting for this plane's turn in the batched backlog.
            m.on('tooltipopen', () => {
              const ac = m._a;
              if (!ac?.callsign || ROUTE_CACHE.has(ac.callsign)) return;
              if (!looksLikeAirlineCallsign(ac.callsign)) return;
              lookupRouteOne(ac.callsign)
                .then(r => { ROUTE_CACHE.set(ac.callsign, r); })
                .catch(() => { ROUTE_CACHE.set(ac.callsign, null); })
                .then(() => {
                  const cdn = isCdnFlight(ac);
                  if (cdn !== m._cdn) { m._cdn = cdn; m.setIcon(planeIcon(ac, cdn)); }
                  m.setTooltipContent(planeTooltip(ac, m._cdn));
                });
            });
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
            if (!m._a) return;
            // Route data can change the Canadian determination — re-evaluate
            // and recolor, don't just refresh the tooltip text.
            const cdn = isCdnFlight(m._a);
            if (cdn !== m._cdn) { m._cdn = cdn; m.setIcon(planeIcon(m._a, cdn)); }
            m.setTooltipContent(planeTooltip(m._a, m._cdn));
          });
        }
      }

      function scheduleShipReconnect() {
        if (unmounted || wsRetryTimer) return;
        const delay = Math.min(60000, 2000 * 2 ** wsRetry++);
        status.ship += ` · retrying in ${Math.round(delay / 1000)}s`;
        updateLegend();
        wsRetryTimer = setTimeout(() => { wsRetryTimer = null; startShips().catch(() => {}); }, delay);
      }

      async function startShips() {
        let key = getAisKey();
        if (proxyIsWorker()) {
          status.ship = 'fetching key…'; updateLegend();
          key = await fetchWorkerAisKey();
          if (unmounted) return;
          if (!key) {
            status.ship = 'worker has no AISSTREAM_API_KEY configured';
            updateLegend();
            return;
          }
        }
        if (!key) {
          status.ship = 'set localStorage aisstream_key to enable';
          updateLegend();
          return;
        }
        try { ws = new WebSocket(aisWsUrl()); }
        catch (e) { status.ship = `WS error: ${e.message}`; updateLegend(); return; }
        // AISStream sends binary frames; default binaryType 'blob' would need
        // an async read per message — arraybuffer decodes synchronously.
        ws.binaryType = 'arraybuffer';
        const decoder = new TextDecoder();

        ws.onopen = () => {
          wsRetry = 0;
          status.ship = 'connected · waiting for data…'; updateLegend();
          const sub = {
            // One box per southern-boundary band — keeps Puget Sound, the
            // US Great Lakes shore and the US Atlantic coast out of the feed.
            BoundingBoxes: boundaryBands().map(b =>
              [[b.lat, b.w], [CANADA_BBOX.lamax, b.e]]),
            // Class A position+static AND Class B (small vessels — many
            // ferries, tugs, pleasure craft only transmit Class B).
            FilterMessageTypes: ['PositionReport', 'ShipStaticData',
              'StandardClassBPositionReport', 'ExtendedClassBPositionReport',
              'StaticDataReport'],
            APIKey: key,   // always direct-to-AISStream now
          };
          ws.send(JSON.stringify(sub));
          // If no messages arrive within 15s, use the uptime monitor to tell
          // an AISStream outage apart from a local key/connection problem.
          setTimeout(() => {
            if (rawCount === 0 && ws && ws.readyState === 1) {
              status.ship = (status.api && status.api.state !== 'Up')
                ? `connected · 0 msgs — ${status.api.hint}`
                : 'connected · 0 msgs — key not activated, or 1-connection limit hit';
              updateLegend();
            }
          }, 15000);
        };
        ws.onerror = () => { status.ship = 'WS error'; updateLegend(); };
        ws.onclose = (ev) => {
          ws = null;
          if (unmounted) return;
          // AISStream closes ~4s in when the key is bad; don't hammer it.
          if (rawCount === 0 && (ev.code === 1008 || /key/i.test(ev.reason || ''))) {
            status.ship = `rejected (${ev.code}${ev.reason ? ': ' + ev.reason : ''}) — check API key`;
            updateLegend();
            return;
          }
          // 4000 = worker-relayed upstream failure; reason says what happened.
          status.ship = ev.code === 4000 && ev.reason
            ? `disconnected — ${ev.reason}`
            : `disconnected (${ev.code})`;
          scheduleShipReconnect();
        };

        let rawCount = 0, parseFails = 0, plotted = 0, logged = 0;
        ws.onmessage = (ev) => {
          rawCount++;
          let msg;
          try {
            const text = typeof ev.data === 'string' ? ev.data : decoder.decode(ev.data);
            if (!text.trim()) return;   // keepalive/empty frame — not an error
            msg = JSON.parse(text);
          } catch (e) {
            if (++parseFails <= 3) console.warn('[tracking] AIS frame decode failed', e, ev.data);
            if (parseFails === 1 || parseFails % 100 === 0) {
              status.ship = `connected · ${rawCount} msgs · ${parseFails} undecodable`;
              updateLegend();
            }
            return;
          }
          if (logged < 3) { console.debug('[tracking] AIS sample', msg); logged++; }

          const meta = msg.MetaData || msg.Metadata || msg.metaData || {};
          const body = msg.Message || msg.message || {};
          const pr = body.PositionReport || body.positionReport ||
                     body.StandardClassBPositionReport || body.ExtendedClassBPositionReport;
          // Static data: Class A ShipStaticData, or Class B StaticDataReport
          // (part B carries ShipType); ExtendedClassB also carries Type.
          const sdr = body.StaticDataReport;
          const sd = body.ShipStaticData || body.shipStaticData ||
                     (sdr?.ReportB ? {
                       Name: sdr.ReportA?.Name,
                       Type: sdr.ReportB.ShipType,
                       UserID: sdr.UserID,
                     } : null) ||
                     (body.ExtendedClassBPositionReport?.Type != null ? {
                       Name: body.ExtendedClassBPositionReport.Name,
                       Type: body.ExtendedClassBPositionReport.Type,
                       UserID: body.ExtendedClassBPositionReport.UserID,
                     } : null);

          const mmsi = meta.MMSI || meta.mmsi || pr?.UserID || sd?.UserID || sdr?.UserID;
          if (!mmsi) {
            if (rawCount <= 5 || rawCount % 100 === 0) {
              status.ship = `connected · ${rawCount} msgs · ${plotted} plotted (no MMSI?)`;
              updateLegend();
            }
            return;
          }

          let entry = shipMarkers[mmsi];
          if (!entry) {
            const cached = shipTypeCache[mmsi];
            entry = shipMarkers[mmsi] = {
              dest: null,
              name: meta.ShipName || cached?.n,
              type: cached?.t ?? null,
              marker: null,
            };
          }

          if (sd) {
            entry.dest = sd.Destination || sd.destination || entry.dest;
            entry.name = sd.Name || sd.name || entry.name;
            const newType = sd.Type ?? sd.type;
            if (newType != null && newType !== entry.type) {
              entry.type = newType;
              shipTypeCache[mmsi] = { t: newType, n: entry.name };
              typeCacheDirty = true;
            }
          }

          let lat = meta.latitude ?? meta.Latitude;
          let lon = meta.longitude ?? meta.Longitude;
          if ((lat == null || lon == null) && pr) {
            lat = pr.Latitude ?? pr.latitude;
            lon = pr.Longitude ?? pr.longitude;
          }
          if (lat == null || lon == null || !inTrackingArea(lat, lon)) {
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

          if (!entry.marker) {
            entry.marker = L.marker([lat, lon], { icon: shipIcon(heading, entry.type, entry.name), keyboard: false });
            entry.marker.addTo(shipGroup);
            plotted++;
          } else {
            entry.marker.setLatLng([lat, lon]);
            entry.marker.setIcon(shipIcon(heading, entry.type, entry.name));
          }
          entry.marker.bindTooltip(
            `<b>${eh((entry.name || meta.ShipName || 'Vessel').toString().trim())}</b>` +
            ` <span style="font-size:10px;color:#6b7280;">${eh(shipClass(entry.type, entry.name).label)}</span><br>` +
            `MMSI ${eh(mmsi)}<br>` +
            (entry.dest ? `Dest: ${eh(entry.dest)}<br>` : '') +
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
          ${SHIP_TYPE_COLORS.map(c =>
            `<div class="legend-item"><span class="color-dot" style="background:${c.color}"></span>🚢 ${c.label}</div>`
          ).join('')}
          <div class="legend-item"><span class="color-dot" style="background:${SHIP_OTHER.color}"></span>🚢 ${SHIP_OTHER.label}</div>
                    <div class="legend-item"><span class="color-dot" style="background:#ea580c"></span>🐟 Fishing vessel (GFW, 7d)</div>
          <div class="wx-row" style="margin-top:6px;" id="tracking-status">connecting…</div>
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

          unmounted = false;
          updateLegendRef = updateLegend;
          pollPlanes().catch(e => console.warn('[tracking] initial poll', e));
          pollTimer = setInterval(() => pollPlanes().catch(() => {}), AIRCRAFT_POLL_MS);
          pollAisApi().catch(() => {});
          apiTimer = setInterval(() => pollAisApi().catch(() => {}), AIS_UPTIME_POLL_MS);
          startShips().catch(e => console.warn('[tracking] startShips', e));
          loadFishing();
          fishTimer = setInterval(loadFishing, 60 * 60 * 1000);
        },
        controls,
        unmount(m) {
          unmounted = true;
          updateLegendRef = null;
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (fishTimer) { clearInterval(fishTimer); fishTimer = null; }
          if (apiTimer) { clearInterval(apiTimer); apiTimer = null; }
          if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
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

