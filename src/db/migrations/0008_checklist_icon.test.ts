import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../seed/defaultSpaces';
import { migrations } from './index';

describe('migration 0008 (C-01) : checklist.icon sur une base 0001→7 peuplée', () => {
  let db: SqlDriver;
  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });
  afterEach(() => db.close());

  it('ajoute la colonne icon (NULL), conserve checklists et items, rejouable sans effet', async () => {
    await migrate(db, migrations.slice(0, 7));
    await db.execute(
      `INSERT INTO checklist (id, space_id, title, date, is_template, created_at, updated_at, device_id, hlc) VALUES ('c1', ?, 'Valise voyage', '2026-10-05', 1, 'z', 'z', 'd', 'h1')`,
      [SPACE_PERSO_ID],
    );
    await db.execute(`INSERT INTO checklist (id, space_id, title, created_at, updated_at, deleted_at, device_id, hlc) VALUES ('c2', ?, 'Supprimée', 'z', 'z', 'z', 'd', 'h2')`, [SPACE_PRO_ID]);
    await db.execute(
      `INSERT INTO checklist_item (id, checklist_id, text, checked, sort_order, created_at, updated_at, device_id, hlc) VALUES ('i1', 'c1', 'Passeport', 1, 1, 'z', 'z', 'd', 'h3')`,
    );

    expect((await migrate(db, migrations)).applied).toEqual(migrations.slice(7).map((m) => m.version));
    expect((await migrate(db, migrations)).applied).toEqual([]);

    const columns = await db.select<{ name: string; notnull: number }>("SELECT name, \"notnull\" FROM pragma_table_info('checklist') WHERE name = 'icon'");
    expect(columns).toEqual([{ name: 'icon', notnull: 0 }]);
    expect(await db.select('SELECT id, title, date, is_template, icon, hlc FROM checklist ORDER BY id')).toEqual([
      { id: 'c1', title: 'Valise voyage', date: '2026-10-05', is_template: 1, icon: null, hlc: 'h1' },
      { id: 'c2', title: 'Supprimée', date: null, is_template: 0, icon: null, hlc: 'h2' },
    ]);
    expect(await db.select('SELECT text, checked FROM checklist_item')).toEqual([{ text: 'Passeport', checked: 1 }]);
  });

  it('base neuve : la colonne existe et accepte une icône', async () => {
    await migrate(db, migrations);
    await db.execute(`INSERT INTO checklist (id, space_id, title, icon, created_at, updated_at, device_id, hlc) VALUES ('c1', ?, 'Courses', 'lucide:shopping-cart', 'z', 'z', 'd', 'h')`, [SPACE_PRO_ID]);
    expect(await db.select('SELECT icon FROM checklist')).toEqual([{ icon: 'lucide:shopping-cart' }]);
  });
});
