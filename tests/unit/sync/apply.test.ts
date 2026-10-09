import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SqlDriver, SqlParams } from '../../../src/db/driver';
import { createDataAccess, createSqlRepositories, type DataAccess } from '../../../src/db/repositories';
import { openTestDb, type TestDb } from '../../../src/db/repositories/sql/testSetup';
import type { SyncField, SyncOp } from '../../../src/domain/sync/format';
import { routineLogId } from '../../../src/domain/sync/naturalIds';
import type { DeviceId, Hlc, IsoDateTime, LocalDate, RoutineId } from '../../../src/domain/types';
import { applyOps, type ApplyContext } from '../../../src/sync/apply';
import { guarded } from '../../../src/sync/guarded';
import { createMemorySyncLogger } from '../../../src/sync/log';
import { runRepairs } from '../../../src/sync/repair';
import type { SyncDeps } from '../../../src/sync/deps';

/**
 * Application des opérations reçues (ADR 0011, sections 3.3, 4, 5.4, 7.2, 8 ; Y-02 critères 6 et 8, Y-09 critères 1, 4 et 5) :
 * identifiants SQL du seul catalogue, réglages locaux refusés, champs inconnus, traces de suppression, mise de côté, réparations.
 */

const SELF = '60000000-0000-4000-8000-0000000000c1' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRO = '00000000-0000-4000-8000-000000000001';
const AT = '2026-10-05T08:00:00.000Z' as IsoDateTime;
const h = (ms: number, dev = B): Hlc => `${String(1_791_187_200_000 + ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const T1 = '11111111-1111-4111-8111-111111111111';

let db: TestDb;
let logger: ReturnType<typeof createMemorySyncLogger>;
const ctx = (extra: Partial<ApplyContext> = {}): ApplyContext => ({ localSv: 18, remoteSv: 18, now: AT, knows: () => false, logger, ...extra });
const op = (t: string, id: string, fields: Record<string, SyncField>): SyncOp => ({ t, id, at: AT, f: new Map(Object.entries(fields)) });
const apply = (data: DataAccess, ops: SyncOp[], extra: Partial<ApplyContext> = {}) => guarded(data, (repos) => applyOps(repos, ops, ctx(extra)));

function taskOp(id: string, hlc: Hlc, title = 'Reçue'): SyncOp {
  const f: Record<string, SyncField> = {
    space_id: [PRO, hlc, null],
    project_id: [null, hlc, null],
    title: [title, hlc, null],
    note: ['', hlc, null],
    date: ['2026-10-05', hlc, null],
    time: [null, hlc, null],
    status: ['todo', hlc, null],
    done_at: [null, hlc, null],
    sort_order: [1, hlc, null],
    carried_over: [0, hlc, null],
    recurrence_id: [null, hlc, null],
    series_index: [null, hlc, null],
    goal_id: [null, hlc, null],
    icon: [null, hlc, null],
    someday: [0, hlc, null],
    source: ['local', hlc, null],
    external_id: [null, hlc, null],
    series_template: [null, hlc, null],
    external_event_id: [null, hlc, null],
    apple_list_id: [null, hlc, null],
    apple_recurring: [0, hlc, null],
    created_at: [AT, hlc, null],
    deleted_at: [null, hlc, null],
  };
  return op('task', id, f);
}

beforeEach(async () => {
  db = await openTestDb(SELF, AT);
  logger = createMemorySyncLogger();
});
afterEach(() => db.close());

describe('application (Y-02 critère 6)', () => {
  it('aucun nom reçu n’atteint le SQL (espion sur execute/select) ; champs inconnus d’une version plus récente rangés par paramètres liés', async () => {
    const sqls: string[] = [];
    const spy: SqlDriver = {
      ...db.driver,
      execute: (sql: string, params?: SqlParams) => (sqls.push(sql), db.driver.execute(sql, params)),
      select: (sql: string, params?: SqlParams) => (sqls.push(sql), db.driver.select(sql, params)),
      transaction: (fn) =>
        db.driver.transaction((tx) =>
          fn({ execute: (sql, params) => (sqls.push(sql), tx.execute(sql, params)), select: (sql, params) => (sqls.push(sql), tx.select(sql, params)) }),
        ),
    };
    const data = createDataAccess(spy, { next: () => ({ at: AT, deviceId: SELF, hlc: h(0, SELF) }) }, createSqlRepositories);
    const evil = op('evil_table', T1, { evil_col: ['x', h(1), null] });
    const evilField = { ...taskOp(T1, h(2)), f: new Map([...taskOp(T1, h(2)).f, ['evil_col', ['y', h(2), null] as SyncField]]) };
    await apply(data, [evil, evilField], { remoteSv: 19 });
    expect(sqls.some((sql) => sql.includes('evil'))).toBe(false);
    expect(await db.driver.select('SELECT table_name, field, value, sv FROM sync_unknown ORDER BY table_name')).toEqual([
      { table_name: 'evil_table', field: 'evil_col', value: '"x"', sv: 19 },
      { table_name: 'task', field: 'evil_col', value: '"y"', sv: 19 },
    ]);
    expect(await db.driver.select('SELECT title FROM task')).toEqual([{ title: 'Reçue' }]);
  });

  it('champ inconnu d’une version égale ou plus ancienne : refusé et journalisé (invalid-field) ; valeur hors type : refusée', async () => {
    const withUnknown = { ...taskOp(T1, h(1)), f: new Map([...taskOp(T1, h(1)).f, ['ghost', ['x', h(1), null] as SyncField]]) };
    await apply(db.data, [withUnknown]);
    expect(await db.driver.select('SELECT * FROM sync_unknown')).toEqual([]);
    expect(logger.entries.some((e) => e.event === 'apply-rejected' && e.detail['reason'] === 'unknown-field')).toBe(true);
    await apply(db.data, [op('task', T1, { status: ['peut-être', h(2), h(1)] })]);
    expect(await db.driver.select('SELECT status FROM task')).toEqual([{ status: 'todo' }]);
    expect(logger.entries.some((e) => e.detail['reason'] === 'invalid-field')).toBe(true);
  });

  it('réglage local reçu : refusé et journalisé ; clé partagée appliquée ; clé inconnue d’une version plus récente rangée à part', async () => {
    await apply(db.data, [
      op('settings', 'device.id', { value: ['"x"', h(1), null] }),
      op('settings', 'general.locale', { value: ['"en"', h(1), null] }),
      op('settings', 'future.option', { value: ['true', h(1), null] }),
    ], { remoteSv: 19 });
    const rows = await db.driver.select<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key IN ('device.id', 'general.locale', 'future.option')");
    expect(rows.find((r) => r.key === 'general.locale')?.value).toBe('"en"');
    expect(rows.find((r) => r.key === 'device.id')?.value).not.toBe('"x"');
    expect(rows.some((r) => r.key === 'future.option')).toBe(false);
    expect(await db.driver.select("SELECT row_id FROM sync_unknown WHERE table_name = 'settings'")).toEqual([{ row_id: 'future.option' }]);
    expect(logger.entries.some((e) => e.detail['reason'] === 'local-setting')).toBe(true);
  });

  it('rejouer un lot est sans effet ; un hlc inférieur ou égal ne change rien ; aucune entrée dans la file', async () => {
    await apply(db.data, [taskOp(T1, h(5), 'v5')]);
    await apply(db.data, [taskOp(T1, h(5), 'v5'), op('task', T1, { title: ['ancienne', h(4), null] })]);
    expect(await db.driver.select('SELECT title, hlc FROM task')).toEqual([{ title: 'v5', hlc: h(5) }]);
    expect(await db.driver.select('SELECT * FROM sync_outbox')).toEqual([]);
    expect(await db.driver.select('SELECT * FROM sync_guard')).toEqual([]);
  });

  it('ligne absente et opération partielle, ou parent absent : mise de côté (sync_parked)', async () => {
    await apply(db.data, [op('task', T1, { title: ['partielle', h(1), h(0)] })]);
    const child = taskOp('22222222-2222-4222-8222-222222222222', h(2));
    const withParent = { ...child, f: new Map([...child.f, ['project_id', ['33333333-3333-4333-8333-333333333333', h(2), null] as SyncField]]) };
    await apply(db.data, [withParent]);
    expect(await db.driver.select('SELECT reason, table_name FROM sync_parked ORDER BY id')).toEqual([
      { reason: 'missing-row', table_name: 'task' },
      { reason: 'missing-parent', table_name: 'task' },
    ]);
  });

  it('ligne créée puis modifiée avant publication (une opération par horloge de champ) : recomposée, même en lots séparés', async () => {
    const full = taskOp(T1, h(1));
    const first = { ...full, f: new Map([...full.f].filter(([name]) => name !== 'title' && name !== 'deleted_at')) };
    await apply(db.data, [first]);
    expect(await db.driver.select('SELECT id FROM task')).toEqual([]);
    await apply(db.data, [op('task', T1, { title: ['Titre', h(2), null] }), op('task', T1, { deleted_at: [null, h(3), null] })]);
    expect(await db.driver.select('SELECT title, hlc FROM task')).toEqual([{ title: 'Titre', hlc: h(3) }]);
    expect(await db.driver.select('SELECT * FROM sync_parked')).toEqual([]);
  });

  it('sync_guard vide après chaque transaction, y compris en échec', async () => {
    await expect(guarded(db.data, async () => Promise.reject(new Error('échec')))).rejects.toThrow('échec');
    expect(await db.driver.select('SELECT * FROM sync_guard')).toEqual([]);
    await db.driver.execute('INSERT INTO sync_guard (id) VALUES (1)');
    expect(await db.data.repos.sync.assertGuardEmpty()).toBe(1);
    expect(await db.driver.select('SELECT * FROM sync_guard')).toEqual([]);
  });
});

describe('traces de suppression (Y-09 critères 4 et 5)', () => {
  it('une opération au hlc inférieur ou égal à la trace ne ressuscite rien ; un UUID n’est jamais recréé', async () => {
    await db.data.repos.sync.insertTombstones([{ table: 'task', rowId: T1, deletedHlc: h(10) }], AT);
    await apply(db.data, [taskOp(T1, h(9))]);
    await apply(db.data, [taskOp(T1, h(11))]);
    expect(await db.driver.select('SELECT id FROM task')).toEqual([]);
    expect(logger.entries.some((e) => e.event === 'apply-abandoned' && e.detail['reason'] === 'purged')).toBe(true);
  });

  it('identifiant naturel : une recréation complète plus récente est acceptée et retire la trace', async () => {
    const R = '44444444-4444-4444-8444-444444444444' as RoutineId;
    await db.driver.execute(`INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Lire', 'daily', '2026-10-01', ?, ?, ?, ?)`, [R, PRO, AT, AT, SELF, h(0, SELF)]);
    const id = routineLogId(R, '2026-10-03' as LocalDate);
    await db.data.repos.sync.insertTombstones([{ table: 'routine_log', rowId: id, deletedHlc: h(10) }], AT);
    const recreate = (hlc: Hlc) => op('routine_log', id, { routine_id: [R, hlc, null], date: ['2026-10-03', hlc, null], done_at: [AT, hlc, null], created_at: [AT, hlc, null], deleted_at: [null, hlc, null] });
    await apply(db.data, [recreate(h(8))]);
    expect(await db.driver.select('SELECT id FROM routine_log')).toEqual([]);
    await apply(db.data, [recreate(h(12))]);
    expect(await db.driver.select('SELECT id FROM routine_log')).toEqual([{ id }]);
    expect(await db.driver.select('SELECT * FROM sync_tombstone')).toEqual([]);
  });

  it('suppression contre modification : la suppression la plus récente gagne, l’autre champ est fusionné, conflit sur deleted_at', async () => {
    await apply(db.data, [taskOp(T1, h(1))]);
    // Modification locale (non publiée) du titre, puis suppression reçue plus récente qui ne l'a pas vue.
    await db.driver.execute("UPDATE task SET title = 'Modifiée ici', hlc = ? WHERE id = ?", [h(2, SELF), T1]);
    await apply(db.data, [op('task', T1, { deleted_at: [AT, h(3), h(1)] })]);
    expect(await db.driver.select('SELECT title, deleted_at IS NOT NULL AS deleted FROM task')).toEqual([{ title: 'Modifiée ici', deleted: 1 }]);
    expect(await db.driver.select('SELECT field, discarded_value FROM conflict_log')).toEqual([{ field: 'deleted_at', discarded_value: '"modified"' }]);
  });
});

describe('réparations après un lot (Y-02 critère 8)', () => {
  it('routine.paused recalculé depuis routine_pause, sans entrée de file ; une seule session Focus ouverte, valeur déterministe', async () => {
    const R = '55555555-5555-4555-8555-555555555555';
    await apply(db.data, [
      op('routine', R, {
        space_id: [PRO, h(1), null], title: ['Courir', h(1), null], icon: [null, h(1), null], schedule_type: ['daily', h(1), null], weekdays: ['[]', h(1), null],
        times_per_week: [null, h(1), null], interval: [null, h(1), null], start_date: ['2026-10-01', h(1), null], time: [null, h(1), null], archived: [0, h(1), null],
        created_at: [AT, h(1), null], deleted_at: [null, h(1), null],
      }),
      op('routine_pause', '66666666-6666-4666-8666-666666666666', { routine_id: [R, h(2), null], from_date: ['2026-10-04', h(2), null], to_date: [null, h(2), null], created_at: [AT, h(2), null], deleted_at: [null, h(2), null] }),
    ]);
    const focus = (id: string, startedAt: string, hlc: Hlc) =>
      op('focus_session', id, { task_id: [null, hlc, null], space_id: [PRO, hlc, null], planned_min: [25, hlc, null], started_at: [startedAt, hlc, null], ended_at: [null, hlc, null], paused_sec: [0, hlc, null], paused_at: [null, hlc, null], project_id: [null, hlc, null], created_at: [AT, hlc, null], deleted_at: [null, hlc, null] });
    const result = await apply(db.data, [focus('77777777-7777-4777-8777-777777777771', '2026-10-05T07:00:00.000Z', h(3)), focus('77777777-7777-4777-8777-777777777772', '2026-10-05T07:30:00.000Z', h(4))]);
    const deps = { data: db.data } as SyncDeps;
    await runRepairs(deps, new Map([['routine_pause', new Set(['66666666-6666-4666-8666-666666666666'])], ...result.touched]));
    expect(await db.driver.select('SELECT paused FROM routine')).toEqual([{ paused: 1 }]);
    expect(await db.driver.select("SELECT * FROM sync_outbox WHERE table_name = 'routine'")).toEqual([]);
    expect(await db.driver.select('SELECT id, ended_at FROM focus_session ORDER BY id')).toEqual([
      { id: '77777777-7777-4777-8777-777777777771', ended_at: '2026-10-05T07:30:00.000Z' },
      { id: '77777777-7777-4777-8777-777777777772', ended_at: null },
    ]);
    // La clôture est une écriture locale publiée.
    expect(await db.driver.select("SELECT field FROM sync_outbox WHERE table_name = 'focus_session'")).toEqual([{ field: 'ended_at' }]);
  });
});
