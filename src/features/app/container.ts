import type { StoreApi } from 'zustand';
import { systemClock, type Clock } from '../../domain/clock';
import type { HlcClock } from '../../domain/hlc';
import { uuidGenerator, type IdGenerator } from '../../domain/id';
import type { DataAccess } from '../../db/repositories';
import type { DesktopPlatform, OsFamily, Runtime } from '../../platform';
import { createMemoryCalendarPlatform, PRODUCTION_ENDPOINTS, type CalendarPlatform } from '../../platform/calendars';
import { createUnavailableBackup, type BackupService } from '../../platform/backup';
import { createUnavailableFiles, type FileService } from '../../platform/files';
import { createNoopFocusEndScheduler, type FocusEndScheduler, type FocusWindowPlatform, type SoundPlayer } from '../../platform/focus';
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
 * Ils ne lisent jamais un singleton de module (aucune base globale dans une feature).
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
  /** Intégration système du PC Windows (D-01 à D-03, ADR 0006) ; null hors PC (navigateur, iPhone, tests). */
  readonly desktop: DesktopPlatform | null;
  /** Agendas externes (K-01 à K-03, ADR 0008) : coffre, transport HTTP et OAuth ; commandes Rust dans l'app, mémoire ailleurs. */
  readonly calendars: CalendarPlatform;
  /** Mini-fenêtre Focus du PC (F-01, toujours au premier plan) ; null hors PC : la session s'affiche alors dans la fenêtre principale. */
  readonly focusWindow: FocusWindowPlatform | null;
  /** Notification locale de fin de session (iPhone, F-04) : contrat seul à l'ordre 3, implémentation vide ; l'envoi réel est de l'ordre 5. */
  readonly focusEndScheduler: FocusEndScheduler;
  /** Son de fin de session (F-04) ; null : carillon embarqué par défaut (élément Audio). */
  readonly soundPlayer: SoundPlayer | null;
  /** Enregistrement de fichiers (export H-03, P-04, P-07) : boîte « Enregistrer sous » sur PC, téléchargement en développement, indisponible sur iPhone avant l'ordre 5. */
  readonly files: FileService;
  /** Sauvegardes locales (P-04) : quotidienne, liste, restauration ; commandes Rust sur PC, mémoire en développement, indisponible sur iPhone. */
  readonly backups: BackupService;
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
    desktop: parts.desktop ?? null,
    calendars: parts.calendars ?? createMemoryCalendarPlatform(PRODUCTION_ENDPOINTS),
    focusWindow: parts.focusWindow ?? null,
    focusEndScheduler: parts.focusEndScheduler ?? createNoopFocusEndScheduler(),
    soundPlayer: parts.soundPlayer ?? null,
    files: parts.files ?? createUnavailableFiles(),
    backups: parts.backups ?? createUnavailableBackup(),
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
