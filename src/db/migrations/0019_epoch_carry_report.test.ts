import { describe, expect, it } from 'vitest';
import { SYNC_TABLES } from '../../domain/sync/syncTables';
import type { SqlDriver } from '../driver';
import { openSqliteWasmDriver } from '../drivers/sqliteWasm';
import { migrate } from '../migrator';
import { migration0019EpochCarryReport } from './0019_epoch_carry_report';
import { migrations } from './index';

/** Y-TECH-05 (critères 10 et 12) : table locale `epoch_carry_report`, migration 0019. */

const PRO = '00000000-0000-4000-8000-000000000001';
const DEV = '0f8fad5b-d9cb-469f-a165-70867728950e';
const h = (ms: number): string => `${String(ms).padStart(15, '0')}-0000-${DEV}`;
const AT = '2026-10-01T08:00:00.000Z';

async function dbAt(version: number): Promise<SqlDriver> {
  const db = await openSqliteWasmDriver();
  await migrate(db, migrations.slice(0, version));
  return db;
}

const EMPTY_COLUMNS = 'authors, restored, recreated, parent_replaced, overflow, overflow_by';
const EMPTY_VALUES = "'[]', '[]', '[]', '[]', 0, '{}'";
const outbox = (db: SqlDriver) => db.select('SELECT table_name, row_id, field FROM sync_outbox ORDER BY seq');

/** Toutes les tables existantes (sauf `schema_migrations` et la nouvelle) : contenu complet, pour « aucune donnée existante modifiée ». */
async function dump(db: SqlDriver): Promise<Record<string, unknown[]>> {
  const tables = await db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', 'epoch_carry_report') ORDER BY name");
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) out[name] = (await db.select(`SELECT * FROM "${name}"`)).map((row) => JSON.stringify(row)).sort();
  return out;
}

describe('migration 0019 : compte rendu du report d’époque (Y-TECH-05)', () => {
  it('numéro suivant la 0018, sans trou ; rejouable sans effet', async () => {
    expect(migration0019EpochCarryReport.version).toBe(19);
    expect(migrations.map((m) => m.version)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    const db = await dbAt(19);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    await db.close();
  });

  it('schéma exact (colonnes, types, contraintes, valeurs par défaut), base neuve', async () => {
    const db = await dbAt(19);
    const columns = await db.select<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>('PRAGMA table_info(epoch_carry_report)');
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk])).toEqual([
      ['id', 'INTEGER', 0, null, 1],
      ['epoch', 'TEXT', 1, null, 0],
      ['cause', 'TEXT', 1, null, 0],
      ['reporter', 'TEXT', 1, null, 0],
      ['opener', 'TEXT', 1, null, 0],
      ['mode', 'TEXT', 1, null, 0],
      ['authors', 'TEXT', 1, null, 0],
      ['restored', 'TEXT', 1, null, 0],
      ['recreated', 'TEXT', 1, null, 0],
      ['parent_replaced', 'TEXT', 1, null, 0],
      ['overflow', 'INTEGER', 1, null, 0],
      ['overflow_by', 'TEXT', 1, null, 0],
      ['banner', 'INTEGER', 1, null, 0],
      ['created_at', 'TEXT', 1, null, 0],
      ['acknowledged_at', 'TEXT', 0, null, 0],
    ]);
    const insert = (cause: string, mode: string, banner = 0) =>
      db.execute(`INSERT INTO epoch_carry_report (epoch, cause, reporter, opener, mode, banner, created_at, ${EMPTY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ${EMPTY_VALUES})`, ['e', cause, DEV, DEV, mode, banner, AT]);
    await insert('restore', 'replace');
    await insert('concurrent', 'replace', 1);
    await insert('reset', 'merge');
    await expect(insert('autre', 'replace')).rejects.toThrow();
    await expect(insert('restore', 'autre')).rejects.toThrow();
    await expect(insert('restore', 'replace', 2)).rejects.toThrow();
    // Aucune valeur par défaut (texte court : le registre des migrations est dans le départ) : une colonne oubliée est refusée.
    await expect(db.execute('INSERT INTO epoch_carry_report (epoch, cause, reporter, opener, mode, banner, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', ['e', 'restore', DEV, DEV, 'replace', AT])).rejects.toThrow();
    expect(await db.select('SELECT acknowledged_at FROM epoch_carry_report WHERE id = 1')).toEqual([{ acknowledged_at: null }]);
    await db.close();
  });

  it('base de version 18 peuplée : migrée sans qu’aucune donnée existante change ; table vide', async () => {
    const db = await dbAt(18);
    await db.execute('INSERT INTO task (id, space_id, title, created_at, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?, ?, ?)', ['t1', PRO, 'Facture', AT, AT, DEV, h(1)]);
    await db.execute("UPDATE task SET title = 'Facture 2', hlc = ? WHERE id = 't1'", [h(2)]);
    await db.execute('INSERT INTO sync_meta (key, value) VALUES (?, ?)', ['epochCarryNotice', '{"v":1}']);
    const before = await dump(db);
    expect(before['sync_outbox']?.length).toBeGreaterThan(0);
    expect((await migrate(db, migrations)).applied).toEqual([19]);
    expect(await dump(db)).toEqual(before);
    expect(await db.select('SELECT * FROM epoch_carry_report')).toEqual([]);
    expect(await db.select('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    await db.close();
  });

  it('table locale (critère 12) : hors du catalogue publié, aucun déclencheur, aucune écriture n’entre dans la file ni dans les horloges', async () => {
    expect(SYNC_TABLES.map((t) => t.name)).not.toContain('epoch_carry_report');
    const db = await dbAt(19);
    expect(await db.select("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'epoch_carry_report'")).toEqual([]);
    await db.execute(`INSERT INTO epoch_carry_report (epoch, cause, reporter, opener, mode, banner, created_at, ${EMPTY_COLUMNS}) VALUES (?, ?, ?, ?, ?, 0, ?, ${EMPTY_VALUES})`, ['e', 'restore', DEV, DEV, 'replace', AT]);
    await db.execute('UPDATE epoch_carry_report SET restored = ?, acknowledged_at = ? WHERE id = 1', ['[{"label":"À jeter"}]', AT]);
    expect(await outbox(db)).toEqual([]);
    expect(await db.select('SELECT * FROM sync_field_clock')).toEqual([]);
    await db.close();
  });
});
