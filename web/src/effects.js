import * as THREE from 'three';

// A single pooled point-sprite system shared by footfall dust and pickup bursts.
// One draw call, no allocation after construction.

const VERTEX = /* glsl */`
  attribute float size;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (320.0 / max(-mv.z, 0.001));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */`
  precision mediump float;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float falloff = 1.0 - smoothstep(0.0, 0.25, r);
    gl_FragColor = vec4(vColor, vAlpha * falloff);
  }
`;

export class Particles {
  constructor(capacity = 700) {
    this.capacity = capacity;
    this.cursor = 0;

    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);

    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.name = 'particles';
    this.geometry = geometry;
  }

  emit(x, y, z, {
    count = 1, color = [0.8, 0.75, 0.62], speed = 1, spread = 1,
    size = 12, life = 0.6, gravity = -3, drag = 2.4, upward = 1,
  } = {}) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;

      this.positions[i * 3] = x + (Math.random() - 0.5) * 0.12;
      this.positions[i * 3 + 1] = y + Math.random() * 0.08;
      this.positions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.12;

      const theta = Math.random() * Math.PI * 2;
      const r = Math.random() * spread;
      this.velocities[i * 3] = Math.cos(theta) * r * speed;
      this.velocities[i * 3 + 1] = (0.4 + Math.random()) * speed * upward;
      this.velocities[i * 3 + 2] = Math.sin(theta) * r * speed;

      const jitter = 0.85 + Math.random() * 0.3;
      this.colors[i * 3] = color[0] * jitter;
      this.colors[i * 3 + 1] = color[1] * jitter;
      this.colors[i * 3 + 2] = color[2] * jitter;

      this.baseSize[i] = size * (0.7 + Math.random() * 0.6);
      this.sizes[i] = this.baseSize[i];
      this.maxLife[i] = life * (0.75 + Math.random() * 0.5);
      this.life[i] = this.maxLife[i];
      this.alphas[i] = 1;
      this.gravity[i] = gravity;
      this.drag[i] = drag;
    }
  }

  update(dt) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) {
        if (this.alphas[i] !== 0) this.alphas[i] = 0;
        continue;
      }

      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }

      const decay = Math.exp(-this.drag[i] * dt);
      this.velocities[i * 3] *= decay;
      this.velocities[i * 3 + 2] *= decay;
      this.velocities[i * 3 + 1] = this.velocities[i * 3 + 1] * decay + this.gravity[i] * dt;

      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;

      const t = this.life[i] / this.maxLife[i];
      this.alphas[i] = t * t;
      this.sizes[i] = this.baseSize[i] * (1.4 - t * 0.4);
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
  }

  dust(position, intensity = 1) {
    this.emit(position.x, position.y + 0.05, position.z, {
      count: 3, color: [0.78, 0.72, 0.58], speed: 0.55 * intensity, spread: 1.1,
      size: 11, life: 0.55, gravity: -1.6, drag: 3.2, upward: 0.7,
    });
  }

  splash(position) {
    this.emit(position.x, position.y + 0.1, position.z, {
      count: 14, color: [0.72, 0.90, 0.98], speed: 2.0, spread: 1.0,
      size: 9, life: 0.5, gravity: -9, drag: 1.2, upward: 1.4,
    });
  }

  pickup(x, y, z) {
    this.emit(x, y, z, {
      count: 26, color: [1.0, 0.62, 0.42], speed: 2.6, spread: 1.0,
      size: 13, life: 0.85, gravity: -2.2, drag: 1.9, upward: 1.1,
    });
  }
}
