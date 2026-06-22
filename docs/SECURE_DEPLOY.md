# Secure deployment: keeping API keys off the client

GitHub Pages is purely static — anything in `data/config.js` is visible to
every visitor. To keep your AISStream and GFW keys **truly private**, run a
tiny Cloudflare Worker that holds the keys as Worker secrets and injects
them server-side. The browser only ever knows the worker's public URL.

```
Browser ──▶ Cloudflare Worker ──▶ AISStream / GFW / ADS-B feeds
            (holds secrets,
             adds Authorization /
             APIKey, adds CORS)
```

## 1. Deploy the worker

```bash
npm install -g wrangler          # Cloudflare CLI
cd scripts
wrangler login
wrangler deploy                  # uses scripts/wrangler.toml + cloudflare-worker.js
```

You'll get a URL like `https://canada-map-viz.<account>.workers.dev`.

## 2. Set worker secrets (NOT in git)

```bash
wrangler secret put AISSTREAM_API_KEY
wrangler secret put GFW_API_TOKEN
# Optional: lock to your Pages origin
wrangler secret put ALLOWED_ORIGINS    # e.g. https://sam10155.github.io
```

These are encrypted at rest by Cloudflare and never leave the edge.

## 3. Point GitHub Pages at the worker

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Name | Value |
|---|---|
| `TRACKING_PROXY` | `https://canada-map-viz.<account>.workers.dev/` |

That's the **only** secret the Pages deploy needs. Do **not** set
`AISSTREAM_API_KEY` or `GFW_API_TOKEN` as repo secrets in this mode — the
deploy workflow deliberately omits them from `config.js` when
`TRACKING_PROXY` is set.

## 4. Push to `main`

The Actions workflow writes `data/config.js` containing only
`window.TRACKING_PROXY = "https://…workers.dev/"` and deploys. The
tracking layer detects the `https://` proxy and:

- opens the AIS WebSocket at `wss://…workers.dev/ais` (worker injects `APIKey`)
- POSTs GFW requests to `https://…workers.dev/gfw/events` (worker injects `Authorization: Bearer …`)
- routes aircraft feeds through `https://…workers.dev/<host>/<path>` for consistent CORS

## What this protects (and what it doesn't)

| | |
|---|---|
| ✅ | Keys are never present in any file served to the browser |
| ✅ | Keys never appear in DevTools Network tab or page source |
| ✅ | `ALLOWED_ORIGINS` blocks other sites from using your worker |
| ⚠️ | A determined user can still call your worker URL directly from `curl` and consume your free-tier quota. If that matters, add per-IP rate limiting in the worker (Cloudflare KV / Durable Objects). |

## Cost

Cloudflare Workers free tier: 100,000 requests/day. The tracking layer
makes ~6 aircraft requests per 15 s + 1 GFW per hour + 1 long-lived AIS
WebSocket — well under the limit for typical traffic.

## Direct mode (no worker)

If you skip the worker, set `AISSTREAM_API_KEY` and `GFW_API_TOKEN` as repo
secrets instead. They'll be embedded in `data/config.js` and visible to
anyone — fine for free, easily-rotated keys, but not "secure".
