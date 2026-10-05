import { afterEach, describe, expect, it } from 'vitest';
import type { IsoDateTime } from '../../../src/domain/types';
import type { DeviceId } from '../../../src/domain/types';
import { openTestDb, type TestDb } from '../../../src/db/repositories/sql/testSetup';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../sim/syncDevice';

/**
 * Plafonds de la section 1.6 appliqués à l'entretien (Y-02 critère 20) : `sync_parked` (10 000, hors `epoch-carry`, jamais abandonné),
 * `sync_unknown` (50 000 champs), `conflict_log` (10 000 lignes et 12 mois) ; l'abandon est journalisé (table, identifiant, motif),
 * jamais le contenu.
 */

const SELF = '60000000-0000-4000-8000-0000000000c1' as DeviceId;
const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let db: TestDb | null = null;
let devices: SimDevice[] = [];
afterEach(async () => {
  await db?.close();
  db = null;
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

const CAPS = { parked: 10_000, unknownFields: 50_000, unknownBytes: 16 * 1_048_576, conflicts: 10_000, conflictsBefore: '2025-10-05T00:00:00.000Z' as IsoDateTime };

/** Insère `count` lignes numérotées de 1 à `count` par une seule requête (série récursive). */
const series = (count: number): string => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(count)})`;

describe('plafonds (Y-02 critère 20)', () => {
  it('sync_parked : 10 000 au plus hors epoch-carry, les plus anciennes partent, epoch-carry jamais abandonné même au-delà', async () => {
    db = await openTestDb(SELF);
    await db.driver.execute(`${series(10_005)} INSERT INTO sync_parked (reason, table_name, row_id, hlc, op, parked_at) SELECT 'missing-row', 'task', 'r' || i, 'h', '{}', '2026-10-05T00:00:00.000Z' FROM n`);
    await db.driver.execute(`${series(10_100)} INSERT INTO sync_parked (reason, table_name, row_id, hlc, op, parked_at) SELECT 'epoch-carry', 'task', 'c' || i, 'h', '{}', '2026-10-05T00:00:00.000Z' FROM n`);
    const dropped = await db.data.repos.sync.enforceCaps(CAPS);
    const parkedDropped = dropped.filter((d) => d.kind === 'parked');
    expect(parkedDropped).toHaveLength(5);
    expect(parkedDropped.every((d) => d.reason === 'missing-row')).toBe(true);
    expect(parkedDropped.map((d) => d.rowId).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(await db.driver.select("SELECT COUNT(*) AS n FROM sync_parked WHERE reason = 'missing-row'")).toEqual([{ n: 10_000 }]);
    expect(await db.driver.select("SELECT COUNT(*) AS n FROM sync_parked WHERE reason = 'epoch-carry'")).toEqual([{ n: 10_100 }]);
  });

  it('sync_unknown : 50 000 champs au plus, les plus anciens (hlc) partent d’abord', async () => {
    db = await openTestDb(SELF);
    await db.driver.execute(`${series(50_003)} INSERT INTO sync_unknown (table_name, row_id, field, value, hlc, base_hlc, sv) SELECT 'task', 'r' || i, 'zz_futur', '"x"', printf('%015d-0000-${SELF}', i), NULL, 99 FROM n`);
    const dropped = await db.data.repos.sync.enforceCaps(CAPS);
    expect(dropped.filter((d) => d.kind === 'unknown')).toHaveLength(3);
    expect(await db.driver.select('SELECT COUNT(*) AS n FROM sync_unknown')).toEqual([{ n: 50_000 }]);
    expect(await db.driver.select("SELECT COUNT(*) AS n FROM sync_unknown WHERE row_id IN ('r1', 'r2', 'r3')")).toEqual([{ n: 0 }]);
  });

  it('conflict_log : au-delà de 12 mois supprimé ; au-delà de 10 000 lignes, les résolues partent avant les non résolues', async () => {
    const open = await openTestDb(SELF);
    db = open;
    const insert = (where: string, detected: string, resolved: string): Promise<unknown> =>
      open.driver.execute(`${series(10_000)} INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, detected_at, resolved_at) SELECT 'task', '${where}' || i, 'title', 'a', 'b', '${detected}', ${resolved} FROM n`);
    await insert('vieux', '2024-01-01T00:00:00.000Z', 'NULL');
    await insert('recent', '2026-09-01T00:00:00.000Z', 'NULL');
    await db.driver.execute("UPDATE conflict_log SET resolved_at = '2026-09-02T00:00:00.000Z' WHERE row_id IN ('recent1', 'recent2', 'recent3')");
    await db.driver.execute("INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, detected_at) VALUES ('task', 'dernier', 'title', 'a', 'b', '2026-10-01T00:00:00.000Z')");
    const dropped = await db.data.repos.sync.enforceCaps(CAPS);
    expect(dropped.filter((d) => d.kind === 'conflict' && d.reason === 'age')).toHaveLength(10_000);
    const capped = dropped.filter((d) => d.kind === 'conflict' && d.reason === 'cap');
    expect(capped.map((d) => d.rowId)).toEqual(['recent1']);
    expect(await db.driver.select('SELECT COUNT(*) AS n FROM conflict_log WHERE resolved_at IS NULL')).toEqual([{ n: 9_998 }]);
    expect(await db.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 10_000 }]);
    expect(await db.driver.select("SELECT COUNT(*) AS n FROM conflict_log WHERE row_id = 'dernier'")).toEqual([{ n: 1 }]);
  });

  it('l’entretien du cycle applique les plafonds et journalise l’abandon sans contenu (table, identifiant, motif)', async () => {
    const a = await createSimDevice(A_ID, { name: 'PC' });
    const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock });
    devices = [a, b];
    await setupFirst(a);
    await a.cycle();
    await pair(a, b);
    await b.cycle();
    syncFolders(devices);
    await a.cycle();
    await a.driver.execute(`${series(5)} INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, detected_at) SELECT 'task', 'ancien' || i, 'title', 'SECRET-GARDE', 'SECRET-ECARTE', '2020-01-01T00:00:00.000Z' FROM n`);
    await a.cycle();
    expect(await a.driver.select('SELECT COUNT(*) AS n FROM conflict_log')).toEqual([{ n: 0 }]);
    const logged = a.logger.entries.filter((e) => e.event === 'cap-dropped');
    expect(logged).toHaveLength(5);
    for (const entry of logged) {
      expect(Object.keys(entry.detail).sort()).toEqual(['id', 'kind', 'reason', 'table']);
      expect(JSON.stringify(entry)).not.toContain('SECRET');
    }
  });
});
