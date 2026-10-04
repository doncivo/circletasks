/* global process, console */
// Vérifie que package.json, tauri.conf.json et Cargo.toml portent la même version X.Y.Z,
// et, si un tag est fourni, qu'il vaut vX.Y.Z. Usage : node scripts/release/check-version.mjs [vX.Y.Z]
// Les chemins sont résolus depuis l'emplacement du script (racine du dépôt), pas depuis le dossier courant.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Renvoie { version, errors } pour la racine donnée. */
export function checkVersion(root, tag) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version;
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8'))?.[1];

  const errors = [];
  if (!/^\d+\.\d+\.\d+$/.test(conf ?? '')) errors.push(`version tauri.conf.json invalide : ${conf}`);
  if (pkg !== conf) errors.push(`package.json (${pkg}) diffère de tauri.conf.json (${conf})`);
  if (cargo !== conf) errors.push(`Cargo.toml (${cargo}) diffère de tauri.conf.json (${conf})`);
  if (tag !== undefined && tag !== `v${conf}`) errors.push(`le tag ${tag} ne correspond pas à la version v${conf}`);
  return { version: conf, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version, errors } = checkVersion(defaultRoot, process.argv[2]);
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log(version);
}
