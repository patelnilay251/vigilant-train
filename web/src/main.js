import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

const hud = new Hud();

async function fetchTyped(url, Type, label, progress) {
  progress(label);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return new Type(await response.arrayBuffer());
}

async function loadAssets(progress) {
  const manifest = await (await fetch('/assets/world.json')).json();

  const [heights, ao, trees, rocks] = await Promise.all([
    fetchTyped('/assets/heightmap.bin', Float32Array, 'heightfield', progress),
    fetchTyped('/assets/ao.bin', Uint8Array, 'occlusion', progress),
    fetchTyped('/assets/trees.bin', Float32Array, 'forest', progress),
    fetchTyped('/assets/rocks.bin', Float32Array, 'rocks', progress),
  ]);

  progress('character');
  const gltf = await new GLTFLoader().loadAsync('/assets/character.glb');

  return { manifest, heights, ao, trees, rocks, gltf };
}

async function boot() {
  const steps = ['world data', 'heightfield', 'occlusion', 'forest', 'rocks', 'character'];
  let step = 0;
  const progress = (label) => {
    step = Math.min(step + 1, steps.length);
    hud.progress(step / (steps.length + 2), label);
  };

  hud.progress(0.04, 'world data');
  const { manifest, heights, ao, trees, rocks, gltf } = await loadAssets(progress);

  // ---- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 1400);

  hud.progress(0.78, 'building terrain');
  await new Promise((r) => requestAnimationFrame(r));

  const field = new Heightfield(manifest, heights, ao);
  const terrain = createTerrain(field);
  terrain.updateMatrix();
  scene.add(terrain);

  const water = createWater(field);
  if (water) {
    water.updateMatrix();
    scene.add(water);
  }

  hud.progress(0.86, 'planting forest');
  await new Promise((r) => requestAnimationFrame(r));

  scene.add(createTrees(trees, manifest.instanceStride));
  scene.add(createRocks(rocks, manifest.instanceStride));

  const berries = new Berries(manifest.berries);
  berries.group.name = 'berryField';
  scene.add(berries.group);

  const grass = new GrassField(field);
  scene.add(grass.mesh);

  const sky = new Sky(scene, manifest.worldSize);

  const particles = new Particles();
  scene.add(particles.points);

  hud.progress(0.95, 'waking up');
  await new Promise((r) => requestAnimationFrame(r));

  // ---- actors
  const player = new Player(gltf, field);
  scene.add(player.root);

  const rig = new ThirdPersonCamera(camera, field);
  const freeCam = new FreeCamera(camera, field);
  let freeCamActive = false;

  const input = new Input(renderer.domElement);
  input.onLockChange = (locked) => { if (locked) hud.hideStartHint(); };

  input.onKey('KeyF', () => {
    freeCamActive = !freeCamActive;
    if (freeCamActive) freeCam.adoptFrom(camera, rig.yaw, rig.pitch);
    hud.toast(freeCamActive ? 'free camera — Q/E up·down' : 'following character');
  });

  input.onKey('KeyT', () => {
    sky.setTimeOfDay(sky.timeOfDay + 0.08);
    hud.toast(`time ${sky.clockLabel}`);
  });

  input.onKey('KeyP', () => {
    sky.paused = !sky.paused;
    hud.toast(sky.paused ? 'time paused' : 'time running');
  });

  player.onFootstep = (position, speed) => {
    if (player.wading) particles.splash(position);
    else particles.dust(position, Math.min(speed / 4, 1.4));
  };
  player.onLand = (position) => {
    particles.emit(position.x, position.y + 0.04, position.z, {
      count: 10, color: [0.78, 0.72, 0.58], speed: 1.5, spread: 1.2,
      size: 12, life: 0.5, gravity: -2.4, drag: 3.0, upward: 0.5,
    });
  };

  let collected = 0;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---- loop
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
      rig.update(dt, player.position, look, zoom);
    }

    const focus = freeCamActive ? camera.position : player.position;
    sky.update(dt, elapsed, focus);
    grass.update(elapsed, focus, 1);
    berries.update(elapsed);
    particles.update(dt);
    if (water) water.userData.update(elapsed, camera, sky);

    if (!freeCamActive) {
      for (const berry of berries.collect(player.position)) {
        collected++;
        particles.pickup(berry.x, berry.y + 0.3, berry.z);
        hud.toast(berries.remaining === 0 ? 'every berry found' : 'berry +1', 1.0);
      }
    }

    renderer.render(scene, camera);

    hud.update(rawDt, {
      altitude: player.position.y,
      clock: sky.clockLabel,
      triangles: renderer.info.render.triangles,
      berries: collected,
      total: manifest.berries.length,
    });

    requestAnimationFrame(frame);
  }

  hud.progress(1, 'ready');
  hud.ready();
  clock.start();
  frame();

  // Handle for automated checks and for poking at the scene from the console.
  window.__app = {
    THREE, scene, camera, renderer, player, rig, sky, field, berries, grass, manifest,
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
    },
    /** Detach the camera and place it explicitly. Bypasses the follow boom. */
    flyTo: (x, y, z, yaw, pitch) => {
      freeCamActive = true;
      camera.position.set(x, y, z);
      freeCam.yaw = yaw;
      freeCam.pitch = pitch;
    },
    follow: () => { freeCamActive = false; },
    /** Hide the world and show the character alone, for inspecting the asset. */
    solo: (on) => {
      for (const name of ['terrain', 'water', 'trees', 'rocks', 'grass', 'berryField', 'particles', 'sky']) {
        const object = scene.getObjectByName(name);
        if (object) object.visible = !on;
      }
      scene.background = on ? new THREE.Color('#39415c') : null;
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
  const sub = document.getElementById('loader-sub');
  if (sub) {
    sub.textContent = String(error && error.message ? error.message : error);
    sub.style.color = '#ff8a8a';
  }
});
