import { createStore } from 'zustand';
import { todayLocal } from '../../domain/clock';
import type { Task } from '../../domain/model';
import type { LocalDate, Result, SpaceFilter, SpaceId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import type { CreateTaskError } from '../tasks/taskUseCases';

export type TodayStatus = 'idle' | 'loading' | 'ready' | 'error';

/** `addTask` peut en plus échouer pour une raison imprévue (écriture ou lecture en base). */
export type TodayAddTaskError = CreateTaskError | 'unexpected';

/**
 * État et actions de la liste « Aujourd'hui » (A-01, T-01). Une instance par
 * conteneur (`defineFeatureStore`, ADR 0004), lue par `useFeatureStore(todayStore, …)`.
 */
export interface TodayState {
  readonly date: LocalDate | null;
  readonly filter: SpaceFilter;
  readonly tasks: readonly Task[];
  readonly status: TodayStatus;
  /** Clé i18n du message à afficher quand `status` vaut 'error' ; `null` sinon. */
  readonly errorKey: PlainMessageKey | null;
  /** (Re)charge les tâches datées de `date` pour le filtre d'espace donné. Ne rejette jamais. */
  load(date: LocalDate, filter: SpaceFilter): Promise<void>;
  /**
   * Crée une tâche dans `spaceId` (déjà résolu par l'appelant, ES-02) et recharge la
   * liste du jour courant pour qu'elle reflète le filtre actif (une tâche créée
   * dans un autre espace que le filtre n'apparaît pas, comme partout ailleurs).
   * Ne rejette jamais : les échecs sont renvoyés dans le `Result`.
   */
  addTask(title: string, spaceId: SpaceId): Promise<Result<Task, TodayAddTaskError>>;
}

export const todayStore = defineFeatureStore<TodayState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  // Jeton de requête : si un appel plus récent a démarré entre-temps, le résultat
  // d'un appel plus ancien qui se termine après lui est ignoré (pas d'état périmé).
  let requestId = 0;

  const fetchDay = (date: LocalDate, filter: SpaceFilter): Promise<Task[]> =>
    container.data.repos.tasks.listForDay(date, filter);

  return createStore<TodayState>()((set, get) => ({
    date: null,
    filter: 'all',
    tasks: [],
    status: 'idle',
    errorKey: null,

    async load(date, filter) {
      const id = ++requestId;
      set({ status: 'loading', date, filter, errorKey: null });
      try {
        const tasks = await fetchDay(date, filter);
        if (id !== requestId) return; // une requête plus récente a été lancée entre-temps
        set({ tasks, status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ status: 'error', errorKey: 'tasks.todayError' });
      }
    },

    async addTask(title, spaceId) {
      const { date, filter } = get();
      const effectiveDate = date ?? todayLocal(container.clock);
      try {
        const result = await useCases.create({ title, spaceId, date: effectiveDate });
        if (!result.ok) return result;
        const id = ++requestId;
        try {
          const tasks = await fetchDay(effectiveDate, filter);
          if (id === requestId) set({ date: effectiveDate, tasks, status: 'ready', errorKey: null });
        } catch {
          if (id === requestId) set({ status: 'error', errorKey: 'tasks.todayError' });
        }
        return result;
      } catch {
        set({ status: 'error', errorKey: 'tasks.todayError' });
        return { ok: false, error: 'unexpected' };
      }
    },
  }));
});
