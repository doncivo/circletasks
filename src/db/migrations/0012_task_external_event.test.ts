import { describe, expect, it } from 'vitest';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { migrations } from './index';
import { migration0012TaskExternalEvent } from './0012_task_external_event';

describe('migration 0012 (K-04) : task.external_event_id', () => {
  it('ajoute une colonne nulle par défaut, sans clé étrangère ni contrainte d’unicité, rejouable sans effet', async () => {
    const db = await openSqliteWasmDriver();
    expect((await migrate(db, migrations)).applied).toEqual(migrations.map((m) => m.version));
    expect((await migrate(db, migrations)).applied).toEqual([]);
    const columns = await db.select<{ name: string; notnull: number; dflt_value: string | null }>("SELECT name, \"notnull\", dflt_value FROM pragma_table_info('task') WHERE name = 'external_event_id'", []);
    expect(columns).toEqual([{ name: 'external_event_id', notnull: 0, dflt_value: null }]);
    expect(await db.select("SELECT * FROM pragma_foreign_key_list('task') WHERE \"from\" = 'external_event_id'", [])).toEqual([]);
    const indexes = await db.select<{ name: string; unique: number }>("SELECT name, \"unique\" FROM pragma_index_list('task') WHERE name = 'idx_task_external_event_id'", []);
    expect(indexes).toEqual([{ name: 'idx_task_external_event_id', unique: 0 }]);
    await db.close();
  });

  it('numéro suivant le dernier du registre précédent, sans trou ni doublon', () => {
    expect(migration0012TaskExternalEvent.version).toBe(12);
    expect(migrations.map((m) => m.version)).toEqual([...Array(migrations.length).keys()].map((index) => index + 1));
  });

  it('une base peuplée en version 11 est migrée sans perte : les tâches existantes ont un lien nul', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 11));
    await db.execute("INSERT INTO task (id, space_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES ('t1', '00000000-0000-4000-8000-000000000001', 'Avant', '2026-09-23', 'todo', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'd', 'h')", []);
    await migrate(db, migrations);
    expect(await db.select("SELECT title, external_event_id FROM task", [])).toEqual([{ title: 'Avant', external_event_id: null }]);
    await db.close();
  });
});
