import type { GoalsCount, WeekCount } from '../../../domain/monthReport';
import type { ExportRecurrence, ExportTask } from '../../../domain/historyExport';
import type { IsoDateTime, LocalDate } from '../../../domain/types';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { ExportTasksQuery, StatsQuery, StatsRepository } from '../statsRepository';
import { fromJson, fromJsonOrNull } from './sqlHelpers';

interface WeekRow extends SqlRow {
  readonly week_start: string;
  readonly total: number;
  readonly done: number | null;
}

interface GoalRow extends SqlRow {
  readonly total: number;
  readonly achieved: number | null;
}

interface OldestRow extends SqlRow {
  readonly oldest: string | null;
}

interface ExportRow extends SqlRow {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly date: string | null;
  readonly time: string | null;
  readonly status: string;
  readonly done_at: string | null;
  readonly someday: number;
  readonly space_id: string;
  readonly space_name: string;
  readonly project_id: string | null;
  readonly project_name: string | null;
  readonly goal_id: string | null;
  readonly goal_title: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly r_freq: string | null;
  readonly r_interval: number | null;
  readonly r_weekdays: string | null;
  readonly r_month_day: number | null;
  readonly r_nth_weekday: string | null;
  readonly r_until: string | null;
  readonly r_count: number | null;
  readonly sort_key: string;
}

/** Tri de l'export : par date, les tâches sans date à la fin. */
const SORT_KEY = "COALESCE(t.date, '9999-99-99')";

function rowToExportTask(row: ExportRow): ExportTask {
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    date: row.date as LocalDate | null,
    time: row.time,
    status: row.status === 'done' ? 'done' : 'todo',
    doneAt: row.done_at as IsoDateTime | null,
    someday: row.someday === 1,
    spaceId: row.space_id,
    spaceName: row.space_name,
    projectId: row.project_id,
    projectName: row.project_name,
    goalId: row.goal_id,
    goalTitle: row.goal_title,
    recurrence:
      row.r_freq === null
        ? null
        : {
            freq: row.r_freq as ExportRecurrence['freq'],
            interval: row.r_interval ?? 1,
            weekdays: fromJson(row.r_weekdays, [] as number[]),
            monthDay: row.r_month_day,
            nthWeekday: fromJsonOrNull(row.r_nth_weekday),
            until: row.r_until as LocalDate | null,
            count: row.r_count,
          },
    createdAt: row.created_at as IsoDateTime,
    updatedAt: row.updated_at as IsoDateTime,
  };
}

/** Lundi ISO de la date `t.date` : on recule du nombre de jours écoulés depuis le lundi (strftime %w : 0 = dimanche). */
const WEEK_START_SQL = "date(t.date, '-' || ((CAST(strftime('%w', t.date) AS INTEGER) + 6) % 7) || ' days')";

/** Statistiques agrégées (H-01 à H-03). Index utilisés : idx_task_date_space (tâches), idx_goal_space_week (objectifs). */
export function createStatsRepository(db: SqlExecutor): StatsRepository {
  return {
    async taskCountsByWeek({ range, filter }: StatsQuery) {
      const params: SqlValue[] = [range.from, range.to];
      let where = 't.deleted_at IS NULL AND t.someday = 0 AND t.date >= ? AND t.date <= ?';
      if (filter.space !== 'all') {
        where += ' AND t.space_id = ?';
        params.push(filter.space);
      }
      if (filter.project !== null) {
        where += ' AND t.project_id = ?';
        params.push(filter.project);
      }
      const rows = await db.select<WeekRow>(
        `SELECT ${WEEK_START_SQL} AS week_start, COUNT(*) AS total, SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
         FROM task t WHERE ${where} GROUP BY week_start ORDER BY week_start`,
        params,
      );
      return rows.map((row): WeekCount => ({ weekStart: row.week_start as LocalDate, total: row.total, done: row.done ?? 0 }));
    },

    async goalCounts({ range, filter }: StatsQuery) {
      if (filter.project !== null) return { achieved: 0, total: 0 };
      const params: SqlValue[] = [range.from, range.to];
      let where = 'g.deleted_at IS NULL AND g.week_start >= ? AND g.week_start <= ?';
      if (filter.space !== 'all') {
        where += ' AND g.space_id = ?';
        params.push(filter.space);
      }
      const rows = await db.select<GoalRow>(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN g.status = 'achieved' THEN 1 ELSE 0 END) AS achieved FROM goal g WHERE ${where}`,
        params,
      );
      return { achieved: rows[0]?.achieved ?? 0, total: rows[0]?.total ?? 0 } satisfies GoalsCount;
    },

    async oldestActivity() {
      const rows = await db.select<OldestRow>(
        `SELECT MIN(d) AS oldest FROM (
           SELECT MIN(date) AS d FROM task WHERE deleted_at IS NULL AND someday = 0 AND date IS NOT NULL
           UNION ALL SELECT MIN(date) FROM routine_log WHERE deleted_at IS NULL
           UNION ALL SELECT MIN(start_date) FROM routine WHERE deleted_at IS NULL
           UNION ALL SELECT MIN(week_start) FROM goal WHERE deleted_at IS NULL
           UNION ALL SELECT MIN(substr(started_at, 1, 10)) FROM focus_session WHERE deleted_at IS NULL AND ended_at IS NOT NULL
         )`,
        [],
      );
      const oldest = rows[0]?.oldest ?? null;
      return oldest === null ? null : (oldest as LocalDate);
    },

    async listTasksForExport({ filter, range, after, limit }: ExportTasksQuery) {
      const params: SqlValue[] = [];
      let where = 't.deleted_at IS NULL';
      if (filter.space !== 'all') {
        where += ' AND t.space_id = ?';
        params.push(filter.space);
      }
      if (filter.project !== null) {
        where += ' AND t.project_id = ?';
        params.push(filter.project);
      }
      if (range) {
        where += ' AND t.date >= ? AND t.date <= ?';
        params.push(range.from, range.to);
      }
      if (after) {
        where += ` AND (${SORT_KEY} > ? OR (${SORT_KEY} = ? AND t.id > ?))`;
        params.push(after.key, after.key, after.id);
      }
      const size = Math.max(1, Math.floor(limit));
      const rows = await db.select<ExportRow>(
        `SELECT t.id, t.title, t.note, t.date, t.time, t.status, t.done_at, t.someday, t.space_id, s.name AS space_name,
                t.project_id, p.name AS project_name, t.goal_id, g.title AS goal_title, t.created_at, t.updated_at,
                r.freq AS r_freq, r.interval AS r_interval, r.weekdays AS r_weekdays, r.month_day AS r_month_day,
                r.nth_weekday AS r_nth_weekday, r.until AS r_until, r.count AS r_count, ${SORT_KEY} AS sort_key
         FROM task t
         JOIN space s ON s.id = t.space_id
         LEFT JOIN project p ON p.id = t.project_id
         LEFT JOIN goal g ON g.id = t.goal_id
         LEFT JOIN recurrence r ON r.id = t.recurrence_id
         WHERE ${where}
         ORDER BY ${SORT_KEY}, t.id LIMIT ?`,
        [...params, size + 1],
      );
      const page = rows.slice(0, size);
      const last = page[page.length - 1];
      return { tasks: page.map(rowToExportTask), next: rows.length > size && last ? { key: last.sort_key, id: last.id } : null };
    },
  };
}
