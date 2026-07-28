import * as THREE from 'three';

// Lake and coastline water.
//
// Depth is baked into a per-vertex attribute rather than sampled from a float
// texture at runtime: it interpolates smoothly for free, needs no float-filter
// extension, and lets us drop every quad that sits entirely above the waterline
// so there is no hidden full-world plane eating fill rate.

const VERTEX = /* glsl */`
  uniform float uTime;
  varying vec3 vWorldPosition;
  varying float vDepth;
  attribute float depth;

  #include <fog_pars_vertex>

  void main() {
    vDepth = depth;

    vec3 pos = position;
    // Gentle swell, damped to nothing at the shoreline so the mesh stays put
    // where it meets the sand.
    float shore = smoothstep(0.0, 1.6, depth);
    pos.y += (sin(pos.x * 0.42 + uTime * 1.35) * 0.055
            + sin(pos.z * 0.31 - uTime * 1.05) * 0.045) * shore;

    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorldPosition = world.xyz;

    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */`
  precision highp float;

  uniform float uTime;
  uniform vec3 uShallow;
  uniform vec3 uDeep;
  uniform vec3 uSkyColor;
  uniform vec3 uSunColor;
  uniform vec3 uSunDirection;
  uniform vec3 uCameraPosition;

  varying vec3 vWorldPosition;
  varying float vDepth;

  #include <fog_pars_fragment>

  // Two layers of scrolling gradient noise, summed into a surface normal.
  vec2 wave(vec2 p, float t) {
    vec2 n = vec2(0.0);
    n += vec2(cos(p.x * 0.9 + t * 1.7), sin(p.y * 1.1 + t * 1.3)) * 0.055;
    n += vec2(cos(p.y * 1.7 - t * 2.1), sin(p.x * 1.9 + t * 1.9)) * 0.038;
    n += vec2(cos(p.x * 3.7 + p.y * 2.3 + t * 3.1)) * 0.022;
    return n;
  }

  void main() {
    vec2 p = vWorldPosition.xz;
    vec2 slope = wave(p, uTime);
    vec3 normal = normalize(vec3(slope.x, 1.0, slope.y));

    vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
    float fresnel = pow(1.0 - clamp(dot(viewDir, normal), 0.0, 1.0), 3.2);

    vec3 body = mix(uShallow, uDeep, smoothstep(0.15, 5.5, vDepth));
    // Held back from a physical fresnel: across a lake almost every pixel is a
    // grazing angle, so an accurate mix washes the whole surface out to sky.
    vec3 color = mix(body, uSkyColor, 0.16 + 0.46 * fresnel);

    // Sun glitter.
    vec3 halfway = normalize(uSunDirection + viewDir);
    float spec = pow(max(dot(normal, halfway), 0.0), 90.0);
    color += uSunColor * spec * 1.6;

    // Foam where the water meets the shore.
    float foam = (1.0 - smoothstep(0.0, 0.42, vDepth))
               * (0.55 + 0.45 * sin(vDepth * 34.0 - uTime * 2.4));
    color = mix(color, vec3(0.95, 0.98, 1.0), clamp(foam, 0.0, 1.0) * 0.55);

    float alpha = clamp(0.34 + smoothstep(0.0, 1.6, vDepth) * 0.56 + fresnel * 0.28, 0.0, 0.96);

    gl_FragColor = vec4(color, alpha);
    #include <fog_fragment>
    #include <colorspace_fragment>
  }
`;

export function createWater(field, { resolution = 220 } = {}) {
  const { size, half, waterLevel } = field;
  const step = size / resolution;

  // Sample depth on a regular grid, then keep only the quads that touch water.
  const depthGrid = new Float32Array((resolution + 1) * (resolution + 1));
  for (let j = 0; j <= resolution; j++) {
    for (let i = 0; i <= resolution; i++) {
      const x = -half + i * step;
      const z = -half + j * step;
      depthGrid[j * (resolution + 1) + i] = waterLevel - field.heightAt(x, z);
    }
  }

  const positions = [];
  const depths = [];
  const indices = [];
  const vertexIndex = new Int32Array((resolution + 1) * (resolution + 1)).fill(-1);

  const emit = (i, j) => {
    const key = j * (resolution + 1) + i;
    if (vertexIndex[key] >= 0) return vertexIndex[key];
    const id = positions.length / 3;
    positions.push(-half + i * step, waterLevel, -half + j * step);
    // Clamp so the shore band does not go negative and invert the foam term.
    depths.push(Math.max(depthGrid[key], 0));
    vertexIndex[key] = id;
    return id;
  };

  const stride = resolution + 1;
  for (let j = 0; j < resolution; j++) {
    for (let i = 0; i < resolution; i++) {
      const d00 = depthGrid[j * stride + i];
      const d10 = depthGrid[j * stride + i + 1];
      const d01 = depthGrid[(j + 1) * stride + i];
      const d11 = depthGrid[(j + 1) * stride + i + 1];
      // A small negative threshold keeps a rim of geometry up the beach so the
      // foam line has somewhere to live.
      if (Math.max(d00, d10, d01, d11) < -0.35) continue;

      const a = emit(i, j);
      const b = emit(i + 1, j);
      const c = emit(i, j + 1);
      const d = emit(i + 1, j + 1);
      indices.push(a, c, b, b, c, d);
    }
  }

  if (indices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('depth', new THREE.Float32BufferAttribute(depths, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color('#3fa9b8') },
      uDeep: { value: new THREE.Color('#0d3550') },
      uSkyColor: { value: new THREE.Color('#c2ddf2') },
      uSunColor: { value: new THREE.Color('#ffffff') },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uCameraPosition: { value: new THREE.Vector3() },
    },
  ]);

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'water';
  mesh.renderOrder = 10;
  mesh.matrixAutoUpdate = false;

  mesh.userData.update = (elapsed, camera, sky) => {
    uniforms.uTime.value = elapsed;
    uniforms.uCameraPosition.value.copy(camera.position);
    uniforms.uSunDirection.value.copy(sky.sunDirection);
    uniforms.uSunColor.value.copy(sky.palette.sun);
    uniforms.uSkyColor.value.copy(sky.palette.horizon);
    // Darken the body of the water at night rather than leaving it glowing.
    const day = Math.max(0.08, Math.min(1, sky.sunDirection.y * 2.2 + 0.35));
    uniforms.uShallow.value.setRGB(0.247 * day, 0.663 * day, 0.722 * day);
    uniforms.uDeep.value.setRGB(0.051 * day, 0.208 * day, 0.314 * day);
  };

  return mesh;
}
