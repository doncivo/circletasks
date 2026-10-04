import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { SPACE_PERSO_ID } from '../seed/defaultSpaces';
import { migrations } from './index';

const reminderRow = (id: string, target: string, offset: number, deleted: string | null = null) =>
  [id, target, 'tgt', offset, '2026-09-23T09:00', deleted, `h-${id}`] as const;

describe('migration 0009 (E-01) : rappel d’événement à 10080 minutes sur une base 0001→8 peuplée', () => {
  let db: SqlDriver;
  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });
  afterEach(() => db.close());

  it('conserve les rappels existants et leurs index, accepte 10080, refuse une avance inconnue, rejouable sans effet', async () => {
    await migrate(db, migrations.slice(0, 8));
    for (const row of [reminderRow('r1', 'task', 0), reminderRow('r2', 'routine', 1440), reminderRow('r3', 'event', 60, 'z')]) {
      await db.execute(
        `INSERT INTO reminder (id, target_type, target_id, offset_min, fire_at, delivered, created_at, updated_at, deleted_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, 1, 'z', 'z', ?, 'd', ?)`,
        [...row],
      );
    }
    await db.execute(
      `INSERT INTO event (id, space_id, title, start_date, end_date, created_at, updated_at, device_id, hlc) VALUES ('e1', ?, 'Comité', '2026-10-05', '2026-10-05', 'z', 'z', 'd', 'h')`,
      [SPACE_PERSO_ID],
    );

    expect((await migrate(db, migrations)).applied).toEqual(migrations.slice(8).map((m) => m.version));
    expect((await migrate(db, migrations)).applied).toEqual([]);

    expect(await db.select('SELECT id, target_type, offset_min, delivered, deleted_at, hlc FROM reminder ORDER BY id')).toEqual([
      { id: 'r1', target_type: 'task', offset_min: 0, delivered: 1, deleted_at: null, hlc: 'h-r1' },
      { id: 'r2', target_type: 'routine', offset_min: 1440, delivered: 1, deleted_at: null, hlc: 'h-r2' },
      { id: 'r3', target_type: 'event', offset_min: 60, delivered: 1, deleted_at: 'z', hlc: 'h-r3' },
    ]);
    await db.execute(
      `INSERT INTO reminder (id, target_type, target_id, offset_min, fire_at, created_at, updated_at, device_id, hlc) VALUES ('r4', 'event', 'e1', 10080, '2026-09-28T09:00', 'z', 'z', 'd', 'h')`,
    );
    await expect(
      db.execute(`INSERT INTO reminder (id, target_type, target_id, offset_min, fire_at, created_at, updated_at, device_id, hlc) VALUES ('r5', 'event', 'e1', 7, 'x', 'z', 'z', 'd', 'h')`),
    ).rejects.toThrow();
    const indexes = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reminder' AND name LIKE 'idx_%' ORDER BY name");
    expect(indexes.map((i) => i.name)).toEqual(['idx_reminder_deleted_at', 'idx_reminder_fire_at', 'idx_reminder_hlc', 'idx_reminder_target']);
    expect(await db.select("SELECT name FROM sqlite_master WHERE name = 'reminder_rebuild'")).toEqual([]);
    expect(await db.select('SELECT id, title FROM event')).toEqual([{ id: 'e1', title: 'Comité' }]);
  });

  it('base neuve : 10080 accepté', async () => {
    await migrate(db, migrations);
    await db.execute(
      `INSERT INTO reminder (id, target_type, target_id, offset_min, fire_at, created_at, updated_at, device_id, hlc) VALUES ('r', 'event', 'e', 10080, '2026-09-28T09:00', 'z', 'z', 'd', 'h')`,
    );
    expect(await db.select('SELECT offset_min FROM reminder')).toEqual([{ offset_min: 10080 }]);
  });
});
