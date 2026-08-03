// Draws the character's face as a texture.
//
// Previously the face was geometry: black spheres for eyes, red domes for
// cheeks, a dark ellipsoid for the mouth, all intersecting a curved skull. That
// is the wrong representation and it fails in characteristic ways — spheres
// bulge from an angle, discs sink into the head and surface as crescents, and
// every fix trades one artifact for another. The reference model paints its
// face on; so does this now.
//
// The image carries absolute colour, and the mesh's vertex colours become
// multipliers against the skin instead. That split is deliberate: a multiplier
// texture cannot brighten, and the single most important detail on this face is
// a white highlight on a near-black eye, which needs a channel far above the
// skin's blue. Outside the face the texture is plain skin, so body vertices
// point at a corner of it and are left alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePNG } from './lib/png.mjs';
import { FACE_PROJECTION, SKIN } from './lib/face-layout.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../web/assets');
const PREVIEW_DIR = path.resolve(__dirname, '../shots');

const SIZE = Number(process.env.FACE_RES || 768);

// ---------------------------------------------------------------------------
// Target colours, as they should appear on the finished model.
// ---------------------------------------------------------------------------

const EYE = [0.075, 0.065, 0.070];
const GLINT = [1.0, 1.0, 1.0];
const CHEEK = [0.900, 0.145, 0.080];
const CHEEK_EDGE = [0.700, 0.090, 0.060];
const MOUTH = [0.130, 0.070, 0.070];
const TONGUE = [0.870, 0.400, 0.430];
const NOSE = [0.110, 0.085, 0.080];

// ---------------------------------------------------------------------------
// 2D signed distance helpers. Drawing with fields rather than a rasteriser
// gives exact antialiasing for free, and the shapes stay resolution
// independent.
// ---------------------------------------------------------------------------

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

function sdEllipse(px, py, cx, cy, rx, ry) {
  const x = (px - cx) / rx;
  const y = (py - cy) / ry;
  const k = Math.hypot(x, y);
  if (k === 0) return -Math.min(rx, ry);
  // Bounded approximation; exact enough on the zero level set for drawing.
  return (k - 1) * Math.min(rx, ry);
}

/** Rounded segment, for the strokes of the upper lip. */
function sdSegment(px, py, ax, ay, bx, by, r) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay;
  const h = denom === 0 ? 0 : Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function main() {
  const started = Date.now();
  const { eye, cheek, mouth, nose, glint } = FACE_PROJECTION.layout;

  const rgb = new Uint8Array(SIZE * SIZE * 3);

  // One texel, used as the antialiasing width.
  const aa = 1.2 / SIZE;

  const colour = [0, 0, 0];
  const paint = (dst, src, coverage) => {
    dst[0] += (src[0] - dst[0]) * coverage;
    dst[1] += (src[1] - dst[1]) * coverage;
    dst[2] += (src[2] - dst[2]) * coverage;
  };
  const cover = (d) => 1 - smoothstep(-aa, aa, d);

  for (let py = 0; py < SIZE; py++) {
    const v = (py + 0.5) / SIZE;
    for (let px = 0; px < SIZE; px++) {
      const u = (px + 0.5) / SIZE;

      colour[0] = SKIN[0];
      colour[1] = SKIN[1];
      colour[2] = SKIN[2];

      for (const side of [-1, 1]) {
        // ---- cheek pouch, with a slightly darker rim
        const cx = 0.5 + side * cheek.u;
        const dCheek = sdCircle(u, v, cx, cheek.v, cheek.r);
        paint(colour, CHEEK_EDGE, cover(dCheek));
        paint(colour, CHEEK, cover(dCheek + cheek.r * 0.14));

        // ---- eye, with the highlight up and towards the nose
        const ex = 0.5 + side * eye.u;
        paint(colour, EYE, cover(sdEllipse(u, v, ex, eye.v, eye.rx, eye.ry)));
        paint(colour, GLINT, cover(sdEllipse(
          u, v, ex - side * glint.du, eye.v - glint.dv, glint.rx, glint.ry,
        )));

      }

      // ---- open mouth: an oval with a notch bitten out of its upper edge.
      const body = sdEllipse(u, v, 0.5, mouth.v, mouth.rx, mouth.ry);
      const biteL = sdCircle(u, v, 0.5 - mouth.biteU, mouth.v - mouth.biteV, mouth.biteR);
      const biteR = sdCircle(u, v, 0.5 + mouth.biteU, mouth.v - mouth.biteV, mouth.biteR);
      const notch = Math.max(biteL, biteR);          // intersection, not union
      const opening = Math.max(body, -notch);
      paint(colour, MOUTH, cover(opening));
      // Tongue sits in the floor of the opening, clipped to it.
      const tongue = Math.max(
        sdEllipse(u, v, 0.5, mouth.v + mouth.ry * 0.44, mouth.rx * 0.60, mouth.ry * 0.36),
        opening + 0.004,
      );
      paint(colour, TONGUE, cover(tongue));

      // ---- nose
      paint(colour, NOSE, cover(sdEllipse(u, v, 0.5, nose.v, nose.rx, nose.ry)));

      const o = (py * SIZE + px) * 3;
      for (let c = 0; c < 3; c++) {
        rgb[o + c] = Math.round(Math.max(0, Math.min(1, colour[c])) * 255);
      }
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  const encoded = encodePNG(rgb, SIZE, SIZE);
  const texturePath = path.join(OUT_DIR, 'face.png');
  fs.writeFileSync(texturePath, encoded);
  // Same image again where it is easy to open and judge flat, which is the
  // whole reason for moving the face out of geometry.
  fs.writeFileSync(path.join(PREVIEW_DIR, 'face-texture.png'), encoded);

  const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`[face] ${SIZE}x${SIZE} -> ${path.relative(process.cwd(), texturePath)} (${kb(texturePath)})`);
  console.log(`[face] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main();
