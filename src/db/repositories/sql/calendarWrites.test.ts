import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { externalEventRowId } from '../../../domain/calendarProvider';
import type { ExternalEvent } from '../../../domain/model';
import { asEntityId, type CalendarAccountId, type DeviceId, type IsoDateTime } from '../../../domain/types';
import { SPACE_PRO_ID } from '../../seed/defaultSpaces';
import { openTestDb, type TestDb } from './testSetup';

const DEVICE = asEntityId<DeviceId>('30000000-0000-4000-8000-000000000401');
const ACCOUNT = asEntityId<CalendarAccountId>('40000000-0000-4000-8000-000000000001');
const range = { from: '2026-09-01T00:00:00Z' as IsoDateTime, to: '2026-12-01T00:00:00Z' as IsoDateTime };

const event = (externalId: string, title: string, startUtc: string, calendarId = 'cal', patch: Partial<ExternalEvent> = {}): ExternalEvent => ({
  id: externalEventRowId(ACCOUNT, calendarId, externalId),
  accountId: ACCOUNT,
  calendarId,
  externalId,
  title,
  startUtc,
  endUtc: null,
  allDay: false,
  syncedAt: '2026-10-04T10:00:00.000Z' as IsoDateTime,
  ...patch,
});

describe('écritures des agendas externes (K-01, K-03, K-04)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    await db.data.repos.calendarAccounts.create({ id: ACCOUNT, provider: 'google', label: 'ali@example.com', tokenRef: `circletasks.calendar.${ACCOUNT}`, calendars: [{ id: 'cal', name: 'Travail', spaceId: SPACE_PRO_ID, shown: true }] });
  });
  afterEach(() => db.close());

  it('crée un compte avec un tampon de synchro et la référence du coffre, jamais un secret', async () => {
    const account = await db.data.repos.calendarAccounts.getById(ACCOUNT);
    expect(account).toMatchObject({ provider: 'google', label: 'ali@example.com', tokenRef: `circletasks.calendar.${ACCOUNT}`, deviceId: DEVICE });
    expect(account?.hlc).toBeTruthy();
    const columns = await db.driver.select<{ name: string }>('PRAGMA table_info(calendar_account)');
    expect(columns.map((column) => column.name).filter((name) => /secret|password|token$|access|refresh/.test(name))).toEqual([]);
  });

  it('met à jour les agendas (espace, affiché) et fait avancer le hlc', async () => {
    const before = await db.data.repos.calendarAccounts.getById(ACCOUNT);
    db.clock.advance(1000);
    const updated = await db.data.repos.calendarAccounts.updateCalendars(ACCOUNT, [{ id: 'cal', name: 'Travail', spaceId: null, shown: false }]);
    expect(updated.calendars).toEqual([{ id: 'cal', name: 'Travail', spaceId: null, shown: false }]);
    expect(updated.hlc > (before?.hlc ?? '')).toBe(true);
  });

  it('suppression logique : le compte quitte la liste, ses lignes se retirent à part', async () => {
    await db.data.repos.externalEvents.replaceWindow(ACCOUNT, 'cal', [event('a', 'A', '2026-09-23T08:00:00Z')], range);
    await db.data.repos.calendarAccounts.softDelete(ACCOUNT);
    await db.data.repos.externalEvents.deleteForAccount(ACCOUNT);
    expect(await db.data.repos.calendarAccounts.listAll()).toEqual([]);
    expect(await db.data.repos.externalEvents.listBetween(range)).toEqual([]);
    await expect(db.data.repos.calendarAccounts.softDelete(ACCOUNT)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('replaceWindow : ajoute, déplace, retire, sans doublon, en gardant l’identifiant de ligne (K-03 critère 3, K-04 D4)', async () => {
    const repo = db.data.repos.externalEvents;
    await repo.replaceWindow(ACCOUNT, 'cal', [event('a', 'A', '2026-09-23T08:00:00Z'), event('b', 'B', '2026-09-24T08:00:00Z')], range);
    const idA = externalEventRowId(ACCOUNT, 'cal', 'a');
    expect((await repo.listBetween(range)).map((row) => row.title)).toEqual(['A', 'B']);

    await repo.replaceWindow(ACCOUNT, 'cal', [event('a', 'A déplacé', '2026-09-25T08:00:00Z'), event('c', 'C', '2026-09-26T08:00:00Z')], range);
    const rows = await repo.listBetween(range);
    expect(rows.map((row) => [row.title, row.startUtc])).toEqual([
      ['A déplacé', '2026-09-25T08:00:00Z'],
      ['C', '2026-09-26T08:00:00Z'],
    ]);
    expect(rows[0]?.id).toBe(idA);
    expect(await repo.getById(idA)).toMatchObject({ title: 'A déplacé' });
    expect(await repo.getById(externalEventRowId(ACCOUNT, 'cal', 'b'))).toBeNull();
  });

  it('replaceWindow ne touche ni les autres agendas ni les lignes hors de la plage', async () => {
    const repo = db.data.repos.externalEvents;
    await repo.replaceWindow(ACCOUNT, 'other', [event('x', 'Autre agenda', '2026-09-23T08:00:00Z', 'other')], range);
    await repo.replaceWindow(ACCOUNT, 'cal', [event('old', 'Hors plage', '2025-01-01T08:00:00Z'), event('in', 'Dans la plage', '2026-09-23T08:00:00Z')], { from: '2024-12-01T00:00:00Z' as IsoDateTime, to: '2026-12-01T00:00:00Z' as IsoDateTime });
    await repo.replaceWindow(ACCOUNT, 'cal', [event('in', 'Dans la plage', '2026-09-23T08:00:00Z')], range);
    expect(await repo.getById(externalEventRowId(ACCOUNT, 'cal', 'old'))).not.toBeNull();
    expect(await repo.getById(externalEventRowId(ACCOUNT, 'other', 'x'))).not.toBeNull();
  });

  it('deleteForCalendar retire un agenda masqué', async () => {
    const repo = db.data.repos.externalEvents;
    await repo.replaceWindow(ACCOUNT, 'cal', [event('a', 'A', '2026-09-23T08:00:00Z')], range);
    await repo.replaceWindow(ACCOUNT, 'other', [event('x', 'X', '2026-09-23T08:00:00Z', 'other')], range);
    await repo.deleteForCalendar(ACCOUNT, 'cal');
    expect((await repo.listBetween(range)).map((row) => row.title)).toEqual(['X']);
  });

  it('une transaction qui échoue laisse l’ancien état (K-03 critère 3)', async () => {
    const repo = db.data.repos.externalEvents;
    await repo.replaceWindow(ACCOUNT, 'cal', [event('a', 'A', '2026-09-23T08:00:00Z')], range);
    await expect(
      db.data.transaction(async (tx) => {
        await tx.externalEvents.replaceWindow(ACCOUNT, 'cal', [event('b', 'B', '2026-09-24T08:00:00Z')], range);
        throw new Error('échec simulé');
      }),
    ).rejects.toThrow('échec simulé');
    expect((await repo.listBetween(range)).map((row) => row.title)).toEqual(['A']);
  });

  it('500 événements : écriture hors réseau en moins de 500 ms (K-03 critère 10)', async () => {
    const repo = db.data.repos.externalEvents;
    const events = Array.from({ length: 500 }, (_, index) => event(`e${String(index)}`, `Événement ${String(index)}`, new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString().replace('.000Z', 'Z'), 'cal', { endUtc: new Date(Date.UTC(2026, 9, 1) + index * 3_600_000 + 1_800_000).toISOString().replace('.000Z', 'Z') }));
    const started = performance.now();
    await db.data.transaction((tx) => tx.externalEvents.replaceWindow(ACCOUNT, 'cal', events, range));
    await db.data.transaction((tx) => tx.externalEvents.replaceWindow(ACCOUNT, 'cal', events, range));
    expect(performance.now() - started).toBeLessThan(500);
    expect(await repo.listBetween(range)).toHaveLength(500);
  });
});
