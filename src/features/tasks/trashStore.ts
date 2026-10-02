import { createStore } from 'zustand';
import type { Task } from '../../domain/model';
import type { SpaceFilter, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createTrashUseCases } from './trashUseCases';

export type TrashStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * État de l'écran Corbeille (T-08). Contrairement aux listes actives, les tâches supprimées
 * sont gardées ici : `taskEntities` ne contient que des tâches actives (une tâche supprimée en
 * sort, ADR 0004 avenant) ; la restauration la republie dans la source unique.
 */
export interface TrashState {
  readonly filter: SpaceFilter;
  /** Supprimées depuis moins de 30 jours, de la plus récente à la plus ancienne. */
  readonly tasks: readonly Task[];
  readonly status: TrashStatus;
  readonly errorKey: PlainMessageKey | null;
  /** Échec ou refus d'une restauration : message dédié, la liste reste affichée. */
  readonly actionErrorKey: PlainMessageKey | null;
  /** (Re)charge la corbeille pour le filtre d'espace. Ne rejette jamais. */
  load(filter: SpaceFilter): Promise<void>;
  /** Restaure une tâche : elle retrouve date, espace, ordre et rappels. Ne rejette jamais. */
  restore(id: TaskId): Promise<void>;
}

export const trashStore = defineFeatureStore<TrashState>((container: AppContainer) => {
  const useCases = createTrashUseCases(container);
  let requestId = 0;

  return createStore<TrashState>()((set, get) => ({
    filter: 'all',
    tasks: [],
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,

    async load(filter) {
      const id = ++requestId;
      set({ filter, status: 'loading', errorKey: null, actionErrorKey: null });
      try {
        const tasks = await useCases.list(filter);
        if (id !== requestId) return;
        set({ tasks, status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ tasks: [], status: 'error', errorKey: 'trash.loadError' });
      }
    },

    async restore(id) {
      if (!get().tasks.some((task) => task.id === id)) return;
      try {
        const restored = await useCases.restore(id);
        // null : déjà restaurée ou expirée entre-temps, la ligne n'a plus lieu d'être.
        set({ tasks: get().tasks.filter((task) => task.id !== id), actionErrorKey: restored ? null : 'trash.notRestorable' });
      } catch {
        set({ actionErrorKey: 'trash.restoreError' });
      }
    },
  }));
});
