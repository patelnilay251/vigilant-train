import * as THREE from 'three';

// Terrain mesh built directly from the baked heightfield.
//
// Normals come from the analytic gradient of the field rather than
// computeVertexNormals(), which avoids the faceted look you get from averaging
// triangle normals on a regular grid. Biome colour is resolved per vertex from
// height and slope, with the baked occlusion folded in.

const PALETTE = {
  sandDeep: new THREE.Color('#b9a077'),
  sand: new THREE.Color('#d9c79c'),
  grass: new THREE.Color('#5c8f3f'),
  grassDry: new THREE.Color('#7fa049'),
  grassDark: new THREE.Color('#3f6b30'),
  rock: new THREE.Color('#6d6660'),
  rockLight: new THREE.Color('#8a8279'),
  snow: new THREE.Color('#eaf0f6'),
};

const lerpColor = (a, b, t, out) => out.copy(a).lerp(b, t);
const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Generates a small tiling value-noise texture used to break up the flat
 * per-vertex colour at close range. Kept subtle and multiplicative.
 */
function createDetailTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);

  // Two octaves of hashed value noise, tileable by wrapping the lattice.
  const lattice = 32;
  const grid = new Float32Array((lattice + 1) * (lattice + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
  const at = (i, j) => grid[(j % lattice) * (lattice + 1) + (i % lattice)];
  const fade = (t) => t * t * (3 - 2 * t);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 0;
      let amp = 0.65;
      let freq = 1;
      for (let o = 0; o < 2; o++) {
        const fx = (x / size) * lattice * freq;
        const fy = (y / size) * lattice * freq;
        const i = Math.floor(fx);
        const j = Math.floor(fy);
        const tx = fade(fx - i);
        const ty = fade(fy - j);
        const a = at(i, j) * (1 - tx) + at(i + 1, j) * tx;
        const b = at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx;
        value += (a * (1 - ty) + b * ty) * amp;
        amp *= 0.45;
        freq *= 2.7;
      }
      const v = Math.round(190 + value * 65);
      const o = (y * size + x) * 4;
      image.data[o] = v;
      image.data[o + 1] = v;
      image.data[o + 2] = v;
      image.data[o + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(90, 90);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createTerrain(field) {
  const { res, size, half, cell } = field;
  const vertexCount = res * res;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  const color = new THREE.Color();
  const scratch = new THREE.Color();

  let maxHeight = -Infinity;
  for (let i = 0; i < field.heights.length; i++) {
    if (field.heights[i] > maxHeight) maxHeight = field.heights[i];
  }

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const index = j * res + i;
      const x = -half + i * cell;
      const z = -half + j * cell;
      const h = field.heights[index];

      positions[index * 3] = x;
      positions[index * 3 + 1] = h;
      positions[index * 3 + 2] = z;

      // Analytic normal from neighbouring texels.
      const dx = (field.texel(i + 1, j) - field.texel(i - 1, j)) / (2 * cell);
      const dz = (field.texel(i, j + 1) - field.texel(i, j - 1)) / (2 * cell);
      const len = Math.hypot(dx, 1, dz);
      normals[index * 3] = -dx / len;
      normals[index * 3 + 1] = 1 / len;
      normals[index * 3 + 2] = -dz / len;

      uvs[index * 2] = i / (res - 1);
      uvs[index * 2 + 1] = j / (res - 1);

      // ---- biome blend
      const slope = Math.hypot(dx, dz);
      const above = h - field.waterLevel;

      // Grass tone varies with a cheap positional hash so meadows aren't uniform.
      const tint = (Math.sin(x * 0.13) * Math.cos(z * 0.11) + Math.sin(x * 0.031 + z * 0.043)) * 0.5;
      lerpColor(PALETTE.grass, PALETTE.grassDry, smoothstep(-0.6, 0.9, tint), color);
      lerpColor(color, PALETTE.grassDark, smoothstep(0.15, 0.5, slope) * 0.55, color);

      // Sand ring around the waterline.
      const sandAmount = 1 - smoothstep(0.4, 3.4, above);
      lerpColor(color, PALETTE.sand, sandAmount * 0.92, color);
      if (above < 0) {
        lerpColor(color, PALETTE.sandDeep, smoothstep(0, -4, above) * 0.8, color);
      }

      // Rock takes over on steep ground.
      lerpColor(PALETTE.rock, PALETTE.rockLight, smoothstep(0.3, 1.2, slope), scratch);
      lerpColor(color, scratch, smoothstep(0.55, 1.05, slope), color);

      // Snow caps, but not on near-vertical faces.
      const snowLine = maxHeight * 0.66;
      const snow = smoothstep(snowLine, snowLine + 9, h) * (1 - smoothstep(0.85, 1.5, slope));
      lerpColor(color, PALETTE.snow, snow, color);

      // Baked occlusion, floored so crevices stay readable.
      const ao = 0.5 + 0.5 * field.aoTexel(i, j);
      colors[index * 3] = color.r * ao;
      colors[index * 3 + 1] = color.g * ao;
      colors[index * 3 + 2] = color.b * ao;
    }
  }

  const quads = (res - 1) * (res - 1);
  const indices = new Uint32Array(quads * 6);
  let cursor = 0;
  for (let j = 0; j < res - 1; j++) {
    for (let i = 0; i < res - 1; i++) {
      const a = j * res + i;
      const b = a + 1;
      const c = a + res;
      const d = c + 1;
      indices[cursor++] = a; indices[cursor++] = c; indices[cursor++] = b;
      indices[cursor++] = b; indices[cursor++] = c; indices[cursor++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), size);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: createDetailTexture(),
    roughness: 0.96,
    metalness: 0.0,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;

  return mesh;
}
