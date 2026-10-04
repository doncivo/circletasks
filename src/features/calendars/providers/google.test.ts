import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GOOGLE_CALENDARS, DEFAULT_GOOGLE_EVENTS, GOOGLE_ACCOUNT, startCaldavSim, startGoogleSim, type GoogleSimEvent, type GoogleSimOptions } from '../../../../tests/sim';
import type { CalendarProvider, FetchRange } from '../../../domain/calendarProvider';
import { createMemoryCalendarPlatform, simulatorEndpoints, type CalendarPlatform } from '../../../platform/calendars';
import { createGoogleProvider, parseGoogleEvent } from './google';

interface Sims {
  google: Awaited<ReturnType<typeof startGoogleSim>>;
  caldav: Awaited<ReturnType<typeof startCaldavSim>>;
  close(): Promise<void>;
}
let sims: Sims;
let platform: CalendarPlatform;
let provider: CalendarProvider;

const range: FetchRange = { fromUtc: '2026-08-01T00:00:00Z' as never, toUtc: '2027-01-01T00:00:00Z' as never };

async function setup(googleOptions: GoogleSimOptions = {}): Promise<void> {
  const google = await startGoogleSim(googleOptions);
  const caldav = await startCaldavSim();
  sims = { google, caldav, close: async () => void (await Promise.all([google.close(), caldav.close()])) };
  platform = createMemoryCalendarPlatform(simulatorEndpoints(google.baseUrl, caldav.baseUrl), { googleClientId: google.clientId });
  await platform.oauth.authorizeGoogle('ref-google');
  provider = createGoogleProvider(platform.http, platform.endpoints, 'ref-google');
}

beforeEach(() => setup());
afterEach(() => sims.close());

describe('fournisseur Google (K-01, K-03)', () => {
  it('liste les agendas avec nom, couleur et agenda principal (adresse du compte)', async () => {
    const result = await provider.listCalendars();
    expect(result).toEqual({
      ok: true,
      value: [
        { id: GOOGLE_ACCOUNT, name: 'Travail', color: '#3F6FB5', primary: true },
        { id: 'famille@group.calendar.google.com', name: 'Famille', color: '#B5483B', primary: false },
      ],
    });
  });

  it('lit les instants UTC, les journées entières (fin exclue), les instances de séries, sans les annulés', async () => {
    const result = await provider.fetchEvents(GOOGLE_ACCOUNT, range, null);
    expect(result.ok && result.value.kind === 'full' && result.value.cursor).toBe(null);
    const events = result.ok && result.value.kind === 'full' ? result.value.events : [];
    expect(events.map((event) => event.externalId).sort()).toEqual(['point-client', 'standup_20260921T070000Z']);
    expect(events.find((event) => event.externalId === 'point-client')).toEqual({
      calendarId: GOOGLE_ACCOUNT,
      externalId: 'point-client',
      title: 'Point client',
      startUtc: '2026-09-23T08:00:00Z',
      endUtc: '2026-09-23T09:00:00Z',
      allDay: false,
    });
    const family = await provider.fetchEvents('famille@group.calendar.google.com', range, null);
    const familyEvents = family.ok && family.value.kind === 'full' ? family.value.events : [];
    expect(familyEvents.find((event) => event.externalId === 'vacances')).toMatchObject({ allDay: true, startUtc: '2026-10-19', endUtc: '2026-10-24' });
    expect(familyEvents.find((event) => event.externalId === 'sans-titre')).toMatchObject({ title: '' });
  });

  it('suit la pagination', async () => {
    await sims.close();
    const many: GoogleSimEvent[] = Array.from({ length: 7 }, (_, index) => ({ calendarId: GOOGLE_ACCOUNT, id: `e${String(index)}`, status: 'confirmed', summary: `E${String(index)}`, start: { dateTime: `2026-09-2${String(index)}T08:00:00Z` }, end: { dateTime: `2026-09-2${String(index)}T09:00:00Z` } }));
    await setup({ events: many, pageSize: 3 });
    const result = await provider.fetchEvents(GOOGLE_ACCOUNT, range, null);
    expect(result.ok && result.value.kind === 'full' ? result.value.events : []).toHaveLength(7);
    expect(sims.google.log.filter((line) => line.startsWith('GET /calendar/v3/calendars')).length).toBe(3);
  });

  it('ne fait que des GET : aucune écriture vers Google (critère 9)', async () => {
    await provider.listCalendars();
    await provider.fetchEvents(GOOGLE_ACCOUNT, range, null);
    expect(sims.google.log.every((line) => line.startsWith('GET ') || line === 'POST /token')).toBe(true);
    expect(sims.google.log.some((line) => /^(PUT|PATCH|DELETE)/.test(line))).toBe(false);
  });

  it('401 après révocation : unauthorized', async () => {
    sims.google.revokeAll();
    expect(await provider.listCalendars()).toEqual({ ok: false, error: { kind: 'unauthorized' } });
  });

  it('429 avec Retry-After : délai du serveur en millisecondes', async () => {
    sims.google.failNext({ status: 429, retryAfterSeconds: 42, pathPrefix: '/calendar' });
    expect(await provider.fetchEvents(GOOGLE_ACCOUNT, range, null)).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: 42_000 } });
  });

  it('5xx : server ; 403 : agenda refusé ; 404 et 410 : introuvable ; agenda inconnu : introuvable', async () => {
    sims.google.failNext({ status: 503, pathPrefix: '/calendar' });
    expect(await provider.fetchEvents(GOOGLE_ACCOUNT, range, null)).toEqual({ ok: false, error: { kind: 'server', status: 503 } });
    sims.google.failNext({ status: 403, pathPrefix: '/calendar' });
    expect(await provider.fetchEvents(GOOGLE_ACCOUNT, range, null)).toEqual({ ok: false, error: { kind: 'forbidden' } });
    sims.google.failNext({ status: 410, pathPrefix: '/calendar' });
    expect(await provider.fetchEvents(GOOGLE_ACCOUNT, range, null)).toEqual({ ok: false, error: { kind: 'not-found' } });
    expect(await provider.fetchEvents('inconnu', range, null)).toEqual({ ok: false, error: { kind: 'not-found' } });
  });

  it('simulateur injoignable : network ; réponse illisible : malformed', async () => {
    const broken = createGoogleProvider({ request: async () => ({ status: 200, headers: {}, body: '<html>' }) }, platform.endpoints, 'ref-google');
    expect(await broken.listCalendars()).toEqual({ ok: false, error: { kind: 'malformed' } });
    expect(await broken.fetchEvents(GOOGLE_ACCOUNT, range, null)).toEqual({ ok: false, error: { kind: 'malformed' } });
    await sims.close();
    expect(await provider.listCalendars()).toEqual({ ok: false, error: { kind: 'network' } });
    await setup();
  });

  it('un 403 de quota (rateLimitExceeded) est un 429', async () => {
    const quota = createGoogleProvider({ request: async () => ({ status: 403, headers: {}, body: JSON.stringify({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }) }) }, platform.endpoints, 'ref');
    expect(await quota.listCalendars()).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: null } });
  });

  it('jeu par défaut du simulateur', () => {
    expect(DEFAULT_GOOGLE_CALENDARS).toHaveLength(2);
    expect(DEFAULT_GOOGLE_EVENTS.length).toBeGreaterThan(3);
  });
});

describe('parseGoogleEvent', () => {
  it('ignore un événement annulé, sans début ou sans identifiant ; garde les décalages horaires en UTC', () => {
    expect(parseGoogleEvent('c', { id: 'a', status: 'cancelled', start: { date: '2026-09-23' } })).toBeNull();
    expect(parseGoogleEvent('c', { id: 'a', start: {} })).toBeNull();
    expect(parseGoogleEvent('c', { start: { date: '2026-09-23' } })).toBeNull();
    expect(parseGoogleEvent('c', 'texte')).toBeNull();
    expect(parseGoogleEvent('c', { id: 'a', summary: 'x', start: { dateTime: '2026-09-23T10:00:00+02:00' }, end: { dateTime: '2026-09-23T11:30:00+02:00' } })).toMatchObject({ startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:30:00Z', allDay: false });
  });

  it('une journée entière sans fin, ou une fin incohérente, garde endUtc à null', () => {
    expect(parseGoogleEvent('c', { id: 'a', start: { date: '2026-09-23' } })).toMatchObject({ allDay: true, endUtc: null });
    expect(parseGoogleEvent('c', { id: 'a', start: { date: '2026-09-23' }, end: { dateTime: '2026-09-23T10:00:00Z' } })).toMatchObject({ endUtc: null });
  });
});
