import { createStore } from 'zustand';
import type { IconRef, Task } from '../../domain/model';
import type { TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createTaskUseCases } from './createTaskUseCases';

export type TaskDetailStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * État et actions de la fiche détail d'une tâche (A-08), limité par T-03 aux
 * zones icône et note (fiche complète hors périmètre de cette story). Une
 * instance par conteneur (`defineFeatureStore`, ADR 0004).
 */
export interface TaskDetailState {
  readonly taskId: TaskId | null;
  readonly task: Task | null;
  readonly status: TaskDetailStatus;
  /** Clé i18n du message à afficher quand `status` vaut 'error' ; `null` sinon. */
  readonly errorKey: PlainMessageKey | null;
  /** Charge la tâche `id` pour l'affichage dans la fiche. Ne rejette jamais. */
  load(id: TaskId): Promise<void>;
  /** Enregistre la note à la perte de focus (critères 7 à 9). Ne rejette jamais. */
  updateNote(note: string): Promise<void>;
  /** Change ou retire (`null`) l'icône depuis la pastille (critère 5). Ne rejette jamais. */
  updateIcon(icon: IconRef | null): Promise<void>;
}

export const taskDetailStore = defineFeatureStore<TaskDetailState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  // Jeton de requête : ignore une réponse périmée (chargement ou écriture plus
  // ancienne qui se termine après un appel plus récent, même principe que todayStore).
  let requestId = 0;

  async function applyPatch(set: (partial: Partial<TaskDetailState>) => void, get: () => TaskDetailState, patch: { note: string } | { icon: IconRef | null }): Promise<void> {
    const { taskId } = get();
    if (!taskId) return;
    const id = ++requestId;
    try {
      const updated = await useCases.update(taskId, patch);
      if (id !== requestId) return; // un chargement ou une écriture plus récente a pris le dessus
      set({ task: updated, status: 'ready', errorKey: null });
    } catch {
      if (id !== requestId) return;
      set({ status: 'error', errorKey: 'tasks.detailSaveError' });
    }
  }

  return createStore<TaskDetailState>()((set, get) => ({
    taskId: null,
    task: null,
    status: 'idle',
    errorKey: null,

    async load(id) {
      const requestedId = ++requestId;
      set({ taskId: id, status: 'loading', errorKey: null });
      try {
        const task = await container.data.repos.tasks.getById(id);
        if (requestedId !== requestId) return;
        if (!task) {
          set({ status: 'error', errorKey: 'tasks.detailLoadError' });
          return;
        }
        set({ task, status: 'ready', errorKey: null });
      } catch {
        if (requestedId !== requestId) return;
        set({ status: 'error', errorKey: 'tasks.detailLoadError' });
      }
    },

    updateNote: (note) => applyPatch(set, get, { note }),
    updateIcon: (icon) => applyPatch(set, get, { icon }),
  }));
});
