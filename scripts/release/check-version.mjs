/* global process, console */
// Vérifie que package.json, tauri.conf.json et Cargo.toml portent la même version X.Y.Z,
// et, si un tag est fourni, qu'il vaut vX.Y.Z. Usage : node scripts/release/check-version.mjs [vX.Y.Z]
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')).version;
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
const cargo = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync('src-tauri/Cargo.toml', 'utf8'))?.[1];
const tag = process.argv[2];

const errors = [];
if (!/^\d+\.\d+\.\d+$/.test(conf ?? '')) errors.push(`version tauri.conf.json invalide : ${conf}`);
if (pkg !== conf) errors.push(`package.json (${pkg}) diffère de tauri.conf.json (${conf})`);
if (cargo !== conf) errors.push(`Cargo.toml (${cargo}) diffère de tauri.conf.json (${conf})`);
if (tag !== undefined && tag !== `v${conf}`) errors.push(`le tag ${tag} ne correspond pas à la version v${conf}`);

if (errors.length > 0) {
  for (const e of errors) console.error(`::error::${e}`);
  process.exit(1);
}
console.log(conf);
