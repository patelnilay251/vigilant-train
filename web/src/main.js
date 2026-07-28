import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Heightfield } from './heightfield.js';
import { createTerrain } from './terrain.js';
import { createWater } from './water.js';
import { createTrees, createRocks, Berries } from './props.js';
import { GrassField } from './grass.js';
import { Sky } from './sky.js';
import { Player } from './player.js';
import { ThirdPersonCamera, FreeCamera } from './camera.js';
import { Particles } from './effects.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';

const hud = new Hud();

/**
 * Phones get a smaller world budget. Detected from pointer type and the short
 * screen edge rather than a user-agent string, so a small laptop window and a
 * desktop-class tablet both land somewhere sensible.
 */
function pickQuality() {
  const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const short = Math.min(window.innerWidth, window.innerHeight) < 780;
  const lean = coarse || short;

  return lean
    ? {
      lean: true,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 1.6),
      shadowMapSize: 1024,
      grass: { radius: 17, spacing: 0.48, maxInstances: 6500 },
      particles: 360,
      waterResolution: 150,
      fov: 64,
      far: 900,
    }
    : {
      lean: false,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      shadowMapSize: 2048,
      grass: { radius: 24, spacing: 0.38, maxInstances: 16000 },
      particles: 700,
      waterResolution: 220,
      fov: 58,
      far: 1400,
    };
}

// Resolved against this module rather than the document, so the app works
// unchanged at a domain root, under a project subpath, or from a preview URL.
const asset = (name) => new URL(`../assets/${name}`, import.meta.url).href;

async function fetchTyped(name, Type, label, progress) {
  progress(label);
  const url = asset(name);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${name} -> ${response.status}`);
  return new Type(await response.arrayBuffer());
}

async function loadAssets(progress) {
  const manifest = await (await fetch(asset('world.json'))).json();
  const [heights, ao, trees, rocks] = await Promise.all([
    fetchTyped('heightmap.bin', Float32Array, 'shaping the land', progress),
    fetchTyped('ao.bin', Uint8Array, 'settling the light', progress),
    fetchTyped('trees.bin', Float32Array, 'growing the woods', progress),
    fetchTyped('rocks.bin', Float32Array, 'placing stones', progress),
  ]);
  progress('waking the traveller');
  const [gltf, face] = await Promise.all([
    new GLTFLoader().loadAsync(asset('character.glb')),
    new THREE.TextureLoader().loadAsync(asset('face.png')),
  ]);

  face.colorSpace = THREE.SRGBColorSpace;
  // glTF puts v = 0 at the top of the image; TextureLoader assumes the
  // opposite, so without this the face arrives upside down.
  face.flipY = false;
  face.anisotropy = 4;

  return { manifest, heights, ao, trees, rocks, gltf, face };
}

async function boot() {
  const quality = pickQuality();

  const steps = 6;
  let step = 0;
  const progress = (label) => {
    step = Math.min(step + 1, steps);
    hud.progress(step / (steps + 2), label);
  };

  hud.progress(0.05, 'reading the map');
  const { manifest, heights, ao, trees, rocks, gltf, face } = await loadAssets(progress);

  const renderer = new THREE.WebGLRenderer({ antialias: !quality.lean, powerPreference: 'high-performance' });
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = quality.lean ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    quality.fov, window.innerWidth / window.innerHeight, 0.1, quality.far,
  );

  const settle = () => new Promise((r) => requestAnimationFrame(r));

  hud.progress(0.78, 'raising the hills');
  await settle();

  const field = new Heightfield(manifest, heights, ao);
  const terrain = createTerrain(field);
  terrain.updateMatrix();
  scene.add(terrain);

  const water = createWater(field, { resolution: quality.waterResolution });
  if (water) {
    water.updateMatrix();
    scene.add(water);
  }

  hud.progress(0.87, 'planting the meadow');
  await settle();

  scene.add(createTrees(trees, manifest.instanceStride));
  scene.add(createRocks(rocks, manifest.instanceStride));

  const berries = new Berries(manifest.berries);
  berries.group.name = 'berryField';
  scene.add(berries.group);

  const grass = new GrassField(field, quality.grass);
  scene.add(grass.group);

  const sky = new Sky(scene, manifest.worldSize, { shadowMapSize: quality.shadowMapSize });

  // Rim light from behind and slightly above, opposite the sun. Costs one extra
  // light and does most of the work of separating the character from the
  // background, which is what stops it reading as pasted on.
  const rim = new THREE.DirectionalLight('#cfe6ff', 0.7);
  rim.castShadow = false;
  scene.add(rim, rim.target);

  const particles = new Particles(quality.particles);
  scene.add(particles.points);

  hud.progress(0.95, 'almost there');
  await settle();

  const player = new Player(gltf, field);
  // The face is painted rather than modelled. Vertex colours carry the body as
  // multipliers against the skin, and this supplies the absolute colour, so the
  // two multiply together into the finished character.
  player.model.traverse((node) => {
    if (node.isMesh || node.isSkinnedMesh) {
      node.material.map = face;
      node.material.needsUpdate = true;
    }
  });
  scene.add(player.root);

  const rig = new ThirdPersonCamera(camera, field);
  const freeCam = new FreeCamera(camera, field);
  let freeCamActive = false;

  const audio = new Audio();
  const input = new Input(renderer.domElement);

  // Audio contexts may only start from a gesture, so the first tap does double
  // duty: dismiss the hint and open the mixer.
  input.onFirstInput = () => {
    audio.resume();
    hud.hideStartHint();
  };
  input.onLockChange = (locked) => { if (locked) hud.hideStartHint(); };

  input.onKey('KeyF', () => {
    freeCamActive = !freeCamActive;
    if (freeCamActive) freeCam.adoptFrom(camera, rig.yaw, rig.pitch);
    hud.toast(freeCamActive ? 'free camera' : 'following');
  });
  input.onKey('KeyT', () => {
    sky.setTimeOfDay(sky.timeOfDay + 0.08);
    hud.toast(`${sky.clockLabel}`);
  });
  input.onKey('KeyP', () => {
    sky.paused = !sky.paused;
    hud.toast(sky.paused ? 'time paused' : 'time running');
  });
  input.onKey('KeyM', () => {
    audio.setMuted(!audio.muted);
    hud.toast(audio.muted ? 'sound off' : 'sound on');
  });

  player.onFootstep = (position, speed) => {
    if (player.wading) {
      particles.splash(position);
      audio.splash();
    } else {
      particles.dust(position, Math.min(speed / 4, 1.4));
      audio.step(speed > 3.4);
    }
  };
  player.onJump = () => audio.jump();
  player.onLand = (position) => {
    particles.emit(position.x, position.y + 0.04, position.z, {
      count: 10, color: [0.82, 0.76, 0.62], speed: 1.5, spread: 1.2,
      size: 12, life: 0.5, gravity: -2.4, drag: 3.0, upward: 0.5,
    });
    audio.land();
  };

  let collected = 0;

  // ---- post-processing
  //
  // Skipped entirely on the lean tier: UnrealBloomPass runs five downsample and
  // upsample passes, which is a real cost on a phone GPU for an effect that is
  // meant to be subtle. Desktop also gets MSAA on the composer target, since
  // the renderer's own antialiasing does not apply once we render offscreen.
  let composer = null;
  if (!quality.lean) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      0.22,  // strength — a lift on genuine highlights, not a glow filter
      0.55,  // radius
      1.02,  // threshold above white, so only HDR highlights bloom at all
    ));
    // Applies tone mapping and the output colour transform, which the composer
    // otherwise bypasses.
    composer.addPass(new OutputPass());
  }

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  const clock = new THREE.Clock();
  let elapsed = 0;
  let frameIndex = 0;

  function frame() {
    frameIndex++;
    // Simulation dt is clamped so a stalled tab does not teleport the character
    // on resume. The raw value is kept for the FPS readout, which would
    // otherwise report the clamp rate rather than the truth.
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    elapsed += dt;

    input.update();
    const look = input.consumeLook();
    const zoom = input.consumeZoom();

    if (freeCamActive) {
      freeCam.update(dt, input, look);
      player.mixer.update(dt);
    } else {
      player.update(dt, input, rig);
      rig.update(dt, player.position, look, zoom, player.speed > 0.5 ? player.facing : null);
    }

    const focus = freeCamActive ? camera.position : player.position;
    sky.update(dt, elapsed, focus);
    grass.update(elapsed, focus, 1);
    berries.update(elapsed);
    particles.update(dt);
    if (water) water.userData.update(elapsed, camera, sky);

    if (!freeCamActive) {
      const picked = berries.collect(player.position);
      if (picked.length) {
        for (const berry of picked) {
          collected++;
          particles.pickup(berry.x, berry.y + 0.3, berry.z);
        }
        audio.pickup();
        player.cheer();
        hud.pulseScore();
        if (berries.remaining === 0) {
          hud.toast('every berry found', 3.5);
          audio.fanfare();
        }
      }
    }

    // Keep the rim light opposite the sun, aimed at whatever we are following.
    rim.target.position.copy(focus);
    rim.position.set(
      focus.x - sky.sunDirection.x * 26,
      focus.y + 14,
      focus.z - sky.sunDirection.z * 26,
    );
    rim.target.updateMatrixWorld();
    rim.intensity = 0.30 + Math.max(0, sky.sunDirection.y) * 0.55;

    if (composer) composer.render(dt);
    else renderer.render(scene, camera);

    hud.update(rawDt, {
      altitude: player.position.y,
      clock: sky.clockLabel,
      berries: collected,
      total: manifest.berries.length,
    });

    requestAnimationFrame(frame);
  }

  hud.progress(1, 'ready');
  hud.ready();
  clock.start();
  frame();

  // Handle for automated capture and for poking at the scene from the console.
  window.__app = {
    THREE, scene, camera, renderer, player, rig, sky, field, berries, grass, audio, manifest, quality,
    // Lets automated capture wait on rendered frames instead of wall-clock time,
    // which matters a lot when software rendering runs at a couple of fps.
    frameIndex: () => frameIndex,
    setTime: (t) => sky.setTimeOfDay(t),
    teleport: (x, z) => {
      player.position.set(x, field.heightAt(x, z), z);
      player.velocity.set(0, 0, 0);
    },
    orbit: (yaw, pitch, distance) => {
      rig.yaw = yaw;
      rig.pitch = pitch;
      rig.desiredDistance = distance;
      rig.distance = distance;
      // Capture sets the angle deliberately; drifting back would undo it.
      rig.autoAlign = false;
    },
    flyTo: (x, y, z, yaw, pitch) => {
      freeCamActive = true;
      camera.position.set(x, y, z);
      freeCam.yaw = yaw;
      freeCam.pitch = pitch;
    },
    follow: () => { freeCamActive = false; },
    /** Hide the world and show the character alone, for inspecting the asset. */
    solo: (on) => {
      for (const name of ['terrain', 'water', 'trees', 'rocks', 'groundCover', 'berryField', 'particles', 'sky']) {
        const object = scene.getObjectByName(name);
        if (object) object.visible = !on;
      }
      scene.background = on ? new THREE.Color('#5a7fa8') : null;
      scene.fog = on ? null : sky.fog;
      player.leanEnabled = !on;
      if (on) {
        player.facing = 0;
        player.model.rotation.set(0, 0, 0);
      }
    },
  };
}

boot().catch((error) => {
  console.error(error);
  hud.fail(String(error && error.message ? error.message : error));
});
