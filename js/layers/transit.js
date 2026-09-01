/**
 * 🚏 Transit — dedicated live passenger-rail & city-transit overlay.
 *
 *  Mode toggles: 🚌 Bus · 🚋 Streetcar · 🚈 LRT · 🚆 Regional (GO/UP) · 🚄 VIA.
 *  • City fleets come from open GTFS-Realtime VehiclePositions feeds
 *    (protobuf, decoded by the minimal reader below). Viewport-gated:
 *    local modes fetch at zoom ≥ 10, icons at zoom ≥ 12 (canvas dots
 *    below that — the TTC alone runs ~1,700 vehicles).
 *  • Regional rail (GO/UP Express) + VIA show at any zoom.
 *  • Icons are top-down SVGs rotated to heading, coloured per system.
 *
 *  API keys (all free) — set once in the browser console, then reload:
 *    localStorage.setItem('metrolinx_key',  '...')  // GO/UP — api.openmetrolinx.com
 *    localStorage.setItem('translink_key',  '...')  // Vancouver — translink.ca developers
 *    localStorage.setItem('stm_key',        '...')  // Montréal — portail.developpeurs.stm.info
 *    localStorage.setItem('octranspo_key',  '...')  // Ottawa — nextrip-public-api.developer.azure-api.net
 *  Keyless agencies work with no setup. Winnipeg, RTC Québec, TTC subway
 *  and the Montréal métro publish no vehicle positions at all.
 */

(function () {
  const POLL_MS = 25000;
  const LOCAL_ZOOM = 10;      // bus/streetcar/LRT fetch threshold
  const ICON_ZOOM = 12;       // icons vs canvas dots for local modes

  const MODES = {
    bus:       { label: '🚌 Bus',            local: true },
    streetcar: { label: '🚋 Streetcar',      local: true },
    lrt:       { label: '🚈 LRT',            local: true },
    regional:  { label: '🚆 GO / commuter',  local: false },
    via:       { label: '🚄 VIA Rail',       local: false },
  };

  // rules: [regex on route_id, mode] — first match wins; default 'bus'.
  const AGENCIES = [
    { id: 'ttc', label: 'TTC', color: '#da2128',
      host: 'bustime.ttc.ca', path: 'gtfsrt/vehicles',
      bbox: [43.55, -79.65, 43.90, -79.10],
      rules: [[/^5[01]\d/, 'streetcar']] },
    { id: 'calgary', label: 'Calgary Transit', color: '#c8102e',
      host: 'data.calgary.ca', path: 'download/am7c-qe3u/application%2Foctet-stream',
      bbox: [50.80, -114.35, 51.25, -113.80],   // via proxy: the Socrata
      // 302 hop has no CORS headers, so browsers can't follow it direct.
      // VehiclePositions carries NO route_id — only trip_id — so routes
      // (and CTrain identification) come from joining the TripUpdates feed.
      tripFeed: 'download/gs4m-mdc2/application%2Foctet-stream',
      rules: [[/^20[12]$/, 'lrt']] },
    { id: 'ets', label: 'Edmonton ETS', color: '#005daa',
      host: 'gtfs.edmonton.ca', path: 'TMGTFSRealTimeWebService/Vehicle/VehiclePositions.pb',
      bbox: [53.30, -113.75, 53.75, -113.25],
      rules: [[/^(021|022|023)$/, 'lrt']] },
    { id: 'hsr', label: 'Hamilton HSR', color: '#0b5394',
      host: 'opendata.hamilton.ca', path: 'GTFS-RT/GTFS_VehiclePositions.pb',
      bbox: [43.15, -80.15, 43.35, -79.60] },
    { id: 'miway', label: 'MiWay (Mississauga)', color: '#ef7622',
      host: 'www.miapp.ca', path: 'GTFS_RT/Vehicle/VehiclePositions.pb',
      bbox: [43.45, -79.85, 43.70, -79.50] },
    { id: 'brampton', label: 'Brampton Transit', color: '#005caa',
      host: 'gtfs-rt-merge.prod.bt-cadavl.com', path: 'BramptonTransit/GTFS/merged_VehiclePosition.pb',
      bbox: [43.60, -79.95, 43.80, -79.60] },
    { id: 'yrt', label: 'YRT/Viva', color: '#0080c6',
      host: 'rtu.york.ca', path: 'gtfsrealtime/VehiclePositions',
      bbox: [43.75, -79.70, 44.20, -79.20] },
    { id: 'drt', label: 'Durham Region', color: '#00703c',
      host: 'drtonline.durhamregiontransit.com', path: 'gtfsrealtime/VehiclePositions',
      bbox: [43.80, -79.15, 44.10, -78.50] },
    { id: 'halifax', label: 'Halifax Transit', color: '#00558c',
      host: 'gtfs.halifax.ca', path: 'realtime/Vehicle/VehiclePositions.pb',
      bbox: [44.55, -63.80, 44.80, -63.40] },
    // ---- 2026-08 discovery sweep (all fetch-verified) ----
    { id: 'oakville', label: 'Oakville Transit', color: '#00857e',
      host: 'busfinder.oakvilletransit.ca', path: 'gtfsrt/vehicles',
      bbox: [43.36, -79.85, 43.53, -79.64] },
    { id: 'burlington', label: 'Burlington Transit', color: '#8b1d41',
      host: 'opendata.burlington.ca', path: 'gtfs-rt/GTFS_VehiclePositions.pb',
      bbox: [43.29, -79.92, 43.44, -79.72] },
    { id: 'niagara', label: 'Niagara Region Transit', color: '#00a3ad',
      host: '68.71.24.110', path: 'gtfsrt/vehicles',   // http-only via proxy
      bbox: [42.85, -79.35, 43.28, -78.90] },
    { id: 'onmerged', label: 'ON municipal (Metrolinx-hosted)', color: '#607d8b',
      // merged feed: Milton, Cornwall, Sarnia, Orillia, Kawartha Lakes,
      // Temiskaming Shores, Timmins, Belleville, Stratford
      host: 'metrolinx.tmix.se', path: 'gtfs-realtime-milton/vehiclepositions.pb',
      bbox: [42.70, -84.50, 48.60, -74.50] },
    { id: 'guelph', label: 'Guelph Transit', color: '#cc0033',
      host: 'glphprdtmgtfs.glphtrpcloud.com', path: 'tmgtfsrealtimewebservice/vehicle/vehiclepositions.pb',
      bbox: [43.47, -80.35, 43.60, -80.16] },
    { id: 'grt', label: 'Grand River Transit', color: '#0071ce',
      host: 'webapps.regionofwaterloo.ca', path: 'api/grt-routes/api/vehiclepositions',
      bbox: [43.30, -80.60, 43.55, -80.25],
      rules: [[/^301$/, 'lrt']] },     // ION LRT
    { id: 'barrie', label: 'Barrie Transit', color: '#0067a5',
      host: 'www.myridebarrie.ca', path: 'gtfs/GTFS_VehiclePositions.pb',
      bbox: [44.30, -79.75, 44.44, -79.60] },
    { id: 'london', label: 'London Transit', color: '#009b48',
      host: 'gtfs.ltconline.ca', path: 'Vehicle/VehiclePositions.pb',   // http-only via proxy
      bbox: [42.88, -81.40, 43.08, -81.10] },
    { id: 'kingston', label: 'Kingston Transit', color: '#c8102e',
      host: 'api.cityofkingston.ca', path: 'gtfs-realtime/vehicleupdates.pb',
      bbox: [44.20, -76.70, 44.30, -76.40] },
    { id: 'windsor', label: 'Transit Windsor', color: '#005596',
      host: 'windsor.mapstrat.com', path: 'current/gtfrealtime_VehiclePositions.bin',
      bbox: [42.20, -83.12, 42.36, -82.86] },   // occasionally serves an
      // empty snapshot for ~1 min during regeneration — next poll recovers
    { id: 'sudbury', label: 'GOVA (Sudbury)', color: '#00849b',
      host: 'sudbury.tmix.se', path: 'gtfs-realtime/vehiclepositions.pb',
      bbox: [46.35, -81.55, 46.75, -80.85] },
    { id: 'thunderbay', label: 'Thunder Bay Transit', color: '#d31245',
      host: 'api.nextlift.ca', path: 'gtfs-realtime/vehicleupdates.pb',   // http-only via proxy
      bbox: [48.33, -89.40, 48.50, -89.12] },
    { id: 'northbay', label: 'North Bay Transit', color: '#1e4d8c',
      host: 'northbay.tmix.se', path: 'gtfs-realtime/vehicleupdates.pb',
      bbox: [46.24, -79.52, 46.36, -79.38] },
    { id: 'ontarionorthland', label: 'Ontario Northland (intercity)', color: '#003da5',
      host: 'ontarionorthland.tmix.se', path: 'gtfs-realtime/vehicleupdates.pb',
      bbox: [43.60, -89.50, 49.00, -79.30] },
    { id: 'bct', label: 'BC Transit', color: '#00754a',
      // one merged request: Victoria(48) Kelowna(47) Kamloops(46)
      // Nanaimo(41) FraserValley(13) Vernon(14) Penticton(15) PG(22)
      // Squamish(43) Whistler(44) Comox(45) CampbellRiver(12);
      // route_ids carry a system suffix (1-VIC) so merging is safe
      host: 'bct.tmix.se', path: 'gtfs-realtime/vehicleupdates.pb?operatorIds=48,47,46,41,13,14,15,22,43,44,45,12',
      bbox: [48.20, -125.50, 54.50, -119.00] },
    { id: 'medhat', label: 'Medicine Hat Transit', color: '#b58500',
      host: 'medicinehat.tmix.se', path: 'gtfs-realtime/vehicleupdates.pb',
      bbox: [49.97, -110.73, 50.08, -110.60] },
    { id: 'stjean', label: 'Saint-Jean-sur-Richelieu', color: '#0072bc',
      host: 'zenbus.net', path: 'gtfs/rt/poll.proto?file=vp&dataset=saint-jean-sur-richelieu',
      bbox: [45.25, -73.50, 45.50, -73.20], direct: true },   // Zenbus is CORS-open
    { id: 'sorel', label: 'Pierre-De Saurel (Sorel-Tracy)', color: '#4a7729',
      host: 'zenbus.net', path: 'gtfs/rt/poll.proto?file=vp&dataset=pierre-de-saurel',
      bbox: [45.50, -73.55, 46.05, -73.10], direct: true },
    // ---- keyed feeds (free registration; see file header) ----
    { id: 'go', label: 'GO Transit', color: '#00853f',
      host: 'api.openmetrolinx.com', path: 'OpenDataAPI/api/V1/Gtfs/Feed/VehiclePosition',
      bbox: [42.9, -80.6, 44.7, -78.0],
      keyName: 'metrolinx_key', keyParam: 'key',
      // Feed route_ids look like "06260926-56"; the suffix is the short
      // code — letters (LW Lakeshore West, ST, RH…) = trains, numbers =
      // GO buses.
      routeShort: r => String(r).split('-').pop(),
      rules: [[/^[A-Z]{2}/, 'regional']] },
    { id: 'upx', label: 'UP Express', color: '#3d1152',
      host: 'api.openmetrolinx.com', path: 'OpenDataAPI/api/V1/UP/Gtfs/Feed/VehiclePosition',
      bbox: [43.6, -79.65, 43.72, -79.35],
      keyName: 'metrolinx_key', keyParam: 'key',
      routeShort: r => String(r).split('-').pop(),
      rules: [[/./, 'regional']] },
    { id: 'translink', label: 'TransLink', color: '#0761a5',
      host: 'gtfsapi.translink.ca', path: 'v3/gtfsposition',
      bbox: [49.0, -123.35, 49.40, -122.4],
      keyName: 'translink_key', keyParam: 'apikey',
      // Feed uses internal numeric route_ids — mapped to short names via
      // the baked static-GTFS table (scripts/fetch_translink_routes.py).
      // SkyTrain/Canada Line (driverless) never report; WCE does.
      routeMap: 'data/translink-routes.json',
      rules: [[/^WCE$/, 'regional']] },
    { id: 'octranspo', label: 'OC Transpo', color: '#d04328',
      host: 'nextrip-public-api.azure-api.net', path: 'octranspo/gtfs-rt-vp/beta/v1/VehiclePositions',
      bbox: [45.1, -76.1, 45.55, -75.3],
      keyName: 'octranspo_key', keyParam: 'subscription-key',
      rules: [[/^1$|^2$|^4$/, 'lrt']] },
    { id: 'stm', label: 'STM (Montréal)', color: '#00a5d5',
      host: 'api.stm.info', path: 'pub/od/gtfs-rt/ic/v2/vehiclePositions',
      bbox: [45.40, -73.95, 45.72, -73.35],
      keyName: 'stm_key', keyHeader: 'apiKey', direct: true },  // full CORS
  ];

  // ---- minimal GTFS-RT VehiclePositions decoder (protobuf wire format) ----
  function pbFields(buf, start, end, cb) {
    let i = start;
    while (i < end) {
      let key = 0, shift = 0, b;
      do { b = buf[i++]; key |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
      const field = key >>> 3, wire = key & 7;
      if (wire === 0) {
        let v = 0n, s = 0n;
        do { b = buf[i++]; v |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
        cb(field, wire, Number(v), i, i);
      } else if (wire === 1) { cb(field, wire, null, i, i + 8); i += 8; }
      else if (wire === 5) { cb(field, wire, null, i, i + 4); i += 4; }
      else if (wire === 2) {
        let len = 0; shift = 0;
        do { b = buf[i++]; len |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
        cb(field, wire, null, i, i + len); i += len;
      } else { return; }
    }
  }
  const pbFloat = (buf, at) =>
    new DataView(buf.buffer, buf.byteOffset + at, 4).getFloat32(0, true);
  const pbStr = (buf, s, e) => new TextDecoder().decode(buf.subarray(s, e));

  function decodeVehiclePositions(bytes) {
    const buf = new Uint8Array(bytes);
    const out = [];
    pbFields(buf, 0, buf.length, (f, w, v, s, e) => {
      if (f !== 2 || w !== 2) return;              // FeedEntity
      const veh = { lat: null, lon: null };
      pbFields(buf, s, e, (f2, w2, v2, s2, e2) => {
        if (f2 !== 4 || w2 !== 2) return;          // VehiclePosition
        pbFields(buf, s2, e2, (f3, w3, v3, s3, e3) => {
          if (f3 === 2 && w3 === 2) {              // Position
            pbFields(buf, s3, e3, (f4, w4, v4, s4) => {
              if (w4 !== 5) return;
              if (f4 === 1) veh.lat = pbFloat(buf, s4);
              else if (f4 === 2) veh.lon = pbFloat(buf, s4);
              else if (f4 === 3) veh.bearing = pbFloat(buf, s4);
              else if (f4 === 5) veh.speed = pbFloat(buf, s4);
            });
          } else if (f3 === 1 && w3 === 2) {       // TripDescriptor
            pbFields(buf, s3, e3, (f4, w4, v4, s4, e4) => {
              if (f4 === 5 && w4 === 2) veh.route = pbStr(buf, s4, e4);
              else if (f4 === 1 && w4 === 2) veh.trip = pbStr(buf, s4, e4);
            });
          } else if (f3 === 8 && w3 === 2) {       // VehicleDescriptor
            pbFields(buf, s3, e3, (f4, w4, v4, s4, e4) => {
              if (f4 === 1 && w4 === 2) veh.vid = pbStr(buf, s4, e4);
              else if (f4 === 2 && w4 === 2) veh.label = pbStr(buf, s4, e4);
            });
          } else if (f3 === 5 && w3 === 0) veh.ts = v3;
        });
      });
      if (veh.lat != null && veh.lon != null) out.push(veh);
    });
    return out;
  }

  function decodeTripRoutes(bytes) {
    // TripUpdates feed → { trip_id: route_id } (for agencies whose
    // VehiclePositions omit route_id, e.g. Calgary)
    const buf = new Uint8Array(bytes);
    const map = {};
    pbFields(buf, 0, buf.length, (f, w, v, s, e) => {
      if (f !== 2 || w !== 2) return;              // FeedEntity
      pbFields(buf, s, e, (f2, w2, v2, s2, e2) => {
        if (f2 !== 3 || w2 !== 2) return;          // TripUpdate
        let trip = null, route = null;
        pbFields(buf, s2, e2, (f3, w3, v3, s3, e3) => {
          if (f3 !== 1 || w3 !== 2) return;        // TripDescriptor
          pbFields(buf, s3, e3, (f4, w4, v4, s4, e4) => {
            if (f4 === 1 && w4 === 2) trip = pbStr(buf, s4, e4);
            else if (f4 === 5 && w4 === 2) route = pbStr(buf, s4, e4);
          });
        });
        if (trip && route) map[trip] = route;
      });
    });
    return map;
  }

  // Metrolinx serves GTFS-RT as JSON by default (snake_case per the
  // canonical mapping). Same information as the protobuf feeds.
  function decodeVehiclePositionsJson(doc) {
    return (doc.entity || doc.Entity || []).map(e => {
      const vp = e.vehicle; if (!vp) return null;
      const pos = vp.position || {}, trip = vp.trip || {}, veh = vp.vehicle || {};
      return {
        lat: pos.latitude, lon: pos.longitude,
        bearing: pos.bearing, speed: pos.speed,
        route: trip.route_id || trip.routeId,
        trip: trip.trip_id || trip.tripId,
        vid: veh.id, label: veh.label, ts: vp.timestamp,
      };
    }).filter(v => v && v.lat != null && v.lon != null);
  }

  // Sniff the payload: '{' → JSON GTFS-RT, anything else → protobuf.
  function decodeAny(buf) {
    const u8 = new Uint8Array(buf);
    let i = 0;
    while (i < u8.length && (u8[i] === 0x20 || u8[i] === 0x0a || u8[i] === 0x0d || u8[i] === 0x09 || u8[i] === 0xef || u8[i] === 0xbb || u8[i] === 0xbf)) i++;
    if (u8[i] === 0x7b) return decodeVehiclePositionsJson(JSON.parse(new TextDecoder().decode(u8)));
    return decodeVehiclePositions(buf);
  }

  // ---- proxy / fetch helpers (same conventions as tracking.js) ----
  function proxyBase() {
    let p = window.TRACKING_PROXY || '/proxy/';
    if (p && !p.endsWith('/')) p += '/';
    return p;
  }
  const getKey = name => {
    try { return (localStorage.getItem(name) || '').trim() || null; }
    catch { return null; }
  };

  async function finishVehicles(a, vehicles) {
    if (a.routeMap) {
      // static route_id → short-name table (agencies whose realtime feed
      // uses internal numeric ids, e.g. TransLink)
      a._rm = a._rm || fetch(a.routeMap + '?v=' + (window.APP_VERSION || '1'))
        .then(r => r.json()).catch(() => ({}));
      const rm = await a._rm;
      vehicles.forEach(v => { if (v.route && rm[v.route]) v.route = rm[v.route]; });
    }
    if (a.routeShort) vehicles.forEach(v => { if (v.route) v.route = a.routeShort(v.route); });
    return vehicles;
  }

  async function fetchFeed(a) {
    const key = a.keyName ? getKey(a.keyName) : null;
    // Against the deployed Cloudflare worker (absolute proxy URL) keyed
    // agencies are attempted WITHOUT a browser key — the worker injects
    // its stored secret upstream. Local dev (/proxy/) has no secrets, so
    // skip quietly there unless a localStorage key is set.
    const workerMode = !proxyBase().startsWith('/');
    if (a.keyName && !key && !workerMode) return null;
    const qs = a.path.includes('?') ? '&' : '?';
    let params = '';
    if (key && a.keyParam) params = `${qs}${a.keyParam}=${encodeURIComponent(key)}`;
    if (a.direct && (!a.keyName || key)) {
      const url = `https://${a.host}/${a.path}${params}`;
      const headers = (key && a.keyHeader) ? { [a.keyHeader]: key } : undefined;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return finishVehicles(a, decodeAny(await res.arrayBuffer()));
    }
    const res = await fetch(`${proxyBase()}${a.host}/${a.path}${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const vehicles = finishVehicles(a, decodeAny(await res.arrayBuffer()));
    if (a.tripFeed && vehicles.some(v => !v.route && v.trip)) {
      try {
        const tr = await fetch(`${proxyBase()}${a.host}/${a.tripFeed}`);
        if (tr.ok) {
          const map = decodeTripRoutes(await tr.arrayBuffer());
          vehicles.forEach(v => { if (!v.route && v.trip) v.route = map[v.trip]; });
        }
      } catch (e) { /* routes stay blank this cycle */ }
    }
    return vehicles;
  }

  // ---- VIA Rail (JSON feed, national) ----
  async function fetchVia() {
    const res = await fetch(`${proxyBase()}tsimobile.viarail.ca/data/allData.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const out = [];
    for (const [id, t] of Object.entries(j || {})) {
      if (t.lat == null || t.lng == null || t.arrived) continue;
      const next = (t.times || []).find(s => s.eta && s.eta !== 'ARR');
      out.push({
        id, no: id.split(' ')[0], lat: t.lat, lon: t.lng,
        speed: t.speed, dir: t.direction, from: t.from, to: t.to,
        next: next ? { station: next.station,
                       eta: next.arrival?.estimated || next.estimated,
                       lateMin: next.diffMin } : null,
      });
    }
    return out;
  }

  // ---- icons (top-down, rotated to bearing, livery-coloured) ----
  function busIcon(color, bearing) {
    return L.divIcon({
      className: 'track-transit',
      html: `<svg width="18" height="18" viewBox="-9 -9 18 18">
        <g transform="rotate(${bearing || 0})">
          <rect x="-3.4" y="-7" width="6.8" height="14" rx="2"
                fill="${color}" stroke="white" stroke-width="1"/>
          <path d="M-2.6,-6.5 L0,-7.6 L2.6,-6.5 L2.6,-4.9 L-2.6,-4.9 Z" fill="#1f2937" opacity="0.8"/>
          <rect x="-4.2" y="-5.6" width="0.9" height="2" rx="0.3" fill="${color}"/>
          <rect x="3.3" y="-5.6" width="0.9" height="2" rx="0.3" fill="${color}"/>
          <rect x="-2.5" y="-3" width="5" height="1.4" rx="0.3" fill="white" opacity="0.55"/>
          <rect x="-2.5" y="0" width="5" height="1.4" rx="0.3" fill="white" opacity="0.55"/>
          <rect x="-2.5" y="3" width="5" height="1.4" rx="0.3" fill="white" opacity="0.55"/>
        </g></svg>`,
      iconSize: [18, 18], iconAnchor: [9, 9]
    });
  }
  function streetcarIcon(color, bearing) {
    // Long, narrow articulated body with a pantograph — visually distinct
    // from the short wide bus (mirrors) at a glance.
    return L.divIcon({
      className: 'track-transit',
      html: `<svg width="20" height="24" viewBox="-10 -12 20 24">
        <g transform="rotate(${bearing || 0})">
          <rect x="-2.5" y="-11" width="5" height="9.6" rx="1.6"
                fill="${color}" stroke="white" stroke-width="0.9"/>
          <rect x="-2.5" y="-0.4" width="5" height="4.4" rx="0.8"
                fill="${color}" stroke="white" stroke-width="0.9"/>
          <rect x="-2.5" y="5" width="5" height="6.4" rx="1.6"
                fill="${color}" stroke="white" stroke-width="0.9"/>
          <path d="M-1.7,-10.6 L0,-11.5 L1.7,-10.6 L1.7,-9.2 L-1.7,-9.2 Z" fill="#1f2937" opacity="0.85"/>
          <path d="M-3.6,1 L3.6,2.6 M-3.6,2.6 L3.6,1" stroke="#1f2937" stroke-width="0.7"/>
          <rect x="-1.7" y="-8" width="3.4" height="1.2" rx="0.3" fill="white" opacity="0.6"/>
          <rect x="-1.7" y="-5.6" width="3.4" height="1.2" rx="0.3" fill="white" opacity="0.6"/>
          <rect x="-1.7" y="6.4" width="3.4" height="1.2" rx="0.3" fill="white" opacity="0.6"/>
          <rect x="-1.7" y="8.8" width="3.4" height="1.2" rx="0.3" fill="white" opacity="0.6"/>
        </g></svg>`,
      iconSize: [20, 24], iconAnchor: [10, 12]
    });
  }
  function lrtIcon(color, bearing) {
    return L.divIcon({
      className: 'track-transit',
      html: `<svg width="20" height="22" viewBox="-10 -11 20 22">
        <g transform="rotate(${bearing || 0})">
          <path d="M-2.9,-10 L-1.5,-11.4 Q0,-12 1.5,-11.4 L2.9,-10 L2.9,-0.8 L-2.9,-0.8 Z"
                fill="${color}" stroke="white" stroke-width="1"/>
          <rect x="-2.9" y="0.3" width="5.8" height="10" rx="1.3"
                fill="${color}" stroke="white" stroke-width="1"/>
          <path d="M-1.9,-9.8 L0,-10.7 L1.9,-9.8 L1.9,-8.2 L-1.9,-8.2 Z" fill="#1f2937" opacity="0.85"/>
          <rect x="-2" y="-6.8" width="4" height="1.2" rx="0.3" fill="white" opacity="0.55"/>
          <rect x="-2" y="-4.2" width="4" height="1.2" rx="0.3" fill="white" opacity="0.55"/>
          <rect x="-2" y="2.2" width="4" height="1.2" rx="0.3" fill="white" opacity="0.55"/>
          <rect x="-2" y="4.8" width="4" height="1.2" rx="0.3" fill="white" opacity="0.55"/>
          <rect x="-2" y="7.4" width="4" height="1.2" rx="0.3" fill="white" opacity="0.55"/>
        </g></svg>`,
      iconSize: [20, 22], iconAnchor: [10, 11]
    });
  }
  function trainIcon(color, bearing) {
    // Locomotive + two coaches — regional/intercity trains (GO, UP, VIA).
    return L.divIcon({
      className: 'track-transit',
      html: `<svg width="26" height="26" viewBox="-13 -13 26 26">
        <g transform="rotate(${bearing || 0})">
          <path d="M-3,-12 L-1.6,-13.6 Q0,-14.3 1.6,-13.6 L3,-12 L3,-4.4 L-3,-4.4 Z"
                fill="${color}" stroke="white" stroke-width="1"/>
          <path d="M-1.9,-11.7 L0,-12.7 L1.9,-11.7 L1.9,-10 L-1.9,-10 Z" fill="#1f2937" opacity="0.85"/>
          <rect x="-2.2" y="-8.8" width="4.4" height="1.5" rx="0.4" fill="#1f2937" opacity="0.5"/>
          <rect x="-3" y="-3.2" width="6" height="7.4" rx="1.3"
                fill="${color}" stroke="white" stroke-width="1"/>
          <rect x="-2.2" y="-1.8" width="4.4" height="1.4" rx="0.4" fill="white" opacity="0.55"/>
          <rect x="-2.2" y="1" width="4.4" height="1.4" rx="0.4" fill="white" opacity="0.55"/>
          <rect x="-3" y="5.4" width="6" height="7.4" rx="1.3"
                fill="${color}" stroke="white" stroke-width="1"/>
          <rect x="-2.2" y="6.9" width="4.4" height="1.4" rx="0.4" fill="white" opacity="0.55"/>
          <rect x="-2.2" y="9.7" width="4.4" height="1.4" rx="0.4" fill="white" opacity="0.55"/>
        </g></svg>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
  }
  const MODE_ICON = { bus: busIcon, streetcar: streetcarIcon, lrt: lrtIcon,
                      regional: trainIcon, via: trainIcon };

  function classify(a, route) {
    for (const [re, mode] of (a.rules || [])) {
      if (re.test(route || '')) return mode;
    }
    return 'bus';
  }

  function legendHTML() {
    return `<div class="overlay-legend">
      <div class="overlay-legend-title">🚏 Live Transit</div>
      <div class="legend-item">🚌 bus · 🚋 streetcar · 🚈 LRT · 🚆 GO/UP · 🚄 VIA — livery colours</div>
      <div class="wx-row" id="transit-status" style="color:#9ca3af;">⚪ connecting…</div>
      <div class="wx-row">GTFS-RT · agency open data</div>
    </div>`;
  }

  MapModes.register({
    id: 'transit',
    label: 'Transit',
    icon: '🚏',
    build: () => {
      const groups = {};
      Object.keys(MODES).forEach(m => { groups[m] = L.layerGroup(); });
      const renderer = L.canvas({ padding: 0.3 });
      const visible = { bus: true, streetcar: true, lrt: true, regional: true, via: true };
      let legendCtl = null, mapRef = null, timer = null, moveT = null;
      let unmounted = false;

      const setStatus = html => {
        const el = document.getElementById('transit-status');
        if (el) el.innerHTML = html || '';
      };

      function anyLocalOn() { return visible.bus || visible.streetcar || visible.lrt; }

      async function poll() {
        if (!mapRef || unmounted) return;
        const z = mapRef.getZoom();
        const b = mapRef.getBounds();
        const view = b.pad(0.15);
        const useIcons = z >= ICON_ZOOM;
        const counts = { bus: 0, streetcar: 0, lrt: 0, regional: 0, via: 0 };

        // which agencies to fetch this cycle
        const wanted = AGENCIES.filter(a => {
          const [s, w, n, e] = a.bbox;
          if (!(b.getSouth() < n && b.getNorth() > s && b.getWest() < e && b.getEast() > w)) return false;
          const isRegional = (a.rules || []).some(r => r[1] === 'regional');
          if (isRegional && visible.regional) return true;
          return anyLocalOn() && z >= LOCAL_ZOOM;
        });

        const skipped = [];   // keyed agencies not attempted (no key, local dev)
        const errsMap = {};
        const jobs = wanted.map(a => fetchFeed(a).then(
          v => { if (v === null && a.keyName) skipped.push(a.label); return [a, v]; },
          e => { errsMap[a.label] = e.message || 'error'; return [a, null]; }));
        let viaErr = null;
        const viaJob = visible.via ? fetchVia().then(v => v, e => { viaErr = e.message || 'error'; return null; }) : Promise.resolve(null);
        const [results, viaTrains] = await Promise.all([Promise.all(jobs), viaJob]);
        if (unmounted) return;

        Object.values(groups).forEach(g => g.clearLayers());

        results.forEach(([a, vehicles]) => {
          if (!vehicles) return;
          vehicles.forEach(v => {
            const mode = classify(a, v.route);
            if (!visible[mode]) return;
            if (MODES[mode].local && z < LOCAL_ZOOM) return;
            const localIcons = MODES[mode].local ? useIcons : true;
            if (localIcons && MODES[mode].local && !view.contains([v.lat, v.lon])) return;
            const tip =
              `<b>${MODES[mode].label.slice(0, 2)} ${eh(a.label)}${v.route ? ' · ' + eh(String(v.route).replace(/^zenbus:\w+:/, '')) : ''}</b>` +
              (v.label || v.vid ? `<br>vehicle ${eh(v.label || v.vid)}` : '') +
              (v.speed != null ? `<br>${Math.round(v.speed * 3.6)} km/h` : '');
            const mk = localIcons
              ? L.marker([v.lat, v.lon], { icon: MODE_ICON[mode](a.color, v.bearing), keyboard: false })
              : L.circleMarker([v.lat, v.lon], {
                  renderer, radius: 4, color: '#ffffff', weight: 1,
                  fillColor: a.color, fillOpacity: 0.95 });
            mk.bindTooltip(tip, { sticky: true }).addTo(groups[mode]);
            counts[mode]++;
          });
        });

        (viaTrains || []).forEach(t => {
          const late = t.next?.lateMin;
          L.marker([t.lat, t.lon], { icon: trainIcon('#b8860b', t.dir), keyboard: false })
            .bindTooltip(
              `<b>🚄 VIA ${eh(t.no)}</b><br>${eh(t.from || '')} → ${eh(t.to || '')}` +
              (t.next ? `<br>next: ${eh(t.next.station)}${t.next.eta ? ' · ' + eh(t.next.eta) : ''}` +
                (late ? ` <span style="color:${late > 0 ? '#dc2626' : '#22c55e'};">(${late > 0 ? '+' : ''}${late} min)</span>` : '') : '') +
              (t.speed != null ? `<br>${Math.round(t.speed)} km/h` : ''),
              { direction: 'top', offset: [0, -10] })
            .addTo(groups.via);
          counts.via++;
        });

        const okLocal = results.filter(([a, v]) => v &&
          !(a.rules || []).some(r => r[1] === 'regional')).map(([a]) => a.label);
        const rows = [];
        if (anyLocalOn()) {
          const n = counts.bus + counts.streetcar + counts.lrt;
          if (z < LOCAL_ZOOM) rows.push(`⚪ city fleets: zoom ≥ ${LOCAL_ZOOM}`);
          else if (!okLocal.length) rows.push('⚪ city fleets: none in view');
          else rows.push(`🟢 ${n.toLocaleString()} city vehicles · ` +
            (okLocal.length > 3 ? `${okLocal.slice(0, 3).join('+')} +${okLocal.length - 3}` : okLocal.join('+')));
        }
        if (visible.regional) {
          const goAttempted = wanted.some(a => (a.rules || []).some(r => r[1] === 'regional'));
          if (counts.regional) rows.push(`🟢 GO/commuter: ${counts.regional}`);
          else if (skipped.length) rows.push(`🔑 GO/commuter: key needed (${skipped.join(', ')})`);
          else if (goAttempted) rows.push('⚪ GO/commuter: 0 in view');
        }
        if (visible.via) {
          rows.push(viaErr ? `🔴 VIA: ${eh(viaErr)}` : `🟢 VIA: ${counts.via} trains`);
        }
        Object.entries(errsMap).slice(0, 3).forEach(([label, msg]) =>
          rows.push(`🔴 ${eh(label)}: ${eh(msg)}`));
        setStatus(rows.join('<br>'));
      }

      function applyVisibility() {
        if (!mapRef) return;
        Object.entries(groups).forEach(([m, g]) => {
          if (visible[m] && !mapRef.hasLayer(g)) g.addTo(mapRef);
          if (!visible[m] && mapRef.hasLayer(g)) mapRef.removeLayer(g);
        });
        poll().catch(() => {});
      }

      function onMove() {
        clearTimeout(moveT);
        moveT = setTimeout(() => poll().catch(() => {}), 600);
      }

      return {
        controls() {
          const wrap = document.createElement('div');
          Object.entries(MODES).forEach(([k, m]) => {
            const lab = document.createElement('label');
            lab.className = 'mapmode-sub-item';
            lab.innerHTML = `<input type="checkbox" ${visible[k] ? 'checked' : ''}> ${m.label}`;
            lab.querySelector('input').onchange = e => { visible[k] = e.target.checked; applyVisibility(); };
            wrap.appendChild(lab);
          });
          return wrap;
        },
        mount(m) {
          mapRef = m;
          unmounted = false;
          Object.values(groups).forEach(g => g.addTo(m));
          legendCtl = L.control({ position: 'bottomleft' });
          legendCtl.onAdd = () => { const d = L.DomUtil.create('div'); d.innerHTML = legendHTML(); return d; };
          legendCtl.addTo(m);
          poll().catch(() => {});
          timer = setInterval(() => poll().catch(() => {}), POLL_MS);
          m.on('moveend zoomend', onMove);
        },
        unmount(m) {
          unmounted = true;
          if (timer) { clearInterval(timer); timer = null; }
          clearTimeout(moveT);
          m.off('moveend zoomend', onMove);
          Object.values(groups).forEach(g => { g.clearLayers(); if (m.hasLayer(g)) m.removeLayer(g); });
          if (legendCtl) { m.removeControl(legendCtl); legendCtl = null; }
          mapRef = null;
        },
      };
    }
  });
})();

