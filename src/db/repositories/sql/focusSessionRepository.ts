import type { WriteStamper } from '../../../domain/hlc';
import type { FocusSession, FocusSessionPatch, NewFocusSession } from '../../../domain/model';
import type { FocusSessionId, IsoDateTime, SpaceId, TaskId } from '../../../domain/types';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { FocusSessionRepository } from '../focusSessionRepository';
import { readSyncMeta, requireMapped, requireRow, type SyncRow } from './sqlHelpers';

interface FocusSessionRow extends SqlRow, SyncRow {
  readonly task_id: string | null;
  readonly space_id: string;
  readonly planned_min: number | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly paused_sec: number;
  readonly paused_at: string | null;
}

function rowToFocusSession(row: FocusSessionRow): FocusSession {
  return {
    id: row.id as FocusSessionId,
    taskId: row.task_id === null ? null : (row.task_id as TaskId),
    spaceId: row.space_id as SpaceId,
    plannedMin: row.planned_min,
    startedAt: row.started_at as IsoDateTime,
    endedAt: row.ended_at === null ? null : (row.ended_at as IsoDateTime),
    pausedSec: row.paused_sec,
    pausedAt: row.paused_at === null ? null : (row.paused_at as IsoDateTime),
    ...readSyncMeta(row),
  };
}

/** Sessions de concentration (F-01 à F-04, migration 0013). */
export function createFocusSessionRepository(db: SqlExecutor, stamper: WriteStamper): FocusSessionRepository {
  async function fetch(id: string): Promise<FocusSessionRow | undefined> {
    const rows = await db.select<FocusSessionRow>('SELECT * FROM focus_session WHERE id = ? AND deleted_at IS NULL', [id]);
    return rows[0];
  }

  return {
    async getById(id) {
      const row = await fetch(id);
      return row ? rowToFocusSession(row) : null;
    },

    async getOpen() {
      const rows = await db.select<FocusSessionRow>(
        'SELECT * FROM focus_session WHERE ended_at IS NULL AND deleted_at IS NULL ORDER BY started_at DESC, id LIMIT 1',
        [],
      );
      return rows[0] ? rowToFocusSession(rows[0]) : null;
    },

    async create(input: NewFocusSession) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO focus_session (id, task_id, space_id, planned_min, started_at, ended_at, paused_sec, paused_at, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, NULL, ?, ?)`,
        [input.id, input.taskId, input.spaceId, input.plannedMin, input.startedAt, stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
      );
      return requireMapped(await fetch(input.id), 'focus_session', input.id, rowToFocusSession);
    },

    async update(id, patch: FocusSessionPatch) {
      requireRow(await fetch(id), 'focus_session', id);
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.plannedMin !== undefined) {
        sets.push('planned_min = ?');
        params.push(patch.plannedMin);
      }
      if (patch.endedAt !== undefined) {
        sets.push('ended_at = ?');
        params.push(patch.endedAt);
      }
      if (patch.pausedSec !== undefined) {
        sets.push('paused_sec = ?');
        params.push(patch.pausedSec);
      }
      if (patch.pausedAt !== undefined) {
        sets.push('paused_at = ?');
        params.push(patch.pausedAt);
      }
      const stamp = stamper.next();
      await db.execute(`UPDATE focus_session SET ${[...sets, 'updated_at = ?', 'device_id = ?', 'hlc = ?'].join(', ')} WHERE id = ?`, [
        ...params,
        stamp.at,
        stamp.deviceId,
        stamp.hlc,
        id,
      ]);
      return requireMapped(await fetch(id), 'focus_session', id, rowToFocusSession);
    },

    async discard(id) {
      requireRow(await fetch(id), 'focus_session', id);
      const stamp = stamper.next();
      await db.execute('UPDATE focus_session SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?', [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id]);
    },
  };
}
