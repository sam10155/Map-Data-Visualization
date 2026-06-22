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
 *   ALLOWED_ORIGINS     — (optional) comma-separated list; "*" if unset
 */

const PROXY_ALLOW = new Set([
  'api.airplanes.live',
  'api.adsb.lol',
  'opendata.adsb.fi',
  'opensky-network.org',
  'api.adsbdb.com',
]);

function cors(env, extra = {}) {
  const allowed = env.ALLOWED_ORIGINS || '*';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra,
  };
}

function originAllowed(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').trim();
  if (allowed === '*') return true;
  const origin = req.headers.get('Origin') || '';
  return allowed.split(',').map(s => s.trim()).includes(origin);
}

async function handleGfw(req, env) {
  if (!env.GFW_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'GFW_API_TOKEN not configured on worker' }),
      { status: 503, headers: cors(env, { 'Content-Type': 'application/json' }) });
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
  });
  return new Response(r.body, {
    status: r.status,
    headers: cors(env, { 'Content-Type': r.headers.get('Content-Type') || 'application/json' }),
  });
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

  // Connect upstream. Cloudflare Workers fetch() supports WebSocket upgrade.
  const up = await fetch('https://stream.aisstream.io/v0/stream', {
    headers: { Upgrade: 'websocket' },
  });
  const upstream = up.webSocket;
  if (!upstream) {
    server.close(1011, 'upstream ws failed');
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
      upstream.send(ev.data);
    }
  });
  server.addEventListener('close', (ev) => upstream.close(ev.code, ev.reason));
  server.addEventListener('error', () => upstream.close(1011));

  // Upstream → client: forward verbatim.
  upstream.addEventListener('message', (ev) => server.send(ev.data));
  upstream.addEventListener('close', (ev) => server.close(ev.code, ev.reason));
  upstream.addEventListener('error', () => server.close(1011));

  return new Response(null, { status: 101, webSocket: client });
}

async function handleProxy(req, env, host, path, search) {
  if (!PROXY_ALLOW.has(host)) {
    return new Response('host not allowed', { status: 403, headers: cors(env) });
  }
  const upstream = `https://${host}/${path}${search}`;
  const r = await fetch(upstream, {
    method: req.method,
    headers: { 'User-Agent': 'canada-map-viz/1.0', 'Accept': 'application/json' },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(),
    redirect: 'follow',
  });
  return new Response(r.body, {
    status: r.status,
    headers: cors(env, { 'Content-Type': r.headers.get('Content-Type') || 'application/json' }),
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(env) });
    }
    if (!originAllowed(req, env)) {
      return new Response('origin not allowed', { status: 403 });
    }

    const segs = url.pathname.replace(/^\/+/, '').split('/');
    const head = segs.shift() || '';

    if (head === 'ais') return handleAis(req, env);
    if (head === 'gfw' && segs[0] === 'events') return handleGfw(req, env);
    if (head) return handleProxy(req, env, head, segs.join('/'), url.search);

    return new Response('canada-map-viz worker: /ais (ws), /gfw/events, /<host>/<path>',
      { status: 200, headers: cors(env, { 'Content-Type': 'text/plain' }) });
  },
};
