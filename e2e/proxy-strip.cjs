// Reverse proxy minimal pour reproduire un déploiement sous sous-chemin : seules les adresses commençant par PREFIX sont
// transmises au back, avec le préfixe retiré (comme un « proxy_pass http://app:3000/; » nginx). Le reste répond 404.
// Usage : PREFIX=/visit TARGET_PORT=3000 PROXY_PORT=3001 node e2e/proxy-strip.cjs
const http = require('node:http');
const PREFIX = process.env.PREFIX ?? '/visit', TARGET = Number(process.env.TARGET_PORT ?? 3000), PORT = Number(process.env.PROXY_PORT ?? 3001);
http.createServer((req, res) => {
  if (req.url !== PREFIX && !req.url.startsWith(PREFIX + '/') && !req.url.startsWith(PREFIX + '?')) { res.writeHead(404); return res.end('not found'); }
  const path = req.url.slice(PREFIX.length) || '/';
  const up = http.request({ host: '127.0.0.1', port: TARGET, path, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1');
