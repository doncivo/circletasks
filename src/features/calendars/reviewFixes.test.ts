import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_ACCOUNT } from '../../../tests/sim';
import type { InstantRange } from '../../db/repositories';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { CalendarProvider, FetchEventsResult, ProviderEvent } from '../../domain/calendarProvider';
import type { CalendarAccountId, Result } from '../../domain/types';
import { calendarsStore } from './calendarsStore';
import { createGoogleProvider } from './providers/google';
import { refreshAccount, type RefreshDeps } from './refreshUseCase';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

/** Corrections de la revue du lot K : course suppression / masquage, verrou, échec de suppression du secret, pagination. */
const wide = { from: '2026-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' } as InstantRange;
const ACCOUNT = 'b0000000-0000-4000-8000-0000000000aa' as CalendarAccountId;

let h: CalendarHarness;
const store = () => calendarsStore.get(h.container);
const titles = async (): Promise<string[]> => (await h.container.data.repos.externalEvents.listBetween(wide)).map((row) => row.title).sort();
const event = (calendarId: string, id: string): ProviderEvent => ({ calendarId, externalId: id, title: id, startUtc: '2026-09-24T08:00:00Z', endUtc: '2026-09-24T09:00:00Z', allDay: false });

/** Fournisseur dont la lecture réseau « dure » : `during` s'exécute pendant l'attente, avant la réponse. */
function slowProvider(during: () => Promise<void>): CalendarProvider {
  return {
    kind: 'google',
    listCalendars: async () => ({ ok: true, value: [] }),
    fetchEvents: async (calendarId): Promise<Result<FetchEventsResult, never>> => {
      await during();
      return { ok: true, value: { kind: 'full', events: [event(calendarId, `e-${calendarId}`)], cursor: null } };
    },
  };
}

function deps(provider: CalendarProvider): RefreshDeps {
  return { container: h.container, providerFor: () => provider, timeZone: () => 'Europe/Paris', cursors: new Map() };
}

beforeEach(async () => {
  h = await setupCalendarHarness('61');
  await h.container.data.repos.calendarAccounts.create({
    id: ACCOUNT,
    provider: 'google',
    label: 'ali@example.com',
    tokenRef: 'ref',
    calendars: [
      { id: 'a', name: 'A', spaceId: SPACE_PRO_ID, shown: true },
      { id: 'b', name: 'B', spaceId: SPACE_PRO_ID, shown: true },
    ],
  });
});
afterEach(() => h.close());

describe('course entre rafraîchissement, suppression et masquage (revue, bloquant)', () => {
  it('compte supprimé pendant la lecture réseau : rien n’est réécrit, résultat « gone »', async () => {
    let deleted = false;
    const provider = slowProvider(async () => {
      if (deleted) return;
      deleted = true;
      await h.container.data.transaction(async (repos) => {
        await repos.calendarAccounts.softDelete(ACCOUNT);
        await repos.externalEvents.deleteForAccount(ACCOUNT);
      });
    });
    const result = await refreshAccount(deps(provider), ACCOUNT);
    expect(result).toMatchObject({ ok: true, gone: true });
    expect(await titles()).toEqual([]);
  });

  it('agenda masqué pendant la lecture : ses événements ne sont pas réécrits, les autres le sont', async () => {
    let hidden = false;
    const provider = slowProvider(async () => {
      if (hidden) return;
      hidden = true;
      const current = await h.container.data.repos.calendarAccounts.getById(ACCOUNT);
      await h.container.data.repos.calendarAccounts.updateCalendars(ACCOUNT, current?.calendars.map((calendar) => (calendar.id === 'b' ? { ...calendar, shown: false } : calendar)) ?? []);
    });
    const result = await refreshAccount(deps(provider), ACCOUNT);
    expect(result.ok).toBe(true);
    expect(await titles()).toEqual(['e-a']);
  });

  it('store : un compte supprimé pendant son rafraîchissement ne laisse ni état, ni événement, ni verrou', async () => {
    const outcome = await store().getState().connectGoogle();
    if (!outcome.ok) throw new Error('connexion');
    await vi.waitFor(() => expect(store().getState().refreshing).toEqual([]));
    // Le transport est retenu à la lecture des événements : le compte est supprimé pendant ce temps.
    const http = h.container.calendars.http;
    const original = http.request.bind(http);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    vi.spyOn(http, 'request').mockImplementation(async (request) => {
      if (request.url.includes('/events') && !held) {
        held = true;
        await gate;
      }
      return original(request);
    });
    h.db.clock.advance(60_000);
    const refreshing = store().getState().refresh(outcome.accountId, 'manual');
    await vi.waitFor(() => expect(held).toBe(true));
    expect(await store().getState().removeAccount(outcome.accountId)).toBe(true);
    release();
    await refreshing;
    expect(store().getState().states[outcome.accountId]).toBeUndefined();
    expect(store().getState().refreshing).toEqual([]);
    expect(await titles()).toEqual([]);
  });
});

describe('verrou posé avant toute attente (revue)', () => {
  it('trois rafraîchissements lancés ensemble sur un compte sans état connu : un seul passe', async () => {
    const outcome = await store().getState().connectGoogle();
    if (!outcome.ok) throw new Error('connexion');
    await vi.waitFor(() => expect(store().getState().refreshing).toEqual([]));
    // Effacer l'état local force la relecture du coffre (attente) avant la décision.
    store().setState({ states: {} });
    h.db.clock.advance(60_000);
    const before = h.google.log.filter((line) => line.includes('/events')).length;
    const runs = await Promise.all([store().getState().refresh(outcome.accountId, 'manual'), store().getState().refresh(outcome.accountId, 'manual'), store().getState().refresh(outcome.accountId, 'manual')]);
    expect(runs.filter((run) => run === 'done')).toHaveLength(1);
    expect(h.google.log.filter((line) => line.includes('/events')).length - before).toBe(2);
  });
});

describe('suppression du secret (revue sécurité)', () => {
  it('coffre qui refuse d’effacer : le compte est conservé et l’échec signalé ; la nouvelle tentative réussit', async () => {
    const outcome = await store().getState().connectGoogle();
    if (!outcome.ok) throw new Error('connexion');
    await vi.waitFor(() => expect(store().getState().refreshing).toEqual([]));
    const revoke = vi.spyOn(h.container.calendars.oauth, 'revokeGoogle').mockRejectedValue(new Error('coffre indisponible'));
    expect(await store().getState().removeAccount(outcome.accountId)).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(store().getState().messageKey).toBe('calendars.errorRemoveSecret');
    expect(await h.container.data.repos.calendarAccounts.getById(outcome.accountId)).not.toBeNull();
    revoke.mockRestore();
    expect(await store().getState().removeAccount(outcome.accountId)).toBe(true);
    expect(await h.container.data.repos.calendarAccounts.getById(outcome.accountId)).toBeNull();
  });
});

describe('pagination Google bornée (revue)', () => {
  const page = (token: string) => ({ status: 200, headers: {}, body: JSON.stringify({ items: [], nextPageToken: token }) });
  const endpoints = { googleApiBase: 'https://www.googleapis.com/calendar/v3' } as never;

  it('un jeton de page répété ou une liste sans fin : erreur « malformed », pas de boucle', async () => {
    let calls = 0;
    const looping = createGoogleProvider({ request: async () => (calls++, page('toujours-le-meme')) }, endpoints, 'r');
    expect(await looping.listCalendars()).toEqual({ ok: false, error: { kind: 'malformed' } });
    expect(calls).toBe(2);
    let events = 0;
    const endless = createGoogleProvider({ request: async () => page(`p${String(events++)}`) }, endpoints, 'r');
    expect(await endless.fetchEvents(GOOGLE_ACCOUNT, { fromUtc: '2026-01-01T00:00:00Z' as never, toUtc: '2027-01-01T00:00:00Z' as never }, null)).toEqual({ ok: false, error: { kind: 'malformed' } });
    expect(events).toBeLessThanOrEqual(51);
  });
});
