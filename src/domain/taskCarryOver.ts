import type { Task } from './model';
import type { LocalDate } from './types';

/**
 * Report automatique des tâches non faites (T-06, décisions Q1 à Q3 du 2026-10-02).
 * Fonctions pures : la date du jour est fournie par l'appelant (jour local, `todayLocal`).
 *
 * Une tâche est reportable quand elle est à faire, non supprimée, datée (hors « Un jour »
 * et hors sans date) et datée strictement avant aujourd'hui. Sa nouvelle date est
 * aujourd'hui ; l'heure flottante est conservée. Plusieurs jours sautés (app fermée)
 * sont rattrapés d'un coup : toute tâche en retard passe à aujourd'hui. Idempotent :
 * une tâche déjà reportée est datée d'aujourd'hui, donc plus reportable le même jour.
 */
export type CarryOverCandidate = Pick<Task, 'date' | 'status' | 'someday' | 'deletedAt'>;

export interface CarryOverOptions<T> {
  /**
   * Point d'extension T-09 : exclure une tâche du report. Par défaut aucune exclusion,
   * donc une occurrence récurrente non faite est reportée comme toute tâche (Q2) ; la
   * suivante est créée à sa date normale par la récurrence, indépendamment du report.
   */
  readonly skip?: (task: T) => boolean;
}

export function isCarryOverCandidate(task: CarryOverCandidate, today: LocalDate): boolean {
  return (
    task.status === 'todo' && task.deletedAt === null && !task.someday && task.date !== null && task.date < today
  );
}

/** Tâches à reporter vers `today` (ordre d'entrée conservé). */
export function carryOverUndoneTasks<T extends CarryOverCandidate>(
  tasks: readonly T[],
  today: LocalDate,
  options: CarryOverOptions<T> = {},
): T[] {
  return tasks.filter((task) => isCarryOverCandidate(task, today) && !options.skip?.(task));
}

/**
 * Délai avant le prochain minuit local (fuseau de l'appareil) à partir de `nowMs`.
 * Calculé depuis la date civile locale : un changement d'heure ou de fuseau ne
 * décale pas le déclenchement (le jour local suivant est recalculé à chaque armement).
 * Au moins 1 ms.
 */
export function msUntilNextLocalMidnight(nowMs: number): number {
  const now = new Date(nowMs);
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(1, next.getTime() - nowMs);
}
