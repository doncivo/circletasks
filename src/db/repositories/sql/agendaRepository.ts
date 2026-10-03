import { parseCalendars, parseIcon, type CalendarAccount, type CalendarEvent, type CalendarProvider, type ExternalEvent } from '../../../domain/model';
import type { CalendarAccountId, EventId, ExternalEventId, IsoDateTime, LocalDate, LocalTime, SpaceFilter, SpaceId } from '../../../domain/types';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { CalendarAccountRepository, EventRepository, ExternalEventRepository } from '../agendaRepository';
import type { DateRange, InstantRange } from '../common';
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
 * Lectures minimales de l'ordre 1 (A-01, S-01). Pas d'écriture : `event` sera complétée
 * par checklists-events (ordre 2) sans casser ce contrat (ADR 0004).
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

interface ExternalEventRow extends SqlRow {
  readonly id: string;
  readonly account_id: string;
  readonly calendar_id: string;
  readonly external_id: string;
  readonly title: string;
  readonly start_utc: string;
  readonly end_utc: string | null;
  readonly all_day: number;
  readonly synced_at: string;
}

function rowToExternalEvent(row: ExternalEventRow): ExternalEvent {
  return {
    id: row.id as ExternalEventId,
    accountId: row.account_id as CalendarAccountId,
    calendarId: row.calendar_id,
    externalId: row.external_id,
    title: row.title,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    allDay: row.all_day === 1,
    syncedAt: row.synced_at as IsoDateTime,
  };
}

/** Lecture seule des événements externes (S-05) : aucune ligne tant que K-01 n'est pas livré. */
export function createExternalEventRepository(db: SqlExecutor): ExternalEventRepository {
  return {
    async listBetween(range: InstantRange) {
      const rows = await db.select<ExternalEventRow>(
        `SELECT * FROM external_event
         WHERE start_utc < ? AND ((end_utc IS NULL AND start_utc >= ?) OR end_utc > ?)
         ORDER BY start_utc, id`,
        [range.to, range.from, range.from],
      );
      return rows.map(rowToExternalEvent);
    },
  };
}

interface CalendarAccountRow extends SqlRow, SyncRow {
  readonly provider: string;
  readonly label: string;
  readonly token_ref: string;
  readonly calendars: string;
}

/** Lecture seule des comptes d'agenda (S-05) : filtre d'espace par rattachement des agendas (ES-06). */
export function createCalendarAccountRepository(db: SqlExecutor): CalendarAccountRepository {
  return {
    async listAll() {
      const rows = await db.select<CalendarAccountRow>('SELECT * FROM calendar_account WHERE deleted_at IS NULL ORDER BY label, id');
      return rows.map(
        (row): CalendarAccount => ({
          id: row.id as CalendarAccountId,
          provider: row.provider as CalendarProvider,
          label: row.label,
          tokenRef: row.token_ref,
          calendars: parseCalendars(row.calendars),
          ...readSyncMeta(row),
        }),
      );
    },
  };
}
