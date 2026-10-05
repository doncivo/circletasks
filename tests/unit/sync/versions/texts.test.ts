import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { syncEngineEn } from '../../../../src/i18n/en.syncEngine';
import { syncVersionEn } from '../../../../src/i18n/en.syncVersion';
import { syncEngineFr } from '../../../../src/i18n/fr.syncEngine';
import { syncVersionFr } from '../../../../src/i18n/fr.syncVersion';

/** Y-07 critère 12 : textes dans src/i18n (fr et en, parité), aucun texte en dur (journaux sans contenu : twoVersions.test.ts, applyRecette.test.ts). */

const vars = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('textes (Y-07 critère 12)', () => {
  it('sync.version : fr et en ont les mêmes clés, aucun texte vide, mêmes variables ; idem pour la ligne nommant l’appareil', () => {
    expect(Object.keys(syncVersionEn).sort()).toEqual(Object.keys(syncVersionFr).sort());
    for (const [key, fr] of Object.entries(syncVersionFr)) {
      const en = syncVersionEn[key as keyof typeof syncVersionFr];
      expect(fr.trim(), key).not.toBe('');
      expect(en.trim(), key).not.toBe('');
      expect(vars(en), key).toEqual(vars(fr));
    }
    expect(vars(syncEngineFr.status.updateRequiredDevice)).toEqual(['device']);
    expect(vars(syncEngineEn.status.updateRequiredDevice)).toEqual(['device']);
  });

  it('aucun texte en dur dans le composant de version ni dans le bandeau', () => {
    for (const file of ['../../../../src/features/sync/SyncDetailsVersion.tsx', '../../../../src/features/app/AppStatusBanner.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const literals = [...source.matchAll(/(['"`])((?:\.|(?!\1)[^\\n])*)\1/g)].map((m) => m[2] ?? '');
      for (const text of literals) expect(text, `${file} : ${text}`).not.toMatch(/[àâäéèêëîïôöùûüçœ’«»]/i);
      expect(source, file).not.toMatch(/>\s*[A-ZÉ][a-zéèêàç]+[^<{]*</);
    }
  });
});
