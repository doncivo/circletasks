import type { Task } from '../../domain/model';
import { sortTrash, trashCutoff } from '../../domain/taskTrash';
import type { SpaceFilter, TaskId } from '../../domain/types';
import type { TaskUseCaseDeps } from './taskUseCases';

/** Cas d'usage de la corbeille (T-08). */
export interface TrashUseCases {
  /** Tâches supprimées depuis moins de 30 jours, de la plus récente à la plus ancienne. Rejette si la lecture échoue. */
  list(filter: SpaceFilter): Promise<Task[]>;
  /**
   * Restaure une tâche : retrouve sa date, son ordre, son espace et ses rappels, et la republie
   * dans la source unique (elle réapparaît dans les vues). Rend null si elle n'est plus restaurable
   * (déjà restaurée, purgée ou expirée). Rejette si l'écriture échoue.
   */
  restore(id: TaskId): Promise<Task | null>;
  /**
   * Purge physique des tâches supprimées depuis plus de 30 jours ; rend le nombre purgé. Appelée au
   * démarrage (startup.ts). Point d'extension Y-09 : voir src/domain/taskTrash.
   */
  purgeExpired(): Promise<number>;
}

export function createTrashUseCases(deps: TaskUseCaseDeps): TrashUseCases {
  return {
    async list(filter) {
      const now = deps.clock.nowMs();
      const loaded = await deps.data.repos.tasks.listTrash(trashCutoff(now), filter);
      return sortTrash(loaded, now);
    },

    async restore(id) {
      const restored = await deps.data.transaction(async (repos) => {
        const current = await repos.tasks.getById(id, { includeDeleted: true });
        if (!current || current.deletedAt === null) return null;
        if (sortTrash([current], deps.clock.nowMs()).length === 0) return null; // expirée : hors corbeille
        const [back] = await repos.tasks.restore([id]);
        await repos.reminders.restoreForTarget({ type: 'task', id }, { deletedAt: current.deletedAt, hlc: current.hlc });
        return back ?? null;
      });
      if (restored) deps.taskEntities.publish([restored]);
      return restored;
    },

    purgeExpired() {
      return deps.data.transaction((repos) => repos.tasks.purgeDeletedBefore(trashCutoff(deps.clock.nowMs())));
    },
  };
}
