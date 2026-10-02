import { describe, expect, it } from 'vitest';
import { externalEventSpan, externalEventsByDay, externalEventVisible } from './externalEvents';
import type { CalendarAccount, ExternalEvent } from './model';
import { asEntityId, asLocalDate, type CalendarAccountId, type ExternalEventId, type SpaceId } from './types';
import { buildWeek, weekDays } from './week';

const PRO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('10000000-0000-4000-8000-000000000002');
const WEEK = asLocalDate('2026-09-21');
const DAYS = weekDays(WEEK);

const account = (over: Partial<CalendarAccount> = {}): CalendarAccount =>
  ({
    id: 'acc' as CalendarAccountId,
    provider: 'google',
    label: 'Google Agenda',
    tokenRef: '',
    calendars: [{ id: 'pro', name: 'Travail', spaceId: PRO, shown: true }],
    deletedAt: null,
    ...over,
  }) as unknown as CalendarAccount;

const event = (id: string, over: Partial<ExternalEvent> = {}): ExternalEvent =>
  ({ id: id as ExternalEventId, accountId: 'acc' as CalendarAccountId, calendarId: 'pro', externalId: `ext-${id}`, title: id, startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z', allDay: false, ...over }) as ExternalEvent;

const byDay = (events: ExternalEvent[], over: { timeZone?: string; filter?: SpaceId | 'all'; accounts?: CalendarAccount[] } = {}) =>
  externalEventsByDay({ days: DAYS, events, accounts: over.accounts ?? [account()], timeZone: over.timeZone ?? 'Europe/Paris', filter: over.filter ?? 'all' });

describe('externalEventsByDay (S-05 critères 1, 4, 5, 6)', () => {
  it('place l’événement du 23 sept. 08:00Z le mer. 23 à « 10:00 » en Europe/Paris, avec le nom de la source (critère 1)', () => {
    const days = byDay([event('Point client')]);
    expect(days.get(asLocalDate('2026-09-23'))).toEqual([
      { id: 'Point client', title: 'Point client', allDay: false, startTime: '10:00', spaceId: null, calendarName: 'Google Agenda', icon: null, startInstant: '2026-09-23T08:00:00Z' },
    ]);
    expect([...days.keys()]).toEqual(['2026-09-23']);
  });

  it('recalcule l’heure et le jour au changement de fuseau, sans relire la base (dette T-11)', () => {
    const events = [event('Point client'), event('Tard', { startUtc: '2026-09-23T22:30:00Z', endUtc: '2026-09-23T23:00:00Z' })];
    const paris = byDay(events, { timeZone: 'Europe/Paris' });
    expect(paris.get(asLocalDate('2026-09-23'))?.map((e) => [e.title, e.startTime])).toEqual([['Point client', '10:00']]);
    expect(paris.get(asLocalDate('2026-09-24'))?.map((e) => [e.title, e.startTime])).toEqual([['Tard', '00:30']]);
    const tunis = byDay(events, { timeZone: 'Africa/Tunis' });
    expect(tunis.get(asLocalDate('2026-09-23'))?.map((e) => [e.title, e.startTime])).toEqual([['Point client', '09:00'], ['Tard', '23:30']]);
    const newYork = byDay(events, { timeZone: 'America/New_York' });
    expect(newYork.get(asLocalDate('2026-09-23'))?.map((e) => [e.title, e.startTime])).toEqual([['Point client', '04:00'], ['Tard', '18:30']]);
  });

  it('une journée entière reste sur sa date, sans décalage de fuseau, et sans heure (critère 4)', () => {
    const conge = event('Congé', { allDay: true, startUtc: '2026-09-23T00:00:00Z', endUtc: '2026-09-24T00:00:00Z' });
    for (const timeZone of ['Europe/Paris', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const days = byDay([conge], { timeZone });
      expect([...days.keys()]).toEqual(['2026-09-23']);
      expect(days.get(asLocalDate('2026-09-23'))?.[0]).toMatchObject({ allDay: true, startTime: null });
    }
  });

  it('un événement de plusieurs jours s’affiche sur chaque jour couvert de la semaine (critère 5)', () => {
    const voyage = event('Voyage', { startUtc: '2026-09-24T07:00:00Z', endUtc: '2026-09-26T16:00:00Z' });
    const days = byDay([voyage]);
    expect([...days.keys()]).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    expect(days.get(asLocalDate('2026-09-24'))?.[0]).toMatchObject({ allDay: false, startTime: '09:00' });
    expect(days.get(asLocalDate('2026-09-25'))?.[0]).toMatchObject({ allDay: true, startTime: null });
    expect(days.get(asLocalDate('2026-09-26'))?.[0]).toMatchObject({ allDay: true });
  });

  it('une journée entière de plusieurs jours exclut sa date de fin ; un événement qui finit à minuit pile ne déborde pas', () => {
    const conges = event('Congés', { allDay: true, startUtc: '2026-09-25T00:00:00Z', endUtc: '2026-09-28T00:00:00Z' });
    expect([...byDay([conges]).keys()]).toEqual(['2026-09-25', '2026-09-26', '2026-09-27']);
    const soiree = event('Soirée', { startUtc: '2026-09-25T18:00:00Z', endUtc: '2026-09-25T22:00:00Z' });
    expect([...byDay([soiree]).keys()]).toEqual(['2026-09-25']);
    const jusqueMinuit = event('Jusqu’à minuit', { startUtc: '2026-09-25T10:00:00Z', endUtc: '2026-09-25T22:00:00Z' }); // minuit local à Paris
    expect([...byDay([jusqueMinuit]).keys()]).toEqual(['2026-09-25']);
  });

  it('un événement qui déborde de la semaine n’est affiché que sur les jours de la semaine', () => {
    const long = event('Long', { allDay: true, startUtc: '2026-09-18T00:00:00Z', endUtc: '2026-10-05T00:00:00Z' });
    expect([...byDay([long]).keys()]).toEqual(DAYS);
    expect(byDay([event('Après', { startUtc: '2026-09-29T08:00:00Z', endUtc: '2026-09-29T09:00:00Z' })]).size).toBe(0);
    expect(byDay([event('Avant', { startUtc: '2026-09-18T08:00:00Z', endUtc: '2026-09-18T09:00:00Z' })]).size).toBe(0);
  });

  it('une fin absente affiche l’événement sur son seul jour de début', () => {
    expect([...byDay([event('Rappel', { endUtc: null })]).keys()]).toEqual(['2026-09-23']);
  });

  it('trie plusieurs événements du jour : journée entière d’abord, puis par heure de début, en tête devant les tâches (critères 1, 6)', () => {
    const events = [
      event('Tard', { startUtc: '2026-09-23T15:00:00Z', endUtc: '2026-09-23T16:00:00Z' }),
      event('Tôt', { startUtc: '2026-09-23T06:00:00Z', endUtc: '2026-09-23T07:00:00Z' }),
      event('Journée', { allDay: true, startUtc: '2026-09-23T00:00:00Z', endUtc: '2026-09-24T00:00:00Z' }),
    ];
    const week = buildWeek({ weekStart: WEEK, filter: 'all', tasks: [], externalEvents: byDay(events) });
    expect(week[2]?.list.events.map((e) => e.title)).toEqual(['Journée', 'Tôt', 'Tard']);
    expect(week[2]?.list.isEmpty).toBe(false);
  });

  it('au recul d’heure, deux événements à 02:30 sortent dans l’ordre chronologique (CEST puis CET), puis par id', () => {
    // Nuit du 25 au 26 octobre 2026 à Paris : 02:30 existe deux fois (00:30Z en CEST, 01:30Z en CET).
    const week = asLocalDate('2026-10-19');
    const events = [
      event('b-cet', { startUtc: '2026-10-25T01:30:00Z', endUtc: '2026-10-25T02:00:00Z' }),
      event('a-cest', { startUtc: '2026-10-25T00:30:00Z', endUtc: '2026-10-25T01:00:00Z' }),
      event('z-cet', { startUtc: '2026-10-25T01:10:00Z', endUtc: '2026-10-25T01:20:00Z' }),
    ];
    const days = externalEventsByDay({ days: weekDays(week), events, accounts: [account()], timeZone: 'Europe/Paris', filter: 'all' });
    const list = buildWeek({ weekStart: week, filter: 'all', tasks: [], externalEvents: days })[6]?.list.events ?? [];
    expect(list.map((e) => [e.id, e.startTime])).toEqual([['a-cest', '02:30'], ['z-cet', '02:10'], ['b-cet', '02:30']]);
  });

  it('un instant ou un fuseau illisible n’empêche pas l’affichage : l’événement est rangé sans heure (T-11)', () => {
    const days = byDay([event('Point client')], { timeZone: 'Pas/UnFuseau' });
    expect(days.get(asLocalDate('2026-09-23'))?.[0]).toMatchObject({ title: 'Point client', allDay: true, startTime: null });
    expect(byDay([event('Cassé', { startUtc: 'n’importe quoi' })]).size).toBe(0);
  });
});

describe('filtre d’espace des événements externes (S-05 critère 7)', () => {
  const calendars = [
    { id: 'pro', name: 'Travail', spaceId: PRO, shown: true },
    { id: 'perso', name: 'Famille', spaceId: PERSO, shown: true },
    { id: 'libre', name: 'Libre', spaceId: null, shown: true },
    { id: 'cache', name: 'Caché', spaceId: PRO, shown: false },
  ];
  const events = [
    event('Pro', { calendarId: 'pro' }),
    event('Perso', { calendarId: 'perso' }),
    event('Libre', { calendarId: 'libre' }),
    event('Caché', { calendarId: 'cache' }),
    event('Inconnu', { calendarId: 'absent' }),
  ];
  const titles = (filter: SpaceId | 'all') =>
    (byDay(events, { filter, accounts: [account({ calendars })] }).get(asLocalDate('2026-09-23')) ?? []).map((e) => e.title).sort();

  it('sous « Tout », tous les événements sont visibles', () => {
    expect(titles('all')).toEqual(['Caché', 'Inconnu', 'Libre', 'Perso', 'Pro']);
  });

  it('sous Pro ou Perso, seuls ceux dont l’agenda est rattaché à cet espace et affiché', () => {
    expect(titles(PRO)).toEqual(['Pro']);
    expect(titles(PERSO)).toEqual(['Perso']);
  });

  it('externalEventVisible : agenda inconnu ou non rattaché seulement sous « Tout »', () => {
    expect(externalEventVisible(null, 'all')).toBe(true);
    expect(externalEventVisible(null, PRO)).toBe(false);
    expect(externalEventVisible({ id: 'x', name: 'x', spaceId: null, shown: true }, PRO)).toBe(false);
    expect(externalEventVisible({ id: 'x', name: 'x', spaceId: PRO, shown: true }, PRO)).toBe(true);
  });

  it('les événements d’un compte absent de la liste (supprimé) disparaissent', () => {
    expect(byDay([event('Orphelin')], { accounts: [] }).size).toBe(0);
  });
});

describe('externalEventSpan', () => {
  it('donne les jours couverts et les heures locales', () => {
    expect(externalEventSpan(event('x'), 'Europe/Paris')).toEqual({ firstDay: '2026-09-23', lastDay: '2026-09-23', allDay: false, startTime: '10:00', endTime: '11:00' });
    expect(externalEventSpan(event('y', { allDay: true, startUtc: '2026-09-23T00:00:00Z', endUtc: '2026-09-25T00:00:00Z' }), 'Asia/Tokyo')).toEqual({
      firstDay: '2026-09-23',
      lastDay: '2026-09-24',
      allDay: true,
      startTime: null,
      endTime: null,
    });
  });
});
