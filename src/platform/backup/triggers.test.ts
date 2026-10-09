import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlDriver } from '../../db/driver';
import { openSqliteWasmDriver } from '../../db/drivers/sqliteWasm';
import { migrations } from '../../db/migrations';
import { migrate } from '../../db/migrator';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { asEntityId, type DeviceId } from '../../domain/types';

const compact = (sql: string): string => sql.split(/\s+/).filter(Boolean).join(' ');

const source = readFileSync(resolve(import.meta.dirname, '../../../src-tauri/src/backup_triggers.rs'), 'utf8');

/** Entrées `("nom", "table", r##"SQL"##)` d'un tableau Rust déclaré `NAME: [(...); N] = [ ... \n];`. */
function entriesOf(name: string): { readonly count: number; readonly entries: { readonly name: string; readonly table: string; readonly sql: string; readonly since?: number; readonly until?: number }[] } {
  const block = new RegExp(`${name}: \\[\\([^\\]]*\\); (\\d+)\\] = \\[([\\s\\S]*?)\\n\\];`).exec(source);
  expect(block, name).not.toBeNull();
  const entries = [...(block?.[2] ?? '').matchAll(/\("([a-z_]+)", "([a-z_]+)", r##"([\s\S]*?)"##(?:, (\d+), (\d+))?\)/g)].map((match) => ({
    name: match[1] ?? '',
    table: match[2] ?? '',
    sql: compact(match[3] ?? ''),
    ...(match[4] === undefined ? {} : { since: Number(match[4]), until: Number(match[5]) }),
  }));
  return { count: Number(block?.[1]), entries };
}

const triggersOf = async (db: SqlDriver) =>
  (await db.select<{ name: string; tbl_name: string; sql: string }>("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).map((row) => ({ name: row.name, table: row.tbl_name, sql: compact(row.sql) }));

/**
 * P-04 : `REFERENCE_TRIGGERS` de `src-tauri/src/backup_triggers.rs` (déclencheurs admis dans une base à restaurer, et recréés après une
 * restauration) doit être exactement ce que créent les migrations : même nom, même table, même SQL (espaces compactés). Sinon une
 * sauvegarde saine serait refusée, ou un déclencheur au corps modifié admis. `SUPERSEDED_TRIGGERS` garde les corps remplacés par une
 * migration ultérieure avec leur intervalle de versions (ADR 0008 §10.2) : ils doivent être ceux d'une base arrêtée à la version précédente.
 */
describe('Déclencheurs de référence d’une sauvegarde (P-04)', () => {
  it('la référence de Rust est identique à sqlite_master après les migrations de l’app, et il n’y a aucune vue', async () => {
    const { count, entries } = entriesOf('REFERENCE_TRIGGERS');
    expect(entries).toHaveLength(count);
    const db = await openTestDb(asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b9'));
    try {
      const actual = await triggersOf(db.driver);
      expect(entries.map(({ name, table, sql }) => ({ name, table, sql }))).toEqual(actual);
      expect(await db.driver.select("SELECT name FROM sqlite_master WHERE type = 'view'")).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('les corps remplacés (version 15 à 17) sont ceux d’une base arrêtée en version 17, et diffèrent de ceux d’aujourd’hui', async () => {
    const { count, entries } = entriesOf('SUPERSEDED_TRIGGERS');
    expect(entries).toHaveLength(count);
    expect(entries.map((entry) => [entry.name, entry.since, entry.until])).toEqual([
      ['sync_settings_ai', 15, 18],
      ['sync_settings_au', 15, 18],
      ['sync_task_au', 15, 18],
    ]);
    const previous = await openSqliteWasmDriver();
    const current = await openSqliteWasmDriver();
    try {
      await migrate(previous, migrations.slice(0, 17));
      await migrate(current, migrations);
      const old = await triggersOf(previous);
      const now = await triggersOf(current);
      for (const entry of entries) {
        expect(old.find((row) => row.name === entry.name)).toEqual({ name: entry.name, table: entry.table, sql: entry.sql });
        expect(now.find((row) => row.name === entry.name)?.sql, entry.name).not.toBe(entry.sql);
      }
      // Tous les autres déclencheurs de la version 17 sont inchangés en 18 (sync_task_ai ne cite aucune colonne).
      const replaced = new Set(entries.map((entry) => entry.name));
      expect(old.filter((row) => !replaced.has(row.name))).toEqual(now.filter((row) => !replaced.has(row.name)));
    } finally {
      await previous.close();
      await current.close();
    }
  });
});
