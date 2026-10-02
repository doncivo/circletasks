import { createStore } from 'zustand';
import type { PostponeTarget } from '../../domain/taskPostpone';
import type { IconRef } from '../../domain/model';
import type { TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createTaskUseCases } from './createTaskUseCases';

export type TaskDetailStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * État et actions de la fiche détail d'une tâche (A-08), limité par T-03 aux
 * zones icône et note, plus le bouton terminer / rouvrir (T-04). Une instance par
 * conteneur (`defineFeatureStore`, ADR 0004). La tâche affichée n'est PAS copiée
 * ici : seul `taskId` est gardé, l'entité est lue dans `container.taskEntities`
 * (ADR 0004, avenant « Source unique des tâches chargées »).
 */
export interface TaskDetailState {
  readonly taskId: TaskId | null;
  readonly status: TaskDetailStatus;
  /** Clé i18n du message à afficher quand `status` vaut 'error' ; `null` sinon. */
  readonly errorKey: PlainMessageKey | null;
  /** Charge la tâche `id` (publiée dans `taskEntities`) pour la fiche. Ne rejette jamais. */
  load(id: TaskId): Promise<void>;
  /** Enregistre la note à la perte de focus (critères 7 à 9). Ne rejette jamais. */
  updateNote(note: string): Promise<void>;
  /** Change ou retire (`null`) l'icône depuis la pastille (critère 5). Ne rejette jamais. */
  updateIcon(icon: IconRef | null): Promise<void>;
  /**
   * Bouton « Marquer comme terminée » (T-04, critère 1) : bascule selon le statut
   * courant de la tâche affichée. Ne rejette jamais.
   */
  toggleDone(): Promise<void>;
  /** Bouton « Reporter » / « Planifier » (T-05) : annulable, la fiche reste ouverte. Ne rejette jamais. */
  postpone(target: PostponeTarget): Promise<void>;
  /**
   * Supprime la tâche affichée (T-08, après confirmation par la fiche) : corbeille, annulable 5 s.
   * Rend true si elle est supprimée (la fiche doit se fermer), false en cas d'échec (message dédié,
   * la tâche reste affichée). Ne rejette jamais.
   */
  remove(): Promise<boolean>;
}

export const taskDetailStore = defineFeatureStore<TaskDetailState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  // Jeton de requête : ignore une réponse périmée (chargement ou écriture plus
  // ancienne qui se termine après un appel plus récent, même principe que todayStore).
  let requestId = 0;

  async function run(
    set: (partial: Partial<TaskDetailState>) => void,
    get: () => TaskDetailState,
    action: (taskId: TaskId) => Promise<unknown>,
  ): Promise<void> {
    const { taskId } = get();
    if (!taskId) return;
    const id = ++requestId;
    try {
      await action(taskId); // le cas d'usage publie la tâche écrite dans `taskEntities`
      if (id !== requestId) return; // un chargement ou une écriture plus récente a pris le dessus
      set({ status: 'ready', errorKey: null });
    } catch {
      if (id !== requestId) return;
      set({ status: 'error', errorKey: 'tasks.detailSaveError' });
    }
  }

  return createStore<TaskDetailState>()((set, get) => ({
    taskId: null,
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
        container.taskEntities.publish([task]);
        set({ status: 'ready', errorKey: null });
      } catch {
        if (requestedId !== requestId) return;
        set({ status: 'error', errorKey: 'tasks.detailLoadError' });
      }
    },

    updateNote: (note) => run(set, get, (id) => useCases.update(id, { note })),
    updateIcon: (icon) => run(set, get, (id) => useCases.update(id, { icon })),

    postpone: async (target) => {
      const { taskId } = get();
      if (!taskId) return;
      try {
        await useCases.postpone([taskId], target);
        set({ errorKey: null });
      } catch {
        set({ status: 'error', errorKey: 'tasks.postponeError' });
      }
    },

    remove: async () => {
      const { taskId } = get();
      if (!taskId) return false;
      // Une écriture ou un chargement plus ancien ne doit pas écraser l'état après la suppression.
      requestId += 1;
      try {
        await useCases.remove([taskId]); // retire la tâche de `taskEntities` : toutes les vues la perdent
        set({ taskId: null, status: 'idle', errorKey: null });
        return true;
      } catch {
        set({ status: 'error', errorKey: 'tasks.deleteError' });
        return false;
      }
    },

    toggleDone: () =>
      run(set, get, (id) => {
        // Statut lu dans la source unique : une tâche déjà terminée depuis la liste
        // n'est pas terminée une seconde fois (`complete` est de toute façon idempotent).
        const current = container.taskEntities.get(id);
        return current?.status === 'done' ? useCases.reopen(id) : useCases.complete(id);
      }),
  }));
});
