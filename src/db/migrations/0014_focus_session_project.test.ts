import { describe, expect, it } from 'vitest';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { migrations } from './index';
import { migration0014FocusSessionProject } from './0014_focus_session_project';

const PRO = '00000000-0000-4000-8000-000000000001';

describe('migration 0014 : focus_session.project_id', () => {
  it('numéro suivant, sans trou ; rejouable sans effet', async () => {
    expect(migration0014FocusSessionProject.version).toBe(14);
    expect(migrations.map((m) => m.version)).toEqual([...Array(migrations.length).keys()].map((i) => i + 1));
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    await db.close();
  });

  it('base peuplée en version 13 : les sessions reprennent le projet de leur tâche, les autres restent nulles', async () => {
    const db = await openSqliteWasmDriver();
    await migrate(db, migrations.slice(0, 13));
    await db.execute("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES ('p1', ?, 'Mission', '#2f6b7a', 1, 'z', 'z', 'd', 'h')", [PRO]);
    await db.execute("INSERT INTO task (id, space_id, project_id, title, date, status, sort_order, created_at, updated_at, device_id, hlc) VALUES ('t1', ?, 'p1', 'A', '2026-10-04', 'todo', 1, 'z', 'z', 'd', 'h')", [PRO]);
    const ins = "INSERT INTO focus_session (id, task_id, space_id, planned_min, started_at, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, 25, '2026-10-04T08:00:00.000Z', 'z', 'z', 'd', 'h')";
    await db.execute(ins, ['s1', 't1', PRO]);
    await db.execute(ins, ['s2', null, PRO]);
    await migrate(db, migrations);
    expect(await db.select('SELECT id, project_id FROM focus_session ORDER BY id', [])).toEqual([
      { id: 's1', project_id: 'p1' },
      { id: 's2', project_id: null },
    ]);
    await db.close();
  });
});
