// REL-TECH-01 (ADR 0016) : build debug du binaire de fumée (front embarqué, identifiant `.smoke`, port CDP) dans un dossier cargo DÉDIÉ
// (`src-tauri/target/smoke`) : jamais le binaire de `tauri dev` (`src-tauri/target/debug`), qui peut tourner pendant le test en local.
// Usage : `npm run test:smoke:build` ; le test lit le binaire dans `src-tauri/target/smoke/debug/circletasks.exe`.
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const targetDir = resolve(root, 'src-tauri', 'target', 'smoke');
const run = spawnSync('npx', ['tauri', 'build', '--debug', '--no-bundle', '--config', 'src-tauri/tauri.smoke.conf.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
});
if (run.error) throw run.error;
process.exit(run.status ?? 1);
