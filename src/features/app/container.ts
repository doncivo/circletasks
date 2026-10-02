import type { StoreApi } from 'zustand';
import { systemClock, type Clock } from '../../domain/clock';
import type { HlcClock } from '../../domain/hlc';
import { uuidGenerator, type IdGenerator } from '../../domain/id';
import type { DataAccess } from '../../db/repositories';
import type { OsFamily, Runtime } from '../../platform';
import { createShortcutRegistry, type ShortcutRegistry } from './shortcuts';
import { createTaskEntities, type TaskEntities } from './taskEntities';
import { createUndoStack, type UndoStack } from './undo';

/**
 * Conteneur de dépendances unique (ADR 0004), créé une fois au démarrage
 * (`bootstrapApp`), fourni à React par `AppContainerProvider`, remplacé en test
 * par `createAppContainer({ data: faux, clock: createManualClock(…) … })`.
 *
 * Les cas d'usage des features reçoivent un sous-ensemble explicite :
 *   `type TaskUseCaseDeps = Pick<AppContainer, 'clock' | 'ids' | 'data' | 'undo'>`.
 * Ils ne lisent jamais un singleton de module (pas de `getDatabase()` dans une feature).
 */
export interface AppContainer {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Générateur HLC de l'appareil ; les écritures passent par le WriteStamper des repositories. */
  readonly hlc: HlcClock;
  readonly data: DataAccess;
  readonly undo: UndoStack;
  /** Source unique des tâches chargées (ADR 0004, avenant). */
  readonly taskEntities: TaskEntities;
  readonly shortcuts: ShortcutRegistry;
  readonly platform: { readonly runtime: Runtime; readonly os: OsFamily };
}

export type AppContainerParts = Pick<AppContainer, 'hlc' | 'data'> & Partial<AppContainer>;

export function createAppContainer(parts: AppContainerParts): AppContainer {
  return {
    clock: parts.clock ?? systemClock,
    ids: parts.ids ?? uuidGenerator,
    hlc: parts.hlc,
    data: parts.data,
    undo: parts.undo ?? createUndoStack(),
    taskEntities: parts.taskEntities ?? createTaskEntities(),
    shortcuts: parts.shortcuts ?? createShortcutRegistry(),
    platform: parts.platform ?? { runtime: 'web', os: 'other' },
  };
}

/**
 * Store Zustand d'une feature lié au conteneur (une instance par conteneur, donc
 * isolée en test). Usage dans une feature :
 *
 *   export const tasksStore = defineFeatureStore((c) => createStore<TasksState>()((set) => ({
 *     …, create: async (input) => { const r = await taskUseCases(c).create(input); … },
 *   })));
 *   // composant : const today = useFeatureStore(tasksStore, (s) => s.today);
 *   // hors React (raccourci, test) : tasksStore.get(container).getState()
 */
export interface FeatureStore<S> {
  get(container: AppContainer): StoreApi<S>;
}

export function defineFeatureStore<S>(factory: (container: AppContainer) => StoreApi<S>): FeatureStore<S> {
  const instances = new WeakMap<AppContainer, StoreApi<S>>();
  return {
    get: (container) => {
      let store = instances.get(container);
      if (!store) {
        store = factory(container);
        instances.set(container, store);
      }
      return store;
    },
  };
}
