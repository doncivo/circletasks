import { afterEach, describe, expect, it } from 'vitest';
import { appUpdateRestoreEn } from './en.appUpdateRestore';
import { appUpdateRestoreFr } from './fr.appUpdateRestore';
import { tUpdateRestore } from './appUpdateRestoreText';
import { DEFAULT_LOCALE, setLocale } from './index';

describe('textes de la restauration d’avant la mise à jour (I-06)', () => {
  afterEach(() => setLocale(DEFAULT_LOCALE));

  it('mêmes clés et mêmes paramètres en anglais', () => {
    expect(Object.keys(appUpdateRestoreEn).sort()).toEqual(Object.keys(appUpdateRestoreFr).sort());
    for (const key of Object.keys(appUpdateRestoreFr) as (keyof typeof appUpdateRestoreFr)[]) {
      expect(appUpdateRestoreEn[key].match(/\{\w+\}/g) ?? []).toEqual(appUpdateRestoreFr[key].match(/\{\w+\}/g) ?? []);
    }
  });

  it('suit la langue courante et remplace les paramètres', () => {
    expect(tUpdateRestore('restoreConfirm')).toBe('Restaurer');
    expect(tUpdateRestore('restoreFailed', { reason: 'Raison.' })).toBe('La restauration n’a pas abouti. Raison.');
    setLocale('en');
    expect(tUpdateRestore('restoreConfirm')).toBe('Restore');
  });
});
