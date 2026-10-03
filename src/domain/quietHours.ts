import { parseLocalDate, weekdayOf } from './localDate';
import type { QuietHours } from './model';
import { isLocalTime, isWeekday, type LocalDate, type LocalDateTime, type LocalTime, type Result, type Weekday } from './types';

/**
 * Plages silencieuses d'un espace (ES-07, PRD M13) : aucun rappel de l'espace pendant une plage ; un rappel qui y tombe est décalé à
 * la fin de la plage. Le calcul est sur l'heure locale flottante (comme `reminder.fire_at`, T-11) : 08:00 reste 08:00 le jour d'un
 * changement d'heure, aucune durée en heures n'est ajoutée.
 *
 * Une plage ne s'applique qu'aux rappels (tâches, routines, événements) : ni aux récapitulatifs (N-04), ni à la fin d'une session
 * Focus (F-04), ni au PC (aucune notification de rappel n'y est émise).
 *
 * Représentation (`space.quiet_hours`, JSON de `QuietHours`) :
 * - `weekdays` : jours (1 = lundi … 7 = dimanche) où la plage COMMENCE ;
 * - `from` → `to` : une plage dont `to` est avant `from` traverse minuit et finit le lendemain (19:00 → 08:00 commencée le dimanche
 *   finit le lundi 08:00) ;
 * - « toute la journée » : `from` = `to` = « 00:00 » (de 00:00 au 00:00 suivant) ; tout autre `from` = `to` est refusé.
 */

const ALL_DAY: LocalTime = '00:00' as LocalTime;
const EVERY_DAY: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];
const WEEKEND: readonly Weekday[] = [6, 7];

/**
 * Plages de Pro à la création (ES-07 critère 1) : chaque soir 19:00 → 08:00 (dimanche soir compris, jusqu'au lundi 08:00) et le
 * samedi et le dimanche en entier. Perso n'en a aucune. Le JSON de la migration 0007 reprend ces valeurs (texte figé).
 */
export const DEFAULT_PRO_QUIET_HOURS: readonly QuietHours[] = [
  { weekdays: EVERY_DAY, from: '19:00' as LocalTime, to: '08:00' as LocalTime },
  { weekdays: WEEKEND, from: ALL_DAY, to: ALL_DAY },
];

export const isAllDayRange = (range: Pick<QuietHours, 'from' | 'to'>): boolean => range.from === ALL_DAY && range.to === ALL_DAY;

/** Plage « toute la journée » sur les jours donnés. */
export const allDayRange = (weekdays: readonly Weekday[]): QuietHours => ({ weekdays: sortedDays(weekdays), from: ALL_DAY, to: ALL_DAY });

function sortedDays(days: readonly Weekday[]): Weekday[] {
  return [...new Set(days)].sort((a, b) => a - b);
}

export type QuietHoursError = 'no-days' | 'invalid-day' | 'invalid-time' | 'empty-range';

/**
 * Valide une plage (ES-07 critères 3 et 4) : au moins un jour valide, heures 24 h, et début différent de la fin sauf « toute la
 * journée » (00:00 → 00:00). Rend la plage normalisée (jours uniques triés).
 */
export function validateQuietRange(range: QuietHours): Result<QuietHours, QuietHoursError> {
  if (range.weekdays.length === 0) return { ok: false, error: 'no-days' };
  if (range.weekdays.some((day) => !isWeekday(day))) return { ok: false, error: 'invalid-day' };
  if (!isLocalTime(range.from) || !isLocalTime(range.to)) return { ok: false, error: 'invalid-time' };
  if (range.from === range.to && !isAllDayRange(range)) return { ok: false, error: 'empty-range' };
  return { ok: true, value: { weekdays: sortedDays(range.weekdays), from: range.from, to: range.to } };
}

/** Valide toutes les plages ; renvoie la première refusée avec son rang. */
export function validateQuietHours(ranges: readonly QuietHours[]): Result<QuietHours[], { readonly index: number; readonly error: QuietHoursError }> {
  const valid: QuietHours[] = [];
  for (const [index, range] of ranges.entries()) {
    const checked = validateQuietRange(range);
    if (!checked.ok) return { ok: false, error: { index, error: checked.error } };
    valid.push(checked.value);
  }
  return { ok: true, value: valid };
}

const dayIndex = (date: LocalDate): number => {
  const { year, month, day } = parseLocalDate(date);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
};

const dateOfIndex = (index: number): LocalDate => new Date(index * 86_400_000).toISOString().slice(0, 10) as LocalDate;

const minutesOf = (time: LocalTime): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Durée d'une plage en minutes : `to` avant ou égal à `from` = traverse minuit (« toute la journée » : 24 h). */
const durationOf = (range: Pick<QuietHours, 'from' | 'to'>): number => {
  const span = minutesOf(range.to) - minutesOf(range.from);
  return span > 0 ? span : span + 1440;
};

const toLocalDateTime = (totalMinutes: number): LocalDateTime => {
  const day = Math.floor(totalMinutes / 1440);
  const inDay = totalMinutes - day * 1440;
  const hh = String(Math.floor(inDay / 60)).padStart(2, '0');
  const mm = String(inDay % 60).padStart(2, '0');
  return `${dateOfIndex(day)}T${hh}:${mm}` as LocalDateTime;
};

/**
 * Échéance effective d'un rappel (ES-07 critères 5 à 7) : `fireAt` si aucune plage ne le couvre ; sinon la fin de la dernière plage
 * continue (des plages qui se chevauchent ou s'enchaînent comptent pour une seule, critère 6). Début de plage inclus, fin exclue :
 * 08:00 n'est plus silencieux. `fire_at` lui-même n'est jamais modifié : l'échéance effective se recalcule à chaque lecture, donc
 * modifier une plage la met à jour sans écrire de rappel (critère 7). Si les plages couvrent tout sans fin (une semaine continue),
 * l'échéance d'origine est rendue plutôt que de perdre le rappel.
 *
 * @example
 * effectiveFireAt('2026-09-22T20:00', DEFAULT_PRO_QUIET_HOURS) // mardi 20:00 → '2026-09-23T08:00'
 */
export function effectiveFireAt(fireAt: LocalDateTime, quietHours: readonly QuietHours[]): LocalDateTime {
  if (quietHours.length === 0) return fireAt;
  const ranges = quietHours.filter((range) => validateQuietRange(range).ok);
  const [date, time] = fireAt.split('T') as [LocalDate, LocalTime];
  const origin = dayIndex(date) * 1440 + minutesOf(time);
  let moment = origin;
  // Chaque saut avance d'une plage au moins ; au-delà de deux plages par jour et par plage sur une semaine, le silence est continu.
  const limit = 14 * Math.max(ranges.length, 1) + 2;
  for (let step = 0; step <= limit; step += 1) {
    const today = Math.floor(moment / 1440);
    let end = moment;
    // Une plage dure au plus 24 h : elle a commencé aujourd'hui ou hier.
    for (const startDay of [today - 1, today]) {
      const weekday = weekdayOf(dateOfIndex(startDay));
      for (const range of ranges) {
        if (!range.weekdays.includes(weekday)) continue;
        const start = startDay * 1440 + minutesOf(range.from);
        const finish = start + durationOf(range);
        if (start <= moment && moment < finish && finish > end) end = finish;
      }
    }
    if (end === moment) return moment === origin ? fireAt : toLocalDateTime(moment);
    moment = end;
  }
  return fireAt;
}

/** Élément du résumé d'une ligne « Silence Pro » (ES-07 critère 2) : le texte est composé par l'interface (i18n). */
export type QuietSummaryPart =
  | { readonly kind: 'every-day'; readonly from: LocalTime; readonly to: LocalTime }
  | { readonly kind: 'weekend-all-day' }
  | { readonly kind: 'all-day'; readonly weekdays: readonly Weekday[] }
  | { readonly kind: 'range'; readonly weekdays: readonly Weekday[]; readonly from: LocalTime; readonly to: LocalTime };

const sameDays = (days: readonly Weekday[], expected: readonly Weekday[]): boolean => days.length === expected.length && expected.every((day) => days.includes(day));

/**
 * Résumé structuré des plages : « 19:00 – 08:00, week-end » pour Pro par défaut ; liste vide = « Aucune ». Les plages invalides sont
 * ignorées.
 */
export function describeQuietHours(ranges: readonly QuietHours[]): QuietSummaryPart[] {
  const parts: QuietSummaryPart[] = [];
  for (const raw of ranges) {
    const checked = validateQuietRange(raw);
    if (!checked.ok) continue;
    const { weekdays, from, to } = checked.value;
    if (isAllDayRange(checked.value)) parts.push(sameDays(weekdays, WEEKEND) ? { kind: 'weekend-all-day' } : { kind: 'all-day', weekdays });
    else if (sameDays(weekdays, EVERY_DAY)) parts.push({ kind: 'every-day', from, to });
    else parts.push({ kind: 'range', weekdays, from, to });
  }
  return parts;
}
