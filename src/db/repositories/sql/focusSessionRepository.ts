import type { FocusTaskTotal, FocusTotal } from '../../../domain/focusTotals';
import type { WriteStamper } from '../../../domain/hlc';
import type { FocusSession, FocusSessionPatch, NewFocusSession } from '../../../domain/model';
import type { FocusSessionId, IsoDateTime, ProjectId, SpaceId, TaskId } from '../../../domain/types';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';

import type { FocusSessionRepository, FocusTotalsQuery } from '../focusSessionRepository';
import { readSyncMeta, requireMapped, requireRow, type SyncRow } from './sqlHelpers';

interface FocusSessionRow extends SqlRow, SyncRow {
  readonly task_id: string | null;
  readonly space_id: string;
  readonly project_id: string | null;
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
    projectId: row.project_id === null ? null : (row.project_id as ProjectId),
    plannedMin: row.planned_min,
    startedAt: row.started_at as IsoDateTime,
    endedAt: row.ended_at === null ? null : (row.ended_at as IsoDateTime),
    pausedSec: row.paused_sec,
    pausedAt: row.paused_at === null ? null : (row.paused_at as IsoDateTime),
    ...readSyncMeta(row),
  };
}

/**
 * Instant ISO 'YYYY-MM-DDTHH:mm:ss.sssZ' en millisecondes Unix : `strftime('%s')` donne les secondes, les trois chiffres après le point
 * donnent les millisecondes (tous les instants sont écrits par `toISOString()`, format fixe).
 */
const epochMs = (column: string): string => `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000 + CAST(substr(${column}, 21, 3) AS INTEGER))`;

/** Temps de concentration d'une session, en secondes : (fin - début) - pauses, arrondi à la seconde, jamais négatif (= `focusSeconds`). */
const SESSION_SECONDS = `MAX(0, CAST(ROUND((${epochMs('f.ended_at')} - ${epochMs('f.started_at')}) / 1000.0 - f.paused_sec) AS INTEGER))`;

/** Clause des sessions terminées de la plage, filtrées par espace de la session et projet de la tâche (ES-08). */
function totalsWhere(query: FocusTotalsQuery): { readonly sql: string; readonly params: SqlValue[] } {
  const params: SqlValue[] = [query.span.from, query.span.to];
  let sql = 'f.deleted_at IS NULL AND f.ended_at IS NOT NULL AND f.started_at >= ? AND f.started_at < ?';
  if (query.filter.space !== 'all') {
    sql += ' AND f.space_id = ?';
    params.push(query.filter.space);
  }
  if (query.filter.project !== null) {
    sql += ' AND f.project_id = ?';
    params.push(query.filter.project);
  }
  return { sql, params };
}

interface TotalRow extends SqlRow {
  readonly seconds: number | null;
  readonly sessions: number;
}

interface TaskTotalRow extends TotalRow {
  readonly task_id: string;
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
        `INSERT INTO focus_session (id, task_id, space_id, project_id, planned_min, started_at, ended_at, paused_sec, paused_at, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, NULL, ?, ?)`,
        [input.id, input.taskId, input.spaceId, input.projectId ?? null, input.plannedMin, input.startedAt, stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
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

    async totals(query) {
      const where = totalsWhere(query);
      const rows = await db.select<TotalRow>(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(${SESSION_SECONDS}), 0) AS seconds
         FROM focus_session f WHERE ${where.sql}`,
        where.params,
      );
      return { seconds: rows[0]?.seconds ?? 0, sessions: rows[0]?.sessions ?? 0 } satisfies FocusTotal;
    },

    async totalsByTask(query, limit) {
      const where = totalsWhere(query);
      const rows = await db.select<TaskTotalRow>(
        `SELECT f.task_id AS task_id, COUNT(*) AS sessions, COALESCE(SUM(${SESSION_SECONDS}), 0) AS seconds
         FROM focus_session f
         WHERE ${where.sql} AND f.task_id IS NOT NULL
         GROUP BY f.task_id ORDER BY seconds DESC, f.task_id LIMIT ?`,
        [...where.params, Math.max(0, Math.floor(limit))],
      );
      return rows.map((row): FocusTaskTotal => ({ taskId: row.task_id as TaskId, seconds: row.seconds ?? 0, sessions: row.sessions }));
    },

    async listForExport({ filter, span, afterId, limit }) {
      const params: SqlValue[] = [];
      let where = 'f.deleted_at IS NULL';
      if (filter.space !== 'all') {
        where += ' AND f.space_id = ?';
        params.push(filter.space);
      }
      if (filter.project !== null) {
        where += ' AND f.project_id = ?';
        params.push(filter.project);
      }
      if (span) {
        where += ' AND f.started_at >= ? AND f.started_at < ?';
        params.push(span.from, span.to);
      }
      if (afterId !== null) {
        where += ' AND f.id > ?';
        params.push(afterId);
      }
      const rows = await db.select<FocusSessionRow>(`SELECT f.* FROM focus_session f WHERE ${where} ORDER BY f.id LIMIT ?`, [...params, Math.max(1, Math.floor(limit))]);
      return rows.map(rowToFocusSession);
    },

    async totalsForTask(taskId) {
      const rows = await db.select<TotalRow>(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(${SESSION_SECONDS}), 0) AS seconds
         FROM focus_session f WHERE f.deleted_at IS NULL AND f.ended_at IS NOT NULL AND f.task_id = ?`,
        [taskId],
      );
      return { seconds: rows[0]?.seconds ?? 0, sessions: rows[0]?.sessions ?? 0 };
    },

    async discard(id) {
      requireRow(await fetch(id), 'focus_session', id);
      const stamp = stamper.next();
      await db.execute('UPDATE focus_session SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?', [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id]);
    },
  };
}
