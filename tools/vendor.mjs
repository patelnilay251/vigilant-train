// Copies the three.js files the app imports into web/vendor/, so the deployed
// site is a plain directory of static files with no node_modules at runtime.
//
// The examples/jsm layout is preserved because GLTFLoader reaches sideways for
// '../utils/BufferGeometryUtils.js'; flattening it would break that import.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FROM = path.join(ROOT, 'node_modules/three');
const TO = path.join(ROOT, 'web/vendor/three');

const FILES = [
  'build/three.module.js',
  'examples/jsm/loaders/GLTFLoader.js',
  'examples/jsm/utils/BufferGeometryUtils.js',
];

let total = 0;
for (const relative of FILES) {
  const source = path.join(FROM, relative);
  if (!fs.existsSync(source)) {
    console.error(`[vendor] missing ${relative} — run npm install first`);
    process.exit(1);
  }
  const target = path.join(TO, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  total += fs.statSync(target).size;
}

console.log(`[vendor] copied ${FILES.length} files (${(total / 1024).toFixed(0)} KB) to web/vendor/three`);
