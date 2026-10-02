import { createStore } from 'zustand';
import { todayLocal } from '../../domain/clock';
import type { Task } from '../../domain/model';
import { sortTasksForDay } from '../../domain/taskSchedule';
import type { LocalDate, LocalTime, Result, SpaceFilter, SpaceId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import type { CreateTaskError } from '../tasks/taskUseCases';

/** Date et heure optionnelles choisies dans la saisie (T-02) ; `date` absente = jour affiché. */
export interface NewTaskSchedule {
  readonly date?: LocalDate;
  readonly time?: LocalTime | null;
}

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
   * `schedule.date` (T-02) permet de dater la tâche sur un autre jour que celui
   * affiché (ex. jeudi prochain depuis Aujourd'hui) : la liste rechargée reste
   * celle du jour affiché, pas celle de la tâche créée (critère 1 : une tâche
   * créée pour un autre jour n'apparaît pas dans Aujourd'hui). Absent : le jour
   * affiché, comme avant T-02.
   * Ne rejette jamais : les échecs sont renvoyés dans le `Result`.
   */
  addTask(title: string, spaceId: SpaceId, schedule?: NewTaskSchedule): Promise<Result<Task, TodayAddTaskError>>;
}

export const todayStore = defineFeatureStore<TodayState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  // Jeton de requête : si un appel plus récent a démarré entre-temps, le résultat
  // d'un appel plus ancien qui se termine après lui est ignoré (pas d'état périmé).
  let requestId = 0;

  // Ordre d'affichage final (T-02, Q11) : à l'heure d'abord par heure croissante,
  // puis sans heure dans l'ordre manuel du repository, terminées en bas (T-04).
  const fetchDay = async (date: LocalDate, filter: SpaceFilter): Promise<Task[]> =>
    sortTasksForDay(await container.data.repos.tasks.listForDay(date, filter));

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

    async addTask(title, spaceId, schedule) {
      const { date, filter } = get();
      const viewedDate = date ?? todayLocal(container.clock);
      // La tâche est datée sur `schedule.date` si fourni (ex. un autre jour,
      // critère 1), sinon sur le jour affiché, comme avant T-02. La liste
      // rechargée reste celle du jour affiché, qu'il s'agisse ou non du même jour.
      const taskDate = schedule?.date ?? viewedDate;
      try {
        // `exactOptionalPropertyTypes` (tsconfig) : on n'inclut `time` que si
        // `schedule` le fournit explicitement.
        const result = await useCases.create({
          title,
          spaceId,
          date: taskDate,
          ...(schedule?.time !== undefined ? { time: schedule.time } : {}),
        });
        if (!result.ok) return result;
        const id = ++requestId;
        try {
          const tasks = await fetchDay(viewedDate, filter);
          if (id === requestId) set({ date: viewedDate, tasks, status: 'ready', errorKey: null });
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
