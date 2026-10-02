import type { Task } from '../../domain/model';
import type { TaskId } from '../../domain/types';

/**
 * Sélecteur générique des tâches d'une vue (ADR 0004, avenant) : les écrans ne gardent
 * que des ids ; chaque vue fournit son filtre (`predicate`, ex. date et espace du jour
 * affiché) et applique ensuite son propre tri. Une entité absente ou ne satisfaisant
 * plus le filtre (tâche reportée, supprimée, déplacée) sort immédiatement de la vue ;
 * l'ordre des ids est conservé.
 */
export function selectTasks(
  ids: readonly TaskId[],
  entities: ReadonlyMap<TaskId, Task>,
  predicate: (task: Task) => boolean,
): Task[] {
  const selected: Task[] = [];
  for (const id of ids) {
    const task = entities.get(id);
    if (task && task.deletedAt === null && predicate(task)) selected.push(task);
  }
  return selected;
}
