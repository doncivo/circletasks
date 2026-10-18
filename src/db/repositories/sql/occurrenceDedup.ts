import type { Hlc, RecurrenceId, TaskId } from '../../../domain/types';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { OccurrenceDedupRepository } from '../occurrenceDedupRepository';

interface Row extends SqlRow {
  readonly id: string;
  readonly recurrence_id: string;
  readonly series_index: number;
  readonly status: string;
  readonly hlc: string;
}

/** Implémentation SQL de `OccurrenceDedupRepository` (T-TECH-01). Chargée à la demande, jamais dans le JavaScript de départ. */
export function createOccurrenceDedupRepository(db: SqlExecutor): OccurrenceDedupRepository {
  return {
    async listLiveDuplicates() {
      const rows = await db.select<Row>(
        `SELECT t.id, t.recurrence_id, t.series_index, t.status, t.hlc FROM task t
         WHERE t.deleted_at IS NULL AND t.recurrence_id IS NOT NULL AND t.series_index >= 0
           AND EXISTS (SELECT 1 FROM task o WHERE o.recurrence_id = t.recurrence_id AND o.series_index = t.series_index AND o.deleted_at IS NULL AND o.id <> t.id)
         ORDER BY t.recurrence_id, t.series_index, t.id`,
      );
      return rows.map((r) => ({ id: r.id as TaskId, recurrenceId: r.recurrence_id as RecurrenceId, seriesIndex: r.series_index, done: r.status === 'done', hlc: r.hlc as Hlc }));
    },
  };
}
