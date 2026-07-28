// Zero-dependency static server. Serves the app, the baked assets, and three.js
// straight out of node_modules so the project needs no bundler step.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MOUNTS = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/assets/', path.join(ROOT, 'web/public/assets/')],
  ['/src/', path.join(ROOT, 'web/src/')],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function resolveRequest(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') {
    return path.join(ROOT, 'web/index.html');
  }
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const relative = decodeURIComponent(urlPath.slice(prefix.length));
    const resolved = path.resolve(dir, relative);
    // Refuse anything that escapes the mount via ../
    if (!resolved.startsWith(path.resolve(dir))) return null;
    return resolved;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const filePath = resolveRequest(urlPath);

  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`404 ${urlPath}`);
    return;
  }

  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
});

const port = Number(process.env.PORT || 5173);
server.listen(port, () => {
  console.log(`[serve] http://localhost:${port}`);
});
