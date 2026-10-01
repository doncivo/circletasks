import { parseIcon, type CalendarEvent, type Checklist, type ChecklistSummary } from '../../../domain/model';
import type { ChecklistId, EventId, LocalDate, LocalTime, SpaceFilter, SpaceId } from '../../../domain/types';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { ChecklistRepository, EventRepository } from '../agendaRepository';
import type { DateRange } from '../common';
import { readSyncMeta, spaceFilterClause, type SyncRow } from './sqlHelpers';

interface EventRow extends SqlRow, SyncRow {
  readonly space_id: string;
  readonly title: string;
  readonly start_date: string;
  readonly start_time: string | null;
  readonly end_date: string;
  readonly end_time: string | null;
  readonly all_day: number;
  readonly kind: string;
  readonly repeat: string;
  readonly important: number;
  readonly icon: string | null;
  readonly birth_year: number | null;
}

function rowToEvent(row: EventRow): CalendarEvent {
  return {
    id: row.id as EventId,
    spaceId: row.space_id as SpaceId,
    title: row.title,
    startDate: row.start_date as LocalDate,
    startTime: row.start_time as LocalTime | null,
    endDate: row.end_date as LocalDate,
    endTime: row.end_time as LocalTime | null,
    allDay: row.all_day === 1,
    kind: row.kind as CalendarEvent['kind'],
    repeat: row.repeat as CalendarEvent['repeat'],
    important: row.important === 1,
    icon: parseIcon(row.icon),
    birthYear: row.birth_year,
    ...readSyncMeta(row),
  };
}

/**
 * Lectures minimales de l'ordre 1 (A-01, S-01). Pas d'écriture : `event` et
 * `checklist` seront complétées par checklists-events (ordre 2) sans casser ce
 * contrat (ADR 0004).
 */
export function createEventRepository(db: SqlExecutor): EventRepository {
  return {
    async listCandidatesForRange(range: DateRange, filter: SpaceFilter) {
      const f = spaceFilterClause(filter);
      const rows = await db.select<EventRow>(
        `SELECT * FROM event
         WHERE deleted_at IS NULL ${f.sql}
           AND ((repeat = 'once' AND start_date <= ? AND end_date >= ?) OR repeat IN ('monthly', 'yearly'))
         ORDER BY start_date`,
        [...f.params, range.to, range.from],
      );
      return rows.map(rowToEvent);
    },
  };
}

interface ChecklistRow extends SqlRow, SyncRow {
  readonly space_id: string;
  readonly title: string;
  readonly date: string | null;
  readonly is_template: number;
  readonly total: number;
  readonly checked: number;
}

function rowToChecklistSummary(row: ChecklistRow): ChecklistSummary {
  const checklist: Checklist = {
    id: row.id as ChecklistId,
    spaceId: row.space_id as SpaceId,
    title: row.title,
    date: row.date as LocalDate | null,
    isTemplate: row.is_template === 1,
    ...readSyncMeta(row),
  };
  return { checklist, checked: row.checked, total: row.total };
}

const CHECKLIST_SUMMARY_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM checklist_item ci WHERE ci.checklist_id = c.id AND ci.deleted_at IS NULL) AS total,
    (SELECT COUNT(*) FROM checklist_item ci WHERE ci.checklist_id = c.id AND ci.deleted_at IS NULL AND ci.checked = 1) AS checked
  FROM checklist c
`;

export function createChecklistRepository(db: SqlExecutor): ChecklistRepository {
  return {
    async listSummariesForDay(date: LocalDate, filter: SpaceFilter) {
      const f = spaceFilterClause(filter, 'c.space_id');
      const rows = await db.select<ChecklistRow>(
        `${CHECKLIST_SUMMARY_SELECT} WHERE c.deleted_at IS NULL AND c.date = ? ${f.sql} ORDER BY c.title`,
        [date, ...f.params],
      );
      return rows.map(rowToChecklistSummary);
    },

    async listSummariesForRange(range: DateRange, filter: SpaceFilter) {
      const f = spaceFilterClause(filter, 'c.space_id');
      const rows = await db.select<ChecklistRow>(
        `${CHECKLIST_SUMMARY_SELECT} WHERE c.deleted_at IS NULL AND c.date BETWEEN ? AND ? ${f.sql} ORDER BY c.date, c.title`,
        [range.from, range.to, ...f.params],
      );
      return rows.map(rowToChecklistSummary);
    },
  };
}
