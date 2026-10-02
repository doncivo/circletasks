import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { SPACE_PRO_ID } from '../seed/defaultSpaces';
import { migration0001CoreTables } from './0001_core_tables';
import { migration0002TaskDoneAtIndex } from './0002_task_done_at_index';
import { migrations } from './index';

describe('migration 0003 (T-10) : colonne series_template sur une base 0001+0002 peuplée', () => {
  let db: SqlDriver;
  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });
  afterEach(() => db.close());

  it('ajoute la colonne (NULL) sans perte, puis est rejouable sans effet', async () => {
    await migrate(db, [migration0001CoreTables, migration0002TaskDoneAtIndex]);
    await db.execute(
      `INSERT INTO task (id, space_id, title, date, status, created_at, updated_at, device_id, hlc)
       VALUES ('t1', ?, 'Avant 0003', '2026-09-23', 'todo', '2026-09-23T08:00:00.000Z', '2026-09-23T08:00:00.000Z', 'd', 'h')`,
      [SPACE_PRO_ID],
    );
    expect((await migrate(db, migrations)).applied).toEqual([3, 4, 5, 6]);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    const rows = await db.select<{ title: string; series_template: string | null }>('SELECT title, series_template FROM task');
    expect(rows).toEqual([{ title: 'Avant 0003', series_template: null }]);
  });
});
