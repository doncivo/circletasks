import { addDays, daysInMonth, makeLocalDate, weekdayOf } from './localDate';
import type { Routine } from './model';
import { daysOfWeek, isPlannedOn, isQuotaRule, mondayOf, type DateInterval, type RoutineRule } from './routineSchedule';
import type { LocalDate, RoutineId } from './types';

/**
 * Rapport d'une routine (R-06) : taux de complétion sur 7, 30 et 90 jours, carte de chaleur mensuelle, carte de toutes les
 * routines. Calculs à la volée sur les jours prévus et les validations : jamais stockés. Jours avant `startDate`, de pause et non
 * prévus exclus ; l'occurrence du jour n'entre au dénominateur que si elle est validée.
 */


export interface CompletionRate {
  /** Occurrences prévues dans la période (aujourd'hui seulement si validée). */
  readonly planned: number;
  readonly done: number;
  /** Pourcentage entier arrondi ; null si aucun jour prévu (« — »). */
  readonly percent: number | null;
}

const NO_RATE: CompletionRate = { planned: 0, done: 0, percent: null };

function toRate(planned: number, done: number): CompletionRate {
  return planned === 0 ? NO_RATE : { planned, done, percent: Math.round((done / planned) * 100) };
}

/**
 * Taux entre `from` et `to` (bornes incluses, `to` au plus `today`). Jours avant `startDate`, de pause et non prévus exclus ;
 * aujourd'hui n'entre au dénominateur que s'il est validé. « X fois par semaine » : pour chaque semaine touchée, le quota X
 * (au plus les jours disponibles dans la période) est le dénominateur, les validations de la semaine plafonnées au quota le numérateur.
 */
export function rateBetween(
  rule: RoutineRule,
  done: ReadonlySet<LocalDate>,
  from: LocalDate,
  to: LocalDate,
  today: LocalDate,
  pauses: readonly DateInterval[] = [],
): CompletionRate {
  const start = from < rule.startDate ? rule.startDate : from;
  const end = to > today ? today : to;
  if (start > end) return NO_RATE;
  // Aujourd'hui non validé : ni prévu ni manqué.
  const counts = (date: LocalDate): boolean => isPlannedOn(rule, date, pauses) && !(date === today && !done.has(date));

  if (isQuotaRule(rule)) {
    let planned = 0;
    let validated = 0;
    for (let weekStart = mondayOf(start); weekStart <= end; weekStart = addDays(weekStart, 7)) {
      const days = daysOfWeek(weekStart).filter((date) => date >= start && date <= end && counts(date));
      const quota = Math.min(rule.timesPerWeek ?? 0, days.length);
      planned += quota;
      validated += Math.min(days.filter((date) => done.has(date)).length, quota);
    }
    return toRate(planned, validated);
  }

  let planned = 0;
  let validated = 0;
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (!counts(date)) continue;
    planned += 1;
    if (done.has(date)) validated += 1;
  }
  return toRate(planned, validated);
}

/** Taux sur les `days` derniers jours, aujourd'hui compris (7, 30 ou 90 : R-06). */
export function completionRate(
  rule: RoutineRule,
  done: ReadonlySet<LocalDate>,
  today: LocalDate,
  days: number,
  pauses: readonly DateInterval[] = [],
): CompletionRate {
  return rateBetween(rule, done, addDays(today, 1 - days), today, today, pauses);
}

/** Taux du mois civil (`month` 1 à 12), jusqu'à aujourd'hui au plus. */
export function monthRate(
  rule: RoutineRule,
  done: ReadonlySet<LocalDate>,
  year: number,
  month: number,
  today: LocalDate,
  pauses: readonly DateInterval[] = [],
): CompletionRate {
  return rateBetween(rule, done, makeLocalDate(year, month, 1), makeLocalDate(year, month, daysInMonth(year, month)), today, pauses);
}

/** Texte de pourcentage « 67 % » ; « — » sans jour prévu. */
export function formatPercent(rate: CompletionRate): string {
  return rate.percent === null ? '—' : `${String(rate.percent)} %`;
}

/** État d'un jour de la carte de chaleur d'une routine (R-06 critère 3). */
export type HeatmapState = 'done' | 'missed' | 'upcoming' | 'none';

export interface HeatmapCell {
  readonly date: LocalDate;
  readonly day: number;
  readonly state: HeatmapState;
  readonly isToday: boolean;
}

export interface MonthHeatmap {
  readonly year: number;
  readonly month: number;
  /** Cases vides avant le 1er (lundi en premier : 0 si le 1er est un lundi). */
  readonly leadingBlanks: number;
  readonly cells: readonly HeatmapCell[];
}

function monthCells<T>(year: number, month: number, make: (date: LocalDate, day: number) => T): { leadingBlanks: number; cells: T[] } {
  const total = daysInMonth(year, month);
  const first = makeLocalDate(year, month, 1);
  const cells = Array.from({ length: total }, (_, i) => make(makeLocalDate(year, month, i + 1), i + 1));
  return { leadingBlanks: weekdayOf(first) - 1, cells };
}

/**
 * Carte de chaleur d'un mois : validé ; prévu non fait (passé) ; prévu à venir (aujourd'hui compris tant qu'il n'est pas validé) ;
 * non prévu (vide). Une validation sur un jour non prévu (planification modifiée depuis) reste « validé ». « X fois par
 * semaine » : aucun jour n'est prévu en particulier, seuls les jours validés sont marqués.
 */
export function monthHeatmap(
  rule: RoutineRule,
  done: ReadonlySet<LocalDate>,
  year: number,
  month: number,
  today: LocalDate,
  pauses: readonly DateInterval[] = [],
): MonthHeatmap {
  const quota = isQuotaRule(rule);
  const { leadingBlanks, cells } = monthCells(year, month, (date, day): HeatmapCell => {
    let state: HeatmapState = 'none';
    if (done.has(date)) state = 'done';
    else if (!quota && isPlannedOn(rule, date, pauses)) state = date < today ? 'missed' : 'upcoming';
    return { date, day, state, isToday: date === today };
  });
  return { year, month, leadingBlanks, cells };
}

/** État d'un jour de la carte de toutes les routines (Rapport.html, « ROUTINES — JOURS COMPLÉTÉS »). */
export type AggregateState = 'all' | 'partial' | 'missed' | 'upcoming' | 'none';

export interface AggregateCell {
  readonly date: LocalDate;
  readonly day: number;
  readonly state: AggregateState;
  readonly isToday: boolean;
  readonly planned: number;
  readonly done: number;
}

export interface MonthAggregate {
  readonly year: number;
  readonly month: number;
  readonly leadingBlanks: number;
  readonly cells: readonly AggregateCell[];
}

/**
 * Carte mensuelle de toutes les routines : par jour, validées / prévues. Les routines archivées ou en pause (dont les jours
 * prévus passés ne sont pas connus, pas d'historique de pause) ne comptent que par leurs validations, qui restent dans les
 * statistiques (R-05 critère 6). « Tout validé » : toutes les occurrences du jour faites ; « partiel » : au moins une ; « manqué » :
 * jour passé sans validation ; « à venir » : aujourd'hui non terminé et jours futurs.
 */
export function monthAggregate(
  routines: readonly Routine[],
  doneByRoutine: ReadonlyMap<RoutineId, ReadonlySet<LocalDate>>,
  year: number,
  month: number,
  today: LocalDate,
): MonthAggregate {
  const { leadingBlanks, cells } = monthCells(year, month, (date, day): AggregateCell => {
    let planned = 0;
    let doneCount = 0;
    for (const routine of routines) {
      if (routine.deletedAt !== null) continue;
      const done = doneByRoutine.get(routine.id as RoutineId)?.has(date) ?? false;
      const trackPlan = !routine.paused && !routine.archived && !isQuotaRule(routine);
      if (trackPlan ? isPlannedOn(routine, date) : done) {
        planned += 1;
        if (done) doneCount += 1;
      }
    }
    let state: AggregateState = 'none';
    if (planned > 0) {
      if (doneCount === planned) state = 'all';
      else if (doneCount > 0) state = 'partial';
      else state = date < today ? 'missed' : 'upcoming';
    }
    return { date, day, state, isToday: date === today, planned, done: doneCount };
  });
  return { year, month, leadingBlanks, cells };
}
