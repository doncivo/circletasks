import type { IsoDateTime, LocalDate, LocalTime, RoutineId, RoutineLogId, RoutinePauseId, SpaceId, SyncMeta, Weekday } from '../types';
import type { IconRef } from './icon';

/** Type de planification d'une routine (R-01, R-07). */
export type RoutineScheduleType = 'daily' | 'weekdays' | 'x_per_week' | 'every_n_days' | 'every_n_weeks';

/**
 * Routine (M4). Table `routine`. Les occurrences ne sont jamais stockées d'avance :
 * elles se calculent à l'affichage (domain-logic) ; seules les validations vont dans
 * `routine_log`.
 *
 * Invariants :
 * - `weekdays` non vide si `scheduleType = 'weekdays'` (aussi pour `every_n_weeks`) ;
 * - `timesPerWeek` 1–7 si `x_per_week`, sinon null ;
 * - `interval` 2–30 si `every_n_days`, 2–8 si `every_n_weeks`, sinon null (R-07) ;
 * - `startDate` : date de départ du calcul (obligatoire pour every_n_*) ;
 * - `paused` : aucune occurrence générée ; `archived` : retirée des listes (R-05).
 */
export interface Routine extends SyncMeta {
  readonly id: RoutineId;
  readonly spaceId: SpaceId;
  readonly title: string;
  readonly icon: IconRef | null;
  readonly scheduleType: RoutineScheduleType;
  readonly weekdays: readonly Weekday[];
  readonly timesPerWeek: number | null;
  readonly interval: number | null;
  readonly startDate: LocalDate;
  readonly time: LocalTime | null;
  readonly paused: boolean;
  readonly archived: boolean;
}

export type RoutineFields = Omit<Routine, keyof SyncMeta>;
export type NewRoutine = RoutineFields & { readonly id: RoutineId };
export type RoutinePatch = Partial<RoutineFields>;

/**
 * Validation d'une routine pour un jour (R-03). Table `routine_log`,
 * unique (routine_id, date). Annuler une validation = suppression logique de la ligne.
 * En synchro, les validations s'additionnent (PRD 7).
 */
export interface RoutineLog extends SyncMeta {
  readonly id: RoutineLogId;
  readonly routineId: RoutineId;
  readonly date: LocalDate;
  readonly doneAt: IsoDateTime;
}

/**
 * Période de pause d'une routine (R-04 critère 5, R-05). Table `routine_pause`, synchronisable. `fromDate` : premier jour de pause ;
 * `toDate` : dernier jour de pause, null tant que la pause est ouverte. Les jours de pause ne comptent ni dans les séries, ni dans
 * les taux, ni dans la carte de chaleur ; les validations passées restent intactes.
 */
export interface RoutinePause extends SyncMeta {
  readonly id: RoutinePauseId;
  readonly routineId: RoutineId;
  readonly fromDate: LocalDate;
  readonly toDate: LocalDate | null;
}
