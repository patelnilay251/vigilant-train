import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Instanced scenery. Every prop type is one geometry drawn once per frame with
// a few thousand transforms, so the whole forest costs four draw calls.

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/** Deterministic hash so prop variation is stable across reloads. */
function hash(n) {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

function buildBroadleaf() {
  const trunk = new THREE.CylinderGeometry(0.17, 0.30, 2.3, 7, 1);
  trunk.translate(0, 1.15, 0);

  // Three overlapping blobs read as a canopy without any transparency.
  const blobs = [
    new THREE.IcosahedronGeometry(1.35, 1).translate(0, 3.15, 0),
    new THREE.IcosahedronGeometry(1.00, 1).translate(0.85, 2.55, 0.35),
    new THREE.IcosahedronGeometry(0.90, 1).translate(-0.72, 2.70, -0.42),
  ];
  return { trunk, leaves: mergeGeometries(blobs) };
}

function buildPine() {
  const trunk = new THREE.CylinderGeometry(0.13, 0.24, 2.6, 7, 1);
  trunk.translate(0, 1.3, 0);

  const tiers = [
    new THREE.ConeGeometry(1.45, 1.9, 9).translate(0, 2.35, 0),
    new THREE.ConeGeometry(1.12, 1.7, 9).translate(0, 3.35, 0),
    new THREE.ConeGeometry(0.75, 1.5, 9).translate(0, 4.30, 0),
  ];
  return { trunk, leaves: mergeGeometries(tiers) };
}

function instanced(geometry, material, count) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  return mesh;
}

/**
 * @param {Float32Array} data interleaved [x, y, z, scale, yaw, variant]
 */
export function createTrees(data, stride = 6) {
  const count = data.length / stride;
  const broadleafIdx = [];
  const pineIdx = [];
  for (let i = 0; i < count; i++) {
    (data[i * stride + 5] >= 2 ? pineIdx : broadleafIdx).push(i);
  }

  const barkMaterial = new THREE.MeshStandardMaterial({ color: '#6b4b32', roughness: 0.95, flatShading: true });
  const leafMaterial = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, flatShading: true });

  const group = new THREE.Group();
  group.name = 'trees';

  for (const [indices, build, tint] of [
    [broadleafIdx, buildBroadleaf, ['#4e7f34', '#68974a', '#3f6b2c']],
    [pineIdx, buildPine, ['#2f5c3c', '#3d6b45', '#27503a']],
  ]) {
    if (indices.length === 0) continue;
    const { trunk, leaves } = build();
    const trunkMesh = instanced(trunk, barkMaterial, indices.length);
    const leafMesh = instanced(leaves, leafMaterial.clone(), indices.length);

    indices.forEach((sourceIndex, i) => {
      const o = sourceIndex * stride;
      tmpPos.set(data[o], data[o + 1], data[o + 2]);
      const scale = data[o + 3];
      tmpQuat.setFromAxisAngle(UP, data[o + 4]);
      // Slight non-uniform scale stops the copies from reading as identical.
      const lean = 0.9 + hash(sourceIndex * 3.7) * 0.24;
      tmpScale.set(scale * lean, scale, scale * lean);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      trunkMesh.setMatrixAt(i, tmpMatrix);
      leafMesh.setMatrixAt(i, tmpMatrix);

      tmpColor.set(tint[Math.floor(hash(sourceIndex * 9.13) * tint.length)]);
      const shade = 0.86 + hash(sourceIndex * 5.11) * 0.28;
      tmpColor.multiplyScalar(shade);
      leafMesh.setColorAt(i, tmpColor);
    });

    trunkMesh.instanceMatrix.needsUpdate = true;
    leafMesh.instanceMatrix.needsUpdate = true;
    if (leafMesh.instanceColor) leafMesh.instanceColor.needsUpdate = true;
    trunkMesh.computeBoundingSphere();
    leafMesh.computeBoundingSphere();
    group.add(trunkMesh, leafMesh);
  }

  return group;
}

export function createRocks(data, stride = 6) {
  const count = data.length / stride;
  if (count === 0) return new THREE.Group();

  // One lumpy base shape; instance scale and rotation do the rest.
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const displace = 0.72 + hash(x * 12.9 + y * 78.2 + z * 37.7) * 0.55;
    position.setXYZ(i, x * displace, y * displace * 0.78, z * displace);
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: '#ffffff', roughness: 0.92, metalness: 0.0, flatShading: true,
  });

  const mesh = instanced(geometry, material, count);
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    tmpPos.set(data[o], data[o + 1], data[o + 2]);
    const scale = data[o + 3];
    tmpQuat.setFromEuler(new THREE.Euler(hash(i * 2.1) * 0.5 - 0.25, data[o + 4], hash(i * 6.3) * 0.5 - 0.25));
    tmpScale.set(scale, scale * (0.6 + hash(i * 1.7) * 0.5), scale);
    tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
    mesh.setMatrixAt(i, tmpMatrix);

    const grey = 0.42 + hash(i * 4.9) * 0.30;
    tmpColor.setRGB(grey, grey * 0.98, grey * 0.92);
    mesh.setColorAt(i, tmpColor);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = 'rocks';
  return mesh;
}

/**
 * Collectible berries. Kept as one instanced mesh whose matrices are refreshed
 * each frame for the bob, with collected entries scaled to zero.
 */
export class Berries {
  constructor(entries) {
    this.entries = entries.map((e, i) => ({ ...e, collected: false, phase: hash(i * 8.3) * Math.PI * 2 }));
    this.remaining = this.entries.length;

    const geometry = new THREE.SphereGeometry(0.17, 14, 11);
    const material = new THREE.MeshStandardMaterial({
      color: '#ff4d5e',
      emissive: '#ff2740',
      emissiveIntensity: 0.85,
      roughness: 0.35,
      metalness: 0.0,
    });

    this.mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, this.entries.length));
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'berries';

    // A soft additive halo so they are findable from a distance.
    const haloGeometry = new THREE.SphereGeometry(0.36, 12, 9);
    const haloMaterial = new THREE.MeshBasicMaterial({
      color: '#ff8090', transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.halo = new THREE.InstancedMesh(haloGeometry, haloMaterial, Math.max(1, this.entries.length));
    this.halo.frustumCulled = false;
    this.halo.renderOrder = 5;

    this.group = new THREE.Group();
    this.group.add(this.mesh, this.halo);
    this.update(0);
  }

  update(elapsed) {
    for (let i = 0; i < this.entries.length; i++) {
      const berry = this.entries[i];
      if (berry.collected) {
        tmpMatrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, tmpMatrix);
        this.halo.setMatrixAt(i, tmpMatrix);
        continue;
      }
      const bob = Math.sin(elapsed * 1.9 + berry.phase) * 0.13;
      tmpPos.set(berry.x, berry.y + 0.22 + bob, berry.z);
      tmpQuat.setFromAxisAngle(UP, elapsed * 1.1 + berry.phase);
      tmpScale.setScalar(berry.scale);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      this.mesh.setMatrixAt(i, tmpMatrix);

      const pulse = berry.scale * (1 + Math.sin(elapsed * 2.6 + berry.phase) * 0.12);
      tmpScale.setScalar(pulse);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      this.halo.setMatrixAt(i, tmpMatrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.halo.instanceMatrix.needsUpdate = true;
  }

  /** Returns the entries collected by a body at `position` this frame. */
  collect(position, radius = 1.15) {
    const picked = [];
    const r2 = radius * radius;
    for (const berry of this.entries) {
      if (berry.collected) continue;
      const dx = berry.x - position.x;
      const dy = berry.y + 0.3 - position.y;
      const dz = berry.z - position.z;
      if (dx * dx + dy * dy * 0.4 + dz * dz <= r2) {
        berry.collected = true;
        this.remaining--;
        picked.push(berry);
      }
    }
    return picked;
  }
}
