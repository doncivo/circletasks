import { describe, expect, it } from 'vitest';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { migrations } from './index';
import { migration0013FocusSession } from './0013_focus_session';

const PRO = '00000000-0000-4000-8000-000000000001';

describe('migration 0013 (F-01) : table focus_session', () => {
  it('crée la table avec paused_at et les colonnes de synchro, rejouable sans effet', async () => {
    const db = await openSqliteWasmDriver();
    expect((await migrate(db, migrations)).applied).toEqual(migrations.map((m) => m.version));
    expect((await migrate(db, migrations)).applied).toEqual([]);
    const columns = await db.select<{ name: string; notnull: number; dflt_value: string | null }>("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('focus_session')", []);
    expect(columns.map((c) => c.name)).toEqual(['id', 'task_id', 'space_id', 'planned_min', 'started_at', 'ended_at', 'paused_sec', 'paused_at', 'created_at', 'updated_at', 'deleted_at', 'device_id', 'hlc', 'project_id']);
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));
    expect(byName['task_id']?.notnull).toBe(0);
    expect(byName['planned_min']?.notnull).toBe(0);
    expect(byName['paused_at']?.notnull).toBe(0);
    expect(byName['paused_sec']).toMatchObject({ notnull: 1, dflt_value: '0' });
    // Aucune clé étrangère sur task_id : la session survit à la tâche (F-03 critère 8).
    const foreignKeys = await db.select<{ from: string }>("SELECT \"from\" FROM pragma_foreign_key_list('focus_session')", []);
    expect(foreignKeys).toEqual([{ from: 'space_id' }]);
    await db.close();
  });

  it('rejette une durée prévue nulle ou négative et des pauses négatives', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    const insert = (planned: number | null, paused: number) =>
      db.execute(
        "INSERT INTO focus_session (id, space_id, planned_min, started_at, paused_sec, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, '2026-10-04T08:00:00.000Z', ?, 'x', 'x', 'd', 'h')",
        [`s-${String(planned)}-${String(paused)}`, PRO, planned, paused],
      );
    await insert(null, 0);
    await insert(25, 10);
    await expect(insert(0, 0)).rejects.toThrow();
    await expect(insert(-5, 0)).rejects.toThrow();
    await expect(insert(25, -1)).rejects.toThrow();
    await db.close();
  });

  it('numéro suivant le dernier du registre précédent, sans trou ni doublon', () => {
    expect(migration0013FocusSession.version).toBe(13);
    expect(migrations.map((m) => m.version)).toEqual([...Array(migrations.length).keys()].map((index) => index + 1));
  });

  it('une base peuplée en version 12 est migrée sans perte, la table est vide', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 12));
    await db.execute("INSERT INTO task (id, space_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES ('t1', ?, 'Avant', '2026-09-23', 'todo', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'd', 'h')", [PRO]);
    await db.execute("INSERT INTO settings (key, value, updated_at, device_id, hlc) VALUES ('ui.theme', '\"dark\"', 'x', 'd', 'h')", []);
    await migrate(db, migrations);
    expect(await db.select('SELECT title FROM task', [])).toEqual([{ title: 'Avant' }]);
    expect(await db.select('SELECT value FROM settings WHERE key = ?', ['ui.theme'])).toEqual([{ value: '"dark"' }]);
    expect(await db.select('SELECT COUNT(*) AS n FROM focus_session', [])).toEqual([{ n: 0 }]);
    await db.close();
  });

  it('rejoué sur une base qui a déjà la table et des sessions : les lignes sont conservées', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    await db.execute("INSERT INTO focus_session (id, space_id, planned_min, started_at, created_at, updated_at, device_id, hlc) VALUES ('s1', ?, 25, '2026-10-04T08:00:00.000Z', 'x', 'x', 'd', 'h')", [PRO]);
    for (const statement of migration0013FocusSession.statements) await db.execute(statement, []);
    expect(await db.select('SELECT id FROM focus_session', [])).toEqual([{ id: 's1' }]);
    await db.close();
  });
});
