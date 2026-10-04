import type { GoalsCount, WeekCount } from '../../../domain/monthReport';
import type { LocalDate } from '../../../domain/types';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { StatsQuery, StatsRepository } from '../statsRepository';

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
  };
}
