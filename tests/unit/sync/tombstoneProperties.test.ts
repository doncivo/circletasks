import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDb, type TestDb } from '../../../src/db/repositories/sql/testSetup';
import type { SyncField, SyncOp } from '../../../src/domain/sync/format';
import { routineLogId } from '../../../src/domain/sync/naturalIds';
import type { DeviceId, Hlc, IsoDateTime, LocalDate, RoutineId } from '../../../src/domain/types';
import { applyOps, type ApplyContext } from '../../../src/sync/apply';
import { guarded } from '../../../src/sync/guarded';
import { createMemorySyncLogger } from '../../../src/sync/log';
import { retryParked } from '../../../src/sync/maintenance';
import type { SyncDeps } from '../../../src/sync/deps';

/**
 * Propriétés des traces de suppression (ADR 0011, sections 4 et 5.4 ; Y-09 critères 4 et 9) : un identifiant purgé ne revient jamais avec
 * un hlc inférieur ou égal à `deleted_hlc` ; ni l'ordre d'arrivée ni la relecture d'un enregistrement ne changent le résultat.
 */

const SELF = '60000000-0000-4000-8000-0000000000c1' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRO = '00000000-0000-4000-8000-000000000001';
const AT = '2026-10-05T08:00:00.000Z' as IsoDateTime;
const h = (ms: number, dev = B): Hlc => `${String(1_791_187_200_000 + ms).padStart(15, '0')}-0000-${dev}` as Hlc;
const T1 = '11111111-1111-4111-8111-111111111111';
const R = '44444444-4444-4444-8444-444444444444' as RoutineId;
const DAY = '2026-10-03' as LocalDate;
const LOG_ID = routineLogId(R, DAY);
const TOMB = h(10);

let db: TestDb;
let logger: ReturnType<typeof createMemorySyncLogger>;
const ctx = (): ApplyContext => ({ localSv: 17, remoteSv: 17, now: AT, knows: () => false, logger });
const op = (t: string, id: string, fields: Record<string, SyncField>): SyncOp => ({ t, id, at: AT, f: new Map(Object.entries(fields)) });
const apply = (ops: SyncOp[]) => guarded(db.data, (repos) => applyOps(repos, ops, ctx()));

function taskFields(hlc: Hlc, title: string): Record<string, SyncField> {
  return {
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
    created_at: [AT, hlc, null],
    deleted_at: [null, hlc, null],
  };
}

const logFields = (hlc: Hlc, doneAt: string, deletedAt: string | null = null): Record<string, SyncField> => ({
  routine_id: [R, hlc, null],
  date: [DAY, hlc, null],
  done_at: [doneAt, hlc, null],
  created_at: [AT, hlc, null],
  deleted_at: [deletedAt, hlc, null],
});

async function seedRoutine(): Promise<void> {
  await db.driver.execute(`INSERT INTO routine (id, space_id, title, schedule_type, start_date, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Lire', 'daily', '2026-10-01', ?, ?, ?, ?)`, [R, PRO, AT, AT, SELF, h(0, SELF)]);
}

/** Remet la base dans l'état initial d'une exécution (sous garde : aucune entrée de file). */
async function reset(): Promise<void> {
  await db.driver.transaction(async (tx) => {
    await tx.execute('INSERT INTO sync_guard (id) VALUES (1)');
    for (const table of ['task', 'routine_log', 'sync_tombstone', 'sync_field_clock', 'sync_parked', 'conflict_log']) await tx.execute(`DELETE FROM ${table}`);
    await tx.execute('DELETE FROM sync_guard');
  });
}

async function finalState(): Promise<unknown> {
  return {
    logs: await db.driver.select('SELECT id, done_at, deleted_at, hlc FROM routine_log ORDER BY id'),
    tombs: await db.driver.select('SELECT table_name, row_id, deleted_hlc FROM sync_tombstone ORDER BY table_name, row_id'),
  };
}

beforeEach(async () => {
  db = await openTestDb(SELF, AT);
  logger = createMemorySyncLogger();
  await seedRoutine();
});
afterEach(() => db.close());

const hlcOffset = fc.integer({ min: 1, max: 20 });

describe('traces : propriétés (Y-09 critère 9)', () => {
  it('UUID : quelles que soient les opérations reçues (complètes ou partielles, hlc quelconques, dans n’importe quel ordre, rejouées), l’identifiant purgé ne revient jamais', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ at: hlcOffset, partial: fc.boolean(), title: fc.string({ maxLength: 4 }) }), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        async (writes, replay) => {
          await reset();
          await db.data.repos.sync.insertTombstones([{ table: 'task', rowId: T1, deletedHlc: TOMB }], AT);
          const ops = writes.map((w) => op('task', T1, w.partial ? { title: [w.title, h(w.at), null], deleted_at: [null, h(w.at), null] } : taskFields(h(w.at), w.title)));
          await apply(ops);
          if (replay) await apply(ops);
          expect(await db.driver.select('SELECT id FROM task')).toEqual([]);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('identifiant naturel, recréations complètes seulement : le résultat ne dépend ni de l’ordre ni du rejeu, et rien d’inférieur à la trace ne passe', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ at: hlcOffset, done: fc.boolean() }), { minLength: 1, maxLength: 6 }).filter((ws) => new Set(ws.map((w) => w.at)).size === ws.length),
        fc.integer({ min: 0, max: 1000 }),
        async (writes, seed) => {
          const ops = writes.map((w) => op('routine_log', LOG_ID, logFields(h(w.at), w.done ? '2026-10-03T09:00:00.000Z' : '2026-10-03T07:00:00.000Z')));
          await reset();
          await db.data.repos.sync.insertTombstones([{ table: 'routine_log', rowId: LOG_ID, deletedHlc: TOMB }], AT);
          await apply(ops);
          const first = await finalState();
          await reset();
          await db.data.repos.sync.insertTombstones([{ table: 'routine_log', rowId: LOG_ID, deletedHlc: TOMB }], AT);
          const shuffled = [...ops].sort((a, b) => ((a.id.length + seed + (writes.findIndex((w) => h(w.at) === [...a.f.values()][0]?.[1]) * 7919)) % 5) - ((b.id.length + seed + (writes.findIndex((w) => h(w.at) === [...b.f.values()][0]?.[1]) * 104729)) % 5));
          await apply([...shuffled, ...ops]);
          expect(await finalState()).toEqual(first);
          // La trace n'est retirée que par une écriture plus récente qu'elle.
          const newest = Math.max(...writes.map((w) => w.at));
          const rows = (await finalState()) as { logs: { hlc: string }[]; tombs: unknown[] };
          if (newest > 10) {
            expect(rows.logs).toHaveLength(1);
            expect(rows.tombs).toEqual([]);
            expect(rows.logs[0]?.hlc).toBe(h(newest));
          } else {
            expect(rows.logs).toEqual([]);
            expect(rows.tombs).toHaveLength(1);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  /** Reprise du moteur après une lecture : les opérations mises de côté sont retentées (engine.ts, retryParked). */
  const retry = (): Promise<unknown> => retryParked({ data: db.data, clock: { nowMs: () => Date.parse(AT) }, sv: 17, logger } as unknown as SyncDeps);

  /**
   * DÉFAUT D2 (signalé par la QA, corrigé : l'opération partielle plus récente est mise de côté, missing-row) : sur un identifiant naturel tracé, une opération partielle plus récente que la
   * trace est abandonnée (apply.ts : !full donne rejected, jamais mise de côté) alors que la même opération sur un identifiant
   * absent sans trace est mise de côté (missing-row) et recomposée à l'arrivée de la création. Un appareil qui lit l'écriture
   * partielle (décocher) avant la recréation complète (cocher) qui la précède dans le temps diverge des deux autres définitivement.
   */
  it('D2 (corrigé) : recréation complète (hlc 12) et décochage partiel (hlc 13) : même résultat quel que soit l’ordre d’arrivée', async () => {
    const recreate = op('routine_log', LOG_ID, logFields(h(12), '2026-10-03T09:00:00.000Z'));
    const uncheck = op('routine_log', LOG_ID, { deleted_at: ['2026-10-04T08:00:00.000Z', h(13), h(12)] });
    await db.data.repos.sync.insertTombstones([{ table: 'routine_log', rowId: LOG_ID, deletedHlc: TOMB }], AT);
    await apply([recreate]);
    await apply([uncheck]);
    await retry();
    const inOrder = await finalState();
    await reset();
    await db.data.repos.sync.insertTombstones([{ table: 'routine_log', rowId: LOG_ID, deletedHlc: TOMB }], AT);
    await apply([uncheck]);
    await apply([recreate]);
    await retry();
    expect(await finalState()).toEqual(inOrder);
  });

  it('même chose sans trace : l’ordre d’arrivée ne change rien (l’opération partielle est mise de côté puis recomposée par la reprise du moteur)', async () => {
    const recreate = op('routine_log', LOG_ID, logFields(h(12), '2026-10-03T09:00:00.000Z'));
    const uncheck = op('routine_log', LOG_ID, { deleted_at: ['2026-10-04T08:00:00.000Z', h(13), h(12)] });
    await apply([recreate]);
    await apply([uncheck]);
    const inOrder = await finalState();
    await reset();
    await apply([uncheck]);
    await apply([recreate]);
    await retry();
    expect(await finalState()).toEqual(inOrder);
  });
});
