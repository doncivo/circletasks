import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { SPACE_PRO_ID } from '../seed/defaultSpaces';
import { migrations } from './index';

const insert = (db: SqlDriver, id: string, key: string, over: { source?: string; overridden?: number; date?: string } = {}) =>
  db.execute(
    `INSERT INTO holiday (id, country, year, key, date, name, kind, source, overridden, created_at, updated_at, device_id, hlc) VALUES (?, 'TN', 2026, ?, ?, ?, 'lunar', ?, ?, 'z', 'z', 'd', 'h')`,
    [id, key, over.date ?? '2026-03-20', key, over.source ?? 'table', over.overridden ?? 0],
  );

describe('migration 0010 (E-03) : table holiday sur une base 0001→9 peuplée', () => {
  let db: SqlDriver;
  beforeEach(async () => {
    db = await openSqliteWasmDriver();
  });
  afterEach(() => db.close());

  it('crée la table sans toucher aux données existantes, rejouable sans effet', async () => {
    await migrate(db, migrations.slice(0, 9));
    await db.execute(
      `INSERT INTO event (id, space_id, title, start_date, end_date, created_at, updated_at, device_id, hlc) VALUES ('e1', ?, 'Comité', '2026-10-05', '2026-10-05', 'z', 'z', 'd', 'h')`,
      [SPACE_PRO_ID],
    );
    await db.execute(`INSERT INTO reminder (id, target_type, target_id, offset_min, fire_at, created_at, updated_at, device_id, hlc) VALUES ('r1', 'event', 'e1', 10080, '2026-09-28T09:00', 'z', 'z', 'd', 'h')`);

    expect((await migrate(db, migrations)).applied).toEqual(migrations.slice(9).map((m) => m.version));
    expect((await migrate(db, migrations)).applied).toEqual([]);

    expect(await db.select('SELECT id, title FROM event')).toEqual([{ id: 'e1', title: 'Comité' }]);
    expect(await db.select('SELECT offset_min FROM reminder')).toEqual([{ offset_min: 10080 }]);
    expect(await db.select('SELECT COUNT(*) AS n FROM holiday')).toEqual([{ n: 0 }]);
    const columns = await db.select<{ name: string }>("SELECT name FROM pragma_table_info('holiday') ORDER BY cid");
    expect(columns.map((c) => c.name)).toEqual(['id', 'country', 'year', 'key', 'date', 'name', 'kind', 'source', 'overridden', 'created_at', 'updated_at', 'deleted_at', 'device_id', 'hlc']);
  });

  it('une fête par pays, année et clé ; pays, genre et source contrôlés', async () => {
    await migrate(db, migrations);
    await insert(db, 'h1', 'eidAlFitr');
    await expect(insert(db, 'h2', 'eidAlFitr')).rejects.toThrow();
    await insert(db, 'h3', 'eidAlAdha', { source: 'manual', overridden: 1, date: '2026-05-28' });
    await expect(db.execute(`INSERT INTO holiday (id, country, year, key, date, name, kind, created_at, updated_at, device_id, hlc) VALUES ('x', 'DE', 2026, 'k', '2026-01-01', 'k', 'fixed', 'z', 'z', 'd', 'h')`)).rejects.toThrow();
    await expect(db.execute(`INSERT INTO holiday (id, country, year, key, date, name, kind, source, created_at, updated_at, device_id, hlc) VALUES ('y', 'FR', 2026, 'k', '2026-01-01', 'k', 'fixed', 'api', 'z', 'z', 'd', 'h')`)).rejects.toThrow();
    expect(await db.select('SELECT key, source, overridden FROM holiday ORDER BY key')).toEqual([
      { key: 'eidAlAdha', source: 'manual', overridden: 1 },
      { key: 'eidAlFitr', source: 'table', overridden: 0 },
    ]);
  });
});
