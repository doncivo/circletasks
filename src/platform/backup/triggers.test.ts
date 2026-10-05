import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { asEntityId, type DeviceId } from '../../domain/types';

const compact = (sql: string): string => sql.split(/\s+/).filter(Boolean).join(' ');

/**
 * P-04 : `REFERENCE_TRIGGERS` de `src-tauri/src/backup_triggers.rs` (déclencheurs admis dans une base à restaurer, et recréés après une
 * restauration) doit être exactement ce que créent les migrations : même nom, même table, même SQL (espaces compactés). Sinon une
 * sauvegarde saine serait refusée, ou un déclencheur au corps modifié admis.
 */
describe('Déclencheurs de référence d’une sauvegarde (P-04)', () => {
  it('la référence de Rust est identique à sqlite_master après les migrations de l’app, et il n’y a aucune vue', async () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../src-tauri/src/backup_triggers.rs'), 'utf8');
    const block = /REFERENCE_TRIGGERS: \[\(&str, &str, &str\); (\d+)\] = \[([\s\S]*)\];\s*$/.exec(source);
    expect(block).not.toBeNull();
    const entries = [...(block?.[2] ?? '').matchAll(/\("([a-z_]+)", "([a-z_]+)", r##"([\s\S]*?)"##\)/g)].map((match) => ({
      name: match[1] ?? '',
      table: match[2] ?? '',
      sql: compact(match[3] ?? ''),
    }));
    expect(entries).toHaveLength(Number(block?.[1]));
    const db = await openTestDb(asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b9'));
    try {
      const rows = await db.driver.select<{ name: string; tbl_name: string; sql: string }>("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
      const actual = rows.map((row) => ({ name: row.name, table: row.tbl_name, sql: compact(row.sql) }));
      expect(entries).toEqual(actual);
      expect(await db.driver.select("SELECT name FROM sqlite_master WHERE type = 'view'")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
