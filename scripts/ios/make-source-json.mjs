/* global process, console */
// Génère ou met à jour source.json (format des sources SideStore / AltStore v1).
// Usage : node scripts/ios/make-source-json.mjs <version> <ipaUrl> <ipaPath> <notes> [source.json existant] > source.json
// Les anciennes versions du fichier existant sont conservées (la plus récente en premier).
import { readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [version, ipaUrl, ipaPath, notes, existingPath] = process.argv.slice(2);
if (!version || !ipaUrl || !ipaPath) {
  console.error('Usage : make-source-json.mjs <version> <ipaUrl> <ipaPath> <notes> [existant]');
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const template = JSON.parse(readFileSync(join(here, 'source.template.json'), 'utf8'));
const base = existingPath && existsSync(existingPath) ? JSON.parse(readFileSync(existingPath, 'utf8')) : template;
const app = base.apps[0];
const entry = {
  version,
  date: new Date().toISOString(),
  localizedDescription: notes || `CircleTasks ${version}`,
  downloadURL: ipaUrl,
  size: statSync(ipaPath).size,
  minOSVersion: template.apps[0].versions[0].minOSVersion,
};
const previous = (app.versions ?? []).filter((v) => v.version !== version && v.version !== '__VERSION__');
app.versions = [entry, ...previous].slice(0, 10);
process.stdout.write(JSON.stringify(base, null, 2) + '\n');
