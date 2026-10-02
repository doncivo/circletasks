import type { Task } from './model';
import { isLocalDate, type LocalDate, type Result } from './types';

/**
 * Déplacement d'une tâche vers un autre jour (S-02, glisser-déposer de la Semaine ; S-06, depuis « Un jour »).
 *
 * Seule la date change : l'heure, l'espace, le titre et les autres champs sont conservés. « Un jour » est levé (la tâche est
 * planifiée) et le badge « reportée » disparaît (T-06 critère 4 : un changement de date manuel l'efface). Une tâche terminée se
 * déplace aussi (S-02 critère 7) et reste terminée. La tâche prend la fin de l'ordre manuel du jour d'arrivée (Q11 : les tâches
 * à heure restent placées par leur heure, seul l'ordre des tâches sans heure compte).
 */
export type MoveToDayError = 'invalid-date' | 'same-day';

export interface MovedSchedule {
  readonly date: LocalDate;
  readonly someday: false;
  readonly carriedOver: false;
  readonly sortOrder: number;
}

/**
 * `lastSortOrder` : plus grand ordre manuel des tâches déjà présentes le jour d'arrivée (null si aucune). Une tâche dont l'ordre
 * dépasse déjà celui-ci le garde (la valeur ne change pas inutilement) ; sinon elle passe juste après.
 */
export function moveTaskToDate(
  task: Pick<Task, 'date' | 'someday' | 'sortOrder'>,
  date: LocalDate,
  lastSortOrder: number | null,
): Result<MovedSchedule, MoveToDayError> {
  if (!isLocalDate(date)) return { ok: false, error: 'invalid-date' };
  if (!task.someday && task.date === date) return { ok: false, error: 'same-day' };
  const sortOrder = lastSortOrder === null || task.sortOrder > lastSortOrder ? task.sortOrder : lastSortOrder + 1;
  return { ok: true, value: { date, someday: false, carriedOver: false, sortOrder } };
}
