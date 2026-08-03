// Runtime access to the baked heightfield.
//
// Terrain rendering, character grounding, prop placement and grass all sample
// through this one class, which is what guarantees they agree: the character
// stands exactly on the surface that is drawn, because both read the same
// bilinear interpolation of the same texels.

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export class Heightfield {
  constructor(manifest, heights, ao) {
    this.res = manifest.resolution;
    this.size = manifest.worldSize;
    this.half = this.size / 2;
    this.cell = manifest.cell;
    this.waterLevel = manifest.waterLevel;
    this.heights = heights;
    this.ao = ao;
  }

  /** Height at integer grid coordinates, clamped at the edges. */
  texel(i, j) {
    const ci = clamp(i, 0, this.res - 1);
    const cj = clamp(j, 0, this.res - 1);
    return this.heights[cj * this.res + ci];
  }

  aoTexel(i, j) {
    const ci = clamp(i, 0, this.res - 1);
    const cj = clamp(j, 0, this.res - 1);
    return this.ao[cj * this.res + ci] / 255;
  }

  /** Fractional grid coordinates for a world position. */
  toGrid(x, z) {
    return [
      clamp((x + this.half) / this.cell, 0, this.res - 1.0001),
      clamp((z + this.half) / this.cell, 0, this.res - 1.0001),
    ];
  }

  heightAt(x, z) {
    const [fx, fz] = this.toGrid(x, z);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h00 = this.texel(i, j);
    const h10 = this.texel(i + 1, j);
    const h01 = this.texel(i, j + 1);
    const h11 = this.texel(i + 1, j + 1);
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  aoAt(x, z) {
    const [fx, fz] = this.toGrid(x, z);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a00 = this.aoTexel(i, j);
    const a10 = this.aoTexel(i + 1, j);
    const a01 = this.aoTexel(i, j + 1);
    const a11 = this.aoTexel(i + 1, j + 1);
    return (a00 * (1 - tx) + a10 * tx) * (1 - tz) + (a01 * (1 - tx) + a11 * tx) * tz;
  }

  /** Surface normal from central differences of the interpolated field. */
  normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
    const e = this.cell;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    const len = Math.hypot(dx, 1, dz);
    out.x = -dx / len;
    out.y = 1 / len;
    out.z = -dz / len;
    return out;
  }

  /** 0 on the flat, ~1 at a 45-degree slope. */
  slopeAt(x, z) {
    const e = this.cell;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.hypot(dx, dz);
  }

  clampToWorld(x, z, margin = 3) {
    const limit = this.half - margin;
    return [clamp(x, -limit, limit), clamp(z, -limit, limit)];
  }
}
