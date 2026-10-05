import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver, SqlParams } from '../../../../src/db/driver';
import { createDataAccess, createSqlRepositories, type DataAccess } from '../../../../src/db/repositories';
import { openTestDb, type TestDb } from '../../../../src/db/repositories/sql/testSetup';
import { acceptsUnknownFrom } from '../../../../src/domain/sync/compat';
import type { SyncField, SyncOp } from '../../../../src/domain/sync/format';
import { journalRecordToText, parseJournalRecord } from '../../../../src/domain/sync/parse';
import type { DeviceId, Hlc, IsoDateTime } from '../../../../src/domain/types';
import { applyOps, type ApplyContext } from '../../../../src/sync/apply';
import { guarded } from '../../../../src/sync/guarded';
import { createMemorySyncLogger } from '../../../../src/sync/log';

/**
 * Recette de ce que le lot Y2 a livré pour Y-07 (critères 1 à 4 ; ADR 0011 §7.2, §8, §3.3) : `apply.ts` garde ou refuse les champs,
 * tables et clés de réglage inconnus selon la même règle que `compat.ts` (test d'équivalence : `apply.ts` n'est pas modifié), noms
 * soumis à l'expression stricte, valeurs refusées par le type du catalogue, réglages locaux toujours refusés.
 */

const SELF = '60000000-0000-4000-8000-0000000000f1' as DeviceId;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRO = '00000000-0000-4000-8000-000000000001';
const AT = '2026-10-05T08:00:00.000Z' as IsoDateTime;
const LOCAL_SV = 17;
const h = (ms: number): Hlc => `${String(1_791_187_200_000 + ms).padStart(15, '0')}-0000-${A}` as Hlc;

let db: TestDb;
let logger: ReturnType<typeof createMemorySyncLogger>;
const op = (t: string, id: string, fields: Record<string, SyncField>): SyncOp => ({ t, id, at: AT, f: new Map(Object.entries(fields)) });
const apply = (ops: SyncOp[], remoteSv: number, data: DataAccess = db.data) =>
  guarded(data, (repos) => applyOps(repos, ops, { localSv: LOCAL_SV, remoteSv, now: AT, knows: () => false, logger } satisfies ApplyContext));

function fullTask(id: string, hlc: Hlc, extra: Record<string, SyncField> = {}): SyncOp {
  const v = (value: string | number | null): SyncField => [value, hlc, null];
  return op('task', id, {
    space_id: v(PRO),
    project_id: v(null),
    title: v('Reçue'),
    note: v(''),
    date: v('2026-10-05'),
    time: v(null),
    status: v('todo'),
    done_at: v(null),
    sort_order: v(1),
    carried_over: v(0),
    recurrence_id: v(null),
    series_index: v(null),
    goal_id: v(null),
    icon: v(null),
    someday: v(0),
    source: v('local'),
    external_id: v(null),
    series_template: v(null),
    external_event_id: v(null),
    created_at: v(AT),
    deleted_at: v(null),
    ...extra,
  });
}

const idOf = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const kept = async (table: string, rowId: string) => db.driver.select('SELECT field, sv FROM sync_unknown WHERE table_name = ? AND row_id = ? ORDER BY field', [table, rowId]);

beforeEach(async () => {
  db = await openTestDb(SELF, AT);
  logger = createMemorySyncLogger();
});
afterEach(() => db.close());

describe('équivalence apply.ts / compat.ts (Y-07 critère 1)', () => {
  it('pour tout sv distant (1 à 20) : champ, table et clé de réglage inconnus gardés si et seulement si compat le dit', async () => {
    for (let sv = 1; sv <= 20; sv += 1) {
      const id = idOf(sv);
      const expected = acceptsUnknownFrom(LOCAL_SV, sv);
      await apply([fullTask(id, h(sv), { future_col: ['f', h(sv), null] }), op('future_table', id, { a: ['b', h(sv), null] }), op('settings', `future.option${String(sv)}`, { value: ['true', h(sv), null] })], sv);
      expect((await kept('task', id)).length > 0, `champ, sv ${String(sv)}`).toBe(expected);
      expect((await kept('future_table', id)).length > 0, `table, sv ${String(sv)}`).toBe(expected);
      expect((await kept('settings', `future.option${String(sv)}`)).length > 0, `réglage, sv ${String(sv)}`).toBe(expected);
      // Les champs connus sont appliqués dans tous les cas.
      expect(await db.driver.select('SELECT title FROM task WHERE id = ?', [id])).toEqual([{ title: 'Reçue' }]);
    }
    expect(acceptsUnknownFrom(LOCAL_SV, LOCAL_SV + 1)).toBe(true);
  });
});

describe('champs inconnus d’une version plus récente (Y-07 critère 2)', () => {
  it('rangés par paramètres liés avec la règle de hlc ordinaire : la valeur au plus grand hlc est gardée, quel que soit l’ordre d’arrivée', async () => {
    const id = idOf(1);
    await apply([fullTask(id, h(1))], LOCAL_SV);
    await apply([op('task', id, { future_col: ['récente', h(30), null] })], LOCAL_SV + 1);
    await apply([op('task', id, { future_col: ['ancienne', h(20), null] })], LOCAL_SV + 1);
    await apply([op('task', id, { future_col: ['récente', h(30), null] })], LOCAL_SV + 1);
    expect(await db.driver.select('SELECT value, hlc FROM sync_unknown WHERE row_id = ?', [id])).toEqual([{ value: '"récente"', hlc: h(30) }]);
  });

  it('valeur refusée par le type du catalogue (colonne connue) : gardée à part, la colonne locale est intacte', async () => {
    const id = idOf(2);
    await apply([fullTask(id, h(1))], LOCAL_SV);
    await apply([op('task', id, { status: ['peut-être', h(5), h(1)], title: ['Nouveau', h(5), h(1)] })], LOCAL_SV + 1);
    expect(await db.driver.select('SELECT status, title FROM task WHERE id = ?', [id])).toEqual([{ status: 'todo', title: 'Nouveau' }]);
    expect(await db.driver.select('SELECT field, value FROM sync_unknown WHERE row_id = ?', [id])).toEqual([{ field: 'status', value: '"peut-être"' }]);
  });

  it('colonnes techniques, locales ou de clé : jamais gardées, même d’une version plus récente', async () => {
    const id = idOf(3);
    await apply([fullTask(id, h(1), { hlc: ['x', h(1), null], discarded: [1, h(1), null], id: ['y', h(1), null] })], LOCAL_SV + 1);
    expect(await kept('task', id)).toEqual([]);
    expect(await db.driver.select('SELECT discarded FROM task WHERE id = ?', [id])).toEqual([{ discarded: 0 }]);
  });

  it('nom hors de ^[a-z][a-z0-9_]{0,62}$ : l’enregistrement entier est refusé à l’analyse (rien n’est appliqué)', () => {
    const good = fullTask(idOf(4), h(1));
    for (const bad of ['Future', 'future-col', '_x', '1x', 'x'.repeat(64), 'é']) {
      const asField = journalRecordToText({ k: 'ops', sv: 18, ops: [{ ...good, f: new Map([...good.f, [bad, ['v', h(1), null] as SyncField]]) }] });
      expect(parseJournalRecord(asField), `champ ${bad}`).toBeNull();
      const asTable = journalRecordToText({ k: 'ops', sv: 18, ops: [good, op(bad, idOf(4), { a: ['v', h(1), null] })] });
      expect(parseJournalRecord(asTable), `table ${bad}`).toBeNull();
    }
    expect(parseJournalRecord(journalRecordToText({ k: 'ops', sv: 18, ops: [good] }))).not.toBeNull();
    expect(parseJournalRecord(journalRecordToText({ k: 'ops', sv: 18, ops: [{ ...good, f: new Map([...good.f, ['x'.repeat(63), ['v', h(1), null] as SyncField]]) }] }))).not.toBeNull();
  });

  it('un espion sur execute ne voit jamais un nom reçu (table, champ ni clé de réglage)', async () => {
    const sqls: string[] = [];
    const spy: SqlDriver = {
      ...db.driver,
      execute: (sql: string, params?: SqlParams) => (sqls.push(sql), db.driver.execute(sql, params)),
      select: (sql: string, params?: SqlParams) => (sqls.push(sql), db.driver.select(sql, params)),
      transaction: (fn) => db.driver.transaction((tx) => fn({ execute: (sql, params) => (sqls.push(sql), tx.execute(sql, params)), select: (sql, params) => (sqls.push(sql), tx.select(sql, params)) })),
    };
    const data = createDataAccess(spy, { next: () => ({ at: AT, deviceId: SELF, hlc: h(0) }) }, createSqlRepositories);
    await apply([fullTask(idOf(5), h(1), { zzfield: ['v', h(1), null] }), op('zztable', idOf(5), { zzcol: ['v', h(1), null] }), op('settings', 'zzkey.option', { value: ['1', h(1), null] })], LOCAL_SV + 1, data);
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.some((sql) => sql.includes('zz'))).toBe(false);
    expect(await db.driver.select("SELECT COUNT(*) AS n FROM sync_unknown WHERE table_name IN ('task', 'zztable', 'settings')")).toEqual([{ n: 3 }]);
  });
});

describe('champ inconnu d’une version égale ou plus ancienne (Y-07 critère 3)', () => {
  it.each([LOCAL_SV, LOCAL_SV - 1, 1])('sv %i : refusé, journalisé sans contenu (table et motif seulement), absent de sync_unknown', async (sv) => {
    const id = idOf(10 + sv);
    await apply([fullTask(id, h(1), { future_col: ['secret', h(1), null] })], sv);
    expect(await kept('task', id)).toEqual([]);
    const entries = logger.entries.filter((e) => e.event === 'apply-rejected');
    expect(entries).toEqual([expect.objectContaining({ detail: { table: 'task', reason: 'unknown-field' } })]);
    expect(JSON.stringify(logger.entries)).not.toMatch(/secret|future_col/);
  });
});

describe('clés de réglage inconnues (Y-07 critère 4)', () => {
  it('acceptées seulement si la clé respecte l’expression ET le sv distant est supérieur ; rangées à part, jamais dans settings', async () => {
    const accepted = ['future.option', 'future.subKey.leaf', 'a.b.c.d'];
    const refused = ['Future.option', 'future', 'a.b.c.d.e', 'future.Option', 'future.__proto__', 'future.op-tion', 'future..option'];
    await apply([...accepted, ...refused].map((key) => op('settings', key, { value: ['true', h(1), null] })), LOCAL_SV + 1);
    const rows = await db.driver.select<{ row_id: string }>("SELECT row_id FROM sync_unknown WHERE table_name = 'settings' ORDER BY row_id");
    expect(rows.map((r) => r.row_id)).toEqual([...accepted].sort());
    const inSettings = await db.driver.select<{ key: string }>('SELECT key FROM settings');
    for (const key of [...accepted, ...refused]) expect(inSettings.some((r) => r.key === key), key).toBe(false);
    // Même clé valide, sv égal : refusée.
    await apply([op('settings', 'other.option', { value: ['true', h(2), null] })], LOCAL_SV);
    expect(await kept('settings', 'other.option')).toEqual([]);
  });

  it('clé de portée locale : toujours refusée, même d’une version plus récente', async () => {
    const before = await db.driver.select("SELECT value FROM settings WHERE key = 'device.id'");
    await apply([op('settings', 'device.id', { value: ['"pirate"', h(1), null] })], LOCAL_SV + 5);
    expect(await db.driver.select("SELECT value FROM settings WHERE key = 'device.id'")).toEqual(before);
    expect(await kept('settings', 'device.id')).toEqual([]);
    expect(logger.entries.some((e) => e.detail['reason'] === 'local-setting')).toBe(true);
  });
});
