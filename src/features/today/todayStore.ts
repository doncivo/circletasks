import { createStore } from 'zustand';
import { todayLocal } from '../../domain/clock';
import type { IconRef, RecurrenceFields, Task } from '../../domain/model';
import type { PostponeTarget } from '../../domain/taskPostpone';
import { sortTasksForDay } from '../../domain/taskSchedule';
import type { LocalDate, LocalTime, RecurrenceId, Result, SpaceFilter, SpaceId, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { selectTasks } from '../app/selectTasks';
import { defineFeatureStore, type AppContainer } from '../app/container';
import type { SeriesScope } from '../../domain/recurrenceEdit';
import { createSeriesUseCases } from '../tasks/seriesUseCases';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import type { CreateTaskError } from '../tasks/taskUseCases';

/** Date et heure optionnelles choisies dans la saisie (T-02) ; `date` absente = jour affiché. */
export interface NewTaskSchedule {
  readonly date?: LocalDate;
  readonly time?: LocalTime | null;
  /** T-09 : répétition choisie à la saisie (absent : une fois). */
  readonly recurrence?: RecurrenceFields | null;
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
  /** Règles des séries affichées (T-09) : sous-ligne « mensuelle » ; une règle ne change pas avant T-10. */
  readonly recurrences: ReadonlyMap<RecurrenceId, RecurrenceFields>;
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
  /** T-10 critère 4 : reporte une occurrence récurrente (Ctrl+D) pour « cette occurrence » ou « toutes les suivantes ». Ne rejette jamais. */
  postponeSeries(id: TaskId, target: PostponeTarget, scope: SeriesScope): Promise<void>;
  /**
   * Supprime une tâche de la liste (T-08 : Suppr après confirmation) : corbeille, annulable 5 s.
   * La tâche quitte la liste aussitôt (retirée de `taskEntities`). `scope` : occurrence d'une série récurrente (T-10,
   * « cette occurrence » génère la suivante, « toutes les suivantes » arrête la série). Ne rejette jamais.
   */
  remove(id: TaskId, scope?: SeriesScope): Promise<void>;
  /**
   * T-09 : lit les règles des séries affichées pas encore connues (ex. règle posée depuis la fiche),
   * pour l'indicateur « mensuelle » de la ligne. Ne rejette jamais.
   */
  syncRecurrences(): Promise<void>;
}

export const todayStore = defineFeatureStore<TodayState>((container: AppContainer) => {
  const useCases = createTaskUseCases(container);
  const series = createSeriesUseCases(container);
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
  // Règles des séries du jour (une lecture par série inconnue) ; un échec n'empêche pas l'affichage des tâches.
  const loadRecurrences = async (
    tasks: readonly Task[],
    known: ReadonlyMap<RecurrenceId, RecurrenceFields>,
  ): Promise<ReadonlyMap<RecurrenceId, RecurrenceFields>> => {
    const missing = [...new Set(tasks.flatMap((task) => (task.recurrenceId && !known.has(task.recurrenceId) ? [task.recurrenceId] : [])))];
    if (missing.length === 0) return known;
    const next = new Map(known);
    for (const id of missing) {
      try {
        const rule = await container.data.repos.recurrences.getById(id);
        if (rule) next.set(id, rule);
      } catch {
        // règle illisible : pas d'indicateur sur la ligne
      }
    }
    return next;
  };
  const fetchDay = async (date: LocalDate, filter: SpaceFilter): Promise<Task[]> =>
    sortTasksForDay(await listAndPublish(date, filter));

  return createStore<TodayState>()((set, get) => ({
    date: null,
    filter: 'all',
    taskIds: [],
    recurrences: new Map<RecurrenceId, RecurrenceFields>(),
    status: 'idle',
    errorKey: null,
    actionErrorKey: null,

    async load(date, filter) {
      const id = ++requestId;
      set({ status: 'loading', date, filter, errorKey: null, actionErrorKey: null });
      try {
        const tasks = await fetchDay(date, filter);
        const recurrences = await loadRecurrences(tasks, get().recurrences);
        if (id !== requestId) return; // une requête plus récente a été lancée entre-temps
        set({ taskIds: tasks.map((task) => task.id), recurrences, status: 'ready' });
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
          ...(schedule?.recurrence ? { recurrence: schedule.recurrence } : {}),
        });
        if (!result.ok) return result;
        const id = ++requestId;
        try {
          const tasks = await fetchDay(viewedDate, filter);
          const recurrences = await loadRecurrences(tasks, get().recurrences);
          if (id === requestId) set({ date: viewedDate, taskIds: tasks.map((task) => task.id), recurrences, status: 'ready', errorKey: null });
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
        // T-09 : l'occurrence suivante peut tomber sur le jour affiché (ex. tous les jours) : recharge discrète.
        const { date, filter } = get();
        if (current.recurrenceId !== null && current.status !== 'done' && date !== null) {
          const loaded = await fetchDay(date, filter);
          set({ taskIds: loaded.map((task) => task.id), recurrences: await loadRecurrences(loaded, get().recurrences) });
        }
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

    async postponeSeries(id, target, scope) {
      if (!get().taskIds.includes(id)) return;
      try {
        const result = await series.postpone(id, target, scope);
        set({ actionErrorKey: result.ok ? null : 'tasks.postponeError' });
      } catch {
        set({ actionErrorKey: 'tasks.postponeError' });
      }
    },

    async syncRecurrences() {
      const shown = get().taskIds.flatMap((id) => {
        const task = container.taskEntities.get(id);
        return task ? [task] : [];
      });
      const known = get().recurrences;
      const recurrences = await loadRecurrences(shown, known);
      if (recurrences !== known) set({ recurrences });
    },

    async remove(id, scope) {
      if (!get().taskIds.includes(id)) return;
      try {
        if (scope) {
          const result = await series.remove(id, scope);
          if (!result.ok) {
            set({ actionErrorKey: 'tasks.deleteError' });
            return;
          }
        } else await useCases.remove([id]);
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
