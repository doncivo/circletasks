import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../db/seed/defaultSpaces';
import { insertCalendarAccount, insertExternalEvent } from '../db/seed/externalEventFixtures';
import { openTestDb, type TestDb } from '../db/repositories/sql/testSetup';
import { prefillCalendarSpaces, spaceOfExternalEvent, validateCalendarRef, validateCalendars, type ExternalCalendarRef } from './externalCalendars';
import { externalEventsByDay } from './externalEvents';
import type { CalendarAccount, ExternalEvent } from './model';
import { matchesSpaceFilter } from './spaceRules';
import { asEntityId, asLocalDate, type CalendarAccountId, type DeviceId, type ExternalEventId, type SpaceId } from './types';
import { weekDays } from './week';

const PRO = SPACE_PRO_ID;
const PERSO = SPACE_PERSO_ID;
const spaces = [
  { id: PRO, sortOrder: 1 },
  { id: PERSO, sortOrder: 2 },
];
const calendar = (over: Partial<ExternalCalendarRef> = {}): ExternalCalendarRef => ({ id: 'pro', name: 'Travail', spaceId: PRO, shown: true, ...over });
const account = (calendars: ExternalCalendarRef[]): CalendarAccount => ({ id: 'acc' as CalendarAccountId, provider: 'google', label: 'Google Agenda', tokenRef: '', calendars }) as unknown as CalendarAccount;
const event = (id: string, calendarId: string): ExternalEvent =>
  ({ id: id as ExternalEventId, accountId: 'acc' as CalendarAccountId, calendarId, externalId: id, title: id, startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z', allDay: false }) as ExternalEvent;

describe('agendas externes rattachés à un espace (ES-06)', () => {
  const accounts = [account([calendar(), calendar({ id: 'perso', name: 'Famille', spaceId: PERSO }), calendar({ id: 'libre', name: 'Libre', spaceId: null, shown: false })])];

  it('l’espace d’un événement est celui de son agenda (critère 1)', () => {
    expect(spaceOfExternalEvent(event('a', 'pro'), accounts)).toBe(PRO);
    expect(spaceOfExternalEvent(event('b', 'perso'), accounts)).toBe(PERSO);
    expect(spaceOfExternalEvent(event('c', 'libre'), accounts)).toBeNull();
    expect(spaceOfExternalEvent(event('d', 'inconnu'), accounts)).toBeNull();
    expect(spaceOfExternalEvent({ ...event('e', 'pro'), accountId: 'autre' as CalendarAccountId }, accounts)).toBeNull();
  });

  it('un agenda affiché sans espace est refusé ; masqué sans espace accepté ; espace inconnu refusé (critère 2)', () => {
    expect(validateCalendarRef(calendar({ spaceId: null }), spaces)).toEqual({ ok: false, error: 'space-required' });
    expect(validateCalendarRef(calendar({ spaceId: null, shown: false }), spaces)).toMatchObject({ ok: true });
    expect(validateCalendarRef(calendar({ spaceId: asEntityId<SpaceId>('00000000-0000-4000-8000-0000000000ff') }), spaces)).toEqual({ ok: false, error: 'unknown-space' });
    expect(validateCalendarRef(calendar(), spaces)).toMatchObject({ ok: true });
    expect(validateCalendars([calendar(), calendar({ id: 'x', spaceId: null })], spaces)).toEqual({ ok: false, error: { calendarId: 'x', error: 'space-required' } });
    expect(validateCalendars([calendar(), calendar({ id: 'perso', spaceId: PERSO })], spaces)).toMatchObject({ ok: true });
  });

  it('sous le filtre Pro, seuls les événements de l’agenda Pro sont retenus (critère 3)', () => {
    const events = [event('Point client', 'pro'), event('Dentiste', 'perso')];
    const kept = (filter: SpaceId | 'all') => events.filter((e) => matchesSpaceFilter({ spaceId: spaceOfExternalEvent(e, accounts) }, filter)).map((e) => e.title);
    expect(kept(PRO)).toEqual(['Point client']);
    expect(kept(PERSO)).toEqual(['Dentiste']);
    expect(kept('all')).toEqual(['Point client', 'Dentiste']);
    // La Semaine applique la même règle : un agenda non rattaché ou masqué n'apparaît que sous « Tout » (S-05).
    const week = (filter: SpaceId | 'all') =>
      [...externalEventsByDay({ days: weekDays(asLocalDate('2026-09-21')), events: [...events, event('Libre', 'libre')], accounts, timeZone: 'Europe/Paris', filter }).values()].flat().map((e) => e.title);
    expect(week(PRO)).toEqual(['Point client']);
    expect(week(PERSO)).toEqual(['Dentiste']);
  });

  it('un agenda nouvellement connecté reçoit l’espace par défaut (Pro, T-01) ; les autres gardent le leur (critère 5)', () => {
    const prefilled = prefillCalendarSpaces([calendar({ id: 'a', spaceId: null }), calendar({ id: 'b', spaceId: PERSO })], spaces);
    expect(prefilled.map((c) => c.spaceId)).toEqual([PRO, PERSO]);
  });
});

describe('changer l’espace d’un agenda en base (ES-06 critère 6)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(asEntityId<DeviceId>('30000000-0000-4000-8000-0000000e5006'));
    await insertCalendarAccount(db.driver, { id: 'acc-google', provider: 'google', label: 'Google Agenda', calendars: [{ id: 'cal', name: 'Famille', spaceId: PERSO, shown: true }] });
    await insertExternalEvent(db.driver, { id: 'e1', accountId: 'acc-google', calendarId: 'cal', title: 'Dentiste', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z' });
  });
  afterEach(() => db.close());

  const visibleFor = async (filter: SpaceId | 'all') => {
    const accounts = await db.data.repos.calendarAccounts.listAll();
    const events = await db.data.repos.externalEvents.listBetween({ from: '2026-09-21T00:00:00.000Z' as never, to: '2026-09-28T00:00:00.000Z' as never });
    return events.filter((e) => matchesSpaceFilter({ spaceId: spaceOfExternalEvent(e, accounts) }, filter)).map((e) => e.title);
  };

  it('les événements suivent le filtre dès que l’agenda change d’espace, sans toucher aux événements (pas de resynchronisation)', async () => {
    expect(await visibleFor(PRO)).toEqual([]);
    expect(await visibleFor(PERSO)).toEqual(['Dentiste']);
    const before = await db.driver.select('SELECT * FROM external_event');
    await db.driver.execute('UPDATE calendar_account SET calendars = ? WHERE id = ?', [JSON.stringify([{ id: 'cal', name: 'Famille', space_id: PRO, shown: true }]), 'acc-google']);
    expect(await visibleFor(PRO)).toEqual(['Dentiste']);
    expect(await visibleFor(PERSO)).toEqual([]);
    expect(await db.driver.select('SELECT * FROM external_event')).toEqual(before);
  });
});
