// Horizontal collision against scenery.
//
// Trees and rocks are drawn as instanced meshes with a few thousand transforms
// and no collision at all, so the character walked straight through them. Rather
// than a physics engine, each prop contributes a circle in the XZ plane and the
// character is pushed out of any it overlaps.
//
// Lookups go through a uniform grid. A linear scan over ~2000 props every frame
// would be wasteful when only the handful within a couple of metres can possibly
// matter, and the props never move, so the grid is built once and never updated.

export class ColliderField {
  /**
   * @param {number} worldSize width of the world in metres
   * @param {number} cellSize  grid pitch; should comfortably exceed the largest
   *   prop radius so a query only ever needs the 3x3 neighbourhood
   */
  constructor(worldSize, cellSize = 6) {
    this.half = worldSize / 2;
    this.cellSize = cellSize;
    this.columns = Math.ceil(worldSize / cellSize) + 1;
    this.cells = new Map();
    this.count = 0;
    this.maxRadius = 0;
  }

  _key(cx, cz) {
    return cz * this.columns + cx;
  }

  _cellCoords(x, z) {
    return [
      Math.floor((x + this.half) / this.cellSize),
      Math.floor((z + this.half) / this.cellSize),
    ];
  }

  add(x, z, radius) {
    if (radius <= 0) return;
    const [cx, cz] = this._cellCoords(x, z);
    const key = this._key(cx, cz);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(x, z, radius);
    this.count++;
    if (radius > this.maxRadius) this.maxRadius = radius;
  }

  /**
   * Pushes a circle out of every collider it overlaps.
   *
   * Resolving against all overlaps in one pass rather than stopping at the first
   * is what stops the character wedging between two adjacent trunks: the pushes
   * accumulate and the result is out of both.
   *
   * @returns {{x:number, z:number, hit:boolean, nx:number, nz:number}}
   *   nx/nz is the accumulated push direction, for cancelling velocity into it.
   */
  resolve(x, z, radius) {
    const [cx, cz] = this._cellCoords(x, z);
    let outX = x;
    let outZ = z;
    let pushX = 0;
    let pushZ = 0;
    let hit = false;

    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        const bucket = this.cells.get(this._key(gx, gz));
        if (!bucket) continue;

        for (let i = 0; i < bucket.length; i += 3) {
          const px = bucket[i];
          const pz = bucket[i + 1];
          const pr = bucket[i + 2];
          const combined = pr + radius;

          let dx = outX - px;
          let dz = outZ - pz;
          let distanceSq = dx * dx + dz * dz;
          if (distanceSq >= combined * combined) continue;

          let distance = Math.sqrt(distanceSq);
          if (distance < 1e-5) {
            // Dead centre: no meaningful direction, so pick one deterministically
            // rather than dividing by zero.
            dx = 1;
            dz = 0;
            distance = 1;
          }

          const overlap = combined - distance;
          const nx = dx / distance;
          const nz = dz / distance;
          outX += nx * overlap;
          outZ += nz * overlap;
          pushX += nx * overlap;
          pushZ += nz * overlap;
          hit = true;
        }
      }
    }

    const pushLength = Math.hypot(pushX, pushZ);
    return {
      x: outX,
      z: outZ,
      hit,
      nx: pushLength > 1e-6 ? pushX / pushLength : 0,
      nz: pushLength > 1e-6 ? pushZ / pushLength : 0,
    };
  }
}

/**
 * @param {Array<{data: Float32Array, stride: number, radiusOf: (scale:number)=>number}>} groups
 */
export function buildColliders(worldSize, groups) {
  const field = new ColliderField(worldSize);
  for (const { data, stride, radiusOf } of groups) {
    for (let i = 0; i < data.length; i += stride) {
      field.add(data[i], data[i + 2], radiusOf(data[i + 3]));
    }
  }
  return field;
}
