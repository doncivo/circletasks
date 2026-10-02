import { createStore } from 'zustand';
import { todayLocal } from '../../domain/clock';
import type { IconRef, Task } from '../../domain/model';
import type { PostponeTarget } from '../../domain/taskPostpone';
import { sortTasksForDay } from '../../domain/taskSchedule';
import type { LocalDate, LocalTime, Result, SpaceFilter, SpaceId, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { selectTasks } from '../app/selectTasks';
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
  /** Ids des tâches du jour (ordre d'affichage) ; les entités sont lues dans `container.taskEntities` (ADR 0004, avenant). */
  readonly taskIds: readonly TaskId[];
  readonly status: TodayStatus;
  /** Clé i18n du message à afficher quand `status` vaut 'error' ; `null` sinon. */
  readonly errorKey: PlainMessageKey | null;
  /** Échec d'une action sur une tâche (terminer / rouvrir) : message dédié, la liste reste affichée. */
  readonly actionErrorKey: PlainMessageKey | null;
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
   * `icon` (T-03) : choisi dans la feuille « Nouvelle tâche » (iPhone, Ajout.html) ;
   * absent sur la saisie en ligne PC, qui ne porte pas ce champ (pas de maquette).
   * Ne rejette jamais : les échecs sont renvoyés dans le `Result`.
   */
  addTask(
    title: string,
    spaceId: SpaceId,
    schedule?: NewTaskSchedule,
    icon?: IconRef | null,
  ): Promise<Result<Task, TodayAddTaskError>>;
  /**
   * Termine ou rouvre une tâche (T-04 : case de la ligne, raccourci Espace)
   * selon son état courant dans la liste affichée ; répercute le nouvel état
   * (tri recalculé, terminées en bas, `sortTasksForDay`) sans recharger toute
   * la liste. Ignore un id absent de la liste affichée. Ne rejette jamais.
   */
  toggleDone(id: TaskId): Promise<void>;
  /**
   * Reporte une tâche de la liste (T-05 : « Demain », « Semaine prochaine », date ;
   * Ctrl+D = demain). Annulable (le cas d'usage pousse la commande). La tâche quitte
   * la liste aussitôt (`resolveTodayTasks` revérifie la date) sans recharger. Ne rejette jamais.
   */
  postpone(id: TaskId, target: PostponeTarget): Promise<void>;
  /**
   * Supprime une tâche de la liste (T-08 : Suppr après confirmation) : corbeille, annulable 5 s.
   * La tâche quitte la liste aussitôt (retirée de `taskEntities`). Ne rejette jamais.
   */
  remove(id: TaskId): Promise<void>;
}

export const todayStore = defineFeatureStore<TodayState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  // Jeton de requête : si un appel plus récent a démarré entre-temps, le résultat
  // d'un appel plus ancien qui se termine après lui est ignoré (pas d'état périmé).
  let requestId = 0;

  // Ordre d'affichage final (T-02, Q11) : à l'heure d'abord par heure croissante,
  // puis sans heure dans l'ordre manuel du repository, terminées en bas (T-04).
  const listAndPublish = async (date: LocalDate, filter: SpaceFilter): Promise<Task[]> => {
    const loaded = await container.data.repos.tasks.listForDay(date, filter);
    container.taskEntities.publish(loaded);
    return loaded;
  };
  const fetchDay = async (date: LocalDate, filter: SpaceFilter): Promise<Task[]> =>
    sortTasksForDay(await listAndPublish(date, filter));

  return createStore<TodayState>()((set, get) => ({
    date: null,
    filter: 'all',
    taskIds: [],
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,

    async load(date, filter) {
      const id = ++requestId;
      set({ status: 'loading', date, filter, errorKey: null, actionErrorKey: null });
      try {
        const tasks = await fetchDay(date, filter);
        if (id !== requestId) return; // une requête plus récente a été lancée entre-temps
        set({ taskIds: tasks.map((task) => task.id), status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ status: 'error', errorKey: 'tasks.todayError' });
      }
    },

    async addTask(title, spaceId, schedule, icon) {
      const { date, filter } = get();
      const viewedDate = date ?? todayLocal(container.clock);
      // La tâche est datée sur `schedule.date` si fourni (ex. un autre jour,
      // critère 1), sinon sur le jour affiché, comme avant T-02. La liste
      // rechargée reste celle du jour affiché, qu'il s'agisse ou non du même jour.
      const taskDate = schedule?.date ?? viewedDate;
      try {
        // `exactOptionalPropertyTypes` (tsconfig) : on n'inclut `time` / `icon` que
        // si l'appelant les fournit explicitement.
        const result = await useCases.create({
          title,
          spaceId,
          date: taskDate,
          ...(schedule?.time !== undefined ? { time: schedule.time } : {}),
          ...(icon !== undefined ? { icon } : {}),
        });
        if (!result.ok) return result;
        const id = ++requestId;
        try {
          const tasks = await fetchDay(viewedDate, filter);
          if (id === requestId) set({ date: viewedDate, taskIds: tasks.map((task) => task.id), status: 'ready', errorKey: null });
        } catch {
          if (id === requestId) set({ status: 'error', errorKey: 'tasks.todayError' });
        }
        return result;
      } catch {
        set({ status: 'error', errorKey: 'tasks.todayError' });
        return { ok: false, error: 'unexpected' };
      }
    },

    async toggleDone(id) {
      if (!get().taskIds.includes(id)) return; // pas dans la liste affichée
      const current = container.taskEntities.get(id);
      if (!current) return;
      try {
        // Le cas d'usage publie la tâche écrite dans  : la ligne, la
        // fiche ouverte et le tri (terminées en bas) la reflètent sans autre copie.
        if (current.status === 'done') await useCases.reopen(id);
        else await useCases.complete(id);
        set({ actionErrorKey: null });
      } catch {
        // Échec d'écriture : la liste reste affichée telle quelle, message dédié.
        set({ actionErrorKey: 'tasks.completeError' });
      }
    },

    async postpone(id, target) {
      if (!get().taskIds.includes(id)) return;
      try {
        await useCases.postpone([id], target);
        set({ actionErrorKey: null });
      } catch {
        set({ actionErrorKey: 'tasks.postponeError' });
      }
    },

    async remove(id) {
      if (!get().taskIds.includes(id)) return;
      try {
        await useCases.remove([id]);
        set({ actionErrorKey: null });
      } catch {
        set({ actionErrorKey: 'tasks.deleteError' });
      }
    },
  }));
});

/** Jour et filtre d'espace d'une vue « Aujourd'hui » : une tâche qui n'y correspond plus en sort. */
export interface TodayView {
  readonly date: LocalDate | null;
  readonly filter: SpaceFilter;
}

/**
 * Tâches affichées (entités lues dans la source unique, tri Q11 / T-04 : terminées en bas).
 * Avec `view`, date, « Un jour » et espace sont revérifiés (`selectTasks`) : une tâche
 * reportée hors du jour (T-05) ou changée d'espace quitte la liste immédiatement.
 */
export function resolveTodayTasks(taskIds: readonly TaskId[], entities: ReadonlyMap<TaskId, Task>, view?: TodayView): Task[] {
  const tasks = selectTasks(taskIds, entities, (task) =>
    !view || view.date === null
      ? true
      : task.date === view.date && !task.someday && (view.filter === 'all' || task.spaceId === view.filter),
  );
  return sortTasksForDay(tasks);
}
