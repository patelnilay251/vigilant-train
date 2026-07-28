// Deterministic gradient noise and the fractal variants the terrain is built
// from. Seeded so that every run of the asset pipeline produces byte-identical
// output — the world is reproducible from the seed alone.

/** Small, fast, well-distributed PRNG. Returns a function producing [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRADIENTS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.SQRT1_2, -Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2],
];

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Classic 2D gradient (Perlin) noise in roughly [-1, 1]. */
export function makeNoise2D(seed) {
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  const source = new Uint8Array(256);
  for (let i = 0; i < 256; i++) source[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = source[i];
    source[i] = source[j];
    source[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = source[i & 255];

  return function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;

    const dot = (gx, gy, dx, dy) => gx * dx + gy * dy;
    const g = (ix, iy) => GRADIENTS[perm[(perm[ix & 255] + (iy & 255)) & 255] & 7];

    const g00 = g(X, Y);
    const g10 = g(X + 1, Y);
    const g01 = g(X, Y + 1);
    const g11 = g(X + 1, Y + 1);

    const n00 = dot(g00[0], g00[1], xf, yf);
    const n10 = dot(g10[0], g10[1], xf - 1, yf);
    const n01 = dot(g01[0], g01[1], xf, yf - 1);
    const n11 = dot(g11[0], g11[1], xf - 1, yf - 1);

    const u = fade(xf);
    const v = fade(yf);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.4142;
  };
}

/** Fractional Brownian motion: summed octaves at doubling frequency. */
export function fbm(noise, x, y, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise(x * frequency, y * frequency);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal. Folding the noise about zero and inverting produces the
 * sharp crests that read as mountain ranges rather than dunes.
 */
export function ridged(noise, x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise(x * frequency, y * frequency));
    sum += amplitude * n * n;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}
