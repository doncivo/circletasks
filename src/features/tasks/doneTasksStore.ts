import { createStore } from 'zustand';
import { donePeriodOf, isInDonePeriod, shiftDonePeriod, type DonePeriod, type DonePeriodKind } from '../../domain/donePeriod';
import type { Task } from '../../domain/model';
import type { LocalDate, SpaceFilter, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { selectTasks } from '../app/selectTasks';
import { createDoneTasksUseCases } from './doneTasksUseCases';

export type DoneTasksStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * État de l'écran « Tâches terminées » (T-07). Ne garde que des ids : les entités sont
 * lues dans `container.taskEntities` (ADR 0004, avenant) ; une tâche rouverte, supprimée
 * ou déplacée hors de la période quitte la liste via `resolveDoneTasks`.
 */
export interface DoneTasksState {
  readonly period: DonePeriod | null;
  readonly filter: SpaceFilter;
  readonly taskIds: readonly TaskId[];
  readonly status: DoneTasksStatus;
  readonly errorKey: PlainMessageKey | null;
  /** Échec d'une réouverture : message dédié, la liste reste affichée. */
  readonly actionErrorKey: PlainMessageKey | null;
  /** Ouvre l'écran : période « Jour » = `today` (critère 1). Ne rejette jamais. */
  open(today: LocalDate, filter: SpaceFilter): Promise<void>;
  /** Jour / Semaine / Mois : période du même type contenant le début de la période affichée (critère 2). */
  selectKind(kind: DonePeriodKind): Promise<void>;
  /** Précédent (-1) / suivant (+1) : décale d'un jour, d'une semaine ou d'un mois (critère 3). */
  shift(step: -1 | 1): Promise<void>;
  /** Filtre d'espace Pro / Perso / Tout (critère 5). */
  setFilter(filter: SpaceFilter): Promise<void>;
  /** Décoche : rouvre la tâche (annulable 5 s, critère 6). Ne rejette jamais. */
  reopen(id: TaskId): Promise<void>;
}

export const doneTasksStore = defineFeatureStore<DoneTasksState>((container: AppContainer) => {
  const useCases = createDoneTasksUseCases(container);
  // Jeton de requête : le résultat d'un chargement périmé est ignoré.
  let requestId = 0;

  return createStore<DoneTasksState>()((set, get) => {
    async function reload(period: DonePeriod, filter: SpaceFilter): Promise<void> {
      const id = ++requestId;
      set({ period, filter, status: 'loading', errorKey: null, actionErrorKey: null });
      try {
        const tasks = await useCases.list(period, filter);
        if (id !== requestId) return;
        set({ taskIds: tasks.map((task) => task.id), status: 'ready' });
      } catch {
        if (id !== requestId) return;
        set({ taskIds: [], status: 'error', errorKey: 'done.loadError' });
      }
    }

    return {
      period: null,
      filter: 'all',
      taskIds: [],
      status: 'idle',
      errorKey: null,
      actionErrorKey: null,

      open: (today, filter) => reload(donePeriodOf('day', today), filter),

      async selectKind(kind) {
        const { period, filter } = get();
        if (!period || period.kind === kind) return;
        await reload(donePeriodOf(kind, period.from), filter);
      },

      async shift(step) {
        const { period, filter } = get();
        if (!period) return;
        await reload(shiftDonePeriod(period, step), filter);
      },

      async setFilter(filter) {
        const { period } = get();
        if (!period) return;
        await reload(period, filter);
      },

      async reopen(id) {
        if (!get().taskIds.includes(id)) return;
        try {
          // Le cas d'usage publie la tâche rouverte : elle quitte la liste (resolveDoneTasks).
          await useCases.reopen(id);
          set({ actionErrorKey: null });
        } catch {
          set({ actionErrorKey: 'done.reopenError' });
        }
      },
    };
  });
});

/** Tâches affichées : terminées dans la période et l'espace, revérifiées dans la source unique. */
export function resolveDoneTasks(
  taskIds: readonly TaskId[],
  entities: ReadonlyMap<TaskId, Task>,
  view: { readonly period: DonePeriod | null; readonly filter: SpaceFilter },
): Task[] {
  const { period, filter } = view;
  if (!period) return [];
  return selectTasks(taskIds, entities, (task) => isInDonePeriod(task, period) && (filter === 'all' || task.spaceId === filter));
}
