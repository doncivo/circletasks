import { addDays, weekdayOf } from './localDate';
import type { Routine, RoutineLog, RoutinePause } from './model';
import type { TodayRoutineEntry } from './todayList';
import type { LocalDate, RoutineId, Weekday } from './types';

/**
 * Planification des routines (R-01, R-03, R-07) : jours prévus, compteur de la semaine, liste du jour.
 *
 * Les occurrences ne sont JAMAIS stockées d'avance (PRD 6) : tout se calcule ici à partir de la règle de la routine, de sa date de
 * départ et des validations (`routine_log`). Dates civiles locales, arithmétique en UTC : aucun effet de fuseau ni de changement
 * d'heure (les 29 mars et 25 octobre comptent 24 h). Semaines ISO, du lundi au dimanche.
 */

/** Ce que la planification lit d'une routine (un brouillon de formulaire convient pour l'aperçu). */
export type RoutineRule = Pick<Routine, 'scheduleType' | 'weekdays' | 'timesPerWeek' | 'interval' | 'startDate'>;

/** État d'une routine qui rend un jour actif ou non. */
export type RoutineState = Pick<Routine, 'paused' | 'archived' | 'deletedAt'>;

/** Période de pause, bornes incluses : aucune occurrence n'est prévue ces jours-là (R-05). */
export interface DateInterval {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

/** Fin d'une pause ouverte : aucune reprise connue. */
export const OPEN_PAUSE_END = '9999-12-31' as LocalDate;

/** Périodes de pause (supprimées exclues) de chaque routine ; une pause ouverte court sans fin. */
export function pausesByRoutine(pauses: readonly RoutinePause[]): Map<RoutineId, DateInterval[]> {
  const out = new Map<RoutineId, DateInterval[]>();
  for (const pause of pauses) {
    if (pause.deletedAt !== null) continue;
    const list = out.get(pause.routineId) ?? [];
    list.push({ from: pause.fromDate, to: pause.toDate ?? OPEN_PAUSE_END });
    out.set(pause.routineId, list);
  }
  return out;
}

/** Nombre de jours civils entre deux dates (positif si `to` est après `from`). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const ms = (date: LocalDate): number => {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Lundi de la semaine qui contient `date`. */
export function mondayOf(date: LocalDate): LocalDate {
  return addDays(date, 1 - weekdayOf(date));
}

/** Les sept jours de la semaine commençant le lundi `weekStart`. */
export function daysOfWeek(weekStart: LocalDate): LocalDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** « X fois par semaine » : pas de jour précis, un quota par semaine (QB-01, QB-02). */
export function isQuotaRule(rule: Pick<RoutineRule, 'scheduleType'>): boolean {
  return rule.scheduleType === 'x_per_week';
}

/** `date` tombe-t-elle dans une période de pause ? */
export function isPausedOn(date: LocalDate, pauses: readonly DateInterval[]): boolean {
  return pauses.some((pause) => date >= pause.from && date <= pause.to);
}

/**
 * Un jour est-il « prévu » ? Aucun jour avant `startDate` ne l'est (R-01 critère 9) ni pendant une pause.
 * - tous les jours : chaque jour ; jours choisis : les jours de `weekdays` ;
 * - tous les N jours : `startDate` + k × N ; toutes les N semaines : les `weekdays` des semaines `startDate` + k × N (QB-04) ;
 * - X fois par semaine : tout jour est possible (le quota se contrôle à la semaine, voir `weekCounter`).
 */
export function isPlannedOn(rule: RoutineRule, date: LocalDate, pauses: readonly DateInterval[] = []): boolean {
  if (date < rule.startDate || isPausedOn(date, pauses)) return false;
  switch (rule.scheduleType) {
    case 'daily':
    case 'x_per_week':
      return true;
    case 'weekdays':
      return rule.weekdays.includes(weekdayOf(date));
    case 'every_n_days': {
      const n = rule.interval ?? 0;
      return n >= 1 && daysBetween(rule.startDate, date) % n === 0;
    }
    case 'every_n_weeks': {
      const n = rule.interval ?? 0;
      if (n < 1 || !rule.weekdays.includes(weekdayOf(date))) return false;
      const weeks = Math.round(daysBetween(mondayOf(rule.startDate), mondayOf(date)) / 7);
      return weeks % n === 0;
    }
    default:
      return false;
  }
}

/** Jours prévus de `from` à `to` inclus, dans l'ordre. */
export function plannedDates(rule: RoutineRule, from: LocalDate, to: LocalDate, pauses: readonly DateInterval[] = []): LocalDate[] {
  const out: LocalDate[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) if (isPlannedOn(rule, date, pauses)) out.push(date);
  return out;
}

/** Garde-fou de `nextOccurrences` : au plus ~11 ans de recherche (N max 30 jours ou 8 semaines). */
const SEARCH_LIMIT_DAYS = 4_000;

/** Les `count` prochains jours prévus à partir de `from` (inclus), pour l'aperçu « Prochaines fois » (R-07 critère 3). */
export function nextOccurrences(rule: RoutineRule, from: LocalDate, count: number, pauses: readonly DateInterval[] = []): LocalDate[] {
  const out: LocalDate[] = [];
  let date = from < rule.startDate ? rule.startDate : from;
  for (let i = 0; i < SEARCH_LIMIT_DAYS && out.length < count; i += 1) {
    if (isPlannedOn(rule, date, pauses)) out.push(date);
    date = addDays(date, 1);
  }
  return out;
}

/** Dates validées d'une routine (une validation supprimée n'existe plus : `deletedAt` non nul). */
export function doneDatesOf(logs: readonly RoutineLog[], routineId?: RoutineId): Set<LocalDate> {
  const out = new Set<LocalDate>();
  for (const log of logs) if (log.deletedAt === null && (routineId === undefined || log.routineId === routineId)) out.add(log.date);
  return out;
}

/** Validations de chaque routine, regroupées en une passe. */
export function groupDoneDates(logs: readonly RoutineLog[]): Map<RoutineId, Set<LocalDate>> {
  const out = new Map<RoutineId, Set<LocalDate>>();
  for (const log of logs) {
    if (log.deletedAt !== null) continue;
    const set = out.get(log.routineId) ?? new Set<LocalDate>();
    set.add(log.date);
    out.set(log.routineId, set);
  }
  return out;
}

export interface WeekCounter {
  /** Validations de la semaine sur des jours prévus (au plus `planned`). */
  readonly done: number;
  /** Occurrences prévues dans la semaine (le quota X pour « X fois par semaine ») ; jamais avant `startDate`. */
  readonly planned: number;
}

/**
 * Compteur « faits / prévus » de la semaine commençant le lundi `weekStart` (R-01 critères 7 et 8) : « Tous les jours » 7,
 * « Jours choisis » le nombre de jours, « X fois par semaine » X (même la semaine de départ), « Tous les N » les occurrences de la semaine. La
 * semaine de départ ne compte que les jours depuis `startDate` (aucun jour antérieur n'est prévu, critère 9) ; une semaine entièrement
 * avant le départ n'a rien de prévu.
 */
export function weekCounter(rule: RoutineRule, done: ReadonlySet<LocalDate>, weekStart: LocalDate, pauses: readonly DateInterval[] = []): WeekCounter {
  const days = daysOfWeek(weekStart).filter((day) => isPlannedOn(rule, day, pauses));
  const planned = isQuotaRule(rule) ? (days.length > 0 ? (rule.timesPerWeek ?? 0) : 0) : days.length;
  const count = days.filter((day) => done.has(day)).length;
  return { done: Math.min(count, planned), planned };
}

/** Le quota de la semaine de `date` est-il atteint ? (« X fois par semaine ») */
export function quotaReached(rule: RoutineRule, done: ReadonlySet<LocalDate>, date: LocalDate, pauses: readonly DateInterval[] = []): boolean {
  const counter = weekCounter(rule, done, mondayOf(date), pauses);
  return counter.done >= counter.planned;
}

/**
 * Le jour `date` peut-il être validé ou rouvert depuis la carte, la liste du jour ou la Semaine (QB-03) ? Jamais un jour futur ;
 * un jour déjà validé se rouvre toujours ; sinon il doit être prévu et, pour « X fois par semaine », le quota de la semaine ne
 * doit pas être atteint (QB-01 : pas de 4e validation). Une routine en pause ou archivée n'a aucun jour actif.
 */
export function canToggleDay(
  routine: RoutineState & RoutineRule,
  done: ReadonlySet<LocalDate>,
  date: LocalDate,
  today: LocalDate,
  pauses: readonly DateInterval[] = [],
): boolean {
  if (routine.paused || routine.archived || routine.deletedAt !== null || date > today) return false;
  if (done.has(date)) return true;
  if (!isPlannedOn(routine, date, pauses)) return false;
  return !isQuotaRule(routine) || !quotaReached(routine, done, date, pauses);
}

/** Un des sept ronds L à D de la carte. */
export interface WeekRound {
  readonly date: LocalDate;
  readonly weekday: Weekday;
  /** Jour prévu (rond plein) ; sinon rond en pointillés. Pour « X fois par semaine » tout jour depuis le départ l'est. */
  readonly planned: boolean;
  readonly done: boolean;
  /** Jour après aujourd'hui. */
  readonly future: boolean;
  /** Cliquable : aujourd'hui et jours passés, jours prévus ou déjà validés (QB-03). */
  readonly toggleable: boolean;
}

export function weekRounds(
  routine: RoutineState & RoutineRule,
  done: ReadonlySet<LocalDate>,
  weekStart: LocalDate,
  today: LocalDate,
  pauses: readonly DateInterval[] = [],
): WeekRound[] {
  return daysOfWeek(weekStart).map((date) => ({
    date,
    weekday: weekdayOf(date),
    planned: isPlannedOn(routine, date, pauses),
    done: done.has(date),
    future: date > today,
    toggleable: canToggleDay(routine, done, date, today, pauses),
  }));
}

/** La routine compte-t-elle dans les listes du jour ? (ni supprimée, ni archivée, ni en pause). */
export function isActive(routine: RoutineState): boolean {
  return routine.deletedAt === null && !routine.archived && !routine.paused;
}

/**
 * Routines affichées le jour `date` dans Aujourd'hui et la Semaine (R-01 critère 11, R-03, R-05) : jours prévus des routines
 * actives, avec l'état de leur validation. « X fois par semaine » (QB-01) : affichée chaque jour depuis le départ tant que le
 * quota de la semaine n'est pas atteint, plus du tout ensuite jusqu'au lundi ; le jour d'une validation elle reste affichée
 * (barrée). Les routines en pause n'ont aucune occurrence, ni les archivées.
 */
export function routinesForDay(
  routines: readonly Routine[],
  doneByRoutine: ReadonlyMap<RoutineId, ReadonlySet<LocalDate>>,
  date: LocalDate,
  pauses: ReadonlyMap<RoutineId, readonly DateInterval[]> = new Map<RoutineId, readonly DateInterval[]>(),
): TodayRoutineEntry[] {
  const out: TodayRoutineEntry[] = [];
  for (const routine of routines) {
    const routinePauses = pauses.get(routine.id as RoutineId) ?? [];
    if (!isActive(routine) || !isPlannedOn(routine, date, routinePauses)) continue;
    const done = doneByRoutine.get(routine.id as RoutineId) ?? new Set<LocalDate>();
    const doneToday = done.has(date);
    if (isQuotaRule(routine) && !doneToday && quotaReached(routine, done, date, routinePauses)) continue;
    out.push({ routine, done: doneToday });
  }
  return out;
}
