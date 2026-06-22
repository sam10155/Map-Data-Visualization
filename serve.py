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

HOST = '0.0.0.0'
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8081

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
}

_ssl_ctx = ssl.create_default_context()


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
            self.send_error(403, f'host not allowed: {host}'); return
        url = f'https://{host}/{upstream_path}'

        body = None
        if method == 'POST':
            length = int(self.headers.get('Content-Length', '0') or 0)
            body = self.rfile.read(length) if length else None

        req = urllib.request.Request(
            url, data=body, method=method,
            headers={
                'User-Agent': 'canada-map-viz/1.0',
                'Accept': 'application/json',
                'Content-Type': self.headers.get('Content-Type',
                                                  'application/x-www-form-urlencoded'),
            })
        try:
            with urllib.request.urlopen(req, timeout=60, context=_ssl_ctx) as r:
                data = r.read()
                self.send_response(r.status)
                self.send_header('Content-Type',
                                 r.headers.get('Content-Type', 'application/json'))
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            data = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(502, f'upstream error: {e}')

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
