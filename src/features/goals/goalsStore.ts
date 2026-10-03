import { createStore } from 'zustand';
import type { Goal, IconRef } from '../../domain/model';
import type { GoalTitleError } from '../../domain/goalRules';
import type { GoalId, LocalDate, Result, SpaceId } from '../../domain/types';
import { weekStartOf } from '../../domain/week';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { onGoalsChanged } from './goalEvents';
import { createGoalUseCases, goalTitleErrorKey, type GoalSaveError } from './goalUseCases';

export type GoalsStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * État de l'écran Objectif (M17). Une instance par conteneur (`defineFeatureStore`, ADR 0004). Le store garde les objectifs de la
 * semaine en cours de TOUS les espaces : le filtre d'espace global (`useAppStore`) est appliqué à l'affichage par le domaine
 * (`goalsOfWeek`), jamais dupliqué ici.
 */
export interface GoalsState {
  /** Lundi de la semaine chargée ; null avant le premier chargement. */
  readonly weekStart: LocalDate | null;
  readonly goals: readonly Goal[];
  readonly status: GoalsStatus;
  readonly errorKey: PlainMessageKey | null;
  /** Échec d'une action (enregistrer, supprimer) : message dédié, les sections restent affichées. */
  readonly actionErrorKey: PlainMessageKey | null;
  /** (Re)charge les objectifs de la semaine de `today`. Ne rejette jamais. */
  load(today: LocalDate): Promise<void>;
  /** Relit sans repasser par `loading` (écriture annulée ailleurs). Ne rejette jamais. */
  refresh(): Promise<void>;
  create(input: { title: string; spaceId: SpaceId; icon?: IconRef | null }): Promise<Result<Goal, GoalTitleError | 'unexpected'>>;
  setTitle(id: GoalId, title: string): Promise<Result<Goal, GoalSaveError | 'unexpected'>>;
  setIcon(id: GoalId, icon: IconRef | null): Promise<void>;
  setSpace(id: GoalId, spaceId: SpaceId): Promise<void>;
  remove(id: GoalId): Promise<boolean>;
  clearActionError(): void;
}

export const goalsStore = defineFeatureStore<GoalsState>((container: AppContainer) => {
  const useCases = createGoalUseCases(container);
  let requestId = 0;

  return createStore<GoalsState>()((set, get) => {
    const read = async (weekStart: LocalDate): Promise<readonly Goal[]> => container.data.repos.goals.listForWeek(weekStart, 'all');

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

    const store: GoalsState = {
      weekStart: null,
      goals: [],
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

      async remove(id) {
        return guard(async () => {
          const done = await useCases.remove(id);
          await get().refresh();
          return done;
        }, false);
      },

      clearActionError() {
        set({ actionErrorKey: null });
      },
    };

    // Une écriture faite ailleurs (annulation, reconduction, Aujourd'hui) : la semaine se relit.
    onGoalsChanged(container.data, () => void get().refresh());
    return store;
  });
});
