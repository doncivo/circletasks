import { addDays } from './localDate';
import { isPlannedOn, isQuotaRule, mondayOf, weekCounter, type DateInterval, type RoutineRule } from './routineSchedule';
import type { LocalDate } from './types';

/**
 * Séries d'une routine (R-04), calculées à la volée sur les jours prévus : jamais stockées. Fonctions pures, `today` fourni
 * par l'appelant. L'occurrence du jour, tant qu'elle n'est pas validée, ne casse pas la série ; les jours avant `startDate`, de
 * pause et non prévus sont ignorés.
 */

export type StreakUnit = 'days' | 'weeks' | 'sessions';

export interface Streaks {
  /** Série en cours : occurrences prévues consécutives validées jusqu'à la dernière échue (semaines pour « X fois par semaine »). */
  readonly current: number;
  /** Plus longue série jamais atteinte ; jamais inférieure à la série en cours. */
  readonly best: number;
  readonly unit: StreakUnit;
}

/** Unité de la série : jours (tous les jours), semaines (X fois par semaine, QB-02), séances (autres fréquences). */
export function streakUnit(rule: Pick<RoutineRule, 'scheduleType'>): StreakUnit {
  if (rule.scheduleType === 'daily') return 'days';
  if (rule.scheduleType === 'x_per_week') return 'weeks';
  return 'sessions';
}

/** Première date validée à partir du départ (une validation antérieure au départ ne compte pas) ; null s'il n'y en a pas. */
function firstDoneFrom(done: ReadonlySet<LocalDate>, startDate: LocalDate): LocalDate | null {
  let first: LocalDate | null = null;
  for (const date of done) if (date >= startDate && (first === null || date < first)) first = date;
  return first;
}

/**
 * Séries en cours et meilleure (R-04) sur les jours prévus. Une occurrence prévue passée et non validée remet la série à 0 ; les
 * jours non prévus et de pause sont ignorés ; l'occurrence du jour non validée ne la casse pas. « X fois par semaine » (QB-02) :
 * semaines consécutives (lundi → dimanche) où le quota est atteint ; la semaine en cours, même incomplète, ne casse jamais la
 * série et s'y ajoute si son quota est atteint.
 */
export function computeStreaks(rule: RoutineRule, done: ReadonlySet<LocalDate>, today: LocalDate, pauses: readonly DateInterval[] = []): Streaks {
  const unit = streakUnit(rule);
  const first = firstDoneFrom(done, rule.startDate);
  // Avant la première validation, chaque occurrence est manquée : la série y vaut 0, on part de là.
  if (first === null || first > today) return { current: 0, best: 0, unit };
  let run = 0;
  let best = 0;

  if (isQuotaRule(rule)) {
    const currentWeek = mondayOf(today);
    for (let weekStart = mondayOf(first); weekStart <= currentWeek; weekStart = addDays(weekStart, 7)) {
      const counter = weekCounter(rule, done, weekStart, pauses);
      const met = counter.planned > 0 && counter.done >= counter.planned;
      if (met) {
        run += 1;
        best = Math.max(best, run);
      } else if (weekStart < currentWeek && counter.planned > 0) run = 0;
    }
    return { current: run, best: Math.max(best, run), unit };
  }

  for (let date = first; date <= today; date = addDays(date, 1)) {
    if (!isPlannedOn(rule, date, pauses)) continue;
    if (done.has(date)) {
      run += 1;
      best = Math.max(best, run);
    } else if (date < today) run = 0;
  }
  return { current: run, best: Math.max(best, run), unit };
}
