// CAP-IOS-01 critère 16 et I-05 critère 8 (ADR 0015 §4.2 et §4.3) : le contrat Info.plist exige le micro, la reconnaissance vocale et la caméra
// (élargie à la photo d'une liste), en français, non vides ; aucune clé superflue (forbiddenKeys) ; entrées négatives (clé retirée, texte vide,
// texte anglais, clé interdite ajoutée = échec). Le contrôle de build-ios.yml lit le même contrat.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlist } from './plist.mjs';
import { checkPlistContract, validateContract } from './check-plist-contract.mjs';

type Json = Record<string, unknown>;
const root = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const FORBIDDEN = [
  'UIBackgroundModes',
  'NSLocationWhenInUseUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSPhotoLibraryUsageDescription',
  'NSPhotoLibraryAddUsageDescription',
  'NSContactsUsageDescription',
  'NSUserTrackingUsageDescription',
];

/** Clés d'usage de l'app sur cette branche (NSRemindersFullAccessUsageDescription arrive avec K-05, écart 8 de l'ADR 0015). */
const USAGE_KEYS = ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription', 'NSFaceIDUsageDescription'];

/** Heuristique de langue : au moins deux mots français courants et aucun mot anglais courant. */
function looksFrench(text: string): boolean {
  const french = text.match(/\b(le|la|les|de|des|du|un|une|votre|vous|pour|sur|sans|seulement|utilise|rien|est|et)\b/gi) ?? [];
  const english = text.match(/\b(the|your|you|to|and|is|for|with|only|uses|this)\b/gi) ?? [];
  return french.length >= 2 && english.length === 0;
}

describe('contrat Info.plist de la capture sur iPhone (CAP-IOS-01, I-05)', () => {
  const contract = JSON.parse(read('scripts/ios/plist-contract.json')) as Json;
  const plist = parsePlist(read('src-tauri/Info.ios.plist')) as Json;

  it('entrées vision et speech du contrat, bien formé, clés interdites déclarées', () => {
    const plugins = contract['plugins'] as Json;
    expect(plugins['vision']).toEqual({ story: 'CAP-IOS-01', usageDescriptions: ['NSCameraUsageDescription'] });
    expect(plugins['speech']).toEqual({ story: 'CAP-IOS-01', usageDescriptions: ['NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription'] });
    expect(contract['forbiddenKeys']).toEqual(FORBIDDEN);
    expect(contract['formatVersion']).toBe(1);
    expect(validateContract(contract)).toEqual([]);
  });

  it('Info.ios.plist respecte le contrat : aucune erreur, aucun avertissement', () => {
    expect(checkPlistContract(contract, plist)).toEqual({ errors: [], warnings: [] });
  });

  it('chaque description d’usage est non vide, en français, et dit à quoi sert l’autorisation', () => {
    for (const key of USAGE_KEYS) {
      const text = String(plist[key]);
      expect(text.trim(), key).not.toBe('');
      expect(looksFrench(text), `${key} : ${text}`).toBe(true);
      expect(text, key).toMatch(/^CircleTasks /);
      // 3 phrases au plus (I-05 critère 9, par analogie).
      expect(text.split(/[.!?]\s/).length, key).toBeLessThanOrEqual(3);
    }
    expect(plist['NSCameraUsageDescription']).toMatch(/code d'association/);
    expect(plist['NSCameraUsageDescription']).toMatch(/photographier une liste de tâches/);
    expect(plist['NSMicrophoneUsageDescription']).toMatch(/seulement pendant que vous dictez/);
    expect(plist['NSSpeechRecognitionUsageDescription']).toMatch(/sur l'iPhone, sans rien envoyer/);
  });

  it('aucune clé superflue : ni mode d’arrière-plan, ni localisation, photothèque, contacts ou suivi', () => {
    for (const key of FORBIDDEN) expect(Object.hasOwn(plist, key), key).toBe(false);
    // Aucune description d'usage hors de celles du contrat.
    const usage = Object.keys(plist).filter((key) => /UsageDescription$/.test(key));
    expect(usage.sort()).toEqual([...USAGE_KEYS].sort());
  });

  it('contrat négatif : clé retirée = échec, pour chaque clé de la capture', () => {
    for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) {
      const without = Object.fromEntries(Object.entries(plist).filter(([name]) => name !== key));
      const { errors } = checkPlistContract(contract, without);
      expect(errors.some((e) => e.startsWith(`${key} absente`)), key).toBe(true);
    }
  });

  it('contrat négatif : texte vide ou blanc = échec', () => {
    for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) {
      for (const blank of ['', '   ']) {
        expect(checkPlistContract(contract, { ...plist, [key]: blank }).errors, key).toContain(`${key} : description d'usage vide`);
      }
    }
  });

  it('contrat négatif : un texte anglais est détecté par le contrôle de langue des tests', () => {
    expect(looksFrench('CircleTasks uses the microphone only while you dictate a task.')).toBe(false);
    expect(looksFrench(String(plist['NSMicrophoneUsageDescription']))).toBe(true);
  });

  it('contrat négatif : chaque clé interdite ajoutée = échec nommant la clé', () => {
    for (const key of FORBIDDEN) {
      const value = key === 'UIBackgroundModes' ? ['audio'] : 'Texte.';
      const { errors } = checkPlistContract(contract, { ...plist, [key]: value });
      expect(errors, key).toContain(`${key} interdite (aucune clé superflue)`);
    }
  });

  it('forbiddenKeys mal écrit : contrat refusé', () => {
    expect(validateContract({ formatVersion: 1, plugins: {}, forbiddenKeys: 'UIBackgroundModes' })).toEqual(['Contrat : « forbiddenKeys » doit être une liste de clés']);
    expect(validateContract({ formatVersion: 1, plugins: {}, forbiddenKeys: [''] })).toHaveLength(1);
    expect(validateContract({ formatVersion: 1, plugins: {}, forbiddenKeys: ['UIBackgroundModes'] })).toEqual([]);
  });

  it('build-ios.yml : contrôle du contrat, plugins vision et speech compilés pour l’iPhone et jamais pour Windows', () => {
    const workflow = read('.github/workflows/build-ios.yml');
    expect(workflow).toContain('node scripts/ios/check-plist-contract.mjs scripts/ios/plist-contract.json info/Info.plist');
    expect(workflow).toMatch(/for CRATE in [^;\n]*tauri-plugin-vision[^;\n]*tauri-plugin-speech/);
  });
});
