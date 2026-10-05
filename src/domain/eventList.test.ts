import { describe, expect, it } from 'vitest';
import { buildEventList, dayDots, firstUpcomingEntry, groupByMonth, isPastEntry, todayEntriesForDay } from './eventList';
import { makeEvent } from './eventTestKit';
import type { CalendarAccount, ExternalEvent } from './model';
import { asEntityId, asLocalDate as d, asLocalTime as tm, type CalendarAccountId, type DeviceId, type ExternalEventId, type Hlc, type IsoDateTime, type SpaceId } from './types';

const PRO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000001');
const PERSO = asEntityId<SpaceId>('00000000-0000-4000-8000-000000000002');

const account: CalendarAccount = {
  id: asEntityId<CalendarAccountId>('94000000-0000-4000-8000-000000000001'),
  provider: 'google',
  label: 'Google Agenda',
  username: '',
  tokenRef: '',
  calendars: [
    { id: 'pro', name: 'Travail', spaceId: PRO, shown: true },
    { id: 'libre', name: 'Libre', spaceId: null, shown: true },
  ],
  createdAt: '2026-01-01T00:00:00.000Z' as IsoDateTime,
  updatedAt: '2026-01-01T00:00:00.000Z' as IsoDateTime,
  deletedAt: null,
  deviceId: asEntityId<DeviceId>('30000000-0000-4000-8000-000000000003'),
  hlc: '0000000000001-0000-test' as Hlc,
};

const external = (id: string, calendarId: string, startUtc: string, endUtc: string | null, allDay = false): ExternalEvent => ({
  id: asEntityId<ExternalEventId>(`95000000-0000-4000-8000-${id.padStart(12, '0')}`),
  accountId: account.id,
  calendarId,
  externalId: id,
  title: `Externe ${id}`,
  startUtc,
  endUtc,
  allDay,
  syncedAt: '2026-10-01T08:00:00.000Z' as IsoDateTime,
});

const base = { year: 2026, accounts: [account], timeZone: 'Europe/Paris' } as const;

describe('liste de l’année (E-01 critère 1, D4)', () => {
  it('trie locaux et externes par jour, journée entière avant les heures', () => {
    const entries = buildEventList({
      ...base,
      filter: 'all',
      events: [makeEvent({ title: 'B', startDate: '2026-09-23', allDay: false, startTime: tm('14:00'), endTime: tm('15:00') }), makeEvent({ title: 'A', startDate: '2026-09-23' }), makeEvent({ title: 'Z', startDate: '2026-01-02' })],
      externalEvents: [external('1', 'pro', '2026-09-23T08:00:00Z', '2026-09-23T09:00:00Z')],
    });
    expect(entries.map((e) => `${e.date} ${e.title}`)).toEqual(['2026-01-02 Z', '2026-09-23 A', '2026-09-23 Externe 1', '2026-09-23 B']);
    expect(entries[2]).toMatchObject({ source: 'external', startTime: '10:00', endTime: '11:00', calendarName: 'Google Agenda', spaceId: PRO });
  });

  it('une série mensuelle donne une ligne par mois de l’année, le 31 devient le dernier jour', () => {
    const entries = buildEventList({ ...base, filter: 'all', events: [makeEvent({ title: 'Fin de mois', startDate: '2025-11-30', repeat: 'monthly' })], externalEvents: [] });
    expect(entries.map((e) => e.date)).toEqual(['2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30', '2026-05-30', '2026-06-30', '2026-07-30', '2026-08-30', '2026-09-30', '2026-10-30', '2026-11-30', '2026-12-30']);
  });

  it('les événements externes suivent le filtre d’espace de leur agenda', () => {
    const events = [external('1', 'pro', '2026-09-23T08:00:00Z', null), external('2', 'libre', '2026-09-24T08:00:00Z', null)];
    expect(buildEventList({ ...base, filter: 'all', events: [], externalEvents: events })).toHaveLength(2);
    expect(buildEventList({ ...base, filter: PRO, events: [], externalEvents: events }).map((e) => e.title)).toEqual(['Externe 1']);
    expect(buildEventList({ ...base, filter: PERSO, events: [], externalEvents: events })).toEqual([]);
  });

  it('un événement externe d’un compte inconnu ou d’une autre année est écarté', () => {
    expect(buildEventList({ ...base, accounts: [], filter: 'all', events: [], externalEvents: [external('1', 'pro', '2026-09-23T08:00:00Z', null)] })).toEqual([]);
    expect(buildEventList({ ...base, filter: 'all', events: [], externalEvents: [external('1', 'pro', '2025-09-23T08:00:00Z', null)] })).toEqual([]);
  });

  it('groupe par mois, repère la première ligne à venir et le passé', () => {
    const entries = buildEventList({ ...base, filter: 'all', events: [makeEvent({ title: 'Hier', startDate: '2026-10-01' }), makeEvent({ title: 'Plus tard', startDate: '2026-11-05' }), makeEvent({ title: 'Janvier', startDate: '2026-01-05' })], externalEvents: [] });
    expect(groupByMonth(entries).map((g) => [g.month, g.entries.length])).toEqual([[1, 1], [10, 1], [11, 1]]);
    expect(firstUpcomingEntry(entries, d('2026-10-02'))?.title).toBe('Plus tard');
    expect(firstUpcomingEntry(entries, d('2026-12-01'))).toBeNull();
    expect(entries.map((entry) => isPastEntry(entry, d('2026-10-02')))).toEqual([true, true, false]);
  });
});

describe('points de la grille (E-01 critère 8, D6)', () => {
  it('un point par espace et par jour, un événement de plusieurs jours marque chaque jour', () => {
    const entries = buildEventList({
      ...base,
      filter: 'all',
      events: [
        makeEvent({ title: 'Pro 1', startDate: '2026-10-10', spaceId: PRO }),
        makeEvent({ title: 'Pro 2', startDate: '2026-10-10', spaceId: PRO }),
        makeEvent({ title: 'Perso', startDate: '2026-10-10', spaceId: PERSO }),
        makeEvent({ title: 'Plage', startDate: '2026-10-20', endDate: '2026-10-22', allDay: false, startTime: tm('09:00'), endTime: tm('17:00'), spaceId: PRO }),
      ],
      externalEvents: [external('1', 'libre', '2026-10-10T08:00:00Z', null)],
    });
    const dots = dayDots(entries, 2026, 10, [PRO, PERSO]);
    expect(dots.get(d('2026-10-10'))?.map((dot) => dot.spaceId)).toEqual([PRO, PERSO, null]);
    expect([...dots.keys()].filter((day) => day.startsWith('2026-10-2')).sort()).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    expect(dots.has(d('2026-10-11'))).toBe(false);
    expect(dayDots(entries, 2026, 11, [PRO, PERSO]).size).toBe(0);
  });
});

describe('bandeaux d’un jour (E-01 critère 11)', () => {
  it('heure de début le premier jour, toute la journée ensuite ; type conservé', () => {
    const events = [makeEvent({ title: 'Nuit', startDate: '2026-10-02', endDate: '2026-10-03', allDay: false, startTime: tm('22:00'), endTime: tm('02:00'), kind: 'birthday' })];
    expect(todayEntriesForDay(events, d('2026-10-02'))).toMatchObject([{ title: 'Nuit', allDay: false, startTime: '22:00', kind: 'birthday', calendarName: null }]);
    expect(todayEntriesForDay(events, d('2026-10-03'))).toMatchObject([{ allDay: true, startTime: null }]);
    expect(todayEntriesForDay(events, d('2026-10-04'))).toEqual([]);
  });
});
