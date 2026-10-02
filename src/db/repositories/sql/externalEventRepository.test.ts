import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asEntityId, type DeviceId, type IsoDateTime, type SpaceId } from '../../../domain/types';
import { insertCalendarAccount, insertExternalEvent } from '../../seed/externalEventFixtures';
import { SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000305');
const iso = (value: string) => value as IsoDateTime;

describe('ExternalEventRepository et CalendarAccountRepository (SQL, S-05)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    await insertCalendarAccount(db.driver, {
      id: 'acc-google',
      provider: 'google',
      label: 'Google Agenda',
      calendars: [
        { id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true },
        { id: 'misc', name: 'Divers', spaceId: null, shown: false },
      ],
    });
  });
  afterEach(() => db.close());

  it('listBetween rend les événements qui chevauchent la plage, triés par début, sans autre', async () => {
    await insertExternalEvent(db.driver, { id: 'avant', accountId: 'acc-google', calendarId: 'pro', title: 'Avant', startUtc: '2026-09-20T08:00:00Z', endUtc: '2026-09-20T09:00:00Z' });
    await insertExternalEvent(db.driver, { id: 'mer', accountId: 'acc-google', calendarId: 'pro', title: 'Point client', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z' });
    await insertExternalEvent(db.driver, { id: 'lun', accountId: 'acc-google', calendarId: 'pro', title: 'Lundi', startUtc: '2026-09-21T07:00:00Z', endUtc: '2026-09-21T08:00:00Z' });
    await insertExternalEvent(db.driver, { id: 'apres', accountId: 'acc-google', calendarId: 'pro', title: 'Après', startUtc: '2026-09-29T08:00:00Z', endUtc: '2026-09-29T09:00:00Z' });
    await insertExternalEvent(db.driver, { id: 'cheval', accountId: 'acc-google', calendarId: 'pro', title: 'À cheval', startUtc: '2026-09-19T08:00:00Z', endUtc: '2026-09-22T08:00:00Z' });

    const found = await db.data.repos.externalEvents.listBetween({ from: iso('2026-09-21T00:00:00Z'), to: iso('2026-09-28T00:00:00Z') });
    expect(found.map((event) => event.title)).toEqual(['À cheval', 'Lundi', 'Point client']);
    expect(found[2]).toMatchObject({ id: 'mer', accountId: 'acc-google', calendarId: 'pro', startUtc: '2026-09-23T08:00:00Z', endUtc: '2026-09-23T09:00:00Z', allDay: false });
  });

  it('un événement sans fin est retenu sur son instant de début ; une journée entière garde son drapeau', async () => {
    await insertExternalEvent(db.driver, { id: 'sans-fin', accountId: 'acc-google', calendarId: 'pro', title: 'Rappel', startUtc: '2026-09-23T08:00:00Z' });
    await insertExternalEvent(db.driver, { id: 'jour', accountId: 'acc-google', calendarId: 'pro', title: 'Congé', startUtc: '2026-09-24T00:00:00Z', endUtc: '2026-09-25T00:00:00Z', allDay: true });
    const found = await db.data.repos.externalEvents.listBetween({ from: iso('2026-09-23T00:00:00Z'), to: iso('2026-09-26T00:00:00Z') });
    expect(found.map((event) => [event.title, event.endUtc, event.allDay])).toEqual([
      ['Rappel', null, false],
      ['Congé', '2026-09-25T00:00:00Z', true],
    ]);
    expect(await db.data.repos.externalEvents.listBetween({ from: iso('2026-09-25T00:00:00Z'), to: iso('2026-09-26T00:00:00Z') })).toEqual([]);
  });

  it('listAll rend les comptes avec leurs agendas (espace, affiché) ; vide sans compte', async () => {
    const accounts = await db.data.repos.calendarAccounts.listAll();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: 'acc-google', provider: 'google', label: 'Google Agenda', tokenRef: '' });
    expect(accounts[0]?.calendars).toEqual([
      { id: 'pro', name: 'Travail', spaceId: SPACE_PRO_ID as SpaceId, shown: true },
      { id: 'misc', name: 'Divers', spaceId: null, shown: false },
    ]);
    await db.driver.execute('UPDATE calendar_account SET deleted_at = ?', ['2026-09-22T00:00:00.000Z']);
    expect(await db.data.repos.calendarAccounts.listAll()).toEqual([]);
  });

  it('une colonne calendars illisible donne une liste vide, sans exception', async () => {
    await db.driver.execute("UPDATE calendar_account SET calendars = 'pas du json'");
    expect((await db.data.repos.calendarAccounts.listAll())[0]?.calendars).toEqual([]);
  });
});
