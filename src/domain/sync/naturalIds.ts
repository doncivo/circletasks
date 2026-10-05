/**
 * Identifiants déterministes (ADR 0011, section 8 ; Y-02 critère 9, Y-09 critère 4).
 *
 * Deux appareils qui créent « la même » ligne doivent lui donner le même identifiant, sinon la fusion par ligne en ferait deux :
 * - `routine_log` : une validation par routine et par jour, `rlog|<routine_id>|<date>` (sans lui, deux validations du même jour sur
 *   deux appareils violeraient `UNIQUE (routine_id, date)`) ;
 * - `holiday` : une ligne par pays, année et fête, `holiday|<pays>|<année>|<clé>`.
 *
 * La migration 0016 réécrit les identifiants existants avec exactement les mêmes formules, en SQL pur. Module pur.
 */

import type { HolidayId, LocalDate, RoutineId, RoutineLogId } from '../types';
import { isId, isLocalDate } from '../types';

export type NaturalIdTable = 'routine_log' | 'holiday';

const RLOG_RE = /^rlog\|([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\|(\d{4}-\d{2}-\d{2})$/;
const HOLIDAY_RE = /^holiday\|(FR|TN)\|(\d{4})\|([A-Za-z][A-Za-z0-9_-]{0,63})$/;

/** Identifiant de la validation d'une routine pour un jour. */
export function routineLogId(routineId: RoutineId, date: LocalDate): RoutineLogId {
  return `rlog|${routineId}|${date}` as RoutineLogId;
}

/** Identifiant de la ligne `holiday` d'un pays, d'une année et d'une fête. */
export function holidayId(country: 'FR' | 'TN', year: number, key: string): HolidayId {
  return `holiday|${country}|${String(year)}|${key}` as HolidayId;
}

/** L'identifiant est-il l'identifiant naturel bien formé de cette table ? */
export function isNaturalId(table: NaturalIdTable, id: string): boolean {
  if (table === 'routine_log') {
    const m = RLOG_RE.exec(id);
    return m !== null && m[1] !== undefined && m[2] !== undefined && isId(m[1]) && isLocalDate(m[2]);
  }
  return HOLIDAY_RE.test(id);
}

/** Identifiant naturel attendu pour une ligne de ces valeurs (contrôle de cohérence d'une recréation reçue, section 5.4). */
export function expectedNaturalId(table: NaturalIdTable, row: ReadonlyMap<string, unknown>): string | null {
  if (table === 'routine_log') {
    const routine = row.get('routine_id');
    const date = row.get('date');
    return typeof routine === 'string' && typeof date === 'string' ? `rlog|${routine}|${date}` : null;
  }
  const country = row.get('country');
  const year = row.get('year');
  const key = row.get('key');
  return (country === 'FR' || country === 'TN') && typeof year === 'number' && typeof key === 'string' ? `holiday|${country}|${String(year)}|${key}` : null;
}
