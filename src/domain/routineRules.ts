import { isValidIconRef, type RoutineFields, type RoutineScheduleType } from './model';
import { isLocalDate, isLocalTime, isWeekday, type Result, type Weekday } from './types';

/**
 * Règles de saisie d'une routine (R-01, R-02, R-07) : titre, fréquence, date de départ, heure.
 * Fonctions pures ; les écrans et cas d'usage ne connaissent pas ces bornes.
 */

/** Longueur maximale du titre : comme T-01. */
export const ROUTINE_TITLE_MAX_LENGTH = 200;

/** « Tous les N jours » : N de 2 à 30 (R-07). */
export const EVERY_N_DAYS_MIN = 2;
export const EVERY_N_DAYS_MAX = 30;
/** « Toutes les N semaines » : N de 2 à 8 (R-07). */
export const EVERY_N_WEEKS_MIN = 2;
export const EVERY_N_WEEKS_MAX = 8;
/** « X fois par semaine » : X de 1 à 7 (R-01). */
export const TIMES_PER_WEEK_MIN = 1;
export const TIMES_PER_WEEK_MAX = 7;

export type RoutineError =
  | 'empty-title'
  | 'title-too-long'
  | 'weekdays-required'
  | 'times-per-week-invalid'
  | 'interval-invalid'
  | 'start-date-invalid'
  | 'time-invalid'
  | 'icon-invalid'
  | 'schedule-type-invalid';

const SCHEDULE_TYPES: readonly RoutineScheduleType[] = ['daily', 'weekdays', 'x_per_week', 'every_n_days', 'every_n_weeks'];

/** Bornes de N selon l'unité (jours ou semaines) ; null si le type n'a pas de N. */
export function intervalBounds(type: RoutineScheduleType): { readonly min: number; readonly max: number } | null {
  if (type === 'every_n_days') return { min: EVERY_N_DAYS_MIN, max: EVERY_N_DAYS_MAX };
  if (type === 'every_n_weeks') return { min: EVERY_N_WEEKS_MIN, max: EVERY_N_WEEKS_MAX };
  return null;
}

/** Jours choisis, sans doublon et dans l'ordre de la semaine (lundi = 1). */
export function normalizeWeekdays(days: readonly number[]): Weekday[] {
  return [...new Set(days.filter(isWeekday))].sort((a, b) => a - b) as Weekday[];
}

/**
 * Valide et normalise une routine avant écriture : titre sans espaces de bord (1 à 200), champs de fréquence
 * cohérents avec le type (les champs inutiles sont remis à vide : `weekdays` vide, `timesPerWeek` et `interval` null),
 * `weekdays` non vide pour « Jours choisis » et « Toutes les N semaines » (QB-04), date de départ réelle, heure 24 h.
 * Un code d'erreur par cause (le premier rencontré).
 */
export function validateRoutine(input: RoutineFields): Result<RoutineFields, RoutineError> {
  const title = input.title.trim();
  if (title.length === 0) return { ok: false, error: 'empty-title' };
  if (title.length > ROUTINE_TITLE_MAX_LENGTH) return { ok: false, error: 'title-too-long' };
  if (!SCHEDULE_TYPES.includes(input.scheduleType)) return { ok: false, error: 'schedule-type-invalid' };
  if (input.icon !== null && !isValidIconRef(input.icon)) return { ok: false, error: 'icon-invalid' };
  if (!isLocalDate(input.startDate)) return { ok: false, error: 'start-date-invalid' };
  if (input.time !== null && !isLocalTime(input.time)) return { ok: false, error: 'time-invalid' };

  const type = input.scheduleType;
  const weekdays = normalizeWeekdays(input.weekdays);
  const needsDays = type === 'weekdays' || type === 'every_n_weeks';
  if (needsDays && weekdays.length === 0) return { ok: false, error: 'weekdays-required' };

  let timesPerWeek: number | null = null;
  if (type === 'x_per_week') {
    const x = input.timesPerWeek;
    if (x === null || !Number.isInteger(x) || x < TIMES_PER_WEEK_MIN || x > TIMES_PER_WEEK_MAX) return { ok: false, error: 'times-per-week-invalid' };
    timesPerWeek = x;
  }

  let interval: number | null = null;
  const bounds = intervalBounds(type);
  if (bounds) {
    const n = input.interval;
    if (n === null || !Number.isInteger(n) || n < bounds.min || n > bounds.max) return { ok: false, error: 'interval-invalid' };
    interval = n;
  }

  return {
    ok: true,
    value: { ...input, title, weekdays: needsDays ? weekdays : [], timesPerWeek, interval },
  };
}

/** Nouveau N après un changement d'unité jours / semaines : ramené à 8 s'il dépasse (R-07 critère 1), jamais sous 2. */
export function clampInterval(type: 'every_n_days' | 'every_n_weeks', n: number): number {
  const bounds = intervalBounds(type);
  if (!bounds) return n;
  return Math.min(Math.max(Math.trunc(n), bounds.min), bounds.max);
}
