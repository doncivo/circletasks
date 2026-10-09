/* global process, console */
// Contrôle de cohérence de la source SideStore (I-06, ADR 0007 avenant I-06 point 2), lancé par build-ios.yml en simulation sur une
// branche (source publiée lue à l'URL publique, aucun secret) et avant le push sur un tag ios-v*.
// Usage : node scripts/ios/check-source.mjs source.json [--published X.Y.Z] [--downgrade error|warn]
// `--downgrade warn` (simulation sur une branche, revue I-06 M2) : une version inférieure à la plus haute publiée est un avertissement ;
// sur un tag ios-v*, c'est un échec (défaut).
// Sortie : une ligne ::error:: par écart (code 1), une ligne ::warning:: par avertissement, puis « source valide ».
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compareVersions, ipaUrlFor } from './make-source-json.mjs';

export const BUNDLE_ID = 'fr.circletasks.planner';
/** iOS minimum de référence (tauri.conf.json, PRD 7) : au-delà, la version doit le dire dans ses notes. */
export const BASE_MIN_OS = 18;

/** Compare deux CFBundleVersion composant par composant (« 0.3.0 » > « 0.2.10 ») ; null si l'un est illisible. */
export function compareBuilds(a, b) {
  const parse = (v) => (/^\d+(\.\d+)*$/.test(String(v)) ? String(v).split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Contrôle une source (objet). `published` : version que la publication vient d'écrire (refusée si elle est inférieure à la plus haute
 * des autres versions : SideStore n'installe pas une version plus ancienne, et l'app refuse une base plus récente, D5).
 * Rend { errors, warnings } ; aucune exception pour un écart attendu.
 */
export function checkSource(source, { published, downgrade = 'error' } = {}) {
  const errors = [];
  const warnings = [];
  const app = source?.apps?.[0];
  if (!app) return { errors: ['aucune app dans la source'], warnings };
  if (app.bundleIdentifier !== BUNDLE_ID) errors.push(`bundleIdentifier ${String(app.bundleIdentifier)} ≠ ${BUNDLE_ID} : la mise à jour perdrait les données`);
  if (typeof app.iconURL !== 'string' || app.iconURL === '') errors.push('iconURL absent (obligatoire pour SideStore)');
  const versions = Array.isArray(app.versions) ? app.versions : [];
  if (versions.length === 0) errors.push('aucune version');

  const seen = new Set();
  versions.forEach((v, i) => {
    const label = `version ${String(v?.version)}`;
    if (!/^\d+\.\d+\.\d+$/.test(String(v?.version ?? ''))) errors.push(`${label} : numéro invalide`);
    if (seen.has(v?.version)) errors.push(`${label} : présente deux fois`);
    seen.add(v?.version);
    if (v?.downloadURL !== ipaUrlFor(v?.version)) errors.push(`${label} : downloadURL ${String(v?.downloadURL)} ≠ ${ipaUrlFor(v?.version)}`);
    // Champs exigés de la version publiée (et de toutes sans `published`) ; une version publiée avant I-01 (0.1.0 : ni sha256 ni
    // buildVersion) reste intacte : avertissement seulement, elle n'est jamais réécrite.
    const strict = published === undefined || v?.version === published;
    const missing = (text) => (strict ? errors : warnings).push(`${label} : ${text}${strict ? '' : ' (version déjà publiée, laissée intacte)'}`);
    if (!/^[0-9a-f]{64}$/.test(String(v?.sha256 ?? ''))) missing('sha256 absent ou invalide');
    if (!Number.isInteger(v?.size) || v.size <= 0) errors.push(`${label} : size absente ou invalide`);
    if (typeof v?.buildVersion !== 'string' || v.buildVersion === '') missing('buildVersion absent');
    const minOs = Number.parseInt(String(v?.minOSVersion ?? ''), 10);
    if (Number.isFinite(minOs) && minOs > BASE_MIN_OS && !String(v?.localizedDescription ?? '').includes(`iOS ${String(minOs)}`)) {
      errors.push(`${label} : iOS minimum ${String(v.minOSVersion)} sans note « iOS ${String(minOs)} » dans les notes`);
    }
    if (i > 0 && compareVersions(versions[i - 1]?.version, v?.version) <= 0) errors.push(`${label} : ordre des versions (la plus haute d'abord) non respecté`);
  });

  // D6 : l'ordre des buildVersion suit celui des versions ; deux versions distinctes n'ont jamais le même build.
  for (let i = 0; i < versions.length; i += 1) {
    for (let j = i + 1; j < versions.length; j += 1) {
      const a = versions[i];
      const b = versions[j];
      const byVersion = compareVersions(a?.version, b?.version);
      const byBuild = compareBuilds(a?.buildVersion, b?.buildVersion);
      if (byBuild === null) continue;
      if (byBuild === 0) errors.push(`buildVersion ${String(a.buildVersion)} identique pour ${String(a.version)} et ${String(b.version)}`);
      else if (Math.sign(byBuild) !== Math.sign(byVersion)) errors.push(`buildVersion non croissant : ${String(a.version)} (${String(a.buildVersion)}) et ${String(b.version)} (${String(b.buildVersion)})`);
    }
  }

  if (published !== undefined) {
    const entry = versions.find((v) => v?.version === published);
    if (!entry) errors.push(`version publiée ${published} absente de la source`);
    const others = versions.filter((v) => v?.version !== published).map((v) => v?.version);
    const highest = others.sort((a, b) => compareVersions(b, a))[0];
    if (highest !== undefined && compareVersions(published, highest) < 0) (downgrade === 'warn' ? warnings : errors).push(`version publiée ${published} inférieure à la plus haute déjà présente (${String(highest)}) : aucune rétrogradation`);
    if (entry && String(entry.localizedDescription ?? '').trim() === `CircleTasks ${published}`) warnings.push(`notes de ${published} égales au repli : aucune section dans CHANGELOG.md`);
  }

  const latest = versions[0];
  if (latest) {
    for (const [field, value] of [
      ['version', latest.version],
      ['versionDate', latest.date],
      ['downloadURL', latest.downloadURL],
      ['size', latest.size],
    ]) {
      if (app[field] !== value) errors.push(`champ d'app hérité ${field} différent de la première version (${String(app[field])} ≠ ${String(value)})`);
    }
  }
  return { errors, warnings };
}

function parseArgs(argv) {
  const out = { file: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] === '--published') out.published = argv[i + 1];
    else if (argv[i] === '--downgrade' && (argv[i + 1] === 'warn' || argv[i + 1] === 'error')) out.downgrade = argv[i + 1];
    else throw new Error(`Argument invalide : ${String(argv[i])}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.file) throw new Error('source.json manquant');
    const { errors, warnings } = checkSource(JSON.parse(readFileSync(args.file, 'utf8')), {
      ...(args.published === undefined ? {} : { published: args.published }),
      ...(args.downgrade === undefined ? {} : { downgrade: args.downgrade }),
    });
    for (const w of warnings) console.log(`::warning::check-source : ${w}`);
    for (const e of errors) console.log(`::error::check-source : ${e}`);
    if (errors.length > 0) process.exit(1);
    console.log('source valide');
  } catch (err) {
    console.log(`::error::check-source : ${err instanceof Error ? err.message : String(err)}`);
    console.error('Usage : check-source.mjs source.json [--published X.Y.Z]');
    process.exit(1);
  }
}
