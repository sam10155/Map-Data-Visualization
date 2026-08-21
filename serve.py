#!/usr/bin/env python3
"""
Dev server: static files + a /proxy/<host>/<path> passthrough that adds
CORS headers, so the browser can hit airplanes.live / adsb.lol / OpenSky /
Overpass without being blocked.

Usage:  python3 serve.py [port]   (default 8081)
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import urllib.request, urllib.error
import mimetypes, socket, sys, ssl

mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/json', '.geojson')

# Bind to loopback by default — this is a *dev* server with a CORS proxy
# and full filesystem read access; exposing it to the LAN is a footgun.
# Pass an explicit host as the second arg to override.
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8081
HOST = sys.argv[2] if len(sys.argv) > 2 else '127.0.0.1'

MAX_PROXY_BODY = 256 * 1024   # 256 KB — far more than any feed needs

# Redirects are followed ONLY when the target is https on an allow-listed
# host. urllib's default HTTPRedirectHandler would let an allow-listed
# upstream 302 to an arbitrary host (e.g. cloud metadata at
# 169.254.169.254); some legit upstreams (Calgary's Socrata GTFS-RT)
# 302 within their own host to the current snapshot file.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        from urllib.parse import urlparse
        u = urlparse(newurl)
        if u.scheme == 'https' and u.hostname in PROXY_ALLOW:
            return super().redirect_request(req, fp, code, msg, headers, newurl)
        raise urllib.error.HTTPError(req.full_url, code,
            f'redirect to {newurl} blocked by proxy', headers, fp)

_opener = urllib.request.build_opener(
    _NoRedirect,
    urllib.request.HTTPSHandler(context=ssl.create_default_context()),
)

# GRT (Region of Waterloo) negotiates a small DH key that default OpenSSL
# policy rejects; browsers accept it (ECDHE). Relax SECLEVEL just for them.
_weak_ctx = ssl.create_default_context()
try:
    _weak_ctx.set_ciphers('DEFAULT:@SECLEVEL=1')
except ssl.SSLError:
    pass
_weak_opener = urllib.request.build_opener(
    _NoRedirect, urllib.request.HTTPSHandler(context=_weak_ctx))
PROXY_WEAK_TLS = {'webapps.regionofwaterloo.ca'}

# Allow-list of upstream hosts the proxy will forward to.
PROXY_ALLOW = {
    'api.airplanes.live',
    'api.adsb.lol',
    'opendata.adsb.fi',
    'opensky-network.org',
    'overpass-api.de',
    'z.overpass-api.de',
    'overpass.openstreetmap.fr',
    'api.open-meteo.com',
    'gateway.api.globalfishingwatch.org',
    'aisuptime.buttermilkgreen.fyi',
    'tsimobile.viarail.ca',
    'cwfis.cfs.nrcan.gc.ca',
    # GTFS-Realtime transit feeds (open, no key; no CORS upstream)
    'bustime.ttc.ca',
    'gtfs.edmonton.ca',
    'opendata.hamilton.ca',
    'www.miapp.ca',
    'gtfs-rt-merge.prod.bt-cadavl.com',
    'rtu.york.ca',
    'drtonline.durhamregiontransit.com',
    'gtfs.halifax.ca',
    # keyed GTFS-RT feeds (key appended client-side as query param)
    'api.openmetrolinx.com',
    'gtfsapi.translink.ca',
    'nextrip-public-api.azure-api.net',
    'data.calgary.ca',
    # 2026-08 transit discovery sweep
    'busfinder.oakvilletransit.ca',
    'opendata.burlington.ca',
    '68.71.24.110',
    'metrolinx.tmix.se',
    'glphprdtmgtfs.glphtrpcloud.com',
    'webapps.regionofwaterloo.ca',
    'www.myridebarrie.ca',
    'gtfs.ltconline.ca',
    'api.cityofkingston.ca',
    'windsor.mapstrat.com',
    'sudbury.tmix.se',
    'api.nextlift.ca',
    'northbay.tmix.se',
    'ontarionorthland.tmix.se',
    'bct.tmix.se',
    'medicinehat.tmix.se',
    'zenbus.net',
}

# Hosts that only serve plain HTTP (Niagara's bare-IP BusTime, London LTC,
# Thunder Bay) — proxy reaches them over http; everything else is https.
PROXY_HTTP_ONLY = {
    '68.71.24.110',
    'gtfs.ltconline.ca',
    'api.nextlift.ca',
}

class Handler(SimpleHTTPRequestHandler):

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _proxy(self, method):
        # /proxy/<host>/<rest...>
        rest = self.path[len('/proxy/'):]
        if '/' not in rest:
            self.send_error(400, 'bad proxy path'); return
        host, upstream_path = rest.split('/', 1)
        if host not in PROXY_ALLOW:
            self.send_error(403, 'host not allowed'); return
        scheme = 'http' if host in PROXY_HTTP_ONLY else 'https'
        url = f'{scheme}://{host}/{upstream_path}'

        body = None
        if method == 'POST':
            try:
                length = int(self.headers.get('Content-Length', '0') or 0)
            except ValueError:
                self.send_error(400, 'bad content-length'); return
            if length < 0 or length > MAX_PROXY_BODY:
                self.send_error(413, 'request body too large'); return
            body = self.rfile.read(length) if length else None

        # Only forward a fixed Content-Type — don't pass arbitrary client headers.
        ct = self.headers.get('Content-Type', '')
        fwd_ct = 'application/json' if 'json' in ct else 'application/x-www-form-urlencoded'

        req = urllib.request.Request(
            url, data=body, method=method,
            headers={
                'User-Agent': 'canada-map-viz/1.0',
                # */*: some upstreams (MiWay IIS) 406 a JSON-only Accept
                # for protobuf .pb files.
                'Accept': '*/*',
                'Content-Type': fwd_ct,
            })
        opener = _weak_opener if host in PROXY_WEAK_TLS else _opener
        try:
            with opener.open(req, timeout=60) as r:
                data = r.read()
                self.send_response(r.status)
                # Force JSON/text — never relay text/html (would execute on
                # localhost origin if upstream returns an HTML error page).
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(502, 'upstream error')

    def do_GET(self):
        if self.path.startswith('/proxy/'):
            return self._proxy('GET')
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith('/proxy/'):
            return self._proxy('POST')
        self.send_error(405)

    def log_message(self, fmt, *args):
        sys.stdout.write(f"\033[94m{self.command}\033[0m \033[92m{self.path[:80]}\033[0m => {fmt % args}\n")


def run():
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    ip = socket.gethostbyname(socket.gethostname())
    print(f"\n[-] Serving on \033[96mhttp://localhost:{PORT}\033[0m  (and http://{ip}:{PORT})")
    print(f"[-] Proxy: /proxy/<host>/<path> for {sorted(PROXY_ALLOW)}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[x] Shutting down…")
    finally:
        httpd.server_close()


if __name__ == '__main__':
    run()
