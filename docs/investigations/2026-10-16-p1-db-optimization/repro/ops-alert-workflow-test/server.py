import http.server, json, sys
QUEUE = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        lines = open(QUEUE).read().splitlines()
        status, body = (lines[0].split(' ', 1) + ['{}'])[:2] if lines else ('200', '{}')
        open(QUEUE, 'w').write('\n'.join(lines[1:]) + ('\n' if lines[1:] else ''))
        self.send_response(int(status)); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(body.encode())
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
