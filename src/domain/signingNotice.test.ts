import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFINITIONS, isSharedSetting } from './model/settings';
import { EMPTY_SIGNING_STATUS, SIGNING_ALERT_LEAD_MS, parseSigningStatus, signingNotice } from './signingNotice';

const H = 3_600_000;
const ms = (iso: string): number => Date.parse(iso);

describe('signingNotice (I-02 critère 1, ADR 0013 §3.3)', () => {
  it('alerte 24 h (instant absolu) avant l’expiration', () => {
    expect(SIGNING_ALERT_LEAD_MS).toBe(24 * H);
  });

  it('ok : alerte à venir, heure murale du fuseau injecté', () => {
    const expiresAt = ms('2026-10-15T09:12:34Z');
    const notice = signingNotice({ expiresAt, now: ms('2026-10-08T09:12:34Z'), zone: 'Europe/Paris' });
    expect(notice).toEqual({ state: 'ok', expiresAt, alertInstant: expiresAt - 24 * H, alertAt: '2026-10-14T11:12' });
  });

  it('fuseau différent : même instant, autre heure murale (indépendant de TZ)', () => {
    const expiresAt = ms('2026-10-15T09:12:34Z');
    const now = ms('2026-10-08T00:00:00Z');
    expect(signingNotice({ expiresAt, now, zone: 'Africa/Tunis' })).toMatchObject({ alertAt: '2026-10-14T10:12' });
    expect(signingNotice({ expiresAt, now, zone: 'America/New_York' })).toMatchObject({ alertAt: '2026-10-14T05:12' });
    expect(signingNotice({ expiresAt, now, zone: 'UTC' })).toMatchObject({ alertAt: '2026-10-14T09:12' });
  });

  it('heure d’été : expiration juste après le passage à l’heure d’hiver, l’alerte reste 24 h avant (pas « même heure la veille »)', () => {
    // 2026-10-25 : 03:00 (UTC+2) devient 02:00 (UTC+1) à Paris. Expiration à 09:30 heure d’hiver (08:30Z).
    const expiresAt = ms('2026-10-25T08:30:00Z');
    const notice = signingNotice({ expiresAt, now: ms('2026-10-20T00:00:00Z'), zone: 'Europe/Paris' });
    expect(notice).toMatchObject({ state: 'ok', alertInstant: ms('2026-10-24T08:30:00Z'), alertAt: '2026-10-24T10:30' });
  });

  it('heure d’été : expiration juste après le passage à l’heure d’été', () => {
    // 2027-03-28 : 02:00 (UTC+1) devient 03:00 (UTC+2). Expiration à 03:30 heure d’été (01:30Z).
    const expiresAt = ms('2027-03-28T01:30:00Z');
    expect(signingNotice({ expiresAt, now: ms('2027-03-20T00:00:00Z'), zone: 'Europe/Paris' })).toMatchObject({ alertAt: '2027-03-27T02:30' });
  });

  it('soon : moins de 24 h restantes (bornes)', () => {
    const expiresAt = ms('2026-10-15T09:00:00Z');
    expect(signingNotice({ expiresAt, now: expiresAt - 24 * H, zone: 'UTC' })).toEqual({ state: 'soon', expiresAt, remainingMs: 24 * H });
    expect(signingNotice({ expiresAt, now: expiresAt - 1, zone: 'UTC' })).toEqual({ state: 'soon', expiresAt, remainingMs: 1 });
    expect(signingNotice({ expiresAt, now: expiresAt - 24 * H - 1, zone: 'UTC' })).toMatchObject({ state: 'ok' });
  });

  it('expired : échéance atteinte ou passée', () => {
    const expiresAt = ms('2026-10-15T09:00:00Z');
    expect(signingNotice({ expiresAt, now: expiresAt, zone: 'UTC' })).toEqual({ state: 'expired', expiresAt });
    expect(signingNotice({ expiresAt, now: expiresAt + H, zone: null })).toEqual({ state: 'expired', expiresAt });
  });

  it('unknown : date absente ou non finie', () => {
    expect(signingNotice({ expiresAt: null, now: 0, zone: 'UTC' })).toEqual({ state: 'unknown' });
    expect(signingNotice({ expiresAt: Number.NaN, now: 0, zone: 'UTC' })).toEqual({ state: 'unknown' });
    expect(signingNotice({ expiresAt: 1, now: Number.NaN, zone: 'UTC' })).toEqual({ state: 'unknown' });
  });
});

describe('parseSigningStatus (réglage local notifications.signing)', () => {
  const full = {
    v: 1,
    lastRead: { at: '2026-10-08T09:00:00.000Z', expiresAt: '2026-10-15T09:12:34Z', issuedAt: '2026-10-08T09:12:34Z' },
    failure: { at: '2026-10-08T10:00:00.000Z', code: 'profile-missing' },
    scheduled: { instant: ms('2026-10-14T09:12:34Z'), expiresAt: '2026-10-15T09:12:34Z' },
  };

  it('absent ou null : vide, lisible', () => {
    expect(parseSigningStatus(null)).toEqual({ status: EMPTY_SIGNING_STATUS, unreadable: false });
    expect(parseSigningStatus(undefined)).toEqual({ status: EMPTY_SIGNING_STATUS, unreadable: false });
  });

  it('valeur complète relue telle quelle ; issuedAt facultatif', () => {
    expect(parseSigningStatus(full)).toEqual({ status: full, unreadable: false });
    const noIssued = { ...full, lastRead: { at: full.lastRead.at, expiresAt: full.lastRead.expiresAt } };
    expect(parseSigningStatus(noIssued).status.lastRead?.issuedAt).toBeNull();
    expect(parseSigningStatus({ v: 1 })).toEqual({ status: EMPTY_SIGNING_STATUS, unreadable: false });
  });

  it('forme inattendue : vide et illisible', () => {
    const bad: unknown[] = [
      'x',
      [],
      { v: 2 },
      { ...full, lastRead: { at: 'hier', expiresAt: full.lastRead.expiresAt } },
      { ...full, lastRead: { ...full.lastRead, issuedAt: 3 } },
      { ...full, failure: { at: full.failure.at, code: 'other' } },
      { ...full, scheduled: { instant: 'x', expiresAt: full.scheduled.expiresAt } },
      { ...full, scheduled: { instant: Number.NaN, expiresAt: full.scheduled.expiresAt } },
      { ...full, scheduled: [] },
    ];
    for (const raw of bad) expect(parseSigningStatus(raw)).toEqual({ status: EMPTY_SIGNING_STATUS, unreadable: true });
  });

  it('réglage local, défaut null, jamais partagé', () => {
    expect(SETTINGS_DEFINITIONS['notifications.signing']).toEqual({ scope: 'local', defaultValue: null });
    expect(isSharedSetting('notifications.signing')).toBe(false);
  });
});
