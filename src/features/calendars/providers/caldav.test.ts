import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALDAV_APP_PASSWORD, CALDAV_USER, startCaldavSim, startGoogleSim, type CaldavSim, type GoogleSim } from '../../../../tests/sim';
import type { CalendarProvider, FetchRange, ProviderEvent } from '../../../domain/calendarProvider';
import { createMemoryCalendarPlatform, simulatorEndpoints, type CalendarPlatform } from '../../../platform/calendars';
import { createCaldavProvider } from './caldav';

let google: GoogleSim;
let caldav: CaldavSim;
let platform: CalendarPlatform;
let provider: CalendarProvider;
let timeZone = 'Europe/Paris';

const range: FetchRange = { fromUtc: '2026-08-01T00:00:00Z' as never, toUtc: '2027-01-01T00:00:00Z' as never };

async function setup(): Promise<void> {
  google = await startGoogleSim();
  caldav = await startCaldavSim();
  platform = createMemoryCalendarPlatform(simulatorEndpoints(google.baseUrl, caldav.baseUrl));
  await platform.vault.set('ref-icloud', CALDAV_APP_PASSWORD);
  provider = createCaldavProvider(platform.http, platform.endpoints, 'ref-icloud', CALDAV_USER, { timeZone: () => timeZone });
}

beforeEach(async () => {
  timeZone = 'Europe/Paris';
  await setup();
});
afterEach(async () => {
  await Promise.all([google.close(), caldav.close()]);
});

const eventsOf = (result: Awaited<ReturnType<CalendarProvider['fetchEvents']>>): ProviderEvent[] => (result.ok && result.value.kind === 'full' ? [...result.value.events] : []);

describe('fournisseur CalDAV iCloud (K-02, K-03)', () => {
  it('découvre le principal puis le dossier des agendas, et ne liste que les agendas d’événements (critère 4)', async () => {
    const result = await provider.listCalendars();
    expect(result).toEqual({ ok: true, value: [{ id: '/1234567/calendars/famille/', name: 'Famille', color: '#B5483B', primary: false }] });
    expect(caldav.log.slice(0, 4)).toEqual(['PROPFIND /.well-known/caldav', 'PROPFIND /', 'PROPFIND /1234567/principal/', 'PROPFIND /1234567/calendars/']);
  });

  it('lit les événements en UTC : TZID, flottant, journée entière, séries développées, sans annulé ni titre (critère 5)', async () => {
    const result = await provider.fetchEvents('/1234567/calendars/famille/', range, null);
    expect(result.ok && result.value.kind === 'full' && result.value.cursor).toMatch(/^sim-ctag-1\|2026-08-01\.\.2027-01-01$/);
    expect(eventsOf(result).map((event) => [event.externalId, event.title, event.startUtc, event.endUtc, event.allDay])).toEqual([
      ['diner-1', 'Dîner chez Leïla', '2026-09-24T17:00:00Z', '2026-09-24T19:00:00Z', false],
      ['flottant-1', 'Marché', '2026-09-26T07:30:00Z', '2026-09-26T08:30:00Z', false],
      ['weekend-1', 'Week-end à Tunis', '2026-09-27', '2026-09-30', true],
      ['piscine#20260922T160000Z', 'Piscine', '2026-09-22T16:00:00Z', '2026-09-22T17:00:00Z', false],
      ['piscine#20260929T160000Z', 'Piscine', '2026-09-29T16:00:00Z', '2026-09-29T17:00:00Z', false],
      ['sans-titre-1', '', '2026-10-01T12:00:00Z', '2026-10-01T13:00:00Z', false],
    ]);
  });

  it('l’heure flottante suit le fuseau de l’appareil', async () => {
    timeZone = 'America/New_York';
    const flottant = eventsOf(await provider.fetchEvents('/1234567/calendars/famille/', range, null)).find((event) => event.externalId === 'flottant-1');
    expect(flottant?.startUtc).toBe('2026-09-26T13:30:00Z');
  });

  it('ctag inchangé : aucune lecture des événements (K-03 D1) ; ctag changé ou fenêtre glissée : relecture', async () => {
    const first = await provider.fetchEvents('/1234567/calendars/famille/', range, null);
    const cursor = first.ok && first.value.kind === 'full' ? first.value.cursor : null;
    caldav.log.length = 0;
    expect(await provider.fetchEvents('/1234567/calendars/famille/', range, cursor)).toEqual({ ok: true, value: { kind: 'unchanged', cursor } });
    expect(caldav.log.some((line) => line.startsWith('REPORT'))).toBe(false);

    const slid = { fromUtc: '2026-08-02T00:00:00Z', toUtc: '2027-01-02T00:00:00Z' } as FetchRange;
    expect((await provider.fetchEvents('/1234567/calendars/famille/', slid, cursor)).ok && caldav.log.some((line) => line.startsWith('REPORT'))).toBe(true);

    caldav.setObjects('famille', []);
    const changed = await provider.fetchEvents('/1234567/calendars/famille/', range, cursor);
    expect(changed.ok && changed.value.kind).toBe('full');
    expect(eventsOf(changed)).toEqual([]);
  });

  it('401 : unauthorized ; mot de passe révoqué ensuite : unauthorized', async () => {
    await platform.vault.set('ref-icloud', 'mauvais');
    expect(await provider.listCalendars()).toEqual({ ok: false, error: { kind: 'unauthorized' } });
    await platform.vault.delete('ref-icloud');
    expect(await provider.listCalendars()).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });

  it('403, 404, 429, 5xx et serveur injoignable sont rangés par type', async () => {
    const id = '/1234567/calendars/famille/';
    caldav.failNext({ status: 403, pathPrefix: '/1234567/calendars/famille' });
    expect(await provider.fetchEvents(id, range, null)).toEqual({ ok: false, error: { kind: 'forbidden' } });
    expect(await provider.fetchEvents('/1234567/calendars/inconnu/', range, null)).toEqual({ ok: false, error: { kind: 'not-found' } });
    caldav.failNext({ status: 429, retryAfterSeconds: 7, pathPrefix: '/1234567/calendars/famille' });
    expect(await provider.fetchEvents(id, range, null)).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: 7000 } });
    caldav.failNext({ status: 502, pathPrefix: '/1234567/calendars/famille' });
    expect(await provider.fetchEvents(id, range, null)).toEqual({ ok: false, error: { kind: 'server', status: 502 } });
    await caldav.close();
    expect(await provider.fetchEvents(id, range, null)).toEqual({ ok: false, error: { kind: 'network' } });
    caldav = await startCaldavSim();
  });

  it('une réponse qui n’est pas du XML : malformed ; une découverte qui échoue est retentée', async () => {
    const garbage = createCaldavProvider({ request: async () => ({ status: 207, headers: {}, body: 'pas du xml' }) }, platform.endpoints, 'ref', 'u', { timeZone: () => timeZone });
    expect(await garbage.listCalendars()).toEqual({ ok: false, error: { kind: 'malformed' } });
    caldav.failNext({ status: 503, pathPrefix: '/' });
    expect((await provider.listCalendars()).ok).toBe(false);
    expect((await provider.listCalendars()).ok).toBe(true);
  });

  it('ne fait que des PROPFIND et des REPORT : aucune écriture (critère 8)', async () => {
    await provider.listCalendars();
    await provider.fetchEvents('/1234567/calendars/famille/', range, null);
    expect(caldav.log.every((line) => line.startsWith('PROPFIND ') || line.startsWith('REPORT '))).toBe(true);
  });
});
