/* global process, console */
// Notes de version (I-06, ADR 0007 avenant I-06 point 3) : script commun au PC (build-windows.yml, latest.json et page de la release)
// et à l'iPhone (build-ios.yml, localizedDescription de la source SideStore et page de la release).
// Section de CHANGELOG.md dont le titre est « ## [X.Y.Z] » ou « ## X.Y.Z » (éventuellement suivi d'une date) : même règle que l'awk
// qu'utilisait build-windows.yml. Lignes vides du début et de la fin retirées.
// Usage : node scripts/release/release-notes.mjs X.Y.Z [CHANGELOG.md] -> notes sur stdout ; code 2 si la section est absente ou vide.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Le titre de section `## …` désigne-t-il `version` ? */
export function headingMatches(heading, version) {
  let t = heading.replace(/^##\s+/, '');
  t = t.replace(/^\[/, '');
  return t === version || t.startsWith(`${version}]`) || t.startsWith(`${version} `);
}

/** Notes de `version` dans le texte d'un CHANGELOG ; null si la section est absente ou vide. */
export function extractReleaseNotes(changelog, version) {
  const lines = String(changelog).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let found = false;
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (found) break;
      if (headingMatches(line, version)) found = true;
      continue;
    }
    if (found) out.push(line);
  }
  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return found && out.length > 0 ? out.join('\n') : null;
}

/** Notes de repli quand la section manque (branche seulement : sur un tag, l'absence fait échouer le job). */
export const fallbackNotes = (version) => `CircleTasks ${version}`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  const file = process.argv[3] ?? join(root, 'CHANGELOG.md');
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('Usage : release-notes.mjs X.Y.Z [CHANGELOG.md]');
    process.exit(1);
  }
  const notes = existsSync(file) ? extractReleaseNotes(readFileSync(file, 'utf8'), version) : null;
  if (notes === null) {
    console.error(`Aucune section « ## ${version} » dans ${file}`);
    process.exit(2);
  }
  process.stdout.write(`${notes}\n`);
}
