import type { WriteStamper } from '../../../domain/hlc';
import { encodeCalendars, encodeIcon, parseCalendars, parseIcon, type CalendarAccount, type CalendarEvent, type CalendarProviderKind, type EventPatch, type ExternalEvent, type NewEvent } from '../../../domain/model';
import type { CalendarAccountId, EventId, ExternalEventId, IsoDateTime, LocalDate, LocalTime, SpaceFilter, SpaceId } from '../../../domain/types';
import type { SqlExecutor, SqlRow, SqlValue } from '../../driver';
import type { CalendarAccountRepository, EventRepository, ExternalEventRepository } from '../agendaRepository';
import type { DateRange, InstantRange, ReadOptions } from '../common';
import { deletedClause, readSyncMeta, requireMapped, requireRow, spaceFilterClause, type SyncRow } from './sqlHelpers';

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

/** Événements locaux : lectures de l'ordre 1 (A-01, S-01) et écritures de E-01 (ADR 0004). */
export function createEventRepository(db: SqlExecutor, stamper: WriteStamper): EventRepository {
  async function fetchById(id: EventId, options?: ReadOptions): Promise<EventRow | undefined> {
    const rows = await db.select<EventRow>(`SELECT * FROM event WHERE id = ? ${deletedClause(options)} LIMIT 1`, [id]);
    return rows[0];
  }

  async function write(id: EventId, sets: string[], params: SqlValue[], where: string): Promise<CalendarEvent> {
    const stamp = stamper.next();
    await db.execute(`UPDATE event SET ${[...sets, 'updated_at = ?', 'device_id = ?', 'hlc = ?'].join(', ')} WHERE id = ? ${where}`, [...params, stamp.at, stamp.deviceId, stamp.hlc, id]);
    return requireMapped(await fetchById(id, { includeDeleted: true }), 'event', id, rowToEvent);
  }

  return {
    async getById(id, options) {
      const row = await fetchById(id, options);
      return row ? rowToEvent(row) : null;
    },

    async create(event: NewEvent) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO event (id, space_id, title, start_date, start_time, end_date, end_time, all_day, kind, repeat, important, icon, birth_year, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [
          event.id,
          event.spaceId,
          event.title,
          event.startDate,
          event.startTime,
          event.endDate,
          event.endTime,
          event.allDay ? 1 : 0,
          event.kind,
          event.repeat,
          event.important ? 1 : 0,
          event.icon ? encodeIcon(event.icon) : null,
          event.birthYear,
          stamp.at,
          stamp.at,
          stamp.deviceId,
          stamp.hlc,
        ],
      );
      return requireMapped(await fetchById(event.id), 'event', event.id, rowToEvent);
    },

    async update(id, patch: EventPatch) {
      requireRow(await fetchById(id), 'event', id);
      const sets: string[] = [];
      const params: SqlValue[] = [];
      const set = (column: string, value: SqlValue): void => {
        sets.push(`${column} = ?`);
        params.push(value);
      };
      if (patch.spaceId !== undefined) set('space_id', patch.spaceId);
      if (patch.title !== undefined) set('title', patch.title);
      if (patch.startDate !== undefined) set('start_date', patch.startDate);
      if (patch.startTime !== undefined) set('start_time', patch.startTime);
      if (patch.endDate !== undefined) set('end_date', patch.endDate);
      if (patch.endTime !== undefined) set('end_time', patch.endTime);
      if (patch.allDay !== undefined) set('all_day', patch.allDay ? 1 : 0);
      if (patch.kind !== undefined) set('kind', patch.kind);
      if (patch.repeat !== undefined) set('repeat', patch.repeat);
      if (patch.important !== undefined) set('important', patch.important ? 1 : 0);
      if (patch.icon !== undefined) set('icon', patch.icon ? encodeIcon(patch.icon) : null);
      if (patch.birthYear !== undefined) set('birth_year', patch.birthYear);
      return write(id, sets, params, 'AND deleted_at IS NULL');
    },

    async softDelete(id) {
      requireRow(await fetchById(id), 'event', id);
      const stamp = stamper.next();
      await db.execute('UPDATE event SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id]);
      return requireMapped(await fetchById(id, { includeDeleted: true }), 'event', id, rowToEvent);
    },

    async restore(id) {
      requireRow(await fetchById(id, { includeDeleted: true }), 'event', id);
      return write(id, ['deleted_at = NULL'], [], 'AND deleted_at IS NOT NULL');
    },

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

/** Lignes par requête d'insertion groupée (9 colonnes par ligne : bien sous la limite de paramètres de SQLite). */
const UPSERT_CHUNK = 50;
const DELETE_CHUNK = 200;

/** Événements externes : lecture (S-05) et écritures de rafraîchissement (K-03), locales, sans tampon de synchro. */
export function createExternalEventRepository(db: SqlExecutor): ExternalEventRepository {
  async function upsert(events: readonly ExternalEvent[]): Promise<void> {
    for (let index = 0; index < events.length; index += UPSERT_CHUNK) {
      const chunk = events.slice(index, index + UPSERT_CHUNK);
      const params: SqlValue[] = chunk.flatMap((event) => [event.id, event.accountId, event.calendarId, event.externalId, event.title, event.startUtc, event.endUtc, event.allDay ? 1 : 0, event.syncedAt]);
      await db.execute(
        `INSERT INTO external_event (id, account_id, calendar_id, external_id, title, start_utc, end_utc, all_day, synced_at)
         VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, start_utc = excluded.start_utc, end_utc = excluded.end_utc,
           all_day = excluded.all_day, synced_at = excluded.synced_at`,
        params,
      );
    }
  }

  async function deleteIds(ids: readonly string[]): Promise<void> {
    for (let index = 0; index < ids.length; index += DELETE_CHUNK) {
      const chunk = ids.slice(index, index + DELETE_CHUNK);
      await db.execute(`DELETE FROM external_event WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
    }
  }

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

    async getById(id) {
      const rows = await db.select<ExternalEventRow>('SELECT * FROM external_event WHERE id = ? LIMIT 1', [id]);
      return rows[0] ? rowToExternalEvent(rows[0]) : null;
    },

    async replaceWindow(accountId, calendarId, events, range) {
      const existing = await db.select<SqlRow & { readonly id: string }>(
        `SELECT id FROM external_event
         WHERE account_id = ? AND calendar_id = ? AND start_utc < ? AND ((end_utc IS NULL AND start_utc >= ?) OR end_utc > ?)`,
        [accountId, calendarId, range.to, range.from, range.from],
      );
      const keep = new Set<string>(events.map((event) => event.id));
      await deleteIds(existing.map((row) => row.id).filter((id) => !keep.has(id)));
      // Lignes dont la fin précède la fenêtre (la fenêtre glisse chaque jour) : purgées, sinon la table ne ferait que grossir.
      await db.execute(
        `DELETE FROM external_event WHERE account_id = ? AND calendar_id = ? AND ((end_utc IS NOT NULL AND end_utc <= ?) OR (end_utc IS NULL AND start_utc < ?))`,
        [accountId, calendarId, range.from, range.from],
      );
      await upsert(events);
    },

    async deleteForCalendar(accountId, calendarId) {
      await db.execute('DELETE FROM external_event WHERE account_id = ? AND calendar_id = ?', [accountId, calendarId]);
    },

    async deleteForAccount(accountId) {
      await db.execute('DELETE FROM external_event WHERE account_id = ?', [accountId]);
    },
  };
}

interface CalendarAccountRow extends SqlRow, SyncRow {
  readonly provider: string;
  readonly label: string;
  readonly token_ref: string;
  readonly username: string;
  readonly calendars: string;
}

function rowToAccount(row: CalendarAccountRow): CalendarAccount {
  return {
    id: row.id as CalendarAccountId,
    provider: row.provider as CalendarProviderKind,
    label: row.label,
    tokenRef: row.token_ref,
    username: row.username,
    calendars: parseCalendars(row.calendars),
    ...readSyncMeta(row),
  };
}

/** Comptes d'agenda : lecture (filtre d'espace par rattachement des agendas, ES-06) et écritures de K-01 / K-02. Aucun secret en base. */
export function createCalendarAccountRepository(db: SqlExecutor, stamper: WriteStamper): CalendarAccountRepository {
  async function fetchRow(id: CalendarAccountId, includeDeleted = false): Promise<CalendarAccountRow | undefined> {
    const rows = await db.select<CalendarAccountRow>(`SELECT * FROM calendar_account WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} LIMIT 1`, [id]);
    return rows[0];
  }

  return {
    async listAll() {
      const rows = await db.select<CalendarAccountRow>('SELECT * FROM calendar_account WHERE deleted_at IS NULL ORDER BY label, id');
      return rows.map(rowToAccount);
    },

    async getById(id) {
      const row = await fetchRow(id);
      return row ? rowToAccount(row) : null;
    },

    async create(account) {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO calendar_account (id, provider, label, token_ref, username, calendars, created_at, updated_at, deleted_at, device_id, hlc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [account.id, account.provider, account.label, account.tokenRef, account.username ?? '', encodeCalendars(account.calendars), stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
      );
      return requireMapped(await fetchRow(account.id), 'calendar_account', account.id, rowToAccount);
    },

    async updateCalendars(id, calendars) {
      requireRow(await fetchRow(id), 'calendar_account', id);
      const stamp = stamper.next();
      await db.execute('UPDATE calendar_account SET calendars = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [encodeCalendars(calendars), stamp.at, stamp.deviceId, stamp.hlc, id]);
      return requireMapped(await fetchRow(id), 'calendar_account', id, rowToAccount);
    },

    async softDelete(id) {
      requireRow(await fetchRow(id), 'calendar_account', id);
      const stamp = stamper.next();
      await db.execute('UPDATE calendar_account SET deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ? AND deleted_at IS NULL', [stamp.at, stamp.at, stamp.deviceId, stamp.hlc, id]);
      return requireMapped(await fetchRow(id, true), 'calendar_account', id, rowToAccount);
    },

    async setLocalCredentials(id, credentials) {
      requireRow(await fetchRow(id), 'calendar_account', id);
      // Colonnes locales seulement, sans tampon : hlc inchangé, rien n'entre dans la file d'envoi.
      await db.execute('UPDATE calendar_account SET username = ?, token_ref = ? WHERE id = ? AND deleted_at IS NULL', [credentials.username, credentials.tokenRef, id]);
      return requireMapped(await fetchRow(id), 'calendar_account', id, rowToAccount);
    },
  };
}
