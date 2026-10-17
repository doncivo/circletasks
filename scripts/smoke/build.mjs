// REL-TECH-01 (ADR 0016) : build debug du binaire de fumée (front embarqué, identifiant `.smoke`, port CDP) dans un dossier cargo DÉDIÉ
// (`src-tauri/target/smoke`) : jamais le binaire de `tauri dev` (`src-tauri/target/debug`), qui peut tourner pendant le test en local.
// Usage : `npm run test:smoke:build` ; le test lit le binaire dans `src-tauri/target/smoke/debug/circletasks.exe`.
//
// REL-TECH-02 : `--nsis` (`npm run test:smoke:installer-build`) construit en plus l'installeur NSIS de fumée (`--bundles nsis`) : même configuration,
// même dossier cargo ; installeur dans `src-tauri/target/smoke/debug/bundle/nsis/` et script généré dans `src-tauri/target/smoke/debug/nsis/x64/installer.nsi`.
// Aucune clé de signature : `createUpdaterArtifacts` n'est activé nulle part dans la configuration de fumée (pas de `.sig`).
// À ne lancer qu'en CI (le CLI télécharge NSIS dans %LOCALAPPDATA%\tauri) ou sur un poste de test dédié.
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const targetDir = resolve(root, 'src-tauri', 'target', 'smoke');
const bundleArgs = process.argv.includes('--nsis') ? ['--bundles', 'nsis'] : ['--no-bundle'];
const run = spawnSync('npx', ['tauri', 'build', '--debug', ...bundleArgs, '--config', 'src-tauri/tauri.smoke.conf.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
});
if (run.error) throw run.error;
process.exit(run.status ?? 1);
