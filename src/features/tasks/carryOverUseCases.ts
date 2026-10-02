import { todayLocal } from '../../domain/clock';
import type { Task } from '../../domain/model';
import { carryOverUndoneTasks } from '../../domain/taskCarryOver';
import type { TaskUseCaseDeps } from './taskUseCases';

export type CarryOverDeps = Pick<TaskUseCaseDeps, 'clock' | 'data' | 'taskEntities'>;

export interface CarryOverUseCases {
  /**
   * T-06 : reporte à aujourd'hui les tâches non faites des jours passés si le réglage
   * `tasks.carryOverUndone` est actif (défaut : oui). Lecture et écriture en une seule
   * transaction ; les tâches écrites sont publiées dans `taskEntities`. Idempotent.
   * Non annulable (critère 10) : aucune commande poussée dans la pile d'annulation.
   * Rend les tâches reportées (liste vide si réglage désactivé ou rien à faire).
   */
  run(): Promise<Task[]>;
}

export function createCarryOverUseCases(deps: CarryOverDeps): CarryOverUseCases {
  return {
    async run() {
      if (!(await deps.data.repos.settings.get('tasks.carryOverUndone'))) return [];
      const today = todayLocal(deps.clock);
      const carried = await deps.data.transaction(async (repos) => {
        const undone = await repos.tasks.listUndoneBefore(today);
        const ids = carryOverUndoneTasks(undone, today).map((task) => task.id);
        return ids.length === 0 ? [] : repos.tasks.carryOver(ids, today);
      });
      deps.taskEntities.publish(carried);
      return carried;
    },
  };
}
