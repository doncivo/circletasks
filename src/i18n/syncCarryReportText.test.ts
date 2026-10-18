import { afterEach, describe, expect, it } from 'vitest';
import { CARRY_REPORT_TABLES } from '../domain/sync/epochCarryReportView';
import { syncCarryReportEn } from './en.syncCarryReport';
import { syncCarryReportFr } from './fr.syncCarryReport';
import { DEFAULT_LOCALE, setLocale } from './index';
import { tCarry } from './syncCarryReportText';

describe('textes du compte rendu du changement d’époque (Y-TECH-05)', () => {
  afterEach(() => setLocale(DEFAULT_LOCALE));

  it('mêmes clés et mêmes paramètres en anglais', () => {
    expect(Object.keys(syncCarryReportEn).sort()).toEqual(Object.keys(syncCarryReportFr).sort());
    const params = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(syncCarryReportFr) as (keyof typeof syncCarryReportFr)[]) expect(params(syncCarryReportEn[key]), key).toEqual(params(syncCarryReportFr[key]));
  });

  it('chaque type d’élément de la correspondance table → libellé a son nom au singulier', () => {
    const kinds = new Set(Object.values(CARRY_REPORT_TABLES).map((entry) => entry.kind));
    kinds.add('other');
    for (const kind of kinds) expect(`kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}` in syncCarryReportFr, kind).toBe(true);
  });

  it('aucun pluriel automatique : formulations « Éléments rétablis : 3 »', () => {
    expect(tCarry('summary', { count: 3 })).toBe('Éléments rétablis : 3');
    expect(tCarry('banner', { count: 1 })).toBe('Changement d’époque : éléments rétablis : 1. Voir le compte rendu');
    expect(tCarry('bannerNoRestored', { count: 2 })).toBe('Changement d’époque : aucun élément supprimé rétabli, autres éléments nommés : 2. Voir le compte rendu');
    expect(tCarry('summaryRecreated', { count: 2 })).toBe('Recréés : 2');
    expect(tCarry('summaryOthers', { count: 3 })).toBe('Rattachés ou mis de côté : 3');
    expect(tCarry('more', { count: 12 })).toBe('Autres éléments : 12');
  });

  it('suit la langue courante', () => {
    expect(tCarry('seen')).toBe('J’ai vu');
    setLocale('en');
    expect(tCarry('seen')).toBe('I have seen it');
  });
});
