import type { Task, TaskStatus } from './model';
import type { LocalDate, LocalTime, Result } from './types';

/**
 * Règles de planification d'une tâche (T-02). Invariant du modèle (`task.ts`) :
 * `someday = true` ⇒ `date = null` et `time = null` ; `time` non null ⇒ `date` non
 * null. Ces règles sont appliquées ici, jamais dans un repository ni un composant.
 */
export interface ScheduleFields {
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly someday: boolean;
}

/**
 * Modification demandée (fiche détail, A-08) : un champ absent (`undefined`) n'est
 * pas touché, `null` l'efface explicitement. Distinct de `ScheduleFields` pour
 * permettre ce « non fourni / effacé » à trois états.
 */
export interface ScheduleInput {
  readonly date?: LocalDate | null;
  readonly time?: LocalTime | null;
  readonly someday?: boolean;
}

export type ScheduleError = 'time-without-date';

export class ScheduleInvariantError extends Error {
  override readonly name = 'ScheduleInvariantError';
  readonly code: ScheduleError;

  constructor(code: ScheduleError) {
    super(`Planification invalide : ${code}`);
    this.code = code;
  }
}

/**
 * Calcule le nouvel état date / heure / someday d'une tâche à partir de l'état
 * courant et d'une modification partielle (critères 5, 6, T-02).
 *
 * - `someday: true` efface toujours date et heure (invariant M18), quels que
 *   soient `patch.date` / `patch.time`.
 * - Effacer la date (`patch.date: null`) efface aussi l'heure (invariant), que la
 *   tâche passe ou non en « Un jour » (c'est l'appelant qui pose `someday`,
 *   cf. T-14 pour la puce « Un jour »).
 * - Effacer uniquement l'heure (`patch.time: null`) conserve la date.
 * - Poser une heure sans qu'aucune date ne soit ou ne reste choisie est une
 *   entrée invalide (`'time-without-date'`), symétrique à la création (T-01).
 */
export function setTaskSchedule(current: ScheduleFields, patch: ScheduleInput): Result<ScheduleFields, ScheduleError> {
  const someday = patch.someday ?? current.someday;
  const date = someday ? null : patch.date !== undefined ? patch.date : current.date;
  const timeRequested = patch.time !== undefined ? patch.time : current.time;

  if (date === null) {
    if (timeRequested !== null && patch.time !== undefined) {
      return { ok: false, error: 'time-without-date' };
    }
    return { ok: true, value: { date: null, time: null, someday } };
  }

  return { ok: true, value: { date, time: timeRequested, someday } };
}

/**
 * Trie les tâches d'une journée (Aujourd'hui, colonne Semaine) selon la décision
 * Q11 (2026-10-02) : les tâches à faire avec une heure d'abord, par heure
 * croissante, puis les tâches à faire sans heure dans leur ordre manuel
 * (`sort_order`, déjà appliqué par le repository) ; les tâches terminées restent
 * en bas quel que soit leur horaire (T-04), triées selon la même règle entre
 * elles. Tri stable : ne change pas l'ordre relatif des tâches sans heure.
 */
export function sortTasksForDay<T extends { readonly time: LocalTime | null; readonly status: TaskStatus }>(
  tasks: readonly T[],
): T[] {
  const todo = tasks.filter((task) => task.status !== 'done');
  const done = tasks.filter((task) => task.status === 'done');
  return [...sortByTimeThenManualOrder(todo), ...sortByTimeThenManualOrder(done)];
}

function sortByTimeThenManualOrder<T extends { readonly time: LocalTime | null }>(tasks: readonly T[]): T[] {
  const withTime = tasks.filter((task): task is T & { time: LocalTime } => task.time !== null);
  const withoutTime = tasks.filter((task) => task.time === null);
  const sortedWithTime = [...withTime].sort((a, b) => a.time.localeCompare(b.time));
  return [...sortedWithTime, ...withoutTime];
}

/** Vue « planification » d'une tâche, pour appeler `setTaskSchedule` à partir d'un `Task` complet. */
export function scheduleOf(task: Pick<Task, 'date' | 'time' | 'someday'>): ScheduleFields {
  return { date: task.date, time: task.time, someday: task.someday };
}
