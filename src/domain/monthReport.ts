import type { FocusTotal } from './focusTotals';
import type { ItemFilter } from './itemFilter';
import { addDays, daysInMonth, makeLocalDate, parseLocalDate } from './localDate';
import type { Routine } from './model';
import { monthAggregate, monthRate, type MonthAggregate } from './routineReport';
import type { DateInterval } from './routineSchedule';
import type { LocalDate, RoutineId } from './types';
import { isoWeekOf, type FirstWeekday } from './week';

/**
 * Rapport mensuel (M11, H-01 et H-02) : bornes de mois, semaines ISO du mois, taux de complétion, tuiles. Fonctions pures : les
 * comptes de tâches et d'objectifs arrivent déjà agrégés par SQL (`StatsRepository`), aucune lecture de toutes les tâches en mémoire.
 */

/** Mois civil consulté (`month` de 1 à 12). */
export interface MonthRef {
  readonly year: number;
  readonly month: number;
}

export function monthOf(date: LocalDate): MonthRef {
  const { year, month } = parseLocalDate(date);
  return { year, month };
}

export const monthIndex = (ref: MonthRef): number => ref.year * 12 + (ref.month - 1);

export function sameMonth(a: MonthRef, b: MonthRef): boolean {
  return monthIndex(a) === monthIndex(b);
}

/** Mois décalé de `delta` mois (négatif : avant). */
export function shiftMonth(ref: MonthRef, delta: number): MonthRef {
  const index = monthIndex(ref) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function firstDayOf(ref: MonthRef): LocalDate {
  return makeLocalDate(ref.year, ref.month, 1);
}

export function lastDayOf(ref: MonthRef): LocalDate {
  return makeLocalDate(ref.year, ref.month, daysInMonth(ref.year, ref.month));
}

/** « Mois suivant » : jamais au-delà du mois courant (H-01 critère 2). */
export function canShowNextMonth(ref: MonthRef, today: LocalDate): boolean {
  return monthIndex(ref) < monthIndex(monthOf(today));
}

/** « Mois précédent » : pas avant le mois de la plus ancienne donnée ; sans donnée, pas de retour en arrière. */
export function canShowPreviousMonth(ref: MonthRef, oldest: LocalDate | null): boolean {
  return oldest !== null && monthIndex(ref) > monthIndex(monthOf(oldest));
}

/** Pourcentage entier arrondi ; null sans élément (« — »). */
export function completionPercent(done: number, total: number): number | null {
  return total <= 0 ? null : Math.round((done / total) * 100);
}

/**
 * Jours de tâches comptés pour le mois : du 1er à la fin du mois, sans dépasser aujourd'hui (pas de date future, H-01 D3) ;
 * null si le mois commence après aujourd'hui.
 */
export function countedRange(ref: MonthRef, today: LocalDate): { readonly from: LocalDate; readonly to: LocalDate } | null {
  const from = firstDayOf(ref);
  const last = lastDayOf(ref);
  const to = last > today ? today : last;
  return from > to ? null : { from, to };
}

/** Une semaine ISO (lundi à dimanche) touchant le mois (H-02). */
export interface WeekSlot {
  /** Lundi de la semaine (clé de regroupement SQL). */
  readonly weekStart: LocalDate;
  readonly weekEnd: LocalDate;
  /** Numéro de semaine ISO (36 pour « S36 »). */
  readonly number: number;
  /** Semaine contenant aujourd'hui. */
  readonly isCurrent: boolean;
}

/** Lundi (ISO) de la semaine de `date`. */
export function isoMondayOf(date: LocalDate): LocalDate {
  const { year, month, day } = parseLocalDate(date);
  const isoWeekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  return addDays(date, 1 - isoWeekday);
}

/**
 * Semaines du mois : celles qui ont au moins un jour dans le mois et commencent au plus tard aujourd'hui (H-02 critère 1). Semaines
 * ISO quel que soit le premier jour de semaine choisi en P-03 (H-02 D2).
 */
export function weeksOfMonth(ref: MonthRef, today: LocalDate): WeekSlot[] {
  const first = firstDayOf(ref);
  const last = lastDayOf(ref);
  const slots: WeekSlot[] = [];
  for (let weekStart = isoMondayOf(first); weekStart <= last; weekStart = addDays(weekStart, 7)) {
    if (weekStart > today) break;
    const weekEnd = addDays(weekStart, 6);
    slots.push({ weekStart, weekEnd, number: isoWeekOf(weekStart).week, isCurrent: weekStart <= today && today <= weekEnd });
  }
  return slots;
}

/** Comptes de tâches d'une semaine, tels que groupés par SQL sur le lundi. */
export interface WeekCount {
  readonly weekStart: LocalDate;
  readonly done: number;
  readonly total: number;
}

export interface WeekBar {
  readonly slot: WeekSlot;
  readonly done: number;
  readonly total: number;
  /** null sans tâche : « — » et barre vide en pointillé. */
  readonly percent: number | null;
}

/** Barres du graphique : une par semaine du mois, comptes à zéro pour une semaine sans ligne. */
export function weeklyCompletion(slots: readonly WeekSlot[], counts: readonly WeekCount[]): WeekBar[] {
  const byWeek = new Map(counts.map((count) => [count.weekStart, count] as const));
  return slots.map((slot) => {
    const count = byWeek.get(slot.weekStart);
    const done = count?.done ?? 0;
    const total = count?.total ?? 0;
    return { slot, done, total, percent: completionPercent(done, total) };
  });
}

export interface RoutinesMonthRate {
  readonly planned: number;
  readonly done: number;
  readonly percent: number | null;
}

/** Données de routines d'un mois (validations du mois seulement). */
export interface RoutinesMonthInput {
  /** Routines non supprimées, archivées comprises (R-05 critère 6). */
  readonly routines: readonly Routine[];
  readonly doneByRoutine: ReadonlyMap<RoutineId, ReadonlySet<LocalDate>>;
  readonly pausesOf: ReadonlyMap<RoutineId, readonly DateInterval[]>;
}

const NO_DATES: ReadonlySet<LocalDate> = new Set();

/**
 * Taux du mois de toutes les routines ensemble (H-01 critère 4) : somme des occurrences prévues validées / prévues de chaque routine
 * (calcul de R-06 : pauses exclues, jours futurs exclus). Une routine archivée ne compte que par ses validations du mois.
 */
export function routinesMonthRate(input: RoutinesMonthInput, ref: MonthRef, today: LocalDate): RoutinesMonthRate {
  let planned = 0;
  let done = 0;
  const first = firstDayOf(ref);
  const last = lastDayOf(ref);
  for (const routine of input.routines) {
    if (routine.deletedAt !== null) continue;
    const validated = input.doneByRoutine.get(routine.id) ?? NO_DATES;
    if (routine.archived) {
      const inMonth = [...validated].filter((date) => date >= first && date <= last).length;
      planned += inMonth;
      done += inMonth;
      continue;
    }
    const rate = monthRate(routine, validated, ref.year, ref.month, today, input.pausesOf.get(routine.id) ?? []);
    planned += rate.planned;
    done += rate.done;
  }
  return { planned, done, percent: completionPercent(done, planned) };
}

export interface RoutineRateRow {
  readonly id: RoutineId;
  readonly title: string;
  readonly percent: number | null;
}

/** Taux du mois de chaque routine active (non archivée), dans l'ordre fourni. */
export function routineRateRows(input: RoutinesMonthInput, ref: MonthRef, today: LocalDate): RoutineRateRow[] {
  return input.routines
    .filter((routine) => routine.deletedAt === null && !routine.archived)
    .map((routine) => ({
      id: routine.id,
      title: routine.title,
      percent: monthRate(routine, input.doneByRoutine.get(routine.id) ?? NO_DATES, ref.year, ref.month, today, input.pausesOf.get(routine.id) ?? []).percent,
    }));
}

/**
 * Les routines et les objectifs n'ont pas de projet (ES-08 critère 4) : sous un filtre de projet, leurs tuiles disparaissent (« — »).
 */
export function hasRoutinesAndGoals(filter: ItemFilter): boolean {
  return filter.project === null;
}

export interface GoalsCount {
  readonly achieved: number;
  readonly total: number;
}

export interface MonthReportInput {
  readonly month: MonthRef;
  readonly today: LocalDate;
  readonly filter: ItemFilter;
  readonly firstWeekday: FirstWeekday;
  /** Tâches groupées par semaine ISO, du premier jour du mois à aujourd'hui au plus. */
  readonly weekCounts: readonly WeekCount[];
  readonly routines: RoutinesMonthInput;
  readonly focus: FocusTotal;
  readonly goals: GoalsCount;
}

export interface MonthReport {
  readonly month: MonthRef;
  readonly filter: ItemFilter;
  readonly tasks: { readonly done: number; readonly total: number; readonly percent: number | null };
  /** null sous un filtre de projet : tuile « — ». */
  readonly routines: RoutinesMonthRate | null;
  readonly focus: FocusTotal;
  /** null sans objectif ou sous un filtre de projet : tuile « — ». */
  readonly goals: GoalsCount | null;
  readonly weeks: readonly WeekBar[];
  /** Carte de chaleur de toutes les routines (R-06), null sous un filtre de projet. */
  readonly heatmap: MonthAggregate | null;
  readonly routineRates: readonly RoutineRateRow[];
  /** Rien à compter ce mois-ci (écran vide de P-06). */
  readonly isEmpty: boolean;
}

/** Assemble le rapport du mois depuis les comptes agrégés (H-01 critères 3 à 7, H-02 critère 3). */
export function buildMonthReport(input: MonthReportInput): MonthReport {
  const weeks = weeklyCompletion(weeksOfMonth(input.month, input.today), input.weekCounts);
  const done = weeks.reduce((sum, bar) => sum + bar.done, 0);
  const total = weeks.reduce((sum, bar) => sum + bar.total, 0);
  const scoped = hasRoutinesAndGoals(input.filter);
  const routines = scoped ? routinesMonthRate(input.routines, input.month, input.today) : null;
  const goals = scoped && input.goals.total > 0 ? input.goals : null;
  const heatmap = scoped
    ? monthAggregate(input.routines.routines, input.routines.doneByRoutine, input.month.year, input.month.month, input.today, input.routines.pausesOf, input.firstWeekday)
    : null;
  const hasRoutineData = routines !== null && (routines.planned > 0 || routines.done > 0);
  return {
    month: input.month,
    filter: input.filter,
    tasks: { done, total, percent: completionPercent(done, total) },
    routines,
    focus: input.focus,
    goals,
    weeks,
    heatmap,
    routineRates: scoped ? routineRateRows(input.routines, input.month, input.today) : [],
    isEmpty: total === 0 && !hasRoutineData && input.focus.sessions === 0 && goals === null,
  };
}
