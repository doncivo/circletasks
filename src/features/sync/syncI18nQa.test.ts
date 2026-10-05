// Y-01 critère 19 (QA) : textes de la section SYNCHRONISATION dans src/i18n (fr et en), aucun texte en dur, boîtes natives complètes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import native from '../../i18n/native/fr.json';
import { syncFolderEn, syncKeyEn } from '../../i18n/en.syncFolder';
import { syncFolderFr, syncKeyFr } from '../../i18n/fr.syncFolder';

const keysOf = (value: object): string[] => Object.keys(value).sort();

describe('Y-01 critère 19 : textes', () => {
  it('fr et en ont exactement les mêmes clés, sans texte vide', () => {
    expect(keysOf(syncFolderEn)).toEqual(keysOf(syncFolderFr));
    expect(keysOf(syncKeyEn)).toEqual(keysOf(syncKeyFr));
    for (const table of [syncFolderFr, syncFolderEn, syncKeyFr, syncKeyEn]) {
      for (const [name, text] of Object.entries(table)) expect(String(text).trim(), name).not.toBe('');
    }
  });

  it('aucun texte français en dur dans le composant (accents, guillemets, point d’interrogation)', () => {
    const source = readFileSync(new URL('./SyncSettingsSection.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const literals = [...source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2] ?? '');
    for (const text of literals) expect(text, text).not.toMatch(/[àâäéèêëîïôöùûüçœ’«»]/i);
    expect(source).not.toMatch(/>\s*[A-ZÉ][a-zéèêàç]+[^<{]*</);
  });

  it('les trois boîtes natives ont titre, question, explication et deux boutons, « Annuler » en second', () => {
    expect(Object.keys(native.consent).sort()).toEqual(['eraseKey', 'replaceKey', 'showKey']);
    for (const [name, box] of Object.entries(native.consent)) {
      expect(Object.keys(box).sort(), name).toEqual(['cancel', 'confirm', 'content', 'instruction', 'title']);
      expect(box.cancel, name).toBe('Annuler');
      expect(box.instruction.endsWith('?'), name).toBe(true);
      expect(box.confirm, name).not.toBe(box.cancel);
    }
    expect(native.consent.showKey.confirm).toBe('Afficher la clé');
    expect(native.consent.eraseKey.content).toContain('Sans clé, cet appareil devra être associé de nouveau');
  });
});
