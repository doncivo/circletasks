import { createStore } from 'zustand';
import type { Goal, IconRef, Task } from '../../domain/model';
import type { GoalTitleError } from '../../domain/goalRules';
import type { GoalId, LocalDate, Result, SpaceFilter, SpaceId, TaskId } from '../../domain/types';
import { weekStartOf } from '../../domain/week';
import type { PlainMessageKey } from '../../i18n';
import { createTaskUseCases } from '../tasks';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { onGoalsChanged } from './goalEvents';
import { createGoalUseCases, goalTitleErrorKey, type GoalSaveError } from './goalUseCases';

export type GoalsStatus = 'idle' | 'loading' | 'ready' | 'error';

/** OB-06 critère 7 : l'historique se charge par pages de 20 semaines. */
export const HISTORY_PAGE_WEEKS = 20;

/**
 * État de l'écran Objectif (M17). Une instance par conteneur (`defineFeatureStore`, ADR 0004). Le store garde les objectifs de la
 * semaine en cours de TOUS les espaces : le filtre d'espace global (`useAppStore`) est appliqué à l'affichage par le domaine
 * (`goalsOfWeek`), jamais dupliqué ici.
 */
export interface GoalsState {
  /** Lundi de la semaine chargée ; null avant le premier chargement. */
  readonly weekStart: LocalDate | null;
  readonly goals: readonly Goal[];
  /** OB-05 : objectifs encore ouverts d'une semaine terminée, tous espaces ; le filtre d'espace est appliqué à l'affichage. */
  readonly reviews: readonly Goal[];
  /** Jour pour lequel les objectifs à réviser ont été lus ; null avant le premier calcul (démarrage de l'app, `startup.ts`). */
  readonly reviewDay: LocalDate | null;
  /** OB-06 : objectifs des semaines passées, du plus récent au plus ancien, déjà chargés (pages de 20 semaines) pour le filtre d'espace. */
  readonly history: readonly Goal[];
  /** OB-06 critère 5 : lundi de la semaine où chaque objectif de l'historique a été reconduit (« Reconduit en S39 »). */
  readonly historyCarriedTo: ReadonlyMap<GoalId, LocalDate>;
  /** Il reste des semaines plus anciennes à charger. */
  readonly historyHasMore: boolean;
  readonly historyStatus: GoalsStatus;
  readonly status: GoalsStatus;
  readonly errorKey: PlainMessageKey | null;
  /** Échec d'une action (enregistrer, supprimer) : message dédié, les sections restent affichées. */
  readonly actionErrorKey: PlainMessageKey | null;
  /** (Re)charge les objectifs de la semaine de `today`. Ne rejette jamais. */
  load(today: LocalDate): Promise<void>;
  /** OB-06 : charge la première page de l'historique (semaines avant celle de `today`) pour le filtre d'espace. Ne rejette jamais. */
  loadHistory(today: LocalDate, filter: SpaceFilter): Promise<void>;
  /** OB-06 : charge 20 semaines de plus. Ne rejette jamais. */
  loadMoreHistory(): Promise<void>;
  /** OB-06 critère 3 : lit les tâches rattachées d'un objectif passé (publiées dans la source unique). Ne rejette jamais. */
  loadGoalTasks(id: GoalId): Promise<void>;
  /** OB-05 : lit les objectifs à réviser le jour `today` (démarrage et passage de minuit, `startup.ts`). Ne rejette jamais. */
  loadReviews(today: LocalDate): Promise<void>;
  /** OB-05 critère 3 : « Reconduire » (annulable 5 s). Ne rejette jamais. */
  carryOver(id: GoalId): Promise<void>;
  /** OB-05 critère 5 : « Clore » (annulable 5 s). Ne rejette jamais. */
  close(id: GoalId): Promise<void>;
  /** Relit sans repasser par `loading` (écriture annulée ailleurs). Ne rejette jamais. */
  refresh(): Promise<void>;
  create(input: { title: string; spaceId: SpaceId; icon?: IconRef | null }): Promise<Result<Goal, GoalTitleError | 'unexpected'>>;
  setTitle(id: GoalId, title: string): Promise<Result<Goal, GoalSaveError | 'unexpected'>>;
  setIcon(id: GoalId, icon: IconRef | null): Promise<void>;
  setSpace(id: GoalId, spaceId: SpaceId): Promise<void>;
  /** OB-02 : épingle l'objectif en tête d'Aujourd'hui ou le retire (il reste dans l'écran Objectif). */
  setPinned(id: GoalId, pinned: boolean): Promise<void>;
  remove(id: GoalId): Promise<boolean>;
  /** OB-04 critère 5 : « Marquer atteint » (achieved) ou « Rouvrir l'objectif » (open) ; jamais automatique, même si toutes les tâches sont faites. */
  setAchieved(id: GoalId, achieved: boolean): Promise<void>;
  /** OB-03 critère 5 : termine ou rouvre une tâche rattachée (T-04, annulable) ; l'avancement suit sans rechargement. Ne rejette jamais. */
  toggleTask(task: Pick<Task, 'id' | 'status'>): Promise<void>;
  clearActionError(): void;
}

export const goalsStore = defineFeatureStore<GoalsState>((container: AppContainer) => {
  const useCases = createGoalUseCases(container);
  const taskUseCases = createTaskUseCases(container);
  let requestId = 0;

  return createStore<GoalsState>()((set, get) => {
    /** Objectifs de la semaine, puis leurs tâches rattachées publiées dans la source unique (ADR 0004) : l'écran les y relit. */
    const read = async (weekStart: LocalDate): Promise<readonly Goal[]> => {
      const goals = await container.data.repos.goals.listForWeek(weekStart, 'all');
      const attached = await Promise.all(goals.map((goal) => container.data.repos.tasks.listByGoal(goal.id)));
      container.taskEntities.publish(attached.flat());
      return goals;
    };

    /** Exécute une écriture : un échec imprévu pose le message d'action et rien n'est rejeté. */
    async function guard<T>(work: () => Promise<T>, fallback: T): Promise<T> {
      set({ actionErrorKey: null });
      try {
        return await work();
      } catch {
        set({ actionErrorKey: 'goals.saveError' });
        return fallback;
      }
    }

    /** Page courante de l'historique (OB-06) : relue telle quelle après un changement d'objectif ; null tant qu'aucune page n'est demandée. */
    let historyQuery: { today: LocalDate; filter: SpaceFilter; weeks: number } | null = null;
    let historyRequest = 0;
    async function readHistory(): Promise<void> {
      const query = historyQuery;
      if (!query) return;
      const id = ++historyRequest;
      try {
        const goals = await container.data.repos.goals.listBefore(weekStartOf(query.today), query.filter, query.weeks);
        const children = await container.data.repos.goals.listCarriedFrom(goals.map((goal) => goal.id));
        if (id !== historyRequest) return;
        const carried = new Map<GoalId, LocalDate>();
        for (const child of children) if (child.carriedFromId) carried.set(child.carriedFromId, child.weekStart);
        set({ history: goals, historyCarriedTo: carried, historyHasMore: new Set(goals.map((goal) => goal.weekStart)).size >= query.weeks, historyStatus: 'ready' });
      } catch {
        if (id === historyRequest) set({ historyStatus: 'error' });
      }
    }

    const store: GoalsState = {
      weekStart: null,
      goals: [],
      reviews: [],
      reviewDay: null,
      history: [],
      historyCarriedTo: new Map<GoalId, LocalDate>(),
      historyHasMore: false,
      historyStatus: 'idle',
      status: 'idle',
      errorKey: null,
      actionErrorKey: null,

      async load(today) {
        const weekStart = weekStartOf(today);
        const id = ++requestId;
        set({ weekStart, status: 'loading', errorKey: null });
        try {
          const goals = await read(weekStart);
          if (id !== requestId) return;
          set({ goals, status: 'ready', errorKey: null });
        } catch {
          if (id !== requestId) return;
          set({ status: 'error', errorKey: 'goals.loadError' });
        }
      },

      async loadHistory(today, filter) {
        historyQuery = { today, filter, weeks: HISTORY_PAGE_WEEKS };
        set({ historyStatus: 'loading' });
        await readHistory();
      },

      async loadMoreHistory() {
        if (!historyQuery || !get().historyHasMore) return;
        historyQuery = { ...historyQuery, weeks: historyQuery.weeks + HISTORY_PAGE_WEEKS };
        await readHistory();
      },

      async loadGoalTasks(id) {
        try {
          container.taskEntities.publish(await container.data.repos.tasks.listByGoal(id));
        } catch {
          // lecture manquée : la ligne se dépliera sans tâches, nouvel essai au prochain toucher
        }
      },

      async loadReviews(today) {
        set({ reviewDay: today });
        try {
          const reviews = await container.data.repos.goals.listOpenBefore(weekStartOf(today));
          if (get().reviewDay === today) set({ reviews });
        } catch {
          // lecture manquée : les cartes gardent leur état, nouvel essai au prochain changement
        }
      },

      async carryOver(id) {
        await guard(async () => {
          await useCases.carryOver(id);
          await get().refresh();
        }, undefined);
      },

      async close(id) {
        await guard(async () => {
          await useCases.close(id);
          await get().refresh();
        }, undefined);
      },

      async refresh() {
        const { weekStart } = get();
        if (weekStart === null) return;
        const id = ++requestId;
        try {
          const goals = await read(weekStart);
          if (id !== requestId) return;
          set({ goals, status: 'ready', errorKey: null });
        } catch {
          // une relecture manquée garde l'affichage courant
        }
      },

      async create(input) {
        return guard<Result<Goal, GoalTitleError | 'unexpected'>>(async () => {
          const { weekStart } = get();
          const result = await useCases.create({ ...input, ...(weekStart ? { weekStart } : {}) });
          if (!result.ok) set({ actionErrorKey: goalTitleErrorKey(result.error) });
          await get().refresh();
          return result;
        }, { ok: false, error: 'unexpected' });
      },

      async setTitle(id, title) {
        return guard<Result<Goal, GoalSaveError | 'unexpected'>>(async () => {
          const result = await useCases.setTitle(id, title);
          if (!result.ok && result.error !== 'not-found') set({ actionErrorKey: goalTitleErrorKey(result.error) });
          await get().refresh();
          return result;
        }, { ok: false, error: 'unexpected' });
      },

      async setIcon(id, icon) {
        await guard(async () => {
          await useCases.update(id, { icon });
          await get().refresh();
        }, undefined);
      },

      async setSpace(id, spaceId) {
        await guard(async () => {
          await useCases.update(id, { spaceId });
          await get().refresh();
        }, undefined);
      },

      async setPinned(id, pinned) {
        await guard(async () => {
          await useCases.update(id, { pinned });
          await get().refresh();
        }, undefined);
      },

      async setAchieved(id, achieved) {
        await guard(async () => {
          await useCases.setStatus(id, achieved ? 'achieved' : 'open');
          await get().refresh();
        }, undefined);
      },

      async remove(id) {
        return guard(async () => {
          const done = await useCases.remove(id);
          await get().refresh();
          return done;
        }, false);
      },

      async toggleTask(task) {
        set({ actionErrorKey: null });
        try {
          if (task.status === 'done') await taskUseCases.reopen(task.id as TaskId);
          else await taskUseCases.complete(task.id as TaskId);
        } catch {
          set({ actionErrorKey: 'tasks.completeError' });
        }
      },

      clearActionError() {
        set({ actionErrorKey: null });
      },
    };

    // Une écriture faite ailleurs (annulation, reconduction, Aujourd'hui) : la semaine se relit.
    onGoalsChanged(container.data, () => {
      void get().refresh();
      const { reviewDay } = get();
      if (reviewDay !== null) void get().loadReviews(reviewDay);
      void readHistory();
    });
    return store;
  });
});
