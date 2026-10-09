import { uuidGenerator } from '../../../../src/domain/id';
import { createManualClock, type ManualClock } from '../../../../src/domain/clock';
import { createHlcClock, createWriteStamper, type HlcClock, type WriteStamper } from '../../../../src/domain/hlc';
import type { Task } from '../../../../src/domain/model';
import type { SyncValue } from '../../../../src/domain/sync/format';
import type { DeviceId, Hlc, LocalDate, SpaceId, TaskId } from '../../../../src/domain/types';
import type { SqlDriver } from '../../../../src/db/driver';
import { openSqliteWasmDriver } from '../../../../src/db/drivers/sqliteWasm';
import { migrations } from '../../../../src/db/migrations';
import { migrate } from '../../../../src/db/migrator';
import { createDataAccess, createSqlRepositories, type DataAccess } from '../../../../src/db/repositories';
import { createTaskEntities, type TaskEntities } from '../../../../src/features/app/taskEntities';
import { createUndoStack, type UndoStack } from '../../../../src/features/app/undo';
import { createSyncConflictUseCases, type SyncConflictUseCases } from '../../../../src/features/sync/syncConflictUseCases';
import { createMemorySyncLogger } from '../../../../src/sync';

/**
 * Banc d'un appareil pour les cas d'usage du journal des conflits (Y-04) : base SQLite Wasm migrée, horloge manuelle, `HlcClock`,
 * `WriteStamper` de l'app, pile d'annulation, source unique des tâches, journal technique en mémoire. Les conflits sont posés tels que
 * Y-02 les inscrit (`conflict_log`), les lignes par les repositories ou en SQL avec un tampon de l'appareil.
 */

export const SELF = '60000000-0000-4000-8000-0000000000a1' as DeviceId;
export const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
export const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
export const START = '2026-10-05T08:00:00.000Z';

export interface ConflictBench {
  readonly driver: SqlDriver;
  readonly data: DataAccess;
  readonly clock: ManualClock;
  readonly hlc: HlcClock;
  readonly stamper: WriteStamper;
  readonly undo: UndoStack;
  readonly taskEntities: TaskEntities;
  readonly logger: ReturnType<typeof createMemorySyncLogger>;
  readonly useCases: SyncConflictUseCases;
  createTask(title: string, extra?: Partial<Task>): Promise<Task>;
  /** Exécute une instruction avec un tampon de l'appareil (`?stamp_at`, `?stamp_hlc` remplacés dans les paramètres). */
  stamped(sql: string, params: (SyncValue | typeof STAMP_AT | typeof STAMP_HLC | typeof STAMP_DEVICE)[]): Promise<Hlc>;
  /** Pose un conflit tel que Y-02 l'inscrit ; renvoie son numéro. */
  conflict(c: Partial<ConflictRow> & Pick<ConflictRow, 'table' | 'rowId' | 'field' | 'kept' | 'discarded'>): Promise<number>;
  select<T = Record<string, unknown>>(sql: string, params?: SyncValue[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface ConflictRow {
  readonly table: string;
  readonly rowId: string;
  readonly field: string;
  readonly kept: SyncValue;
  readonly discarded: SyncValue;
  readonly keptHlc: Hlc;
  readonly discardedHlc: Hlc;
  readonly detectedAt: string;
}

export const STAMP_AT = Symbol('at');
export const STAMP_HLC = Symbol('hlc');
export const STAMP_DEVICE = Symbol('device');

/** hlc d'un autre appareil, `ms` après le début. */
export const otherHlc = (ms: number, device: string = OTHER): Hlc => `${String(Date.parse(START) + ms).padStart(15, '0')}-0000-${device}` as Hlc;

let counter = 0;

export async function openConflictBench(start = START): Promise<ConflictBench> {
  const driver = await openSqliteWasmDriver();
  await migrate(driver, migrations);
  const clock = createManualClock(start);
  const hlc = createHlcClock({ clock, deviceId: SELF });
  const stamper = createWriteStamper(clock, hlc);
  const data = createDataAccess(driver, stamper, createSqlRepositories);
  await data.repos.settings.set('device.id', SELF);
  const undo = createUndoStack();
  const taskEntities = createTaskEntities();
  const logger = createMemorySyncLogger();
  const useCases = createSyncConflictUseCases({ clock, ids: uuidGenerator, data, undo, taskEntities, logger });
  const bench: ConflictBench = {
    driver,
    data,
    clock,
    hlc,
    stamper,
    undo,
    taskEntities,
    logger,
    useCases,
    async createTask(title, extra = {}) {
      counter += 1;
      return data.repos.tasks.create({
        id: (extra.id ?? `${String(counter).padStart(8, '0')}-0000-4000-8000-0000000000a1`) as TaskId,
        spaceId: PRO,
        projectId: null,
        title,
        note: '',
        date: '2026-10-05' as LocalDate,
        time: null,
        status: 'todo',
        doneAt: null,
        sortOrder: counter,
        carriedOver: false,
        recurrenceId: null,
        seriesIndex: null,
        seriesTemplate: null,
        goalId: null,
        icon: null,
        someday: false,
        source: 'local',
        externalId: null,
        appleListId: null,
        appleRecurring: false,
        externalEventId: null,
        ...extra,
      });
    },
    async stamped(sql, params) {
      const stamp = stamper.next();
      await driver.execute(
        sql,
        params.map((p) => (p === STAMP_AT ? stamp.at : p === STAMP_HLC ? stamp.hlc : p === STAMP_DEVICE ? stamp.deviceId : p)),
      );
      return stamp.hlc;
    },
    async conflict(c) {
      await driver.execute(
        `INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, kept_device, discarded_device, kept_hlc, discarded_hlc, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          c.table,
          c.rowId,
          c.field,
          JSON.stringify(c.kept),
          JSON.stringify(c.discarded),
          (c.keptHlc ?? otherHlc(1)).slice(21),
          (c.discardedHlc ?? otherHlc(0, SELF)).slice(21),
          c.keptHlc ?? otherHlc(1),
          c.discardedHlc ?? otherHlc(0, SELF),
          c.detectedAt ?? new Date(clock.nowMs()).toISOString(),
        ],
      );
      const rows = await driver.select<{ id: number }>('SELECT MAX(id) AS id FROM conflict_log');
      return Number(rows[0]?.id);
    },
    select: (sql, params = []) => driver.select(sql, params) as never,
    close: () => driver.close(),
  };
  return bench;
}
