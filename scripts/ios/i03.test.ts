// I-03 critère 4 (ADR 0013 §2.1) : l'entrée biometric du contrat Info.plist exige NSFaceIDUsageDescription non vide ; src-tauri/Info.ios.plist
// porte le texte français ; le contrôle de build-ios.yml échoue si la clé manque ou est vide (contrat négatif). A-07 : aucune clé pour haptics.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlist } from './plist.mjs';
import { checkPlistContract, validateContract } from './check-plist-contract.mjs';

type Json = Record<string, unknown>;
const root = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const FACE_ID_TEXT = 'CircleTasks utilise Face ID pour garder vos tâches privées.';

describe('contrat Info.plist du verrouillage Face ID (I-03)', () => {
  const contract = JSON.parse(read('scripts/ios/plist-contract.json')) as Json;
  const plist = parsePlist(read('src-tauri/Info.ios.plist')) as Json;

  it('biometric : NSFaceIDUsageDescription, story I-03 ; contrat bien formé', () => {
    expect((contract['plugins'] as Json)['biometric']).toEqual({ story: 'I-03', usageDescriptions: ['NSFaceIDUsageDescription'] });
    expect(validateContract(contract)).toEqual([]);
  });

  it('Info.ios.plist porte le texte français exact et respecte le contrat', () => {
    expect(plist['NSFaceIDUsageDescription']).toBe(FACE_ID_TEXT);
    expect(checkPlistContract(contract, plist)).toEqual({ errors: [], warnings: [] });
  });

  it('contrat négatif : clé absente ou vide → échec', () => {
    const { NSFaceIDUsageDescription: _faceId, ...without } = plist;
    expect(checkPlistContract(contract, without).errors).toEqual(['NSFaceIDUsageDescription absente (plugin biometric, I-03)']);
    expect(checkPlistContract(contract, { ...plist, NSFaceIDUsageDescription: '  ' }).errors.length).toBeGreaterThan(0);
  });

  it('A-07 critère 20 et privacy-shield : aucune entrée de contrat (aucune clé Info.plist)', () => {
    const plugins = Object.keys(contract['plugins'] as Json);
    expect(plugins).not.toContain('haptics');
    expect(plugins).not.toContain('privacy-shield');
  });
});
