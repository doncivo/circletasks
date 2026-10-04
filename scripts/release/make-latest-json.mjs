/* global process, console */
// Génère latest.json au format de l'updater Tauri 2 (une seule plateforme : windows-x86_64).
// Usage : node scripts/release/make-latest-json.mjs <version> <installeur.exe> <installeur.exe.sig> <baseUrl> [notes] > latest.json
// <baseUrl> : https://github.com/<proprietaire>/circletasks-releases/releases/download/vX.Y.Z
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [version, exePath, sigPath, baseUrl, notes] = process.argv.slice(2);
if (!version || !exePath || !sigPath || !baseUrl) {
  fail('Usage : make-latest-json.mjs <version> <exe> <sig> <baseUrl> [notes]');
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`Version invalide : ${version}`);
if (!existsSync(exePath)) fail(`Installeur absent : ${exePath}`);
if (!existsSync(sigPath)) fail(`Signature absente : ${sigPath}`);
const signature = readFileSync(sigPath, 'utf8').trim();
if (signature.length === 0) fail('Signature vide');

const latest = {
  version,
  notes: notes || `CircleTasks ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(basename(exePath))}`,
    },
  },
};
process.stdout.write(JSON.stringify(latest, null, 2) + '\n');
