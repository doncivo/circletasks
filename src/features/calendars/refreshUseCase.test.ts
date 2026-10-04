import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstantRange, Repositories } from '../../db/repositories';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { CalendarProvider, FetchEventsResult, FetchRange, ProviderError, ProviderEvent } from '../../domain/calendarProvider';
import type { CalendarAccountId, Result } from '../../domain/types';
import { refreshAccount, type RefreshDeps } from './refreshUseCase';
import { setupCalendarHarness, type CalendarHarness } from './testKit';

const wide = { from: '2026-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' } as InstantRange;
const ACCOUNT = 'b0000000-0000-4000-8000-000000000001' as CalendarAccountId;

let h: CalendarHarness;
let results: Record<string, Result<FetchEventsResult, ProviderError>>;
const requested: { calendarId: string; cursor: string | null }[] = [];

const provider: CalendarProvider = {
  kind: 'google',
  listCalendars: async () => ({ ok: true, value: [] }),
  fetchEvents: async (calendarId: string, _range: FetchRange, cursor) => {
    requested.push({ calendarId, cursor });
    return results[calendarId] ?? { ok: true, value: { kind: 'full', events: [], cursor: null } };
  },
};

const event = (calendarId: string, id: string, title = id): ProviderEvent => ({ calendarId, externalId: id, title, startUtc: '2026-09-24T08:00:00Z', endUtc: '2026-09-24T09:00:00Z', allDay: false });
const full = (...events: ProviderEvent[]): Result<FetchEventsResult, ProviderError> => ({ ok: true, value: { kind: 'full', events, cursor: 'c1' } });

function deps(overrides: Partial<RefreshDeps> = {}): RefreshDeps {
  return { container: h.container, providerFor: () => provider, timeZone: () => 'Europe/Paris', cursors: new Map(), ...overrides };
}

const titles = async (): Promise<string[]> => (await h.container.data.repos.externalEvents.listBetween(wide)).map((row) => row.title).sort();

beforeEach(async () => {
  h = await setupCalendarHarness('41');
  results = {};
  requested.length = 0;
  await h.container.data.repos.calendarAccounts.create({
    id: ACCOUNT,
    provider: 'google',
    label: 'ali@example.com',
    tokenRef: 'ref',
    calendars: [
      { id: 'a', name: 'A', spaceId: SPACE_PRO_ID, shown: true },
      { id: 'b', name: 'B', spaceId: SPACE_PRO_ID, shown: true },
      { id: 'hidden', name: 'Masqué', spaceId: SPACE_PRO_ID, shown: false },
    ],
  });
});
afterEach(() => h.close());

describe('refreshAccount (K-01 critère 6, K-03)', () => {
  it('lit les seuls agendas affichés, écrit tout, vide les agendas masqués et rend la date de réussite', async () => {
    await h.container.data.repos.externalEvents.replaceWindow(ACCOUNT, 'hidden', [{ ...(await baseRow('hidden', 'old')) }], wide);
    results = { a: full(event('a', 'a1', 'Un')), b: full(event('b', 'b1', 'Deux')) };
    const outcome = await refreshAccount(deps(), ACCOUNT);
    expect(outcome).toEqual({ ok: true, at: expect.any(String) as string });
    expect(requested.map((entry) => entry.calendarId)).toEqual(['a', 'b']);
    expect(await titles()).toEqual(['Deux', 'Un']);
  });

  it('un 401, un 429 ou une panne arrête le compte entier sans rien écrire (l’ancien état reste)', async () => {
    await h.container.data.repos.externalEvents.replaceWindow(ACCOUNT, 'a', [await baseRow('a', 'ancien')], wide);
    for (const error of [{ kind: 'unauthorized' }, { kind: 'rate-limited', retryAfterMs: 5000 }, { kind: 'server', status: 500 }, { kind: 'network' }] as ProviderError[]) {
      results = { a: full(event('a', 'a1', 'Nouveau')), b: { ok: false, error } };
      const outcome = await refreshAccount(deps(), ACCOUNT);
      expect(outcome).toMatchObject({ ok: false, error });
      expect(await titles()).toEqual(['ancien']);
    }
  });

  it('un agenda refusé, introuvable ou illisible est ignoré : les autres sont écrits, l’ancien contenu du refusé reste', async () => {
    await h.container.data.repos.externalEvents.replaceWindow(ACCOUNT, 'b', [await baseRow('b', 'garde')], wide);
    for (const kind of ['forbidden', 'not-found', 'malformed'] as const) {
      results = { a: full(event('a', 'a1', `Lu ${kind}`)), b: { ok: false, error: { kind } } };
      expect((await refreshAccount(deps(), ACCOUNT)).ok).toBe(true);
      expect(await titles()).toEqual([`Lu ${kind}`, 'garde']);
    }
  });

  it('transaction : un échec d’écriture au milieu annule tout et ne change pas l’état du compte (K-03 critère 3)', async () => {
    await h.container.data.repos.externalEvents.replaceWindow(ACCOUNT, 'a', [await baseRow('a', 'ancien')], wide);
    results = { a: full(event('a', 'a1', 'Nouveau A')), b: full(event('b', 'b1', 'Nouveau B')) };
    let writes = 0;
    const failing = {
      ...h.container,
      data: {
        ...h.container.data,
        transaction: <T,>(work: (repos: Repositories) => Promise<T>) =>
          h.container.data.transaction((repos) =>
            work({
              ...repos,
              externalEvents: {
                ...repos.externalEvents,
                replaceWindow: async (...args: Parameters<Repositories['externalEvents']['replaceWindow']>) => {
                  writes += 1;
                  if (writes === 2) throw new Error('disque plein');
                  await repos.externalEvents.replaceWindow(...args);
                },
              },
            }),
          ),
      },
    };
    const outcome = await refreshAccount(deps({ container: failing }), ACCOUNT);
    expect(outcome).toMatchObject({ ok: false, error: { kind: 'malformed' } });
    expect(writes).toBe(2);
    expect(await titles()).toEqual(['ancien']);
  });

  it('curseur : transmis au fournisseur, mémorisé après une lecture complète, conservé si rien n’a changé, oublié pour un agenda masqué', async () => {
    const cursors = new Map<string, string | null>();
    results = { a: full(event('a', 'a1')), b: full() };
    await refreshAccount(deps({ cursors }), ACCOUNT);
    expect(cursors.get(`${ACCOUNT}|a`)).toBe('c1');
    results = { a: { ok: true, value: { kind: 'unchanged', cursor: 'c1' } }, b: full() };
    requested.length = 0;
    await refreshAccount(deps({ cursors }), ACCOUNT);
    expect(requested.find((entry) => entry.calendarId === 'a')?.cursor).toBe('c1');
    expect(await titles()).toEqual(['a1']);
    cursors.set(`${ACCOUNT}|hidden`, 'x');
    await refreshAccount(deps({ cursors }), ACCOUNT);
    expect(cursors.has(`${ACCOUNT}|hidden`)).toBe(false);
  });

  it('compte supprimé entre-temps : rien à faire', async () => {
    await h.container.data.repos.calendarAccounts.softDelete(ACCOUNT);
    expect(await refreshAccount(deps(), ACCOUNT)).toMatchObject({ ok: true });
    expect(requested).toEqual([]);
  });

  it('500 événements : le cas d’usage (analyse déjà faite, hors réseau) dure moins de 500 ms (K-03 critère 10)', async () => {
    const events = Array.from({ length: 500 }, (_, index) => ({ ...event('a', `e${String(index)}`, `Événement ${String(index)}`), startUtc: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString().replace('.000Z', 'Z'), endUtc: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000 + 1_800_000).toISOString().replace('.000Z', 'Z') }));
    results = { a: full(...events), b: full() };
    await refreshAccount(deps(), ACCOUNT);
    const started = performance.now();
    const outcome = await refreshAccount(deps(), ACCOUNT);
    expect(performance.now() - started).toBeLessThan(500);
    expect(outcome.ok).toBe(true);
    expect(await h.container.data.repos.externalEvents.listBetween(wide)).toHaveLength(500);
  });
});

async function baseRow(calendarId: string, externalId: string) {
  const { externalEventRowId, toExternalEvents } = await import('../../domain/calendarProvider');
  const [row] = toExternalEvents(ACCOUNT, [event(calendarId, externalId, externalId)], '2026-09-23T10:00:00.000Z' as never);
  return { ...(row as NonNullable<typeof row>), id: externalEventRowId(ACCOUNT, calendarId, externalId) };
}
