import { describe, expect, it } from 'vitest';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { insertCalendarAccount, insertExternalEvent } from '../seed/externalEventFixtures';
import { migrate } from '../migrator';
import { migrations } from './index';

describe('migration 0005 (S-05) : calendar_account et external_event', () => {
  it('crée les deux tables vides, rejouable sans effet', async () => {
    const db = await openSqliteWasmDriver();
    expect((await migrate(db, migrations)).applied).toContain(5);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    const tables = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('calendar_account', 'external_event') ORDER BY name");
    expect(tables.map((row) => row.name)).toEqual(['calendar_account', 'external_event']);
    expect(await db.select('SELECT 1 FROM external_event')).toEqual([]);
    await db.close();
  });

  it('refuse un fournisseur inconnu, un événement sans compte et un doublon (account, calendar, external_id)', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    await expect(
      db.execute("INSERT INTO calendar_account (id, provider, label, created_at, updated_at, device_id, hlc) VALUES ('a', 'outlook', 'x', 'z', 'z', 'd', 'h')"),
    ).rejects.toThrow();
    await db.execute('PRAGMA foreign_keys = ON');
    await expect(insertExternalEvent(db, { id: 'e1', accountId: 'inconnu', calendarId: 'c', title: 'x', startUtc: '2026-09-23T08:00:00Z' })).rejects.toThrow();
    await insertCalendarAccount(db, { id: 'acc', provider: 'google', label: 'Google Agenda', calendars: [] });
    await insertExternalEvent(db, { id: 'e1', accountId: 'acc', calendarId: 'c', title: 'x', startUtc: '2026-09-23T08:00:00Z' });
    await expect(
      db.execute("INSERT INTO external_event (id, account_id, calendar_id, external_id, title, start_utc, all_day, synced_at) VALUES ('e2', 'acc', 'c', 'ext-e1', 'y', '2026-09-23T08:00:00Z', 0, 'z')"),
    ).rejects.toThrow();
    await db.close();
  });
});
