import { afterEach, describe, expect, it } from 'vitest';
import { backupRestoreEn } from './en.backupRestore';
import { backupRestoreFr } from './fr.backupRestore';
import { DEFAULT_LOCALE, setLocale } from './index';
import { tBackupRestore } from './backupRestoreText';

describe('textes de la restauration (P-04-iOS)', () => {
  afterEach(() => setLocale(DEFAULT_LOCALE));

  it('mêmes clés en anglais, aucun paramètre', () => {
    expect(Object.keys(backupRestoreEn).sort()).toEqual(Object.keys(backupRestoreFr).sort());
    for (const text of [...Object.values(backupRestoreFr), ...Object.values(backupRestoreEn)]) expect(text).not.toMatch(/\{\w+\}/);
  });

  it('suit la langue courante', () => {
    expect(tBackupRestore('retry')).toBe('Réessayer');
    setLocale('en');
    expect(tBackupRestore('retry')).toBe('Try again');
  });
});
