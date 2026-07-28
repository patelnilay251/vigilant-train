import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const steps = ['build-character.mjs', 'build-world.mjs'];

for (const step of steps) {
  const result = spawnSync(process.execPath, [path.join(__dirname, step)], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n[build] ${step} failed with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

console.log('\n[build] all assets generated');
