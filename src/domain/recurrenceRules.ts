import type { RecurrenceFields } from './model';
import { addDays, daysInMonth, makeLocalDate, parseLocalDate, weekdayOf } from './localDate';
import type { LocalDate, Result, Weekday } from './types';
import { isLocalDate, isWeekday } from './types';

/**
 * Règles de récurrence des tâches (T-09, T-10). Fonctions pures : aucune date système,
 * aucun fuseau. Tout se calcule sur des dates civiles, donc un changement d'heure
 * n'a aucun effet (les heures de tâche sont flottantes).
 *
 * Conventions :
 * - `seriesIndex` est 0-based (0 = première occurrence, modèle `Task`) ; avec `count = N`,
 *   la série compte N occurrences (indices 0 à N-1) ;
 * - l'occurrence suivante est toujours calculée depuis la date prévue de l'occurrence
 *   courante, jamais depuis sa date de fin ;
 * - semaine commençant le lundi ; intervalle hebdomadaire ancré sur la semaine de la date courante ;
 * - Q7 : un jour de mois inexistant (29, 30, 31) tombe le dernier jour du mois, la règle reprend
 *   son jour d'origine dès qu'il existe (le jour vient de `monthDay`, pas de la date courante) ;
 * - « 5ᵉ <jour> » absent du mois : dernier <jour> du mois (aucun mois n'est sauté) ;
 * - annuelle : mois pris sur la date courante, jour = `monthDay` s'il est renseigné (à poser à
 *   la création, cf. `defaultRecurrence`), sinon jour de la date courante.
 */
export type RecurrenceErrorCode =
  | 'interval_invalid'
  | 'weekdays_required'
  | 'weekday_invalid'
  | 'field_not_allowed'
  | 'month_rule_required'
  | 'month_rule_conflict'
  | 'month_day_invalid'
  | 'nth_invalid'
  | 'end_conflict'
  | 'count_invalid'
  | 'until_invalid'
  | 'until_before_start'
  | 'until_in_past'
  | 'start_required';

export interface RecurrenceError {
  readonly code: RecurrenceErrorCode;
  /** Champ de la règle concerné. */
  readonly field: keyof RecurrenceFields | 'startDate';
}

export interface ValidateRecurrenceOptions {
  /** Date de départ de la tâche : une récurrence exige une date. */
  readonly startDate: LocalDate | null;
  /** Si fourni, une fin déjà dépassée est refusée (T-10 critère 9). */
  readonly today?: LocalDate;
}

const VALID_NTH: readonly number[] = [1, 2, 3, 4, 5, -1];

/** Valide une règle ; renvoie la règle ou la liste complète des erreurs. */
export function validateRecurrence(
  rule: RecurrenceFields,
  options: ValidateRecurrenceOptions,
): Result<RecurrenceFields, readonly RecurrenceError[]> {
  const errors: RecurrenceError[] = [];
  const add = (code: RecurrenceErrorCode, field: RecurrenceError['field']) => errors.push({ code, field });

  if (options.startDate === null) add('start_required', 'startDate');
  if (!Number.isInteger(rule.interval) || rule.interval < 1) add('interval_invalid', 'interval');

  if (rule.freq === 'weekly') {
    if (rule.weekdays.length === 0) add('weekdays_required', 'weekdays');
    else if (!rule.weekdays.every((d) => isWeekday(d)) || new Set(rule.weekdays).size !== rule.weekdays.length) {
      add('weekday_invalid', 'weekdays');
    }
  } else if (rule.weekdays.length > 0) add('field_not_allowed', 'weekdays');

  if (rule.freq === 'monthly') {
    if (rule.monthDay === null && rule.nthWeekday === null) add('month_rule_required', 'monthDay');
    else if (rule.monthDay !== null && rule.nthWeekday !== null) add('month_rule_conflict', 'nthWeekday');
  } else if (rule.nthWeekday !== null) add('field_not_allowed', 'nthWeekday');
  if (rule.freq !== 'monthly' && rule.freq !== 'yearly' && rule.monthDay !== null) {
    add('field_not_allowed', 'monthDay');
  }
  if (rule.monthDay !== null && (!Number.isInteger(rule.monthDay) || rule.monthDay < 1 || rule.monthDay > 31)) {
    add('month_day_invalid', 'monthDay');
  }
  if (rule.nthWeekday !== null) {
    if (!VALID_NTH.includes(rule.nthWeekday.nth) || !isWeekday(rule.nthWeekday.weekday)) {
      add('nth_invalid', 'nthWeekday');
    }
  }

  if (rule.until !== null && rule.count !== null) add('end_conflict', 'count');
  if (rule.count !== null && (!Number.isInteger(rule.count) || rule.count < 1)) add('count_invalid', 'count');
  if (rule.until !== null) {
    if (!isLocalDate(rule.until)) add('until_invalid', 'until');
    else if (options.startDate !== null && rule.until < options.startDate) add('until_before_start', 'until');
    else if (options.today !== undefined && rule.until < options.today) add('until_in_past', 'until');
  }

  return errors.length === 0 ? { ok: true, value: rule } : { ok: false, error: errors };
}

/**
 * Règle par défaut proposée à la saisie pour une date de départ (T-09 critères 1 à 3) :
 * hebdo = jour de la date ; mensuel = « le 23 » ; annuel = chaque 23 sept. (jour mémorisé).
 */
export function defaultRecurrence(freq: RecurrenceFields['freq'], startDate: LocalDate): RecurrenceFields {
  const base: RecurrenceFields = {
    freq,
    interval: 1,
    weekdays: [],
    monthDay: null,
    nthWeekday: null,
    until: null,
    count: null,
  };
  const { day } = parseLocalDate(startDate);
  if (freq === 'weekly') return { ...base, weekdays: [weekdayOf(startDate)] };
  if (freq === 'monthly' || freq === 'yearly') return { ...base, monthDay: day };
  return base;
}

/** Jour d'un mois correspondant au « Nᵉ jour de semaine » ; absent (5ᵉ) ou -1 : le dernier. */
export function nthWeekdayOfMonth(year: number, month: number, nth: number, weekday: Weekday): number {
  const first = weekdayOf(makeLocalDate(year, month, 1));
  const offset = (weekday - first + 7) % 7;
  const dim = daysInMonth(year, month);
  const wanted = 1 + offset + 7 * (nth - 1);
  if (nth !== -1 && wanted <= dim) return wanted;
  return 1 + offset + 7 * Math.floor((dim - 1 - offset) / 7);
}

function monthCandidate(rule: RecurrenceFields, monthIndex: number): LocalDate {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const nth = rule.nthWeekday;
  const day =
    nth !== null
      ? nthWeekdayOfMonth(year, month, nth.nth, nth.weekday)
      : Math.min(rule.monthDay ?? 1, daysInMonth(year, month));
  return makeLocalDate(year, month, day);
}

function nextWeekly(rule: RecurrenceFields, from: LocalDate): LocalDate {
  const days = [...rule.weekdays].sort((a, b) => a - b);
  const current = weekdayOf(from);
  const later = days.find((d) => d > current);
  if (later !== undefined) return addDays(from, later - current);
  const monday = addDays(from, -(current - 1));
  return addDays(monday, 7 * rule.interval + ((days[0] ?? current) - 1));
}

function nextMonthly(rule: RecurrenceFields, from: LocalDate): LocalDate {
  const { year, month } = parseLocalDate(from);
  const index = year * 12 + month - 1;
  const sameMonth = monthCandidate(rule, index);
  return sameMonth > from ? sameMonth : monthCandidate(rule, index + rule.interval);
}

function nextYearly(rule: RecurrenceFields, from: LocalDate): LocalDate {
  const { year, month, day } = parseLocalDate(from);
  const at = (y: number) => makeLocalDate(y, month, Math.min(rule.monthDay ?? day, daysInMonth(y, month)));
  const sameYear = at(year);
  return sameYear > from ? sameYear : at(year + rule.interval);
}

/**
 * Date de l'occurrence suivant `fromDate` (date prévue de l'occurrence courante,
 * d'indice `seriesIndex`), strictement postérieure à `fromDate`. `null` quand la série
 * est terminée : `count` atteint ou date calculée après `until` (inclus).
 */
export function nextOccurrenceDate(
  rule: RecurrenceFields,
  fromDate: LocalDate,
  seriesIndex: number,
): LocalDate | null {
  if (rule.count !== null && seriesIndex + 1 >= rule.count) return null;
  let next: LocalDate;
  switch (rule.freq) {
    case 'daily':
      next = addDays(fromDate, rule.interval);
      break;
    case 'weekly':
      next = nextWeekly(rule, fromDate);
      break;
    case 'monthly':
      next = nextMonthly(rule, fromDate);
      break;
    case 'yearly':
      next = nextYearly(rule, fromDate);
      break;
  }
  return rule.until !== null && next > rule.until ? null : next;
}
