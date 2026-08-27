/**
 * Cloudflare Worker — secure API gateway for the live-tracking layer.
 *
 * The worker holds API keys as **Worker secrets** (never sent to the
 * browser) and injects them into upstream requests. The client only
 * knows the worker's URL.
 *
 * Routes:
 *   GET/POST /<host>/<path>   — CORS proxy for allow-listed hosts
 *   POST     /gfw/events?...  — proxies to GFW v3 with Bearer token injected
 *   WS       /ais             — proxies to AISStream, injects APIKey into
 *                               the client's subscribe message
 *
 * Worker secrets (set via `wrangler secret put …` or dashboard):
 *   AISSTREAM_API_KEY   — aisstream.io key
 *   GFW_API_TOKEN       — Global Fishing Watch JWT
 *   METROLINX_KEY       — GO/UP Express (api.openmetrolinx.com)
 *   TRANSLINK_KEY       — TransLink Vancouver GTFS-RT
 *   OCTRANSPO_KEY       — OC Transpo (Azure APIM subscription key)
 *   STM_KEY             — STM Montréal (sent as apiKey header)
 *   ALLOWED_ORIGINS     — (optional) comma-separated list; "*" if unset
 */

const PROXY_ALLOW = new Set([
  'api.airplanes.live',
  'api.adsb.lol',
  'opendata.adsb.fi',
  'opensky-network.org',
  'api.adsbdb.com',
  'aisuptime.buttermilkgreen.fyi',   // AISStream-Uptime health check
  'tsimobile.viarail.ca',            // VIA Rail live train positions
  'cwfis.cfs.nrcan.gc.ca',           // NRCan wildfire hotspots/active fires
  // GTFS-Realtime transit feeds (open, no key; no CORS upstream)
  'bustime.ttc.ca',
  'gtfs.edmonton.ca',
  'opendata.hamilton.ca',
  'www.miapp.ca',
  'gtfs-rt-merge.prod.bt-cadavl.com',
  'rtu.york.ca',
  'drtonline.durhamregiontransit.com',
  'gtfs.halifax.ca',
  'api.openmetrolinx.com',           // GO/UP Express (key as query param)
  'gtfsapi.translink.ca',            // TransLink Vancouver
  'nextrip-public-api.azure-api.net',// OC Transpo
  'data.calgary.ca',                 // Calgary Transit (302s to snapshot)
  // 2026-08 transit discovery sweep
  'busfinder.oakvilletransit.ca',
  'opendata.burlington.ca',
  '68.71.24.110',                    // Niagara Region Transit (http-only)
  'metrolinx.tmix.se',
  'glphprdtmgtfs.glphtrpcloud.com',
  'webapps.regionofwaterloo.ca',
  'www.myridebarrie.ca',
  'gtfs.ltconline.ca',               // London LTC (http-only)
  'api.cityofkingston.ca',
  'windsor.mapstrat.com',
  'sudbury.tmix.se',
  'api.nextlift.ca',                 // Thunder Bay (http-only)
  'northbay.tmix.se',
  'ontarionorthland.tmix.se',
  'bct.tmix.se',
  'medicinehat.tmix.se',
  'zenbus.net',
  'api.stm.info',                    // STM Montréal (worker injects apiKey header)
  'aviationweather.gov',             // NOAA AWC — METARs/TAFs/SIGMETs (Canadian aerodromes/FIRs)
]);

// Transit API keys stored as worker secrets — injected upstream so the
// browser never sees them. [host, query-param, secret name]. STM takes
// its key as a header instead (handled inline below).
const TRANSIT_KEY_PARAMS = [
  ['api.openmetrolinx.com', 'key', 'METROLINX_KEY'],
  ['gtfsapi.translink.ca', 'apikey', 'TRANSLINK_KEY'],
  ['nextrip-public-api.azure-api.net', 'subscription-key', 'OCTRANSPO_KEY'],
];

// http-only upstreams (no TLS offered)
const PROXY_HTTP_ONLY = new Set(['68.71.24.110', 'gtfs.ltconline.ca', 'api.nextlift.ca']);

function allowedOriginsList(env) {
  const v = (env.ALLOWED_ORIGINS || '*').trim();
  return v === '*' ? null : v.split(',').map(s => s.trim()).filter(Boolean);
}

function cors(env, req, extra = {}) {
  // ACAO must be a SINGLE origin or '*' — never a comma list. Echo the
  // request Origin if it's in the allow-list; otherwise emit nothing
  // (browser will block, which is the intent).
  const list = allowedOriginsList(env);
  const reqOrigin = req?.headers.get('Origin') || '';
  const acao = list === null ? '*' : (list.includes(reqOrigin) ? reqOrigin : '');
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
    ...extra,
  };
  if (acao) h['Access-Control-Allow-Origin'] = acao;
  return h;
}

function originAllowed(req, env) {
  const list = allowedOriginsList(env);
  if (list === null) return true;
  const origin = req.headers.get('Origin') || '';
  // NOTE: Origin is client-supplied and trivially spoofed by non-browser
  // clients. This gate stops other *websites* from using the worker
  // (browsers enforce Origin honestly), but does NOT stop curl. For real
  // abuse-resistance add Cloudflare rate-limiting / Turnstile.
  return list.includes(origin);
}

async function handleGfw(req, env) {
  if (!env.GFW_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'GFW_API_TOKEN not configured on worker' }),
      { status: 503, headers: cors(env, req, { 'Content-Type': 'application/json' }) });
  }
  const url = new URL(req.url);
  const upstream = `https://gateway.api.globalfishingwatch.org/v3/events${url.search}`;
  const r = await fetch(upstream, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GFW_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: await req.text(),
    redirect: 'manual',
  });
  return new Response(r.body, {
    status: r.status,
    headers: cors(env, req, { 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

// Temporary diagnostic: GET /ais/diag connects to AISStream server-side
// with the stored secret and reports what happens. Exposes only key length
// + first 4 chars, never the key itself. Remove once the feed is stable.
async function handleAisDiag(req, env) {
  const key = env.AISSTREAM_API_KEY || '';
  const info = {
    keyConfigured: !!key,
    keyLen: key.length,
    keyPrefix: key.slice(0, 4),
    keyHasWhitespace: /\s/.test(key),
    frames: 0, firstFrame: null,
    closed: false, closeCode: null, closeReason: null, error: null,
  };
  const respond = () => new Response(JSON.stringify(info, null, 2),
    { headers: cors(env, req, { 'Content-Type': 'application/json' }) });
  if (!key) return respond();

  let up;
  try {
    up = await fetch('https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } });
  } catch (e) { info.error = `upstream fetch: ${e.message}`; return respond(); }
  const ws = up.webSocket;
  if (!ws) { info.error = `no upgrade (HTTP ${up.status})`; return respond(); }
  ws.accept();

  const dec = new TextDecoder();
  info.frameLog = [];   // type + byte-length + preview of every frame
  const done = new Promise((res) => {
    ws.addEventListener('message', (ev) => {
      info.frames++;
      let type, len, preview;
      try {
        if (typeof ev.data === 'string') { type = 'text'; len = ev.data.length; preview = ev.data.slice(0, 100); }
        else { const u8 = new Uint8Array(ev.data); type = 'binary'; len = u8.byteLength; preview = dec.decode(u8).slice(0, 100); }
      } catch (e) { type = 'unknown'; len = -1; preview = `<${e.message}>`; }
      if (info.frameLog.length < 8) info.frameLog.push({ type, len, preview });
      if (!info.firstFrame && preview) info.firstFrame = preview;
      if (info.frames >= 6) { try { ws.close(1000); } catch {} res(); }
    });
    ws.addEventListener('close', (ev) => {
      info.closed = true; info.closeCode = ev.code; info.closeReason = ev.reason; res();
    });
    ws.addEventListener('error', (ev) => { info.error = `ws error${ev?.message ? ': ' + ev.message : ''}`; res(); });
    setTimeout(res, 12000);
  });
  // Step 1: send deliberately INVALID JSON. If our frames reach AISStream,
  // it must answer with an error message — proving the send path works.
  ws.send('not json {{{');
  // Step 2 (2s later): real subscription, whole-world bbox — guarantees
  // traffic if the key is accepted.
  setTimeout(() => {
    try {
      ws.send(JSON.stringify({
        APIKey: key,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ['PositionReport'],
      }));
    } catch {}
  }, 2000);
  await done;
  return respond();
}

async function handleAis(req, env) {
  if (req.headers.get('Upgrade') !== 'websocket') {
    return new Response('expected websocket', { status: 426 });
  }
  if (!env.AISSTREAM_API_KEY) {
    return new Response('AISSTREAM_API_KEY not configured on worker', { status: 503 });
  }

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();

  // close() only accepts code 1000 or 3000-4999 — anything else (e.g. a
  // forwarded 1006 from an abnormal upstream drop) THROWS, killing the
  // worker and surfacing to the client as a bare 1011. Sanitize + carry
  // the original code in the reason text so the browser can display it.
  function safeClose(sock, code, reason) {
    const ok = code === 1000 || (code >= 3000 && code < 5000);
    try {
      sock.close(ok ? code : 4000, String(reason || '').slice(0, 120));
    } catch { try { sock.close(1000); } catch {} }
  }

  // Connect upstream. Cloudflare Workers fetch() supports WebSocket upgrade.
  let up;
  try {
    up = await fetch('https://stream.aisstream.io/v0/stream', {
      headers: { Upgrade: 'websocket' },
    });
  } catch (e) {
    safeClose(server, 4000, `upstream fetch failed: ${e.message}`);
    return new Response(null, { status: 101, webSocket: client });
  }
  const upstream = up.webSocket;
  if (!upstream) {
    safeClose(server, 4000, `upstream refused upgrade (HTTP ${up.status})`);
    return new Response(null, { status: 101, webSocket: client });
  }
  upstream.accept();

  // Client → upstream: intercept the first JSON message and inject APIKey.
  server.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      msg.APIKey = env.AISSTREAM_API_KEY;   // overwrite/inject
      upstream.send(JSON.stringify(msg));
    } catch {
      // non-JSON (ping etc.) — forward as-is
      try { upstream.send(ev.data); } catch {}
    }
  });
  server.addEventListener('close', (ev) => safeClose(upstream, ev.code, ev.reason));
  server.addEventListener('error', () => safeClose(upstream, 4000, 'client socket error'));

  // Upstream → client: AISStream sends binary frames; decode to text so
  // the browser always receives strings (and never a stringified Blob).
  // Workers' TextDecoder requires an ArrayBufferView — a raw ArrayBuffer
  // throws — so wrap in Uint8Array.
  const dec = new TextDecoder();
  upstream.addEventListener('message', (ev) => {
    try {
      const text = typeof ev.data === 'string' ? ev.data : dec.decode(new Uint8Array(ev.data));
      if (text) server.send(text);   // drop empty keepalive frames
    } catch {
      try { server.send(ev.data); } catch {}   // last resort: forward verbatim
    }
  });
  upstream.addEventListener('close', (ev) =>
    safeClose(server, ev.code, `upstream closed (${ev.code}${ev.reason ? ': ' + ev.reason : ''})`));
  upstream.addEventListener('error', (ev) =>
    safeClose(server, 4000, `upstream error${ev?.message ? ': ' + ev.message : ''}`));

  return new Response(null, { status: 101, webSocket: client });
}

async function handleProxy(req, env, host, path, search) {
  if (!PROXY_ALLOW.has(host)) {
    return new Response('host not allowed', { status: 403, headers: cors(env, req) });
  }
  let upstream = `${PROXY_HTTP_ONLY.has(host) ? 'http' : 'https'}://${host}/${path}${search}`;
  const upHeaders = { 'User-Agent': 'canada-map-viz/1.0', 'Accept': '*/*' };
  for (const [h, param, secret] of TRANSIT_KEY_PARAMS) {
    if (host === h && env[secret] && !upstream.includes(`${param}=`)) {
      upstream += (upstream.includes('?') ? '&' : '?') +
        `${param}=${encodeURIComponent(env[secret])}`;
    }
  }
  if (host === 'api.stm.info' && env.STM_KEY) upHeaders['apiKey'] = env.STM_KEY;
  let r;
  // Follow redirects manually, but ONLY to https allow-listed hosts —
  // an allow-listed host 302ing to an arbitrary URL would otherwise
  // pivot the worker (SSRF). Calgary's Socrata GTFS-RT legitimately
  // 302s within its own host to the current snapshot file.
  for (let hop = 0; hop < 3; hop++) {
    r = await fetch(upstream, {
      method: req.method,
      // */*: some upstreams (MiWay IIS) 406 a JSON-only Accept for .pb files
      headers: upHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
      redirect: 'manual',
    });
    if (r.status < 300 || r.status >= 400) break;
    const loc = new URL(r.headers.get('Location') || '', upstream);
    if (loc.protocol !== 'https:' || !PROXY_ALLOW.has(loc.hostname)) break;
    upstream = loc.href;
  }
  if (r.status >= 300 && r.status < 400) {
    return new Response(JSON.stringify({ error: 'upstream redirect blocked' }),
      { status: 502, headers: cors(env, req, { 'Content-Type': 'application/json' }) });
  }
  return new Response(r.body, {
    status: r.status,
    headers: cors(env, req, {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    }),
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env, req) });
    }
    if (!originAllowed(req, env)) {
      return new Response('origin not allowed', { status: 403 });
    }

    const segs = url.pathname.replace(/^\/+/, '').split('/');
    const head = segs.shift() || '';

    if (head === 'ais' && segs[0] === 'diag') return handleAisDiag(req, env);
    // AISStream refuses to stream data to Cloudflare-egress connections
    // (subscription accepted, zero data frames — verified via /ais/diag),
    // so the WS relay is useless. Instead hand the key to allow-listed
    // origins and let the browser connect to AISStream directly.
    if (head === 'ais' && segs[0] === 'key') {
      return new Response(JSON.stringify({ key: env.AISSTREAM_API_KEY || null }),
        { headers: cors(env, req, { 'Content-Type': 'application/json' }) });
    }
    if (head === 'ais') return handleAis(req, env);
    if (head === 'gfw' && segs[0] === 'events') return handleGfw(req, env);
    if (head) return handleProxy(req, env, head, segs.join('/'), url.search);

    return new Response('canada-map-viz worker: /ais (ws), /gfw/events, /<host>/<path>',
      { status: 200, headers: cors(env, req, { 'Content-Type': 'text/plain' }) });
  },
};
