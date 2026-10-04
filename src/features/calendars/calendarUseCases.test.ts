import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { externalEventRowId } from '../../domain/calendarProvider';
import type { ExternalEvent } from '../../domain/model';
import { asEntityId, type CalendarAccountId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createCalendarUseCases } from './calendarUseCases';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000402');
const ACCOUNT = asEntityId<CalendarAccountId>('40000000-0000-4000-8000-000000000002');
const range = { from: '2026-09-01T00:00:00Z' as IsoDateTime, to: '2026-12-01T00:00:00Z' as IsoDateTime };

const event = (externalId: string, calendarId: string): ExternalEvent => ({
  id: externalEventRowId(ACCOUNT, calendarId, externalId),
  accountId: ACCOUNT,
  calendarId,
  externalId,
  title: externalId,
  startUtc: '2026-09-23T08:00:00Z',
  endUtc: null,
  allDay: false,
  syncedAt: '2026-10-04T10:00:00.000Z' as IsoDateTime,
});

describe('cas d’usage des comptes d’agendas (K-01, ES-06)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
  });
  afterEach(() => db.close());

  async function seeded() {
    const useCases = createCalendarUseCases(db);
    await useCases.createAccount({
      id: ACCOUNT,
      provider: 'google',
      label: 'ali@example.com',
      tokenRef: `circletasks.calendar.google.${ACCOUNT}`,
      calendars: [
        { id: 'travail', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true },
        { id: 'sport', name: 'Sport', spaceId: SPACE_PRO_ID, shown: true },
      ],
    });
    await db.data.transaction(async (repos) => {
      await repos.externalEvents.replaceWindow(ACCOUNT, 'travail', [event('a', 'travail')], range);
      await repos.externalEvents.replaceWindow(ACCOUNT, 'sport', [event('b', 'sport')], range);
    });
    return useCases;
  }

  it('crée puis liste le compte', async () => {
    const useCases = await seeded();
    expect((await useCases.listAccounts()).map((account) => account.id)).toEqual([ACCOUNT]);
  });

  it('enregistre les agendas et retire les événements des agendas décochés (K-01 critère 5)', async () => {
    const useCases = await seeded();
    await useCases.saveCalendars(ACCOUNT, [
      { id: 'travail', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true },
      { id: 'sport', name: 'Sport', spaceId: SPACE_PRO_ID, shown: false },
    ]);
    expect((await useCases.listAccounts())[0]?.calendars.find((calendar) => calendar.id === 'sport')?.shown).toBe(false);
    expect((await db.data.repos.externalEvents.listBetween(range)).map((row) => row.calendarId)).toEqual(['travail']);
  });

  it('supprime le compte et tous ses événements (K-01 critère 8)', async () => {
    const useCases = await seeded();
    await useCases.removeAccount(ACCOUNT);
    expect(await useCases.listAccounts()).toEqual([]);
    expect(await db.data.repos.externalEvents.listBetween(range)).toEqual([]);
  });

  it('rejette sans rien écrire quand le compte n’existe pas', async () => {
    const useCases = createCalendarUseCases(db);
    await expect(useCases.removeAccount(ACCOUNT)).rejects.toBeDefined();
    await expect(useCases.saveCalendars(ACCOUNT, [])).rejects.toBeDefined();
  });
});
