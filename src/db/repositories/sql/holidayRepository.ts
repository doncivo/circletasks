import type { WriteStamper } from '../../../domain/hlc';
import type { Holiday, HolidayCountry, HolidayKind, HolidaySource } from '../../../domain/model';
import type { HolidayId, LocalDate } from '../../../domain/types';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { HolidayRepository, NewHoliday } from '../holidayRepository';
import { readSyncMeta, requireMapped, type SyncRow } from './sqlHelpers';

interface HolidayRow extends SqlRow, SyncRow {
  readonly country: string;
  readonly year: number;
  readonly key: string;
  readonly date: string;
  readonly name: string;
  readonly kind: string;
  readonly source: string;
  readonly overridden: number;
}

function rowToHoliday(row: HolidayRow): Holiday {
  return {
    id: row.id as HolidayId,
    country: row.country as HolidayCountry,
    year: row.year,
    key: row.key,
    date: row.date as LocalDate,
    name: row.name,
    kind: row.kind as HolidayKind,
    source: row.source as HolidaySource,
    overridden: row.overridden === 1,
    ...readSyncMeta(row),
  };
}

/** Jours fériés stockés (E-03) : fêtes lunaires de la table annuelle et saisies manuelles. */
export function createHolidayRepository(db: SqlExecutor, stamper: WriteStamper): HolidayRepository {
  /** Une ligne par (pays, année, fête), supprimée comprise : l'unicité interdit d'en créer une seconde, on la ranime. */
  async function fetchAny(country: HolidayCountry, year: number, key: string): Promise<HolidayRow | undefined> {
    const rows = await db.select<HolidayRow>('SELECT * FROM holiday WHERE country = ? AND year = ? AND key = ? LIMIT 1', [country, year, key]);
    return rows[0];
  }

  async function insert(holiday: NewHoliday, source: HolidaySource, overridden: boolean, date: LocalDate): Promise<void> {
    const stamp = stamper.next();
    await db.execute(
      `INSERT INTO holiday (id, country, year, key, date, name, kind, source, overridden, created_at, updated_at, deleted_at, device_id, hlc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [holiday.id, holiday.country, holiday.year, holiday.key, date, holiday.name, holiday.kind, source, overridden ? 1 : 0, stamp.at, stamp.at, stamp.deviceId, stamp.hlc],
    );
  }

  async function update(id: string, date: LocalDate, source: HolidaySource, overridden: boolean, deleted: boolean): Promise<void> {
    const stamp = stamper.next();
    await db.execute('UPDATE holiday SET date = ?, source = ?, overridden = ?, deleted_at = ?, updated_at = ?, device_id = ?, hlc = ? WHERE id = ?', [
      date,
      source,
      overridden ? 1 : 0,
      deleted ? stamp.at : null,
      stamp.at,
      stamp.deviceId,
      stamp.hlc,
      id,
    ]);
  }

  async function read(country: HolidayCountry, year: number, key: string): Promise<Holiday> {
    return requireMapped(await fetchAny(country, year, key), 'holiday', `${country}:${String(year)}:${key}`, rowToHoliday);
  }

  return {
    async listForYears(years) {
      if (years.length === 0) return [];
      const marks = years.map(() => '?').join(', ');
      const rows = await db.select<HolidayRow>(`SELECT * FROM holiday WHERE deleted_at IS NULL AND year IN (${marks}) ORDER BY year, country, key`, [...years]);
      return rows.map(rowToHoliday);
    },

    async getByKey(country, year, key) {
      const row = await fetchAny(country, year, key);
      return row && row.deleted_at === null ? rowToHoliday(row) : null;
    },

    async syncTable(rows) {
      let written = 0;
      for (const holiday of rows) {
        const existing = await fetchAny(holiday.country, holiday.year, holiday.key);
        if (!existing) {
          await insert(holiday, 'table', false, holiday.date);
          written += 1;
        } else if (existing.overridden === 0 && (existing.date !== holiday.date || existing.deleted_at !== null || existing.source !== 'table')) {
          // Table mise à jour par une nouvelle version de l'app : la date suit ; une saisie manuelle n'est jamais touchée.
          await update(existing.id, holiday.date, 'table', false, false);
          written += 1;
        }
      }
      return written;
    },

    async setOverride(holiday, date) {
      const existing = await fetchAny(holiday.country, holiday.year, holiday.key);
      if (existing) await update(existing.id, date, 'manual', true, false);
      else await insert(holiday, 'manual', true, date);
      return read(holiday.country, holiday.year, holiday.key);
    },

    async clearOverride(country, year, key, tableDate) {
      const existing = await fetchAny(country, year, key);
      if (!existing) return null;
      if (tableDate === null) {
        await update(existing.id, existing.date as LocalDate, 'table', false, true);
        return null;
      }
      await update(existing.id, tableDate, 'table', false, false);
      return read(country, year, key);
    },
  };
}
