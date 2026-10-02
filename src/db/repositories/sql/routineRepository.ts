import { parseIcon, type NewRoutine, type Routine, type RoutineLog, type RoutinePatch, type RoutinePause } from '../../../domain/model';
import type { IsoDateTime, LocalDate, LocalTime, RoutineId, RoutineLogId, RoutinePauseId, SpaceFilter, SpaceId } from '../../../domain/types';
import type { WriteStamper } from '../../../domain/hlc';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { RoutineLogRepository, RoutineRepository } from '../routineRepository';
import type { DateRange, ReadOptions } from '../common';
import { deletedClause, fromJson, readSyncMeta, requireMapped, spaceFilterClause, toJson, type SyncRow } from './sqlHelpers';

interface RoutineRow extends SqlRow, SyncRow {
  readonly space_id: string;
  readonly title: string;
  readonly icon: string | null;
  readonly schedule_type: string;
  readonly weekdays: string;
  readonly times_per_week: number | null;
  readonly interval: number | null;
  readonly start_date: string;
  readonly time: string | null;
  readonly paused: number;
  readonly archived: number;
}

function rowToRoutine(row: RoutineRow): Routine {
  return {
    id: row.id as RoutineId,
    spaceId: row.space_id as SpaceId,
    title: row.title,
    icon: parseIcon(row.icon),
    scheduleType: row.schedule_type as Routine['scheduleType'],
    weekdays: fromJson(row.weekdays, []),
    timesPerWeek: row.times_per_week,
    interval: row.interval,
    startDate: row.start_date as LocalDate,
    time: row.time as LocalTime | null,
    paused: row.paused === 1,
    archived: row.archived === 1,
    ...readSyncMeta(row),
  };
}

function encodeIconValue(icon: NonNullable<Routine['icon']>): string {
  return icon.kind === 'lucide' ? `lucide:${icon.name}` : `emoji:${icon.value}`;
}

interface RoutinePauseRow extends SqlRow, SyncRow {
  readonly routine_id: string;
  readonly from_date: string;
  readonly to_date: string | null;
}

function rowToPause(row: RoutinePauseRow): RoutinePause {
  return {
    id: row.id as RoutinePauseId,
    routineId: row.routine_id as RoutineId,
    fromDate: row.from_date as LocalDate,
    toDate: row.to_date as LocalDate | null,
    ...readSyncMeta(row),
  };
}

export function createRoutineRepository(db: SqlExecutor, stamper: WriteStamper): RoutineRepository {
  async function fetchPause(id: RoutinePauseId): Promise<RoutinePauseRow | undefined> {
    return (await db.select<RoutinePauseRow>('SELECT * FROM routine_pause WHERE id = ? LIMIT 1', [id]))[0];
  }

  async function fetchById(id: RoutineId, options?: ReadOptions): Promise<RoutineRow | undefined> {
    const rows = await db.select<RoutineRow>(`SELECT * FROM routine WHERE id = ? ${deletedClause(options)} LIMIT 1`, [id]);
    return rows[0];
  }

  return {
    async getById(id, options) {
      const row = await fetchById(id, options);
      return row ? rowToRoutine(row) : null;
    },

    async listForFilter(filter: SpaceFilter, options) {
      const f = spaceFilterClause(filter);
      let sql = `SELECT * FROM routine WHERE deleted_at IS NULL ${f.sql}`;
      if (!options?.includeArchived) sql += ' AND archived = 0';
      sql += ' ORDER BY (time IS NULL), time, title';
      const rows = await db.select<RoutineRow>(sql, f.params);
      return rows.map(rowToRoutine);
    },

    async create(routine: NewRoutine) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO routine (id, space_id, title, icon, schedule_type, weekdays, times_per_week, interval, start_date, time, paused, archived, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          routine.id,
          routine.spaceId,
          routine.title,
          routine.icon ? encodeIconValue(routine.icon) : null,
          routine.scheduleType,
          toJson(routine.weekdays),
          routine.timesPerWeek,
          routine.interval,
          routine.startDate,
          routine.time,
          routine.paused ? 1 : 0,
          routine.archived ? 1 : 0,
          stamp.at,
          stamp.at,
          stamp.deviceId,
          stamp.hlc,
        ],
      );
      return requireMapped(await fetchById(routine.id), 'routine', routine.id, rowToRoutine);
    },

    async update(id: RoutineId, patch: RoutinePatch) {
      const stamp = stamper.next();
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.spaceId !== undefined) {
        sets.push('space_id = ?');
        params.push(patch.spaceId);
      }
      if (patch.title !== undefined) {
        sets.push('title = ?');
        params.push(patch.title);
      }
      if (patch.icon !== undefined) {
        sets.push('icon = ?');
        params.push(patch.icon ? encodeIconValue(patch.icon) : null);
      }
      if (patch.scheduleType !== undefined) {
        sets.push('schedule_type = ?');
        params.push(patch.scheduleType);
      }
      if (patch.weekdays !== undefined) {
        sets.push('weekdays = ?');
        params.push(toJson(patch.weekdays));
      }
      if (patch.timesPerWeek !== undefined) {
        sets.push('times_per_week = ?');
        params.push(patch.timesPerWeek);
      }
      if (patch.interval !== undefined) {
        sets.push('interval = ?');
        params.push(patch.interval);
      }
      if (patch.startDate !== undefined) {
        sets.push('start_date = ?');
        params.push(patch.startDate);
      }
      if (patch.time !== undefined) {
        sets.push('time = ?');
        params.push(patch.time);
      }
      if (patch.paused !== undefined) {
        sets.push('paused = ?');
        params.push(patch.paused ? 1 : 0);
      }
      if (patch.archived !== undefined) {
        sets.push('archived = ?');
        params.push(patch.archived ? 1 : 0);
      }
      sets.push('updated_at = ?', 'device_id = ?', 'hlc = ?');
      params.push(stamp.at, stamp.deviceId, stamp.hlc);
      await db.execute(`UPDATE routine SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, id]);
      return requireMapped(await fetchById(id), 'routine', id, rowToRoutine);
    },

    async setPaused(id: RoutineId, paused: boolean) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE routine SET paused = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [paused ? 1 : 0, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'routine', id, rowToRoutine);
    },

    async setArchived(id: RoutineId, archived: boolean) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE routine SET archived = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [archived ? 1 : 0, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'routine', id, rowToRoutine);
    },

    async softDelete(id: RoutineId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE routine SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id, { includeDeleted: true }), 'routine', id, rowToRoutine);
    },

    async listPauses(filter: SpaceFilter) {
      const f = spaceFilterClause(filter, 'routine.space_id');
      const rows = await db.select<RoutinePauseRow>(
        `SELECT routine_pause.* FROM routine_pause JOIN routine ON routine.id = routine_pause.routine_id
         WHERE routine_pause.deleted_at IS NULL ${f.sql} ORDER BY routine_pause.from_date`,
        f.params,
      );
      return rows.map(rowToPause);
    },

    async listPausesForRoutine(routineId: RoutineId) {
      const rows = await db.select<RoutinePauseRow>('SELECT * FROM routine_pause WHERE routine_id = ? AND deleted_at IS NULL ORDER BY from_date', [routineId]);
      return rows.map(rowToPause);
    },

    async createPause(pause) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO routine_pause (id, routine_id, from_date, to_date, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
        [pause.id, pause.routineId, pause.fromDate, stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
      );
      return requireMapped(await fetchPause(pause.id), 'routine_pause', pause.id, rowToPause);
    },

    async setPauseEnd(id: RoutinePauseId, toDate: LocalDate | null) {
      const stamp = stamper.next();
      await db.execute('UPDATE routine_pause SET to_date = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [toDate, stamp.at, stamp.deviceId, stamp.hlc, id]);
      return requireMapped(await fetchPause(id), 'routine_pause', id, rowToPause);
    },

    async deletePause(id: RoutinePauseId) {
      const stamp = stamper.next();
      await db.execute('UPDATE routine_pause SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id]);
      return requireMapped(await fetchPause(id), 'routine_pause', id, rowToPause);
    },

    async restorePause(id: RoutinePauseId) {
      const stamp = stamper.next();
      await db.execute('UPDATE routine_pause SET deleted_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NOT NULL', [stamp.at, stamp.deviceId, stamp.hlc, id]);
      return requireMapped(await fetchPause(id), 'routine_pause', id, rowToPause);
    },

    async restore(id: RoutineId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE routine SET deleted_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NOT NULL',
        [stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'routine', id, rowToRoutine);
    },
  };
}

interface RoutineLogRow extends SqlRow, SyncRow {
  readonly routine_id: string;
  readonly date: string;
  readonly done_at: string;
}

function rowToRoutineLog(row: RoutineLogRow): RoutineLog {
  return {
    id: row.id as RoutineLogId,
    routineId: row.routine_id as RoutineId,
    date: row.date as LocalDate,
    doneAt: row.done_at as IsoDateTime,
    ...readSyncMeta(row),
  };
}

export function createRoutineLogRepository(db: SqlExecutor, stamper: WriteStamper): RoutineLogRepository {
  async function fetchByRoutineAndDate(routineId: RoutineId, date: LocalDate): Promise<RoutineLogRow | undefined> {
    const rows = await db.select<RoutineLogRow>(
      'SELECT * FROM routine_log WHERE routine_id = ? AND date = ? LIMIT 1',
      [routineId, date],
    );
    return rows[0];
  }

  return {
    async listForRange(range: DateRange, filter: SpaceFilter) {
      const f = spaceFilterClause(filter, 'routine.space_id');
      const rows = await db.select<RoutineLogRow>(
        `SELECT routine_log.* FROM routine_log
         JOIN routine ON routine.id = routine_log.routine_id
         WHERE routine_log.deleted_at IS NULL AND routine_log.date BETWEEN ? AND ? ${f.sql}
         ORDER BY routine_log.date`,
        [range.from, range.to, ...f.params],
      );
      return rows.map(rowToRoutineLog);
    },

    async listForRoutine(routineId: RoutineId, range: DateRange) {
      const rows = await db.select<RoutineLogRow>(
        'SELECT * FROM routine_log WHERE deleted_at IS NULL AND routine_id = ? AND date BETWEEN ? AND ? ORDER BY date',
        [routineId, range.from, range.to],
      );
      return rows.map(rowToRoutineLog);
    },

    async markDone(routineId: RoutineId, date: LocalDate, doneAt: IsoDateTime, id: RoutineLogId) {
      const stamp = stamper.next();
      const existing = await fetchByRoutineAndDate(routineId, date);
      if (existing) {
        await db.execute(
          'UPDATE routine_log SET done_at = ?, deleted_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?',
          [doneAt, stamp.at, stamp.deviceId, stamp.hlc, existing.id],
        );
        return requireMapped(await fetchByRoutineAndDate(routineId, date), 'routine_log', existing.id, rowToRoutineLog);
      }
      await db.execute(
        `INSERT INTO routine_log (id, routine_id, date, done_at, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [id, routineId, date, doneAt, stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
      );
      return requireMapped(await fetchByRoutineAndDate(routineId, date), 'routine_log', id, rowToRoutineLog);
    },

    async unmark(routineId: RoutineId, date: LocalDate) {
      const existing = await fetchByRoutineAndDate(routineId, date);
      if (!existing || existing.deleted_at !== null) return null;
      const stamp = stamper.next();
      await db.execute(
        'UPDATE routine_log SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?',
        [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, existing.id],
      );
      return requireMapped(await fetchByRoutineAndDate(routineId, date), 'routine_log', existing.id, rowToRoutineLog);
    },
  };
}
