// Y-IOS-02 critère 9 (ADR 0011 §23 point 2) : l'entrée barcode-scanner du contrat Info.plist exige NSCameraUsageDescription non vide ;
// src-tauri/Info.ios.plist porte le texte français ; le contrôle de build-ios.yml échoue si la clé manque ou est vide (contrat négatif).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlist } from './plist.mjs';
import { checkPlistContract, validateContract } from './check-plist-contract.mjs';

type Json = Record<string, unknown>;
const root = resolve(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const CAMERA_TEXT = 'CircleTasks utilise la caméra pour scanner le code d’association affiché sur votre PC et pour photographier une liste de tâches à lire.';

describe('contrat Info.plist du scan du QR (Y-IOS-02)', () => {
  const contract = JSON.parse(read('scripts/ios/plist-contract.json')) as Json;
  const plist = parsePlist(read('src-tauri/Info.ios.plist')) as Json;

  it('barcode-scanner : NSCameraUsageDescription, story Y-IOS-02 ; contrat bien formé', () => {
    expect((contract['plugins'] as Json)['barcode-scanner']).toEqual({ story: 'Y-IOS-02', usageDescriptions: ['NSCameraUsageDescription'] });
    expect(validateContract(contract)).toEqual([]);
  });

  it('Info.ios.plist porte le texte français et respecte le contrat', () => {
    expect(String(plist['NSCameraUsageDescription']).replace("'", '’')).toBe(CAMERA_TEXT);
    expect(checkPlistContract(contract, plist)).toEqual({ errors: [], warnings: [] });
  });

  it('contrat négatif : clé absente ou vide → échec', () => {
    const { NSCameraUsageDescription: _camera, ...without } = plist;
    expect(checkPlistContract(contract, without).errors.length).toBeGreaterThan(0);
    expect(checkPlistContract(contract, { ...plist, NSCameraUsageDescription: '  ' }).errors.length).toBeGreaterThan(0);
  });
});
