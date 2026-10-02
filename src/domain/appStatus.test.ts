import { describe, expect, it } from 'vitest';
import { pickAppStatus } from './appStatus';

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
