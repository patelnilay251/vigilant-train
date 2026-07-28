// Naive surface nets.
//
// Chosen over marching cubes deliberately: it needs no 256-entry triangle table,
// produces far more uniform topology (one vertex per straddling cell rather than
// slivers), and the dual formulation makes it trivial to emit quads that we then
// split into triangles. Vertices are seeded from edge crossings and then pushed
// onto the true isosurface with a couple of Newton steps, which removes the
// characteristic surface-nets "shrinkage" on high-curvature features like ear
// tips.

import { gradient } from './sdf.mjs';

// Corner i of a unit cell is at (i&1, (i>>1)&1, (i>>2)&1).
const CUBE_EDGES = [
  [0, 1], [1, 3], [2, 3], [0, 2],
  [4, 5], [5, 7], [6, 7], [4, 6],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * @param {(x:number,y:number,z:number)=>number} field  negative inside
 * @param {{min:number[], max:number[], resolution:number}} options
 * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array}}
 */
export function surfaceNets(field, { min, max, resolution, refineSteps = 2 }) {
  // `resolution` counts samples along the longest axis; the others get however
  // many cubic cells of that size they need. Uniform cells matter here because
  // the Newton refinement step below clamps against cell size.
  const span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const cell = Math.max(span[0], span[1], span[2]) / (resolution - 1);
  const dims = span.map((s) => Math.max(2, Math.ceil(s / cell) + 1));
  const scale = [cell, cell, cell];

  // Sample the field on the full grid once. Two z-slices of cell->vertex
  // indices are enough because faces only ever reference the previous slice.
  const nx = dims[0], ny = dims[1], nz = dims[2];
  const values = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    const wz = min[2] + z * scale[2];
    for (let y = 0; y < ny; y++) {
      const wy = min[1] + y * scale[1];
      let idx = z * nx * ny + y * nx;
      for (let x = 0; x < nx; x++, idx++) {
        values[idx] = field(min[0] + x * scale[0], wy, wz);
      }
    }
  }

  const positions = [];
  const normals = [];
  const indices = [];

  // buffer[] maps a cell (indexed on a 2-slice ring) to its emitted vertex.
  const sliceStride = nx * ny;
  const buffer = new Int32Array(sliceStride * 2).fill(-1);
  const strides = [1, nx, sliceStride];

  const corners = new Float32Array(8);

  for (let z = 0; z < nz - 1; z++) {
    const bufSlice = (z % 2) * sliceStride;
    const bufPrev = ((z + 1) % 2) * sliceStride;

    for (let y = 0; y < ny - 1; y++) {
      for (let x = 0; x < nx - 1; x++) {
        const base = z * sliceStride + y * nx + x;

        let mask = 0;
        for (let i = 0; i < 8; i++) {
          const cx = i & 1, cy = (i >> 1) & 1, cz = (i >> 2) & 1;
          const v = values[base + cx + cy * nx + cz * sliceStride];
          corners[i] = v;
          if (v < 0) mask |= 1 << i;
        }

        const cellIndex = bufSlice + y * nx + x;

        if (mask !== 0 && mask !== 255) {
          // Average the crossings on all straddling edges.
          let sx = 0, sy = 0, sz = 0, crossings = 0;
          for (let e = 0; e < 12; e++) {
            const a = CUBE_EDGES[e][0];
            const b = CUBE_EDGES[e][1];
            const va = corners[a];
            const vb = corners[b];
            if ((va < 0) === (vb < 0)) continue;
            const t = va / (va - vb);
            sx += (a & 1) + t * ((b & 1) - (a & 1));
            sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
            sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
            crossings++;
          }

          let wx = min[0] + (x + sx / crossings) * scale[0];
          let wy = min[1] + (y + sy / crossings) * scale[1];
          let wz = min[2] + (z + sz / crossings) * scale[2];

          // Newton projection onto the isosurface. The averaged point is only a
          // first-order guess; this recovers sharp-ish features without needing
          // the QEF machinery of dual contouring.
          for (let s = 0; s < refineSteps; s++) {
            const d = field(wx, wy, wz);
            if (!Number.isFinite(d) || Math.abs(d) < 1e-6) break;
            const [gx, gy, gz] = gradient(field, wx, wy, wz, cell * 0.35);
            const step = Math.max(-cell, Math.min(cell, d));
            wx -= gx * step;
            wy -= gy * step;
            wz -= gz * step;
          }

          const [nxg, nyg, nzg] = gradient(field, wx, wy, wz, cell * 0.35);

          buffer[cellIndex] = positions.length / 3;
          positions.push(wx, wy, wz);
          normals.push(nxg, nyg, nzg);
        } else {
          buffer[cellIndex] = -1;
        }

        if (mask === 0 || mask === 255) continue;

        // Emit one quad per straddling axis edge originating at corner 0, using
        // the four cells that share that edge.
        for (let axis = 0; axis < 3; axis++) {
          if ((mask & 1) === ((mask >> (1 << axis)) & 1)) continue;

          const u = (axis + 1) % 3;
          const v = (axis + 2) % 3;
          const cellCoord = [x, y, z];
          if (cellCoord[u] === 0 || cellCoord[v] === 0) continue;

          const du = strides[u];
          const dv = strides[v];

          // Cells behind us in z live in the other buffer slice.
          const at = (offset) => {
            const dz = Math.floor(offset / sliceStride);
            const within = offset - dz * sliceStride;
            const slice = dz === 0 ? bufSlice : bufPrev;
            return buffer[slice + within];
          };

          const o = y * nx + x;
          const v0 = at(o);
          const v1 = at(o - du);
          const v2 = at(o - du - dv);
          const v3 = at(o - dv);
          if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue;

          if (mask & 1) {
            indices.push(v0, v1, v2, v0, v2, v3);
          } else {
            indices.push(v0, v3, v2, v0, v2, v1);
          }
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}
