import { parseIcon, type Goal, type GoalPatch, type GoalStatus, type NewGoal } from '../../../domain/model';
import type { GoalId, LocalDate, SpaceFilter, SpaceId } from '../../../domain/types';
import type { WriteStamper } from '../../../domain/hlc';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { GoalRepository } from '../goalRepository';
import type { DateRange, ReadOptions } from '../common';
import { deletedClause, readSyncMeta, requireMapped, spaceFilterClause, type SyncRow } from './sqlHelpers';

interface GoalRow extends SqlRow, SyncRow {
  readonly space_id: string;
  readonly week_start: string;
  readonly title: string;
  readonly icon: string | null;
  readonly pinned: number;
  readonly status: string;
  readonly carried_from_id: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id as GoalId,
    spaceId: row.space_id as SpaceId,
    weekStart: row.week_start as LocalDate,
    title: row.title,
    icon: parseIcon(row.icon),
    pinned: row.pinned === 1,
    status: row.status as GoalStatus,
    carriedFromId: row.carried_from_id as GoalId | null,
    ...readSyncMeta(row),
  };
}

function encodeIconValue(icon: NonNullable<Goal['icon']>): string {
  return icon.kind === 'lucide' ? `lucide:${icon.name}` : `emoji:${icon.value}`;
}

export function createGoalRepository(db: SqlExecutor, stamper: WriteStamper): GoalRepository {
  async function fetchById(id: GoalId, options?: ReadOptions): Promise<GoalRow | undefined> {
    const rows = await db.select<GoalRow>(`SELECT * FROM goal WHERE id = ? ${deletedClause(options)} LIMIT 1`, [id]);
    return rows[0];
  }

  return {
    async getById(id, options) {
      const row = await fetchById(id, options);
      return row ? rowToGoal(row) : null;
    },

    async listForWeek(weekStart: LocalDate, filter: SpaceFilter) {
      const f = spaceFilterClause(filter);
      const rows = await db.select<GoalRow>(
        `SELECT * FROM goal WHERE deleted_at IS NULL AND week_start = ? ${f.sql} ORDER BY created_at, id`,
        [weekStart, ...f.params],
      );
      return rows.map(rowToGoal);
    },

    async listHistory(range: DateRange, filter: SpaceFilter) {
      const f = spaceFilterClause(filter);
      const rows = await db.select<GoalRow>(
        `SELECT * FROM goal WHERE deleted_at IS NULL AND week_start BETWEEN ? AND ? ${f.sql} ORDER BY week_start DESC, title`,
        [range.from, range.to, ...f.params],
      );
      return rows.map(rowToGoal);
    },

    async listBefore(weekStart: LocalDate, filter: SpaceFilter, weeks = 20) {
      const f = spaceFilterClause(filter);
      const limit = Math.max(1, Math.floor(weeks));
      const starts = await db.select<{ week_start: string }>(
        `SELECT DISTINCT week_start FROM goal WHERE deleted_at IS NULL AND week_start < ? ${f.sql} ORDER BY week_start DESC LIMIT ${limit}`,
        [weekStart, ...f.params],
      );
      const oldest = starts.at(-1)?.week_start;
      if (oldest === undefined) return [];
      const rows = await db.select<GoalRow>(
        `SELECT * FROM goal WHERE deleted_at IS NULL AND week_start >= ? AND week_start < ? ${f.sql} ORDER BY week_start DESC, created_at, id`,
        [oldest, weekStart, ...f.params],
      );
      return rows.map(rowToGoal);
    },

    async listOpenBefore(weekStart: LocalDate) {
      const rows = await db.select<GoalRow>(
        "SELECT * FROM goal WHERE deleted_at IS NULL AND status = 'open' AND week_start < ? ORDER BY week_start, created_at, id",
        [weekStart],
      );
      return rows.map(rowToGoal);
    },

    async listCarriedFrom(ids: readonly GoalId[]) {
      if (ids.length === 0) return [];
      const marks = ids.map(() => '?').join(', ');
      const rows = await db.select<GoalRow>(
        `SELECT * FROM goal WHERE deleted_at IS NULL AND carried_from_id IN (${marks}) ORDER BY week_start, created_at, id`,
        [...ids],
      );
      return rows.map(rowToGoal);
    },

    async create(goal: NewGoal) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO goal (id, space_id, week_start, title, icon, pinned, status, carried_from_id, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          goal.id,
          goal.spaceId,
          goal.weekStart,
          goal.title,
          goal.icon ? encodeIconValue(goal.icon) : null,
          goal.pinned ? 1 : 0,
          goal.status,
          goal.carriedFromId,
          stamp.at,
          stamp.at,
          stamp.deviceId,
          stamp.hlc,
        ],
      );
      return requireMapped(await fetchById(goal.id), 'goal', goal.id, rowToGoal);
    },

    async update(id: GoalId, patch: GoalPatch) {
      const stamp = stamper.next();
      const sets: string[] = [];
      const params: SqlValue[] = [];
      if (patch.spaceId !== undefined) {
        sets.push('space_id = ?');
        params.push(patch.spaceId);
      }
      if (patch.weekStart !== undefined) {
        sets.push('week_start = ?');
        params.push(patch.weekStart);
      }
      if (patch.title !== undefined) {
        sets.push('title = ?');
        params.push(patch.title);
      }
      if (patch.icon !== undefined) {
        sets.push('icon = ?');
        params.push(patch.icon ? encodeIconValue(patch.icon) : null);
      }
      if (patch.pinned !== undefined) {
        sets.push('pinned = ?');
        params.push(patch.pinned ? 1 : 0);
      }
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.carriedFromId !== undefined) {
        sets.push('carried_from_id = ?');
        params.push(patch.carriedFromId);
      }
      sets.push('updated_at = ?', 'device_id = ?', 'hlc = ?');
      params.push(stamp.at, stamp.deviceId, stamp.hlc);
      await db.execute(`UPDATE goal SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`, [...params, id]);
      return requireMapped(await fetchById(id), 'goal', id, rowToGoal);
    },

    async setStatus(id: GoalId, status: GoalStatus) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE goal SET status = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [status, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'goal', id, rowToGoal);
    },

    async softDelete(id: GoalId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE goal SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL',
        [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id, { includeDeleted: true }), 'goal', id, rowToGoal);
    },

    async restore(id: GoalId) {
      const stamp = stamper.next();
      await db.execute(
        'UPDATE goal SET deleted_at = NULL, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NOT NULL',
        [stamp.at, stamp.deviceId, stamp.hlc, id],
      );
      return requireMapped(await fetchById(id), 'goal', id, rowToGoal);
    },
  };
}
