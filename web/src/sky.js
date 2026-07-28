import * as THREE from 'three';

// Sky dome, clouds, sun and the day/night cycle.
//
// The dome is a single inverted sphere with an analytic gradient plus two
// layers of fBm cloud projected onto a virtual plane: cheaper than a physical
// atmosphere model and far easier to art-direct towards the soft, high-contrast
// skies of mid-2000s Nintendo. It also owns the palette that the fog, the
// lights and the water tint all read from, so the whole scene changes colour
// together instead of drifting apart.

const VERTEX = /* glsl */`
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */`
  precision highp float;

  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudShade;
  uniform float uNight;
  uniform float uTime;

  varying vec3 vDirection;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash2(i);
    float b = hash2(i + vec2(1.0, 0.0));
    float c = hash2(i + vec2(0.0, 1.0));
    float d = hash2(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
      sum += amp * valueNoise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    vec3 dir = normalize(vDirection);

    // Vertical gradient, biased so most of the colour change happens near the
    // horizon where the eye actually looks.
    float up = max(dir.y, 0.0);
    vec3 color = mix(uHorizon, uZenith, pow(up, 0.42));
    color = mix(uGround, color, smoothstep(-0.10, 0.05, dir.y));

    float sun = max(dot(dir, uSunDirection), 0.0);
    color += uSunColor * pow(sun, 1400.0) * 14.0;   // disc
    color += uSunColor * pow(sun, 9.0) * 0.30;      // forward scatter
    color += uSunColor * pow(sun, 2.0) * 0.06;

    // ---- clouds
    // Projecting the view direction onto a plane above the camera gives the
    // perspective foreshortening that makes a flat noise field read as a
    // cloudscape receding to the horizon.
    if (dir.y > 0.015) {
      vec2 plane = dir.xz / dir.y;

      // The scale sets how many cloud cells span zenith to horizon. Too low and
      // the whole sky is inside one lobe of the noise and reads as flat haze.
      vec2 slow = plane * 0.55 + vec2(uTime * 0.010, uTime * 0.004);
      float base = fbm(slow);
      // Two thresholds: a soft body and a tighter core, which is what gives
      // the billowed edge rather than a uniform haze.
      // A high threshold on a narrow band is what separates distinct billows
      // from an overcast smear; most of the sky should stay open blue.
      float body = smoothstep(0.545, 0.680, base);
      float core = smoothstep(0.620, 0.790, base);

      vec2 fast = plane * 1.30 + vec2(uTime * 0.022, -uTime * 0.009);
      float wisps = smoothstep(0.620, 0.820, fbm(fast)) * 0.18;

      float cover = clamp(body + wisps, 0.0, 1.0);
      // Fade out towards the horizon so the plane projection's stretching at
      // grazing angles never becomes visible.
      cover *= smoothstep(0.012, 0.22, dir.y);

      // Light the cloud from the sun side.
      float facing = clamp(dot(normalize(vec3(dir.x, 0.35, dir.z)), uSunDirection) * 0.5 + 0.5, 0.0, 1.0);
      vec3 cloud = mix(uCloudShade, uCloudLit, facing * 0.65 + core * 0.45);
      cloud += uSunColor * pow(sun, 24.0) * 0.35 * cover;

      color = mix(color, cloud, cover * 0.92);
    }

    // Stars: a sparse hash threshold, only visible once the sun is down.
    if (uNight > 0.01 && dir.y > -0.02) {
      vec3 cell = floor(dir * 340.0);
      float h = hash(cell);
      float star = smoothstep(0.9972, 0.9998, h);
      float twinkle = 0.65 + 0.35 * sin(uTime * 2.2 + h * 90.0);
      color += vec3(star * twinkle * uNight * 1.5) * smoothstep(-0.02, 0.18, dir.y);
    }

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

// Keyframed palette across a full day, keyed on sun elevation in [-1, 1].
//
// The stops below the horizon are deliberately closely spaced: the sun crosses
// that band in a couple of in-game minutes, and spreading twilight over a wide
// elevation range is what stops dusk from snapping straight to black.
const STOPS = [
  { at: -1.00, zenith: '#070c1c', horizon: '#101a30', ground: '#080b14', sun: '#2a3552', light: '#5a6ea6', ambient: '#39496f', cloudLit: '#2c3550', cloudShade: '#161d33', intensity: 0.12 },
  { at: -0.42, zenith: '#0a1024', horizon: '#16203a', ground: '#0a0e1a', sun: '#33405f', light: '#6076ac', ambient: '#3d4e78', cloudLit: '#333f5e', cloudShade: '#1b2340', intensity: 0.16 },
  { at: -0.20, zenith: '#182648', horizon: '#553f62', ground: '#181729', sun: '#8a6a86', light: '#9384bb', ambient: '#5c6796', cloudLit: '#6d5a7a', cloudShade: '#33304f', intensity: 0.38 },
  { at: -0.08, zenith: '#2b4570', horizon: '#d17a60', ground: '#312632', sun: '#ff9d63', light: '#ff9d70', ambient: '#8a7f9c', cloudLit: '#f2a181', cloudShade: '#5e4a63', intensity: 0.90 },
  { at: 0.02, zenith: '#3d69a4', horizon: '#f7ae76', ground: '#4a3d36', sun: '#ffc27a', light: '#ffbb84', ambient: '#a49bab', cloudLit: '#ffc9a4', cloudShade: '#8a7086', intensity: 1.60 },
  { at: 0.14, zenith: '#4a86c6', horizon: '#f8d2a6', ground: '#586250', sun: '#ffe8c0', light: '#ffe2b8', ambient: '#b6bcc0', cloudLit: '#fff0dc', cloudShade: '#b09aa6', intensity: 2.30 },
  { at: 0.38, zenith: '#3f8fd8', horizon: '#bfe0f5', ground: '#63705f', sun: '#fff8ea', light: '#fff6e4', ambient: '#bdd2e0', cloudLit: '#ffffff', cloudShade: '#b9c9de', intensity: 2.85 },
  { at: 1.00, zenith: '#2f86e0', horizon: '#cfe9fa', ground: '#6f7f6c', sun: '#ffffff', light: '#fffcf4', ambient: '#c8dcec', cloudLit: '#ffffff', cloudShade: '#c2d3e6', intensity: 3.10 },
];

const PARSED = STOPS.map((s) => ({
  at: s.at,
  zenith: new THREE.Color(s.zenith),
  horizon: new THREE.Color(s.horizon),
  ground: new THREE.Color(s.ground),
  sun: new THREE.Color(s.sun),
  light: new THREE.Color(s.light),
  ambient: new THREE.Color(s.ambient),
  cloudLit: new THREE.Color(s.cloudLit),
  cloudShade: new THREE.Color(s.cloudShade),
  intensity: s.intensity,
}));

function samplePalette(elevation, out) {
  let hi = 1;
  while (hi < PARSED.length - 1 && PARSED[hi].at < elevation) hi++;
  const a = PARSED[hi - 1];
  const b = PARSED[hi];
  const t = Math.max(0, Math.min(1, (elevation - a.at) / (b.at - a.at)));

  for (const key of ['zenith', 'horizon', 'ground', 'sun', 'light', 'ambient', 'cloudLit', 'cloudShade']) {
    out[key].copy(a[key]).lerp(b[key], t);
  }
  out.intensity = a.intensity + (b.intensity - a.intensity) * t;
  return out;
}

export class Sky {
  constructor(scene, worldSize, { shadowMapSize = 2048 } = {}) {
    this.uniforms = {
      uZenith: { value: new THREE.Color('#2f86e0') },
      uHorizon: { value: new THREE.Color('#cfe9fa') },
      uGround: { value: new THREE.Color('#6f7f6c') },
      uSunColor: { value: new THREE.Color('#ffffff') },
      uSunDirection: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
      uCloudLit: { value: new THREE.Color('#ffffff') },
      uCloudShade: { value: new THREE.Color('#c2d3e6') },
      uNight: { value: 0 },
      uTime: { value: 0 },
    };

    const geometry = new THREE.SphereGeometry(worldSize * 1.6, 48, 32);
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.035;
    const extent = 58;
    Object.assign(this.sun.shadow.camera, {
      left: -extent, right: extent, top: extent, bottom: -extent,
    });
    this.sun.shadow.camera.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight('#c8dcec', '#5a5238', 0.9);
    scene.add(this.ambient);

    this.fog = new THREE.FogExp2('#cfe9fa', 0.0030);
    scene.fog = this.fog;

    this.palette = {
      zenith: new THREE.Color(), horizon: new THREE.Color(), ground: new THREE.Color(),
      sun: new THREE.Color(), light: new THREE.Color(), ambient: new THREE.Color(),
      cloudLit: new THREE.Color(), cloudShade: new THREE.Color(), intensity: 1,
    };

    // 0 .. 1 over a full day; 0.25 is sunrise, 0.5 is noon.
    this.timeOfDay = 0.34;
    this.dayLength = 300; // seconds of real time per in-game day
    this.paused = false;
    this.sunDirection = new THREE.Vector3();
  }

  setTimeOfDay(t) {
    this.timeOfDay = ((t % 1) + 1) % 1;
  }

  get clockLabel() {
    const hours = this.timeOfDay * 24;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  update(dt, elapsed, focus) {
    if (!this.paused) this.timeOfDay = (this.timeOfDay + dt / this.dayLength) % 1;

    // Sun travels a tilted arc so it never sits exactly overhead.
    const angle = (this.timeOfDay - 0.25) * Math.PI * 2;
    this.sunDirection.set(Math.cos(angle) * 0.82, Math.sin(angle), 0.34).normalize();

    const elevation = this.sunDirection.y;
    const p = samplePalette(elevation, this.palette);

    this.uniforms.uZenith.value.copy(p.zenith);
    this.uniforms.uHorizon.value.copy(p.horizon);
    this.uniforms.uGround.value.copy(p.ground);
    this.uniforms.uSunColor.value.copy(p.sun);
    this.uniforms.uCloudLit.value.copy(p.cloudLit);
    this.uniforms.uCloudShade.value.copy(p.cloudShade);
    this.uniforms.uSunDirection.value.copy(this.sunDirection);
    // Hold the stars back until the afterglow has actually gone.
    this.uniforms.uNight.value = Math.max(0, Math.min(1, (-elevation - 0.10) * 4));
    this.uniforms.uTime.value = elapsed;

    this.sun.color.copy(p.light);
    this.sun.intensity = p.intensity;
    this.ambient.color.copy(p.ambient);
    this.ambient.groundColor.setRGB(p.ground.r * 0.8 + 0.08, p.ground.g * 0.8 + 0.07, p.ground.b * 0.7 + 0.05);
    // The floor here stands in for moonlight and bounce; without it the world
    // is unreadable for a third of the cycle, and the foreground goes black the
    // moment the sun grazes the horizon.
    this.ambient.intensity = 0.78 + Math.max(0, elevation) * 0.6;

    this.fog.color.copy(p.horizon).lerp(p.zenith, 0.22);
    this.fog.density = 0.0024 + 0.0020 * Math.max(0, 1 - Math.max(elevation, 0) * 3);

    // Keep the shadow frustum tight around whatever we are following.
    if (focus) {
      this.mesh.position.set(focus.x, 0, focus.z);
      this.sun.target.position.copy(focus);
      this.sun.position.copy(focus).addScaledVector(this.sunDirection, 110);
      this.sun.target.updateMatrixWorld();
    }
  }
}
