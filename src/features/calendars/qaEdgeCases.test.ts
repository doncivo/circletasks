import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALDAV_APP_PASSWORD, CALDAV_USER } from '../../../tests/sim';
import type { InstantRange } from '../../db/repositories';
import type { CalendarAccountId } from '../../domain/types';
import { calendarsStore, type CalendarsState } from './calendarsStore';
import { dumpDatabaseText, setupCalendarHarness, type CalendarHarness } from './testKit';

/**
 * QA du lot K : cas limites transverses sur les simulateurs (aucun compte réel) : jeton expiré puis révoqué, réseau coupé,
 * réponses malformées (ICS), secrets dans les sorties.
 */
const wide = { from: '2026-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' } as InstantRange;
const MIN = 60_000;

let h: CalendarHarness;
const state = (): CalendarsState => calendarsStore.get(h.container).getState();
const idle = (): Promise<void> => vi.waitFor(() => expect(state().refreshing).toEqual([]));
const titles = async (): Promise<string[]> => (await h.container.data.repos.externalEvents.listBetween(wide)).map((event) => event.title).sort();

async function connectGoogle(): Promise<CalendarAccountId> {
  const outcome = await state().connectGoogle();
  if (!outcome.ok) throw new Error(`connexion refusée : ${outcome.failure}`);
  await vi.waitFor(() => expect(state().states[outcome.accountId]).toMatchObject({ kind: 'connected', lastSuccessAt: expect.any(String) as string }));
  await idle();
  return outcome.accountId;
}

async function connectIcloud(): Promise<CalendarAccountId> {
  const outcome = await state().connectIcloud(CALDAV_USER, CALDAV_APP_PASSWORD);
  if (!outcome.ok) throw new Error(`connexion refusée : ${outcome.failure}`);
  await vi.waitFor(() => expect(state().states[outcome.accountId]).toMatchObject({ kind: 'connected', lastSuccessAt: expect.any(String) as string }));
  await idle();
  return outcome.accountId;
}

beforeEach(async () => {
  h = await setupCalendarHarness('91');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

describe('K-01 critère 7 : jeton expiré puis révoqué', () => {
  it('K-01 c.7 jeton expiré : rafraîchi sans reconnexion, le compte reste « Connecté » et les événements sont relus', async () => {
    const accountId = await connectGoogle();
    const ref = `circletasks.calendar.google.${accountId}`;
    const before = h.vault.read(ref);
    h.google.expireAccessTokens();
    h.db.clock.advance(20 * MIN);
    expect(await state().refresh(accountId, 'tick')).toBe('done');
    expect(state().states[accountId]).toMatchObject({ kind: 'connected' });
    expect(h.vault.read(ref)).not.toBe(before);
    expect(await titles()).toEqual(['', 'Point client', 'Stand-up', 'Vacances']);
  });

  it('K-01 c.7 et K-03 c.6 jeton révoqué : « à reconnecter », événements conservés, aucune requête de plus sur tick, ouverture ni retour au premier plan', async () => {
    const accountId = await connectGoogle();
    h.google.revokeAll();
    h.db.clock.advance(20 * MIN);
    await state().refresh(accountId, 'tick');
    expect(state().states[accountId]).toMatchObject({ kind: 'reconnect-required' });
    expect(await titles()).toEqual(['', 'Point client', 'Stand-up', 'Vacances']);
    const requests = h.google.log.length;
    for (let i = 0; i < 5; i += 1) {
      h.db.clock.advance(16 * MIN);
      await state().refresh(accountId, 'tick');
      await state().refresh(accountId, 'open');
    }
    expect(h.google.log.length).toBe(requests);
  });
});

describe('K-03 critère 5 : réseau coupé', () => {
  it('K-03 c.5 Google injoignable : événements conservés, « Hors ligne », une seule tentative par échéance, pas de boucle', async () => {
    const accountId = await connectGoogle();
    const http = h.container.calendars.http;
    const spy = vi.spyOn(http, 'request');
    await h.google.close();
    h.db.clock.advance(20 * MIN);
    expect(await state().refresh(accountId, 'tick')).toBe('done');
    expect(state().states[accountId]).toMatchObject({ kind: 'error', error: 'network' });
    expect(await titles()).toEqual(['', 'Point client', 'Stand-up', 'Vacances']);
    const attempts = spy.mock.calls.length;
    expect(attempts).toBeLessThanOrEqual(3);
    for (let i = 0; i < 10; i += 1) {
      h.db.clock.advance(MIN);
      expect(await state().refresh(accountId, 'tick')).toBe('skipped');
    }
    expect(spy.mock.calls.length).toBe(attempts);
    expect(await titles()).toEqual(['', 'Point client', 'Stand-up', 'Vacances']);
  });

  it('K-03 c.5 iCloud injoignable : événements conservés, état « error/network », pas de boucle', async () => {
    const accountId = await connectIcloud();
    const spy = vi.spyOn(h.container.calendars.http, 'request');
    const expected = await titles();
    await h.caldav.close();
    h.db.clock.advance(20 * MIN);
    await state().refresh(accountId, 'tick');
    expect(state().states[accountId]).toMatchObject({ kind: 'error', error: 'network' });
    expect(await titles()).toEqual(expected);
    const attempts = spy.mock.calls.length;
    for (let i = 0; i < 10; i += 1) {
      h.db.clock.advance(MIN);
      await state().refresh(accountId, 'tick');
    }
    expect(spy.mock.calls.length).toBe(attempts);
  });
});

describe('K-02 / K-03 : réponse ICS malformée', () => {
  const garbageObject = { href: 'x.ics', etag: 'z', startUtc: '2026-09-24T08:00:00Z', endUtc: '2026-09-24T09:00:00Z', ics: 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:ceci-nest-pas-une-date\r\nEND:VCALENDAR' };

  it('K-03 c.3 un REPORT dont tous les objets sont illisibles ne vide pas les événements déjà en base', async () => {
    const accountId = await connectIcloud();
    const expected = await titles();
    expect(expected.length).toBeGreaterThan(0);
    h.caldav.setObjects('famille', [garbageObject]);
    h.db.clock.advance(20 * MIN);
    await state().refresh(accountId, 'manual');
    expect(await titles()).toEqual(expected);
  });

  it('K-03 c.3 un objet illisible parmi des objets valides n’empêche pas la lecture des autres', async () => {
    const accountId = await connectIcloud();
    const kept = [
      {
        href: 'ok.ics',
        etag: 'o',
        startUtc: '2026-09-25T08:00:00Z',
        endUtc: '2026-09-25T09:00:00Z',
        ics: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ok\r\nDTSTART:20260925T080000Z\r\nDTEND:20260925T090000Z\r\nSUMMARY:Valide\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
      },
    ];
    h.caldav.setObjects('famille', [garbageObject, ...kept]);
    h.db.clock.advance(20 * MIN);
    await state().refresh(accountId, 'manual');
    expect(await titles()).toEqual(['Valide']);
  });
});

describe('K-01 c.3, K-02 c.7 : aucun secret dans la base, l’état ni les sorties', () => {
  it('K-01 c.3 / K-02 c.7 connexion, rafraîchissement, révocation, reconnexion et suppression : rien dans console, base ni état', async () => {
    const out: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void out.push(args.map(String).join(' ')));

    const google = await connectGoogle();
    const icloud = await connectIcloud();
    const secrets = [h.vault.read(`circletasks.calendar.google.${google}`) ?? '', CALDAV_APP_PASSWORD, h.google.clientId];
    const refreshToken = /"refresh":"([^"]+)"/.exec(secrets[0] ?? '')?.[1] ?? '';
    const accessToken = /"access":"([^"]+)"/.exec(secrets[0] ?? '')?.[1] ?? '';
    expect(refreshToken).not.toBe('');
    expect(accessToken).not.toBe('');
    const fragments = [refreshToken, accessToken, CALDAV_APP_PASSWORD, h.google.clientId];

    h.google.revokeAll();
    h.caldav.setPassword('autre-mot-de-passe');
    h.db.clock.advance(20 * MIN);
    await state().refreshAll('manual');
    await idle();
    expect(state().states[google]).toMatchObject({ kind: 'reconnect-required' });
    expect(state().states[icloud]).toMatchObject({ kind: 'reconnect-required' });

    const snapshot = async (): Promise<string> => `${await dumpDatabaseText(h.db)}\n${JSON.stringify({ ...state(), reconnectRequest: null })}\n${out.join('\n')}`;
    let text = await snapshot();
    for (const fragment of fragments) expect(text).not.toContain(fragment);

    await state().removeAccount(google);
    await state().removeAccount(icloud);
    text = await snapshot();
    for (const fragment of fragments) expect(text).not.toContain(fragment);
    expect(h.vault.read(`circletasks.calendar.google.${google}`)).toBeNull();
    expect(h.vault.read(`circletasks.calendar.icloud.${icloud}`)).toBeNull();
  });
});
