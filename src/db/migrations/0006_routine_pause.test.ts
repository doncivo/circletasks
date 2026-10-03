import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { SPACE_PRO_ID } from '../seed/defaultSpaces';
import { migrations } from './index';

describe('migration 0006 (R-05) : routine_pause sur une base 0001→0005 peuplée', () => {
  let db: SqlDriver;
  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });
  afterEach(() => db.close());

  it('crée la table, reprend les routines en pause comme période ouverte, sans perte, rejouable', async () => {
    await migrate(db, migrations.slice(0, 5));
    const insert = (id: string, paused: number, deleted: string | null) =>
      db.execute(
        `INSERT INTO routine (id, space_id, title, schedule_type, start_date, paused, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, 'daily', '2026-09-01', ?, '2026-09-10T08:00:00.000Z', '2026-09-20T09:00:00.000Z', ?, 'd', 'h')`,
        [id, SPACE_PRO_ID, `Routine ${id}`, paused, deleted],
      );
    await insert('r-active', 0, null);
    await insert('r-pause', 1, null);
    await insert('r-supprimee', 1, '2026-09-21T00:00:00.000Z');
    await db.execute(
      `INSERT INTO routine_log (id, routine_id, date, done_at, created_at, updated_at, device_id, hlc) VALUES ('l1', 'r-pause', '2026-09-15', '2026-09-15T08:00:00.000Z', 'z', 'z', 'd', 'h')`,
    );

    expect((await migrate(db, migrations)).applied).toEqual(migrations.slice(5).map((m) => m.version));
    expect((await migrate(db, migrations)).applied).toEqual([]);

    const pauses = await db.select<{ id: string; routine_id: string; from_date: string; to_date: string | null; hlc: string }>('SELECT * FROM routine_pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toMatchObject({ routine_id: 'r-pause', from_date: '2026-09-20', to_date: null, hlc: 'h' });
    expect(pauses[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await db.select('SELECT 1 FROM routine')).toHaveLength(3);
    expect(await db.select('SELECT 1 FROM routine_log')).toHaveLength(1);
  });

  it('sur base vide : table vide', async () => {
    await migrate(db, migrations);
    expect(await db.select('SELECT 1 FROM routine_pause')).toEqual([]);
  });
});
