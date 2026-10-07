/* global process, console */
// Contrôle du Info.plist contre scripts/ios/plist-contract.json (I-01, critère 2).
// Usage : node scripts/ios/check-plist-contract.mjs <plist-contract.json> <Info.plist XML>
// Échoue (code 1, lignes ::error::) si une clé exigée manque ou si une description d'usage est vide.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parsePlist } from './plist.mjs';

const USAGE_KEY = /^NS[A-Za-z]+UsageDescription$/;
const ENTRY_FIELDS = new Set(['story', 'usageDescriptions', 'keys', 'arrayIncludes']);

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');

/** Erreurs de forme du contrat (champ inconnu, type faux) : un contrat mal écrit ne doit rien laisser passer. */
export function validateContract(contract) {
  const errors = [];
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return ['Contrat : objet JSON attendu'];
  if (contract.formatVersion !== 1) errors.push(`Contrat : formatVersion 1 attendu (trouvé ${JSON.stringify(contract.formatVersion)})`);
  const plugins = contract.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) {
    errors.push('Contrat : « plugins » doit être un objet');
    return errors;
  }
  for (const [name, entry] of Object.entries(plugins)) {
    const at = `Contrat, plugin ${name}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} : objet attendu`);
      continue;
    }
    for (const field of Object.keys(entry)) if (!ENTRY_FIELDS.has(field)) errors.push(`${at} : champ inconnu « ${field} »`);
    if (typeof entry.story !== 'string' || entry.story.trim() === '') errors.push(`${at} : « story » obligatoire`);
    if (entry.usageDescriptions !== undefined) {
      if (!isStringArray(entry.usageDescriptions)) errors.push(`${at} : « usageDescriptions » doit être une liste de clés`);
      else for (const key of entry.usageDescriptions) if (!USAGE_KEY.test(key)) errors.push(`${at} : « ${key} » n'est pas une clé NS…UsageDescription`);
    }
    if (entry.keys !== undefined && !isStringArray(entry.keys)) errors.push(`${at} : « keys » doit être une liste de clés`);
    if (entry.arrayIncludes !== undefined) {
      const ai = entry.arrayIncludes;
      if (!ai || typeof ai !== 'object' || Array.isArray(ai) || !Object.values(ai).every(isStringArray)) {
        errors.push(`${at} : « arrayIncludes » doit être { clé: [valeurs] }`);
      }
    }
  }
  return errors;
}

/**
 * Compare un Info.plist (objet) au contrat. Rend { errors, warnings }.
 * Toute description d'usage présente doit être non vide, déclarée ou non dans le contrat ;
 * une description non déclarée donne un avertissement (le contrat doit suivre Info.ios.plist).
 */
export function checkPlistContract(contract, plist) {
  const errors = validateContract(contract);
  const warnings = [];
  if (errors.length > 0) return { errors, warnings };
  if (!plist || typeof plist !== 'object' || Array.isArray(plist)) return { errors: ['Info.plist : dictionnaire racine attendu'], warnings };
  const declared = new Set();
  for (const [name, entry] of Object.entries(contract.plugins)) {
    for (const key of entry.usageDescriptions ?? []) {
      declared.add(key);
      if (!Object.hasOwn(plist, key)) errors.push(`${key} absente (plugin ${name}, ${entry.story})`);
    }
    for (const key of entry.keys ?? []) {
      if (!Object.hasOwn(plist, key)) errors.push(`${key} absente (plugin ${name}, ${entry.story})`);
    }
    for (const [key, values] of Object.entries(entry.arrayIncludes ?? {})) {
      const actual = Object.hasOwn(plist, key) ? plist[key] : undefined;
      if (!Array.isArray(actual)) {
        errors.push(`${key} absente ou n'est pas un tableau (plugin ${name}, ${entry.story})`);
        continue;
      }
      for (const v of values) if (!actual.includes(v)) errors.push(`${key} ne contient pas « ${v} » (plugin ${name}, ${entry.story})`);
    }
  }
  for (const [key, value] of Object.entries(plist)) {
    if (!/UsageDescription$/.test(key)) continue;
    if (typeof value !== 'string' || value.trim() === '') errors.push(`${key} : description d'usage vide`);
    else if (!declared.has(key)) warnings.push(`${key} présente mais absente de plist-contract.json`);
  }
  return { errors, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [contractPath, plistPath] = process.argv.slice(2);
  if (!contractPath || !plistPath) {
    console.error('Usage : check-plist-contract.mjs <plist-contract.json> <Info.plist XML>');
    process.exit(1);
  }
  let result;
  try {
    result = checkPlistContract(JSON.parse(readFileSync(contractPath, 'utf8')), parsePlist(readFileSync(plistPath, 'utf8')));
  } catch (err) {
    console.error(`::error::Contrat Info.plist illisible : ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  for (const w of result.warnings) console.log(`::warning::${w}`);
  for (const e of result.errors) console.error(`::error::${e}`);
  if (result.errors.length > 0) process.exit(1);
  const count = Object.keys(JSON.parse(readFileSync(contractPath, 'utf8')).plugins).length;
  console.log(`Contrat Info.plist respecté (${count} plugin(s) déclaré(s)).`);
}
