import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { asEntityId, type DeviceId } from '../../domain/types';

/**
 * P-04 : la liste `EXPECTED_TRIGGERS` de `src-tauri/src/backup.rs` (déclencheurs admis dans une base à restaurer) doit être exactement celle que
 * créent les migrations ; sinon une sauvegarde saine serait refusée, ou un déclencheur étranger admis.
 */
describe('Déclencheurs attendus d’une sauvegarde (P-04)', () => {
  it('la liste de Rust est celle de sqlite_master après les migrations de l’app, et il n’y a aucune vue', async () => {
    const source = readFileSync(resolve(import.meta.dirname, '../../../src-tauri/src/backup.rs'), 'utf8');
    const block = /EXPECTED_TRIGGERS: \[&str; (\d+)\] = \[([^\]]*)\]/.exec(source);
    expect(block).not.toBeNull();
    const listed = [...(block?.[2] ?? '').matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? '').sort();
    expect(listed).toHaveLength(Number(block?.[1]));
    const db = await openTestDb(asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b9'));
    try {
      const triggers = (await db.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")).map((row) => row.name).sort();
      expect(listed).toEqual(triggers);
      expect(await db.driver.select("SELECT name FROM sqlite_master WHERE type = 'view'")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
