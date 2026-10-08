import { describe, expect, it } from 'vitest';
import { APP_STATUS_PRIORITY, pickAppStatus, type ActiveStatuses, type AppStatusKind } from './appStatus';

describe('pickAppStatus (A-09 critère 5)', () => {
  it('aucun état actif : pas de bandeau', () => {
    expect(pickAppStatus({})).toBeNull();
  });

  it('un seul état : celui-ci', () => {
    expect(pickAppStatus({ offline: {} })).toBe('offline');
  });

  it('priorité : agenda déconnecté > en attente d’iCloud > synchro en cours > hors ligne', () => {
    expect(pickAppStatus({ offline: {}, syncing: {} })).toBe('syncing');
    expect(pickAppStatus({ offline: {}, syncing: {}, waitingIcloud: {} })).toBe('waitingIcloud');
    expect(pickAppStatus({ offline: {}, syncing: {}, waitingIcloud: {}, calendarDisconnected: { detail: 'Google' } })).toBe('calendarDisconnected');
  });
});

describe('état syncTrouble (A-09 critère 9 a, D1)', () => {
  it('ordre fixe : agenda > problème de synchro > mise à jour > iCloud > synchro en cours > hors ligne', () => {
    expect(APP_STATUS_PRIORITY).toEqual(['calendarDisconnected', 'syncTrouble', 'remindersTrouble', 'updateRequired', 'waitingIcloud', 'syncing', 'offline']);
  });

  it('chaque paire d’états : le plus prioritaire gagne, quel que soit l’ordre de pose', () => {
    for (const [i, higher] of APP_STATUS_PRIORITY.entries()) {
      for (const lower of APP_STATUS_PRIORITY.slice(i + 1)) {
        const forth: ActiveStatuses = { [higher]: {}, [lower]: {} };
        const back: ActiveStatuses = { [lower]: {}, [higher]: {} };
        expect(pickAppStatus(forth)).toBe(higher);
        expect(pickAppStatus(back)).toBe(higher);
      }
    }
  });

  it('« Hors ligne » ne masque jamais un problème de synchro, un agenda déconnecté le précède', () => {
    expect(pickAppStatus({ offline: {}, syncTrouble: { detail: 'error' } })).toBe('syncTrouble');
    expect(pickAppStatus({ offline: {}, syncing: {}, waitingIcloud: {}, updateRequired: {}, syncTrouble: { detail: 'key-mismatch' } })).toBe('syncTrouble');
    expect(pickAppStatus({ syncTrouble: { detail: 'error' }, calendarDisconnected: { detail: 'Perso' } })).toBe('calendarDisconnected');
  });

  it('tous les états sont ordonnés une seule fois', () => {
    const kinds: readonly AppStatusKind[] = APP_STATUS_PRIORITY;
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
