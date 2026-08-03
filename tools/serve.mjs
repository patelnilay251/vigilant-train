// Zero-dependency static server for local development.
//
// Serves web/ exactly as a static host would, so what runs here and what runs
// on the deployed site are the same tree of files.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../web');

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

// Set BASE_PATH to rehearse hosting under a subpath, which is what GitHub
// project pages and most preview URLs do.
const BASE = (process.env.BASE_PATH || '').replace(/^\/?|\/?$/g, '');

const server = http.createServer((req, res) => {
  let urlPath = new URL(req.url, 'http://localhost').pathname;

  if (BASE) {
    if (urlPath === `/${BASE}`) urlPath = `/${BASE}/`;
    if (!urlPath.startsWith(`/${BASE}/`)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`404 ${urlPath} (expected /${BASE}/…)`);
      return;
    }
    urlPath = urlPath.slice(BASE.length + 1);
  }

  const relative = decodeURIComponent(urlPath === '/' ? 'index.html' : urlPath.slice(1));
  const filePath = path.resolve(ROOT, relative);

  // Refuse anything that escapes the served root via ../
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
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
  console.log(`[serve] http://localhost:${port}${BASE ? `/${BASE}/` : '/'}`);
});
