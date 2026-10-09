// Forwards to BOARDLINK on :3000, giving every request its own client
// address so the per-address rate limiter does not stop the scanner.
const http = require('http'); let n = 0;
http.createServer((req, res) => {
  n++; const h = { ...req.headers, 'x-forwarded-for': `172.16.${(n >> 8) & 255}.${n & 255}`, host: '127.0.0.1:3000' };
  const up = http.request({ host: '127.0.0.1', port: 3000, method: req.method, path: req.url, headers: h }, r => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', e => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(3100, '127.0.0.1');
