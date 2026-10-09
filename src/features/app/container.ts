import type { StoreApi } from 'zustand';
import { systemClock, type Clock } from '../../domain/clock';
import type { HlcClock } from '../../domain/hlc';
import { uuidGenerator, type IdGenerator } from '../../domain/id';
import { observeWrites, type DataAccess } from '../../db/repositories';
import type { DesktopPlatform, OsFamily, Runtime } from '../../platform';
import { createMemoryCalendarPlatform, PRODUCTION_ENDPOINTS, type CalendarPlatform } from '../../platform/calendars';
import { createUnavailableBackup, type BackupService } from '../../platform/backup';
import { createUnavailableReminders, type RemindersPlatform } from '../../platform/reminders';
import type { SyncEngineService, SyncPlatform } from '../../platform/sync/types';
import { createUnavailableFiles, type FileService } from '../../platform/files';
import {
  createLedgerStore,
  createUnavailableNotificationScheduler,
  systemNotificationClock,
  type LedgerStore,
  type NotificationActionSource,
  type NotificationClock,
  type NotificationScheduler,
} from '../../platform/notifications';
import { createNoopFocusEndScheduler, type FocusEndScheduler, type FocusWindowPlatform, type SoundPlayer } from '../../platform/focus';
import { createNoopHaptics, type Haptics } from '../../platform/haptics';
import { createUnavailableAuthenticator, type AppAuthenticator } from '../../platform/biometric';
import { createNoopPrivacyShield, type PrivacyShield } from '../../platform/privacyShield';
import { createSettingsLedger } from '../reminders/settingsLedger';
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
  /** Rappels Apple (K-05 à K-07, ADR 0008 §10) : plugin Swift EventKit sur l'iPhone installé ; « indisponible » partout ailleurs (le PC ne les reçoit que par la synchro). */
  readonly reminders: RemindersPlatform;
  /** Mini-fenêtre Focus du PC (F-01, toujours au premier plan) ; null hors PC : la session s'affiche alors dans la fenêtre principale. */
  readonly focusWindow: FocusWindowPlatform | null;
  /** Notification locale de fin de session (iPhone, F-04) : contrat seul à l'ordre 3, implémentation vide ; l'envoi réel est de l'ordre 5. */
  readonly focusEndScheduler: FocusEndScheduler;
  /** Son de fin de session (F-04) ; null : carillon embarqué par défaut (élément Audio). */
  readonly soundPlayer: SoundPlayer | null;
  /**
   * Notifications locales de rappel (N-01, ADR 0012) : adaptateur réel sur l'iPhone installé, implémentation vide partout ailleurs (le PC
   * n'envoie aucune notification de rappel). Planifié par `replanNotifications` (features/reminders), jamais appelé ailleurs.
   */
  readonly notifications: NotificationScheduler;
  /** Registre local des notifications planifiées, partagé entre les rappels et la fin de Focus (accès sérialisé). */
  readonly notificationLedger: LedgerStore;
  /** Instant et fuseau de l'appareil pour la planification (injectables : tests, e2e). */
  readonly notificationClock: NotificationClock;
  /** Actions « Fait » et « +15 min » des notifications (N-03, plugin Swift) ; null hors iPhone installé : le PC n'en reçoit aucune. */
  readonly notificationActions: NotificationActionSource | null;
  /**
   * Déclencheur `edit` de la replanification (avenant N1.3) : appelé après toute écriture validée d'une tâche, routine, validation, événement,
   * rappel, espace (plages silencieuses) ou récapitulatif ; posé UNE fois ici par `observeWrites`, pas par chaque cas d'usage.
   */
  readonly notificationsPlanChanged: () => void;
  /** S'abonne au déclencheur `edit` ; renvoie le désabonnement. */
  readonly onNotificationsPlanChanged: (listener: () => void) => () => void;
  /** Enregistrement de fichiers (export H-03, P-04, P-07) : boîte « Enregistrer sous » sur PC, téléchargement en développement, indisponible sur iPhone avant l'ordre 5. */
  readonly files: FileService;
  /** Sauvegardes locales (P-04) : quotidienne, liste, restauration ; commandes Rust sur PC, mémoire en développement, indisponible sur iPhone. */
  readonly backups: BackupService;
  /**
   * Synchronisation par iCloud Drive (ADR 0011, lot Y2) ; null sans plateforme de synchro (navigateur de dev sans simulateur,
   * tests, iPhone avant l'ordre 5) : aucun coût ni écran.
   */
  readonly sync: SyncEngineService | null;
  /** Plateforme de synchro du service (`openSyncPlatform`), partagée avec la section Réglages ; null sans synchro. */
  readonly syncPlatform: SyncPlatform | null;
  /** Retour haptique (A-07, ADR 0013 §1.2) : plugin local sur l'iPhone installé, vide ailleurs ; cosmétique, ne rejette jamais. */
  readonly haptics: Haptics;
  /** Face ID ou code de l'iPhone (I-03, ADR 0013 §2.2) : plugin officiel sur l'iPhone installé, non pris en charge ailleurs. */
  readonly authenticator: AppAuthenticator;
  /** Cache de confidentialité natif (I-03, ADR 0013 §2.5) : plugin local sur l'iPhone installé, vide ailleurs. */
  readonly privacyShield: PrivacyShield;
}

export type AppContainerParts = Pick<AppContainer, 'hlc' | 'data'> & Partial<AppContainer>;

/** Réglages dont la modification change le plan de rappels : récapitulatifs (heures, activation) et langue des textes. */
const isPlanSetting = (key: string): boolean => key.startsWith('reminders.') || key === 'general.locale';

export function createAppContainer(parts: AppContainerParts): AppContainer {
  const planListeners = new Set<() => void>();
  const planChanged = (): void => {
    for (const listener of [...planListeners]) listener();
  };
  // Faux de test sans repositories (`{}`) : rien à observer.
  const hasRepositories = typeof (parts.data as Partial<DataAccess>).repos === 'object' && (parts.data as Partial<DataAccess>).repos !== null;
  const data = hasRepositories
    ? observeWrites(parts.data, {
        watch: ['tasks', 'recurrences', 'routines', 'routineLogs', 'events', 'reminders', 'spaces', 'settings'],
        settingsKey: isPlanSetting,
        onWrite: planChanged,
      })
    : parts.data;
  return {
    clock: parts.clock ?? systemClock,
    ids: parts.ids ?? uuidGenerator,
    hlc: parts.hlc,
    data,
    undo: parts.undo ?? createUndoStack(),
    taskEntities: parts.taskEntities ?? createTaskEntities(),
    shortcuts: parts.shortcuts ?? createShortcutRegistry(),
    platform: parts.platform ?? { runtime: 'web', os: 'other' },
    desktop: parts.desktop ?? null,
    calendars: parts.calendars ?? createMemoryCalendarPlatform(PRODUCTION_ENDPOINTS),
    reminders: parts.reminders ?? createUnavailableReminders(),
    focusWindow: parts.focusWindow ?? null,
    focusEndScheduler: parts.focusEndScheduler ?? createNoopFocusEndScheduler(),
    soundPlayer: parts.soundPlayer ?? null,
    notifications: parts.notifications ?? createUnavailableNotificationScheduler(),
    notificationLedger: parts.notificationLedger ?? createLedgerStore(hasRepositories ? createSettingsLedger(parts.data.repos.settings) : { load: () => Promise.resolve({ state: 'missing' }), save: () => Promise.resolve() }),
    notificationClock: parts.notificationClock ?? systemNotificationClock,
    notificationActions: parts.notificationActions ?? null,
    notificationsPlanChanged: planChanged,
    onNotificationsPlanChanged: (listener) => {
      planListeners.add(listener);
      return () => planListeners.delete(listener);
    },
    files: parts.files ?? createUnavailableFiles(),
    backups: parts.backups ?? createUnavailableBackup(),
    sync: parts.sync ?? null,
    syncPlatform: parts.syncPlatform ?? null,
    haptics: parts.haptics ?? createNoopHaptics(),
    authenticator: parts.authenticator ?? createUnavailableAuthenticator(),
    privacyShield: parts.privacyShield ?? createNoopPrivacyShield(),
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
