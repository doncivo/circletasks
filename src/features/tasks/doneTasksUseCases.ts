import { donePeriodInstants, isInDonePeriod, type DonePeriod } from '../../domain/donePeriod';
import type { Task } from '../../domain/model';
import type { SpaceFilter, TaskId } from '../../domain/types';
import type { UndoableCommand } from '../app/undo';
import type { TaskUseCaseDeps } from './taskUseCases';

/** Cas d'usage de la liste « Tâches terminées » (T-07). */
export interface DoneTasksUseCases {
  /**
   * Tâches terminées dans la période (date locale de `doneAt`), filtre d'espace appliqué,
   * hors corbeille. Publiées dans la source unique (`taskEntities`). Rejette si la lecture échoue.
   */
  list(period: DonePeriod, filter: SpaceFilter): Promise<Task[]>;
  /**
   * Rouvre une tâche terminée (T-04) et pousse une commande annulable 5 s (critère 6) :
   * annuler la terminait à nouveau, à l'heure d'origine, si elle n'a pas changé depuis.
   */
  reopen(id: TaskId): Promise<Task>;
}

export function createDoneTasksUseCases(deps: TaskUseCaseDeps): DoneTasksUseCases {
  return {
    async list(period, filter) {
      const loaded = await deps.data.repos.tasks.listDone(donePeriodInstants(period), filter);
      // Garde-fou : la borne SQL est en instants, la période en dates locales (mêmes bornes, minuit local).
      const tasks = loaded.filter((task) => isInDonePeriod(task, period));
      deps.taskEntities.publish(tasks);
      return tasks;
    },

    async reopen(id) {
      const before = await deps.data.repos.tasks.getById(id);
      const reopened = await deps.data.repos.tasks.reopen(id);
      deps.taskEntities.publish([reopened]);
      if (before?.status === 'done' && before.doneAt !== null) {
        const doneAt = before.doneAt;
        const command: UndoableCommand = {
          kind: 'reopen',
          count: 1,
          labelParams: { title: reopened.title },
          async undo() {
            const current = await deps.data.repos.tasks.getById(id);
            if (!current || current.hlc !== reopened.hlc) return 'stale';
            const completed = await deps.data.repos.tasks.complete(id, doneAt);
            deps.taskEntities.publish([completed]);
            return 'undone';
          },
        };
        deps.undo.push(command);
      }
      return reopened;
    },
  };
}
