import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlExecutor, SqlParams } from '../../../src/db/driver';
import { createSqlRepositories } from '../../../src/db/repositories';
import { openTestDb, type TestDb } from '../../../src/db/repositories/sql/testSetup';
import { createHlcClock, createWriteStamper } from '../../../src/domain/hlc';
import type { DeviceId, Hlc, IsoDateTime } from '../../../src/domain/types';

/**
 * Accès aux tables de synchro (ADR 0011 sections 1.6, 4.3 et 7.2 ; revue Y2 point 21) : conflits non réinscrits au rejeu, champs
 * inconnus paginés par `rowid` réel, plafond des champs inconnus appliqué sans boucle de recomptages, index de `sync_parked`.
 */

const SELF = '60000000-0000-4000-8000-0000000000c1' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AT = '2026-10-05T08:00:00.000Z' as IsoDateTime;
const h = (n: number): Hlc => `${String(1_791_187_200_000 + n).padStart(15, '0')}-0000-${B}` as Hlc;

let db: TestDb;
beforeEach(async () => {
  db = await openTestDb(SELF, AT);
});
afterEach(() => db.close());

describe('conflits (revue Y2, point 21)', () => {
  it('le même conflit inscrit deux fois (rejeu) n’apparaît qu’une fois ; un autre conflit du même champ s’ajoute', async () => {
    const c = { table: 'task', rowId: 'r1', field: 'title', keptValue: 'B', discardedValue: 'A', keptDevice: B, discardedDevice: SELF, keptHlc: h(2), discardedHlc: h(1) };
    await db.data.repos.sync.insertConflicts([c], AT);
    await db.data.repos.sync.insertConflicts([c], AT);
    expect(await db.data.repos.sync.countConflictsSince(AT)).toBe(1);
    await db.data.repos.sync.insertConflicts([{ ...c, keptHlc: h(3), keptValue: 'C' }], AT);
    expect(await db.data.repos.sync.countConflictsSince(AT)).toBe(2);
  });
});

describe('champs inconnus (revue Y2, point 21)', () => {
  const put = (rowId: string, field: string, n: number, value = 'v') => db.data.repos.sync.putUnknown({ table: 'task', rowId, field, value, hlc: h(n), base: null, sv: 99 });

  it('pagination par rowid réel : une insertion entre deux pages ne fait ni doublon ni oubli', async () => {
    await put('r2', 'zz_a', 1);
    await put('r3', 'zz_b', 2);
    await put('r4', 'zz_c', 3);
    const first = await db.data.repos.sync.exportUnknown(0, 2);
    await put('r1', 'zz_d', 4);
    const seen = [...first];
    let after = (first.at(-1) as { rowid: number }).rowid;
    for (;;) {
      const page = await db.data.repos.sync.exportUnknown(after, 2);
      if (page.length === 0) break;
      seen.push(...page);
      after = (page.at(-1) as { rowid: number }).rowid;
    }
    const keys = seen.map((u) => `${u.rowId}/${u.field}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(['r1/zz_d', 'r2/zz_a', 'r3/zz_b', 'r4/zz_c']);
  });

  it('plafond en octets : les plus anciens partent, en un nombre d’instructions qui ne dépend pas du nombre de champs écartés', async () => {
    for (let i = 0; i < 120; i += 1) await put(`r${String(i).padStart(3, '0')}`, 'zz_x', i, 'x'.repeat(100));
    const statements: string[] = [];
    const spy: SqlExecutor = {
      execute: (sql: string, params?: SqlParams) => (statements.push(sql), db.driver.execute(sql, params)),
      select: (sql: string, params?: SqlParams) => (statements.push(sql), db.driver.select(sql, params)),
    };
    const repos = createSqlRepositories(spy, createWriteStamper(db.clock, createHlcClock({ clock: db.clock, deviceId: SELF })));
    const dropped = await repos.sync.enforceCaps({ parked: 10_000, unknownFields: 50_000, unknownBytes: 20 * 102, conflicts: 10_000, conflictsBefore: '2025-01-01T00:00:00.000Z' as IsoDateTime });
    const unknownDropped = dropped.filter((d) => d.kind === 'unknown');
    expect(unknownDropped).toHaveLength(100);
    expect(unknownDropped.map((d) => d.rowId)).not.toContain('r119');
    const left = await db.driver.select<{ row_id: string }>('SELECT row_id FROM sync_unknown ORDER BY row_id');
    expect(left.map((r) => r.row_id)).toEqual(Array.from({ length: 20 }, (_, i) => `r${String(100 + i)}`));
    expect(statements.filter((s) => s.includes('sync_unknown')).length).toBeLessThanOrEqual(4);
  });
});

describe('index (revue Y2, point 21)', () => {
  it('sync_parked est indexé sur (reason, table_name, row_id) ; conflict_log sur (table_name, row_id, field)', async () => {
    const parked = await db.driver.select<{ name: string }>("SELECT name FROM pragma_index_list('sync_parked')");
    const parkedCols = await Promise.all(parked.map(async (i) => (await db.driver.select<{ name: string }>(`SELECT name FROM pragma_index_info('${i.name}')`)).map((c) => c.name).join(',')));
    expect(parkedCols).toContain('reason,table_name,row_id');
    const conflicts = await db.driver.select<{ name: string }>("SELECT name FROM pragma_index_list('conflict_log')");
    const conflictCols = await Promise.all(conflicts.map(async (i) => (await db.driver.select<{ name: string }>(`SELECT name FROM pragma_index_info('${i.name}')`)).map((c) => c.name).join(',')));
    expect(conflictCols).toContain('table_name,row_id,field');
  });
});
