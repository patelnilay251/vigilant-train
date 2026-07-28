import * as THREE from 'three';

// A finite patch of grass that follows the player.
//
// Covering 400x400 metres at this density would be millions of instances, so
// instead a fixed-size disc is re-seeded whenever the player leaves the cell it
// was built around. Wind is done in the vertex shader from the instance origin,
// which keeps the per-frame cost at zero once the patch is placed.

const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
const tmpColor = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

// Roughly a quarter of the character's height. Anything taller reads as reeds
// rather than turf, and at this density it would also swamp the silhouette.
const BLADE_HEIGHT = 0.30;

function buildBlade(segments = 4) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const y = t * BLADE_HEIGHT;
    const halfWidth = 0.032 * (1 - t * 0.93);
    const curve = t * t * 0.055;
    positions.push(-halfWidth, y, curve, halfWidth, y, curve);
    // Near-vertical on purpose. With a true face normal, each blade's random
    // yaw decides how much light it catches, and the field reads as scattered
    // dark shards rather than turf.
    normals.push(0, 0.96, 0.28, 0, 0.96, 0.28);
    // Slightly darker at the base fakes self-shadowing within the sward.
    const shade = 0.66 + t * 0.34;
    colors.push(shade, shade, shade, shade, shade, shade);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

export class GrassField {
  constructor(field, { radius = 24, spacing = 0.38, maxInstances = 16000 } = {}) {
    this.field = field;
    this.radius = radius;
    this.spacing = spacing;

    this.uniforms = {
      uTime: { value: 0 },
      uWind: { value: 1.0 },
      uBladeHeight: { value: BLADE_HEIGHT },
      uFadeStart: { value: radius * 0.62 },
      uFadeEnd: { value: radius },
      uCenter: { value: new THREE.Vector3() },
    };

    const material = new THREE.MeshLambertMaterial({
      color: '#ffffff',
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', /* glsl */`
          #include <common>
          uniform float uTime;
          uniform float uWind;
          uniform float uBladeHeight;
          uniform float uFadeStart;
          uniform float uFadeEnd;
          uniform vec3 uCenter;
          varying float vFade;
        `)
        .replace('#include <begin_vertex>', /* glsl */`
          #include <begin_vertex>
          vec3 instanceOrigin = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);

          // Bend increases towards the tip so the base stays rooted.
          float bend = pow(clamp(transformed.y / uBladeHeight, 0.0, 1.0), 1.7);
          float phase = instanceOrigin.x * 0.34 + instanceOrigin.z * 0.27;
          float gust = 0.65 + 0.35 * sin(uTime * 0.45 + instanceOrigin.x * 0.03);
          // Amplitude is in world units at the blade tip; much above ~0.1 and
          // blades bend past horizontal and read as scythes rather than grass.
          float sway = sin(uTime * 1.7 + phase) * 0.085 + sin(uTime * 3.1 + phase * 1.9) * 0.035;

          // Blades carry a random yaw, so a naive offset would blow every blade a
          // different way. Recover cos/sin of that yaw from the instance matrix
          // and express a single world-space wind direction in blade-local space.
          vec2 axis = normalize(vec2(instanceMatrix[0][0], instanceMatrix[0][2]));
          vec2 windLocal = vec2(axis.x, -axis.y);
          transformed.xz += windLocal * (sway * bend * uWind * gust);

          // Shrink blades towards the edge of the patch so its boundary is not
          // a visible circle.
          float d = distance(instanceOrigin.xz, uCenter.xz);
          vFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, d);
          transformed.xz *= mix(0.55, 1.0, vFade);
          transformed.y *= vFade;
        `);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <dithering_fragment>', /* glsl */`
          #include <dithering_fragment>
          if (vFade < 0.02) discard;
        `);
    };
    // Distinct key so this variant does not collide with other Lambert programs.
    material.customProgramCacheKey = () => 'grass-wind-v1';

    this.mesh = new THREE.InstancedMesh(buildBlade(), material, maxInstances);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'grass';
    this.mesh.count = 0;

    this.center = new THREE.Vector2(Infinity, Infinity);
    this.rebuildDistance = 2.0;
  }

  /** Deterministic per-cell jitter so blades do not swim when the patch moves. */
  static jitter(ix, iz, salt) {
    const s = Math.sin(ix * 127.1 + iz * 311.7 + salt * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }

  reseed(cx, cz) {
    const { field, radius, spacing } = this;
    const steps = Math.ceil((radius * 2) / spacing);
    const originX = Math.floor((cx - radius) / spacing) * spacing;
    const originZ = Math.floor((cz - radius) / spacing) * spacing;

    let count = 0;
    const max = this.mesh.instanceMatrix.count;

    for (let j = 0; j <= steps && count < max; j++) {
      for (let i = 0; i <= steps && count < max; i++) {
        const gx = Math.round((originX + i * spacing) / spacing);
        const gz = Math.round((originZ + j * spacing) / spacing);

        const jx = GrassField.jitter(gx, gz, 1) - 0.5;
        const jz = GrassField.jitter(gx, gz, 2) - 0.5;
        const x = gx * spacing + jx * spacing * 1.4;
        const z = gz * spacing + jz * spacing * 1.4;

        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz > radius * radius) continue;

        const h = field.heightAt(x, z);
        if (h < field.waterLevel + 0.35) continue;
        if (field.slopeAt(x, z) > 0.72) continue;

        const r = GrassField.jitter(gx, gz, 3);
        if (r < 0.08) continue; // thin it out slightly

        tmpPos.set(x, h - 0.02, z);
        tmpQuat.setFromAxisAngle(UP, GrassField.jitter(gx, gz, 4) * Math.PI * 2);
        const height = 0.75 + GrassField.jitter(gx, gz, 5) * 0.55;
        tmpScale.set(0.85 + GrassField.jitter(gx, gz, 6) * 0.4, height, 1);
        tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
        this.mesh.setMatrixAt(count, tmpMatrix);

        const ao = 0.68 + 0.32 * field.aoAt(x, z);
        const tone = GrassField.jitter(gx, gz, 7);
        tmpColor.setRGB(
          (0.40 + tone * 0.22) * ao,
          (0.66 + tone * 0.26) * ao,
          (0.27 + tone * 0.15) * ao,
        );
        this.mesh.setColorAt(count, tmpColor);
        count++;
      }
    }

    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.center.set(cx, cz);
    this.uniforms.uCenter.value.set(cx, 0, cz);
  }

  update(elapsed, focus, windStrength = 1) {
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uWind.value = windStrength;
    if (Math.hypot(focus.x - this.center.x, focus.z - this.center.y) > this.rebuildDistance) {
      this.reseed(focus.x, focus.z);
    }
  }
}
