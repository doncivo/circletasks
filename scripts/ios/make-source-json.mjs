/* global process, console */
// Génère ou met à jour source.json (source SideStore, format AltStore ; champs vérifiés dans le code de
// SideStore, branche develop : StoreApp.swift, AppVersion.swift, VerifyAppOperation.swift).
// Usage :
//   node scripts/ios/make-source-json.mjs --version X.Y.Z --ipa CircleTasks.ipa --info-plist Info.plist(XML)
//        --url <URL de l'IPA> [--notes "…"] [--existing source.json] [--date ISO] > source.json
// Toutes les versions du fichier existant sont conservées, la nouvelle en premier ; une version republiée
// remplace seulement sa propre entrée. Contrôles avant écriture : version, identifiant et iOS minimum du
// Info.plist de l'IPA égaux à ceux attendus (SideStore refuse sinon l'installation).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePlist } from './plist.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

export const RELEASES_REPO = 'doncivo/circletasks-releases';
export const SOURCE_URL = `https://raw.githubusercontent.com/${RELEASES_REPO}/main/source.json`;
export const IPA_NAME = 'CircleTasks.ipa';
export const ipaUrlFor = (version) => `https://github.com/${RELEASES_REPO}/releases/download/ios-v${version}/${IPA_NAME}`;

export function loadTemplate() {
  return JSON.parse(readFileSync(join(here, 'source.template.json'), 'utf8'));
}

/** iOS minimum : source unique, tauri.conf.json (bundle.iOS.minimumSystemVersion). */
export function minOSVersionFromConf(confPath = join(root, 'src-tauri', 'tauri.conf.json')) {
  const v = JSON.parse(readFileSync(confPath, 'utf8'))?.bundle?.iOS?.minimumSystemVersion;
  if (typeof v !== 'string' || !/^\d+(\.\d+){0,2}$/.test(v)) throw new Error('bundle.iOS.minimumSystemVersion absent de tauri.conf.json');
  return v;
}

const sameOS = (a, b) => String(a).replace(/(\.0)+$/, '') === String(b).replace(/(\.0)+$/, '');

/**
 * Construit le source.json. `existing` : source.json publié (ou null) ; `info` : Info.plist de l'IPA (objet).
 * Lève une erreur au moindre écart, rien n'est publié dans ce cas.
 */
export function buildSource({ template, existing, info, version, downloadURL, size, sha256, notes, date, minOSVersion }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`Version invalide : ${version}`);
  if (downloadURL !== ipaUrlFor(version)) throw new Error(`URL de l'IPA inattendue : ${downloadURL} (attendu ${ipaUrlFor(version)})`);
  if (!Number.isInteger(size) || size <= 0) throw new Error(`Taille de l'IPA invalide : ${size}`);
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new Error('Empreinte SHA-256 invalide');
  if (Number.isNaN(Date.parse(date))) throw new Error(`Date invalide : ${date}`);
  const tApp = template.apps[0];
  if (info.CFBundleIdentifier !== tApp.bundleIdentifier) throw new Error(`Bundle de l'IPA ${info.CFBundleIdentifier} ≠ ${tApp.bundleIdentifier}`);
  if (info.CFBundleShortVersionString !== version) throw new Error(`Version de l'IPA ${info.CFBundleShortVersionString} ≠ ${version}`);
  if (!sameOS(info.MinimumOSVersion, minOSVersion)) throw new Error(`iOS minimum de l'IPA ${info.MinimumOSVersion} ≠ ${minOSVersion}`);
  if (typeof info.CFBundleVersion !== 'string' || info.CFBundleVersion === '') throw new Error('CFBundleVersion absent du Info.plist');

  const privacy = {};
  for (const [key, value] of Object.entries(info)) if (/UsageDescription$/.test(key)) privacy[key] = String(value);

  const entry = {
    version,
    buildVersion: info.CFBundleVersion,
    date,
    localizedDescription: notes && notes.trim() !== '' ? notes : `CircleTasks ${version}`,
    downloadURL,
    size,
    sha256,
    minOSVersion,
  };
  const existingApp = existing?.apps?.find((a) => a.bundleIdentifier === tApp.bundleIdentifier);
  const previous = (existingApp?.versions ?? []).filter((v) => v && v.version !== version && v.version !== '__VERSION__');
  const app = {
    ...tApp,
    // Champs d'app hérités (anciennes versions de SideStore) : ceux de la dernière version.
    version: entry.version,
    versionDate: entry.date,
    versionDescription: entry.localizedDescription,
    downloadURL: entry.downloadURL,
    size: entry.size,
    // Informatif tant que la source reste au format 1 (SideStore ne vérifie les permissions qu'au format 2).
    appPermissions: { entitlements: [], privacy },
    versions: [entry, ...previous],
  };
  return { ...template, apps: [app], news: Array.isArray(existing?.news) ? existing.news : template.news };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith('--') || argv[i + 1] === undefined) throw new Error(`Argument invalide : ${k}`);
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = parseArgs(process.argv.slice(2));
    for (const k of ['version', 'ipa', 'info-plist', 'url']) if (!a[k]) throw new Error(`--${k} manquant`);
    const ipa = readFileSync(a.ipa);
    const existing = a.existing && existsSync(a.existing) ? JSON.parse(readFileSync(a.existing, 'utf8')) : null;
    const source = buildSource({
      template: loadTemplate(),
      existing,
      info: parsePlist(readFileSync(a['info-plist'], 'utf8')),
      version: a.version,
      downloadURL: a.url,
      size: ipa.length,
      sha256: createHash('sha256').update(ipa).digest('hex'),
      notes: a.notes ?? '',
      date: a.date ?? new Date().toISOString(),
      minOSVersion: minOSVersionFromConf(),
    });
    process.stdout.write(JSON.stringify(source, null, 2) + '\n');
  } catch (err) {
    console.error(`::error::make-source-json : ${err instanceof Error ? err.message : String(err)}`);
    console.error('Usage : make-source-json.mjs --version X.Y.Z --ipa <ipa> --info-plist <Info.plist XML> --url <URL> [--notes …] [--existing source.json] [--date ISO]');
    process.exit(1);
  }
}
