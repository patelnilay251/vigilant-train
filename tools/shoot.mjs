// Headless capture harness.
//
// Drives the running app in Chromium and writes a set of screenshots, so
// rendering changes can be inspected without a display. Also surfaces console
// errors and WebGL warnings, which are otherwise invisible from the terminal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../shots');
const URL_BASE = process.env.APP_URL || 'http://localhost:5173';

// Shots are plain data so they survive being sent into the page.
// { name, time, at: [x, z], orbit: [yaw, pitch, distance], solo?, hud? }
const PI = Math.PI;
const SHOTS = [
  { name: '01-spawn', time: 0.34, at: [0, 0], orbit: [PI, 0.24, 4.4] },
  { name: '02-behind', time: 0.36, at: [0, 0], orbit: [PI * 0.78, 0.16, 2.6] },
  { name: '03-face', time: 0.40, at: [0, 0], orbit: [0.15, 0.06, 2.0] },
  { name: '04-vista', time: 0.30, at: [-40, 60], orbit: [PI * 1.35, 0.40, 12] },
  // Dry ground on the lake's north shore, looking back across the water.
  // Shot from a detached camera out over the water: the shoreline here is a
  // steep bank, so the follow boom would collide with it.
  { name: '05-lake', time: 0.33, at: [112, -96], fly: [134, 11, -118, -0.844, -0.26] },
  { name: '06-sunset', time: 0.757, at: [-20, -30], orbit: [PI * 0.5, 0.14, 8] },
  { name: '07-dusk', time: 0.790, at: [-20, -30], orbit: [PI * 0.5, 0.14, 8] },
  { name: '08-night', time: 0.980, at: [0, 0], orbit: [PI, 0.20, 6] },
  // Character alone, no world, no HUD.
  { name: '09-model-front', time: 0.42, at: [0, 0], orbit: [0, 0.04, 1.9], solo: true, hud: false },
  { name: '10-model-side', time: 0.42, at: [0, 0], orbit: [PI * 0.5, 0.04, 1.9], solo: true, hud: false },
  { name: '11-model-back', time: 0.42, at: [0, 0], orbit: [PI, 0.04, 1.9], solo: true, hud: false },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // The preinstalled browser revision does not match the one this Playwright
  // build expects, so point at it explicitly rather than downloading another.
  const BROWSER_PATH = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

  const browser = await chromium.launch({
    executablePath: fs.existsSync(BROWSER_PATH) ? BROWSER_PATH : undefined,
    // This Playwright release still asks for `--headless=old`, which recent
    // Chromium builds refuse to start with. Swap it for the new headless mode.
    ignoreDefaultArgs: ['--headless=old'],
    args: [
      '--headless=new',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-dev-shm-usage',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });

  const problems = [];
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') problems.push(`[${type}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`[pageerror] ${err.message}`));
  page.on('requestfailed', (req) => problems.push(`[requestfailed] ${req.url()}`));

  console.log(`[shoot] opening ${URL_BASE}`);
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' });

  try {
    await page.waitForFunction(() => window.__app !== undefined, { timeout: 90000 });
  } catch {
    const message = await page.evaluate(() => document.getElementById('loader-sub')?.textContent);
    console.error(`[shoot] app never became ready. loader says: ${message}`);
    problems.forEach((p) => console.error('  ' + p));
    await page.screenshot({ path: path.join(OUT, 'failure.png') });
    await browser.close();
    process.exit(1);
  }

  const stats = await page.evaluate(() => {
    const { renderer, scene, manifest } = window.__app;
    let meshes = 0;
    scene.traverse((o) => { if (o.isMesh || o.isPoints) meshes++; });
    return {
      meshes,
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      programs: renderer.info.programs.length,
      berries: manifest.berries.length,
    };
  });
  console.log('[shoot] scene:', JSON.stringify(stats));

  for (const shot of SHOTS) {
    await page.evaluate((s) => {
      const app = window.__app;
      app.solo(!!s.solo);
      app.setTime(s.time);
      app.teleport(s.at[0], s.at[1]);
      if (s.fly) {
        app.flyTo(s.fly[0], s.fly[1], s.fly[2], s.fly[3], s.fly[4]);
      } else {
        app.follow();
        app.orbit(s.orbit[0], s.orbit[1], s.orbit[2]);
      }
      document.getElementById('hud').style.display = s.hud === false ? 'none' : '';
    }, shot);

    // Wait on rendered frames, not wall time: under SwiftShader this scene runs
    // at a couple of frames per second, and the camera smoothing is per-frame,
    // so a fixed sleep captures the rig mid-interpolation.
    const start = await page.evaluate(() => window.__app.frameIndex());
    await page.waitForFunction(
      (from) => window.__app.frameIndex() >= from + 32,
      start,
      { timeout: 120000 },
    );
    const file = path.join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file });
    console.log(`[shoot] ${path.relative(process.cwd(), file)}`);
  }

  const unique = [...new Set(problems)];
  if (unique.length) {
    console.log(`\n[shoot] ${unique.length} console problem(s):`);
    unique.slice(0, 25).forEach((p) => console.log('  ' + p));
  } else {
    console.log('\n[shoot] no console errors or warnings');
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
