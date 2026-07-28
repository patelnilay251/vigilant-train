// Bakes the world: a heightfield, a horizon-traced ambient occlusion map, and
// scattered instance transforms for props.
//
// All of this could be done at load time in the browser, but doing it here means
// the client starts with finished binary data, the result is identical on every
// machine, and the expensive part (AO tracing, ~10M ray steps) never costs the
// player a frame.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeNoise2D, fbm, ridged, mulberry32 } from './lib/noise.mjs';
import { clamp, smoothstep } from './lib/sdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../web/assets');

const SEED = 1337;
const WORLD_SIZE = 400;          // metres across
const HALF = WORLD_SIZE / 2;
const RES = 320;                 // heightmap samples per axis
const CELL = WORLD_SIZE / (RES - 1);
const WATER_LEVEL = 0;

const LAKE = { x: 92, z: -74, radius: 58, depth: 17 };

const noise = makeNoise2D(SEED);
const forestNoise = makeNoise2D(SEED + 991);
const rockNoise = makeNoise2D(SEED + 4423);

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

function heightAt(x, z) {
  // Domain warping first: it turns the obvious grid-aligned lumps of raw fBm
  // into something that reads as eroded.
  const warp = fbm(noise, x * 0.0061 + 11.3, z * 0.0061 - 7.1, 3) * 24;

  const distance = Math.hypot(x, z) / HALF;

  // Flat, friendly meadow around the spawn point.
  const openness = smoothstep(0.0, 0.17, distance);
  const hills = fbm(noise, (x + warp) * 0.0042, (z + warp) * 0.0042, 5);

  // A rim of mountains hides the world boundary without a visible wall.
  const mountainMask = smoothstep(0.40, 0.98, distance);
  const crest = ridged(noise, x * 0.0026, z * 0.0026, 4);

  let h = 6.0;
  h += hills * 17 * (0.32 + 0.68 * openness);
  h += crest * crest * 52 * mountainMask;
  h += fbm(noise, x * 0.021, z * 0.021, 3) * 1.7;

  // Carve the lake basin.
  const lakeDistance = Math.hypot(x - LAKE.x, z - LAKE.z) / LAKE.radius;
  h -= LAKE.depth * Math.exp(-(lakeDistance * lakeDistance) * 1.35);

  // Beach flattening: compress heights near the waterline so shorelines are
  // gentle instead of cliff-like.
  if (h > WATER_LEVEL - 2.5 && h < WATER_LEVEL + 2.5) {
    const t = (h - (WATER_LEVEL - 2.5)) / 5;
    h = WATER_LEVEL - 2.5 + 5 * (t * t * (3 - 2 * t));
  }

  return h;
}

function bakeHeightmap() {
  const heights = new Float32Array(RES * RES);
  for (let j = 0; j < RES; j++) {
    const z = -HALF + j * CELL;
    for (let i = 0; i < RES; i++) {
      heights[j * RES + i] = heightAt(-HALF + i * CELL, z);
    }
  }
  return heights;
}

const sampleHeight = (heights, i, j) =>
  heights[clamp(j, 0, RES - 1) * RES + clamp(i, 0, RES - 1)];

/** Bilinear sample in world space; mirrors what the client does at runtime. */
function heightAtWorld(heights, x, z) {
  const fx = clamp((x + HALF) / CELL, 0, RES - 1.0001);
  const fz = clamp((z + HALF) / CELL, 0, RES - 1.0001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const h00 = sampleHeight(heights, i, j);
  const h10 = sampleHeight(heights, i + 1, j);
  const h01 = sampleHeight(heights, i, j + 1);
  const h11 = sampleHeight(heights, i + 1, j + 1);
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

function slopeAt(heights, i, j) {
  const dx = (sampleHeight(heights, i + 1, j) - sampleHeight(heights, i - 1, j)) / (2 * CELL);
  const dz = (sampleHeight(heights, i, j + 1) - sampleHeight(heights, i, j - 1)) / (2 * CELL);
  // Magnitude of the gradient; 0 is flat, 1 is a 45 degree slope.
  return Math.hypot(dx, dz);
}

// ---------------------------------------------------------------------------
// Ambient occlusion by horizon tracing
// ---------------------------------------------------------------------------

function bakeAmbientOcclusion(heights) {
  const ao = new Uint8Array(RES * RES);
  const DIRECTIONS = 12;
  const STEPS = 14;
  const STEP_LENGTH = 3.2; // metres

  const dirs = [];
  for (let d = 0; d < DIRECTIONS; d++) {
    const a = (d / DIRECTIONS) * Math.PI * 2;
    dirs.push([Math.cos(a), Math.sin(a)]);
  }

  for (let j = 0; j < RES; j++) {
    const z = -HALF + j * CELL;
    for (let i = 0; i < RES; i++) {
      const x = -HALF + i * CELL;
      const h0 = heights[j * RES + i];

      let occlusion = 0;
      for (const [dx, dz] of dirs) {
        let maxTangent = 0;
        for (let s = 1; s <= STEPS; s++) {
          const dist = s * STEP_LENGTH;
          const h = heightAtWorld(heights, x + dx * dist, z + dz * dist);
          const tangent = (h - h0) / dist;
          if (tangent > maxTangent) maxTangent = tangent;
        }
        // Convert the horizon tangent into the fraction of the hemisphere blocked.
        occlusion += maxTangent / Math.sqrt(1 + maxTangent * maxTangent);
      }
      occlusion /= DIRECTIONS;

      const visibility = clamp(1 - occlusion, 0, 1);
      ao[j * RES + i] = Math.round(visibility * 255);
    }
  }
  return ao;
}

// ---------------------------------------------------------------------------
// Prop scattering
// ---------------------------------------------------------------------------

/**
 * Jittered-grid scatter with per-candidate rejection. Cheaper than true Poisson
 * disk sampling and visually indistinguishable once the props have varied scale.
 */
function scatter(heights, { spacing, jitter, seed, accept, transform }) {
  const rand = mulberry32(seed);
  const out = [];
  const steps = Math.floor(WORLD_SIZE / spacing);

  for (let gz = 0; gz < steps; gz++) {
    for (let gx = 0; gx < steps; gx++) {
      const x = -HALF + (gx + 0.5 + (rand() - 0.5) * jitter) * spacing;
      const z = -HALF + (gz + 0.5 + (rand() - 0.5) * jitter) * spacing;
      if (Math.abs(x) > HALF - 4 || Math.abs(z) > HALF - 4) continue;

      const fx = (x + HALF) / CELL;
      const fz = (z + HALF) / CELL;
      const h = heightAtWorld(heights, x, z);
      const slope = slopeAt(heights, Math.round(fx), Math.round(fz));

      if (!accept({ x, z, h, slope, rand })) continue;
      out.push(transform({ x, z, h, slope, rand }));
    }
  }
  return out;
}

function main() {
  const started = Date.now();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[world] baking ${RES}x${RES} heightfield over ${WORLD_SIZE}m`);
  const heights = bakeHeightmap();

  let minH = Infinity;
  let maxH = -Infinity;
  for (const h of heights) {
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  console.log(`[world] elevation range ${minH.toFixed(1)} .. ${maxH.toFixed(1)}`);

  console.log('[world] tracing ambient occlusion horizons');
  const ao = bakeAmbientOcclusion(heights);

  // Trees cluster into forests via a low-frequency density field, avoid steep
  // ground, and stay clear of the water and the spawn clearing.
  const trees = scatter(heights, {
    spacing: 5.0,
    jitter: 0.95,
    seed: SEED + 17,
    accept: ({ x, z, h, slope, rand }) => {
      if (h < WATER_LEVEL + 1.2 || h > 34) return false;
      if (slope > 0.62) return false;
      if (Math.hypot(x, z) < 18) return false;
      const density = fbm(forestNoise, x * 0.0075, z * 0.0075, 3);
      const threshold = 0.02 + 0.5 * smoothstep(28, 36, h);
      return density > threshold && rand() < 0.82;
    },
    transform: ({ x, z, h, rand }) => ([
      x, h - 0.15, z,
      0.75 + rand() * 0.85,      // scale
      rand() * Math.PI * 2,      // yaw
      Math.floor(rand() * 3),    // variant
    ]),
  });

  const rocks = scatter(heights, {
    spacing: 9.5,
    jitter: 1.0,
    seed: SEED + 53,
    accept: ({ x, z, h, slope, rand }) => {
      if (h < WATER_LEVEL - 1.5) return false;
      if (Math.hypot(x, z) < 12) return false;
      const density = fbm(rockNoise, x * 0.012, z * 0.012, 2);
      return (slope > 0.30 || density > 0.34) && rand() < 0.55;
    },
    transform: ({ x, z, h, rand }) => ([
      x, h - 0.25 - rand() * 0.3, z,
      0.5 + rand() * 1.5,
      rand() * Math.PI * 2,
      Math.floor(rand() * 3),
    ]),
  });

  // Collectibles: spread out, always reachable, never underwater.
  const berries = scatter(heights, {
    spacing: 34,
    jitter: 1.0,
    seed: SEED + 701,
    accept: ({ x, z, h, slope }) => {
      if (h < WATER_LEVEL + 1.0 || h > 30) return false;
      if (slope > 0.42) return false;
      return Math.hypot(x, z) > 14;
    },
    transform: ({ x, z, h, rand }) => ([x, h + 0.55, z, 0.85 + rand() * 0.3, rand() * Math.PI * 2, 0]),
  });

  console.log(`[world] scattered ${trees.length} trees, ${rocks.length} rocks, ${berries.length} berries`);

  const flatten = (rows) => {
    const out = new Float32Array(rows.length * 6);
    rows.forEach((row, i) => out.set(row, i * 6));
    return out;
  };

  fs.writeFileSync(path.join(OUT_DIR, 'heightmap.bin'), Buffer.from(heights.buffer));
  fs.writeFileSync(path.join(OUT_DIR, 'ao.bin'), Buffer.from(ao.buffer));
  fs.writeFileSync(path.join(OUT_DIR, 'trees.bin'), Buffer.from(flatten(trees).buffer));
  fs.writeFileSync(path.join(OUT_DIR, 'rocks.bin'), Buffer.from(flatten(rocks).buffer));

  const spawnHeight = heightAtWorld(heights, 0, 0);
  const manifest = {
    seed: SEED,
    worldSize: WORLD_SIZE,
    resolution: RES,
    cell: CELL,
    waterLevel: WATER_LEVEL,
    elevation: { min: minH, max: maxH },
    lake: LAKE,
    spawn: { x: 0, y: spawnHeight, z: 0 },
    instanceStride: 6,
    counts: { trees: trees.length, rocks: rocks.length, berries: berries.length },
    berries: berries.map(([x, y, z, s, r]) => ({ x, y, z, scale: s, rotation: r })),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'world.json'), JSON.stringify(manifest));

  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`[world] heightmap ${kb(heights.byteLength)}, ao ${kb(ao.byteLength)}, `
    + `trees ${kb(trees.length * 24)}, rocks ${kb(rocks.length * 24)}`);
  console.log(`[world] spawn ground height ${spawnHeight.toFixed(2)}`);
  console.log(`[world] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main();
