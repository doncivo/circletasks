import { describe, expect, it } from 'vitest';
import { parseNotificationLedger } from './notificationLedger';
import { parseNotificationStatus } from './notificationStatus';

const entry = { n: 70_000, sid: 'task:a', at: 1_800_000_000_000, h: '0000abcd', kind: 'task' };

describe('parseNotificationLedger (N-01 critère 6)', () => {
  it('jamais écrit : manquant (installation neuve, rien à reconstruire)', () => {
    expect(parseNotificationLedger(null)).toEqual({ state: 'missing' });
    expect(parseNotificationLedger(undefined)).toEqual({ state: 'missing' });
  });

  it('valide : version 1, fuseau, entrées, fin de Focus', () => {
    const read = parseNotificationLedger({ v: 1, zone: 'Europe/Paris', entries: [entry], focusEnd: { sessionId: 's1', at: 5 } });
    expect(read.state).toBe('valid');
    if (read.state === 'valid') {
      expect(read.ledger.entries).toEqual([entry]);
      expect(read.ledger.focusEnd).toEqual({ sessionId: 's1', at: 5 });
    }
    expect(parseNotificationLedger({ v: 1, zone: null, entries: [], focusEnd: null }).state).toBe('valid');
  });

  it.each([
    ['version inconnue', { v: 2, zone: null, entries: [], focusEnd: null }],
    ['pas un objet', 'x'],
    ['fuseau de type faux', { v: 1, zone: 3, entries: [], focusEnd: null }],
    ['entrées absentes', { v: 1, zone: null, focusEnd: null }],
    ['identifiant numérique réservé (1)', { v: 1, zone: null, entries: [{ ...entry, n: 1 }], focusEnd: null }],
    ['nature inconnue', { v: 1, zone: null, entries: [{ ...entry, kind: 'autre' }], focusEnd: null }],
    ['instant non fini', { v: 1, zone: null, entries: [{ ...entry, at: Number.NaN }], focusEnd: null }],
    ['identifiant stable en double', { v: 1, zone: null, entries: [entry, { ...entry, n: 70_001 }], focusEnd: null }],
    ['identifiant numérique en double', { v: 1, zone: null, entries: [entry, { ...entry, sid: 'task:b' }], focusEnd: null }],
    ['fin de Focus fausse', { v: 1, zone: null, entries: [], focusEnd: { sessionId: 3, at: 1 } }],
    ['fin de Focus absente', { v: 1, zone: null, entries: [] }],
  ])('illisible : %s', (_name, raw) => {
    expect(parseNotificationLedger(raw)).toEqual({ state: 'unreadable' });
  });
});

describe('parseNotificationStatus (N-01 critère 12)', () => {
  const valid = {
    v: 1,
    permission: 'granted',
    lastSuccess: { at: '2026-10-08T10:00:00.000Z', coverage: { state: 'until', until: '2026-11-01T21:00' }, total: 120, zone: 'Europe/Paris' },
    planFailure: { at: '2026-10-08T10:00:00.000Z', reason: 'verify-failed', count: 2, partial: { scheduled: 3, cancelled: 1, kept: 4 } },
    focusEndFailure: { at: '2026-10-08T10:00:00.000Z', sessionId: 's', reason: 'permission-denied' },
    zoneChange: { at: '2026-10-08T10:00:00.000Z', from: 'Europe/Paris', to: 'America/New_York' },
    ledgerRebuiltAt: '2026-10-08T10:00:00.000Z',
    actionsFailure: { at: '2026-10-08T10:00:00.000Z', reason: 'delegate-lost' },
  };

  it('jamais écrit : état vide valide', () => {
    const read = parseNotificationStatus(null);
    expect(read.state).toBe('valid');
    if (read.state === 'valid') expect(read.status).toMatchObject({ permission: null, lastSuccess: null, planFailure: null, focusEndFailure: null });
  });

  it('valide : tous les champs', () => {
    expect(parseNotificationStatus(valid)).toEqual({ state: 'valid', status: valid });
  });

  it('un état écrit avant N-03 (sans actionsFailure) reste lisible : champ nul', () => {
    const { actionsFailure: _omitted, ...older } = valid;
    const read = parseNotificationStatus(older);
    expect(read.state).toBe('valid');
    if (read.state === 'valid') expect(read.status.actionsFailure).toBeNull();
  });

  it.each([
    ['version', { ...valid, v: 9 }],
    ['panne des actions inconnue', { ...valid, actionsFailure: { at: '2026-10-08T10:00:00.000Z', reason: 'bizarre' } }],
    ['panne des actions sans date', { ...valid, actionsFailure: { at: 'x', reason: 'delegate-lost' } }],
    ['autorisation', { ...valid, permission: 'peut-être' }],
    ['code d’échec inconnu', { ...valid, planFailure: { ...valid.planFailure, reason: 'bizarre' } }],
    ['couverture fausse', { ...valid, lastSuccess: { ...valid.lastSuccess, coverage: { state: 'until', until: 'demain' } } }],
    ['date invalide', { ...valid, ledgerRebuiltAt: 'pas une date' }],
    ['nombres négatifs', { ...valid, planFailure: { ...valid.planFailure, count: -1 } }],
  ])('illisible : %s', (_name, raw) => {
    expect(parseNotificationStatus(raw)).toEqual({ state: 'unreadable' });
  });
});
