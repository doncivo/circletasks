import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate } from '../domain/types';
import { asEntityId, type DeviceId } from '../domain/types';
import type { SqlDriver } from './driver';
import { openSqliteWasmDriver } from './drivers/sqliteWasm';
import { migrations } from './migrations';
import { migrate } from './migrator';
import { openTestDb, type TestDb } from './repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from './seed/defaultSpaces';
import { buildManyTasks, sampleSomedayTasks, sampleTodayTasks } from './seed/sampleData';

/** ES-02 critères 1 et 6 : chaque élément métier appartient à un espace existant, la base le garantit. */
describe('appartenance à un espace (ES-02)', () => {
  let driver: SqlDriver;
  beforeEach(async () => {
    driver = await openSqliteWasmDriver();
    await migrate(driver, migrations);
  });
  afterEach(() => driver.close());

  const tablesWithSpace = async (): Promise<string[]> => {
    const tables = await driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
    const found: string[] = [];
    for (const { name } of tables) {
      const columns = await driver.select<{ name: string }>(`PRAGMA table_info(${name})`);
      if (columns.some((column) => column.name === 'space_id')) found.push(name);
    }
    return found;
  };

  it('toutes les tables portant un space_id : colonne NOT NULL et clé étrangère vers space', async () => {
    const tables = await tablesWithSpace();
    // Tâches, routines, objectifs, événements, checklists et projets (le projet appartient lui aussi à un espace).
    expect(tables.sort()).toEqual(['checklist', 'event', 'goal', 'project', 'routine', 'task']);
    for (const table of tables) {
      const columns = await driver.select<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`);
      expect(columns.find((c) => c.name === 'space_id')?.notnull, `${table}.space_id NOT NULL`).toBe(1);
      const keys = await driver.select<{ table: string; from: string }>(`PRAGMA foreign_key_list(${table})`);
      expect(keys.some((k) => k.from === 'space_id' && k.table === 'space'), `${table}.space_id → space`).toBe(true);
    }
  });

  it('la base refuse un space_id nul ou inconnu dans chaque table métier', async () => {
    const insertSql: Record<string, string> = {
      task: "INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('t', ?, 'x', 'z', 'z', 'd', 'h')",
      routine: "INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES ('r', ?, 'x', 'daily', '2026-09-01', 'z', 'z', 'd', 'h')",
      goal: "INSERT INTO goal (id, space_id, week_start, title, created_at, updated_at, device_id, hlc) VALUES ('g', ?, '2026-09-21', 'x', 'z', 'z', 'd', 'h')",
      event: "INSERT INTO event (id, space_id, title, start_date, end_date, created_at, updated_at, device_id, hlc) VALUES ('e', ?, 'x', '2026-09-21', '2026-09-21', 'z', 'z', 'd', 'h')",
      checklist: "INSERT INTO checklist (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES ('c', ?, 'x', 'z', 'z', 'd', 'h')",
      project: "INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES ('p', ?, 'x', '#2f6b7a', 1, 'z', 'z', 'd', 'h')",
    };
    for (const table of await tablesWithSpace()) {
      const sql = insertSql[table];
      if (!sql) throw new Error(`Table métier sans test d'appartenance : ${table}`);
      await expect(driver.execute(sql, [null]), `${table} : space_id nul`).rejects.toMatchObject({ code: 'constraint' });
      await expect(driver.execute(sql, ['00000000-0000-4000-8000-0000000000ff']), `${table} : espace inconnu`).rejects.toMatchObject({ code: 'constraint' });
      await expect(driver.execute(sql, [SPACE_PERSO_ID]), `${table} : espace existant`).resolves.toBeDefined();
    }
  });
});

describe('données d’exemple (ES-02 critère 6)', () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await openTestDb(asEntityId<DeviceId>('60000000-0000-4000-8000-0000000e5002'));
  });
  afterEach(() => db.close());

  it('toutes les tâches d’exemple ont un espace existant et s’écrivent en base', async () => {
    const date = '2026-10-02' as LocalDate;
    const samples = [...sampleTodayTasks(date), ...sampleSomedayTasks(), ...buildManyTasks(date, 10)];
    for (const task of samples) {
      expect([SPACE_PRO_ID, SPACE_PERSO_ID]).toContain(task.spaceId);
      await db.data.repos.tasks.create(task);
    }
    const all = await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task WHERE space_id IS NULL');
    expect(all[0]?.n).toBe(0);
    expect((await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task'))[0]?.n).toBe(samples.length);
  });
});
