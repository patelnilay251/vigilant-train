import * as THREE from 'three';

// Sky dome, sun and the day/night cycle.
//
// The dome is a single inverted sphere with an analytic gradient: cheaper than a
// physical atmosphere model and easier to art-direct. It also owns the palette
// that the fog, the lights and the water tint all read from, so the whole scene
// changes colour together instead of drifting apart.

const VERTEX = /* glsl */`
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */`
  precision highp float;

  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform float uNight;
  uniform float uTime;

  varying vec3 vDirection;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
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
  { at: -1.00, zenith: '#060a16', horizon: '#0d1424', ground: '#070a12', sun: '#2a3552', light: '#4a5c8c', ambient: '#2c3a5e', intensity: 0.10 },
  { at: -0.42, zenith: '#080e1e', horizon: '#131b30', ground: '#090d18', sun: '#33405f', light: '#54679a', ambient: '#32426a', intensity: 0.14 },
  { at: -0.20, zenith: '#152144', horizon: '#4a3a5c', ground: '#161528', sun: '#8a6a86', light: '#8b7bb0', ambient: '#55618f', intensity: 0.35 },
  { at: -0.08, zenith: '#274069', horizon: '#c2705e', ground: '#2e2430', sun: '#ff9d63', light: '#ff9668', ambient: '#7d7597', intensity: 0.85 },
  { at: 0.02, zenith: '#37619c', horizon: '#f0a06a', ground: '#463a34', sun: '#ffc27a', light: '#ffb277', ambient: '#9a94a8', intensity: 1.55 },
  { at: 0.14, zenith: '#3d76b8', horizon: '#f3c79a', ground: '#55604f', sun: '#ffe8c0', light: '#ffdcae', ambient: '#93a0aa', intensity: 2.25 },
  { at: 0.38, zenith: '#3a7bc8', horizon: '#b4d3ec', ground: '#5f6d62', sun: '#fff6e2', light: '#fff2da', ambient: '#a2b4c4', intensity: 2.80 },
  { at: 1.00, zenith: '#2f6fd0', horizon: '#c2ddf2', ground: '#6b7a6e', sun: '#ffffff', light: '#fffaf0', ambient: '#aec2d2', intensity: 3.05 },
];

const PARSED = STOPS.map((s) => ({
  at: s.at,
  zenith: new THREE.Color(s.zenith),
  horizon: new THREE.Color(s.horizon),
  ground: new THREE.Color(s.ground),
  sun: new THREE.Color(s.sun),
  light: new THREE.Color(s.light),
  ambient: new THREE.Color(s.ambient),
  intensity: s.intensity,
}));

function samplePalette(elevation, out) {
  let hi = 1;
  while (hi < PARSED.length - 1 && PARSED[hi].at < elevation) hi++;
  const a = PARSED[hi - 1];
  const b = PARSED[hi];
  const t = Math.max(0, Math.min(1, (elevation - a.at) / (b.at - a.at)));

  out.zenith.copy(a.zenith).lerp(b.zenith, t);
  out.horizon.copy(a.horizon).lerp(b.horizon, t);
  out.ground.copy(a.ground).lerp(b.ground, t);
  out.sun.copy(a.sun).lerp(b.sun, t);
  out.light.copy(a.light).lerp(b.light, t);
  out.ambient.copy(a.ambient).lerp(b.ambient, t);
  out.intensity = a.intensity + (b.intensity - a.intensity) * t;
  return out;
}

export class Sky {
  constructor(scene, worldSize) {
    this.uniforms = {
      uZenith: { value: new THREE.Color('#2f6fd0') },
      uHorizon: { value: new THREE.Color('#c2ddf2') },
      uGround: { value: new THREE.Color('#6b7a6e') },
      uSunColor: { value: new THREE.Color('#ffffff') },
      uSunDirection: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
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
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.035;
    const extent = 62;
    Object.assign(this.sun.shadow.camera, {
      left: -extent, right: extent, top: extent, bottom: -extent,
    });
    this.sun.shadow.camera.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight('#a8bccc', '#4a4433', 0.85);
    scene.add(this.ambient);

    this.fog = new THREE.FogExp2('#c2ddf2', 0.0038);
    scene.fog = this.fog;

    this.palette = {
      zenith: new THREE.Color(), horizon: new THREE.Color(), ground: new THREE.Color(),
      sun: new THREE.Color(), light: new THREE.Color(), ambient: new THREE.Color(), intensity: 1,
    };

    // 0 .. 1 over a full day; 0.25 is sunrise, 0.5 is noon.
    this.timeOfDay = 0.34;
    this.dayLength = 240; // seconds of real time per in-game day
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
    this.uniforms.uSunDirection.value.copy(this.sunDirection);
    // Hold the stars back until the afterglow has actually gone.
    this.uniforms.uNight.value = Math.max(0, Math.min(1, (-elevation - 0.10) * 4));
    this.uniforms.uTime.value = elapsed;

    this.sun.color.copy(p.light);
    this.sun.intensity = p.intensity;
    this.ambient.color.copy(p.ambient);
    this.ambient.groundColor.setRGB(p.ground.r * 0.8 + 0.06, p.ground.g * 0.8 + 0.05, p.ground.b * 0.7 + 0.04);
    // The floor here is what stands in for moonlight; without it the world is
    // unreadable for a third of the cycle, and the foreground goes black the
    // moment the sun grazes the horizon.
    this.ambient.intensity = 0.68 + Math.max(0, elevation) * 0.6;

    this.fog.color.copy(p.horizon).lerp(p.zenith, 0.25);
    this.fog.density = 0.0030 + 0.0022 * Math.max(0, 1 - Math.max(elevation, 0) * 3);

    // Keep the shadow frustum tight around whatever we are following.
    if (focus) {
      this.mesh.position.set(focus.x, 0, focus.z);
      this.sun.target.position.copy(focus);
      this.sun.position.copy(focus).addScaledVector(this.sunDirection, 110);
      this.sun.target.updateMatrixWorld();
    }
  }
}
