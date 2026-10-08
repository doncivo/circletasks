import type { OsFamily, Runtime } from '../runtime';
import { createFakeNotificationScheduler, type FakeNotificationScheduler } from './fake';
import type { NotificationClock } from './notificationClock';
import type { LedgerStore } from './notificationLedger';
import { NotificationSchedulerError, type NotificationScheduler } from './types';
import { createUnavailableNotificationScheduler } from './unavailable';

export * from './types';
export { createFakeNotificationScheduler, type FakeNotificationCall, type FakeNotificationScheduler } from './fake';
export { createUnavailableNotificationScheduler } from './unavailable';
export { sortRequests, validateRequests } from './validate';
export { systemNotificationClock, type NotificationClock } from './notificationClock';
export { createLedgerStore, type LedgerStore, type NotificationLedger } from './notificationLedger';

/** Dépendances de l'adaptateur réel (iPhone) : registre local partagé, horloge, journal technique (codes et nombres seulement). */
export interface NotificationSchedulerDeps {
  readonly ledger: LedgerStore;
  readonly clock: NotificationClock;
  readonly log?: (code: string, data?: Readonly<Record<string, number>>) => void;
}

/**
 * Résolveur (ADR 0012 avenant N1.2) : l'adaptateur réel pour (`tauri`, `ios`) seulement, chargé à la demande ; l'implémentation vide
 * partout ailleurs (PC, navigateur de développement, Playwright, Vitest). Le PC n'émet aucun rappel (CLAUDE.md).
 *
 * En développement seulement (`import.meta.env.DEV`, absent d'un build), un test de bout en bout peut poser `globalThis.__ctNotifications`
 * (planificateur injecté) ou `globalThis.__ctNotificationsFake = true` (le faux testé de `fake.ts`, exposé ensuite en
 * `globalThis.__ctNotifications` pour que le test lise ses appels), avant le chargement de la page.
 */
export function openNotificationScheduler(runtime: Runtime, os: OsFamily, deps?: NotificationSchedulerDeps): NotificationScheduler {
  if (import.meta.env.DEV) {
    const scope = globalThis as { __ctNotifications?: NotificationScheduler | FakeNotificationScheduler; __ctNotificationsFake?: boolean };
    if (!scope.__ctNotifications && scope.__ctNotificationsFake === true) scope.__ctNotifications = createFakeNotificationScheduler();
    if (scope.__ctNotifications) return scope.__ctNotifications;
  }
  if (runtime === 'tauri' && os === 'ios' && deps !== undefined) {
    return createLazyScheduler(async () => {
      const { createTauriNotificationScheduler, createIosNotificationBridge } = await import('./tauriNotifications');
      return createTauriNotificationScheduler({ bridge: createIosNotificationBridge(), ...deps });
    });
  }
  return createUnavailableNotificationScheduler();
}

/** Charge l'adaptateur à la première utilisation ; un chargement impossible rend `unavailable` (visible), jamais un silence. */
function createLazyScheduler(load: () => Promise<NotificationScheduler>): NotificationScheduler {
  let loaded: Promise<NotificationScheduler> | null = null;
  const real = (): Promise<NotificationScheduler> => {
    loaded ??= load().catch((error: unknown) => {
      loaded = null;
      throw error;
    });
    return loaded;
  };
  const unavailable = (): Promise<never> => Promise.reject(new NotificationSchedulerError('unavailable'));
  return {
    availability: () => real().then((scheduler) => scheduler.availability(), () => 'unavailable' as const),
    permission: () => real().then((scheduler) => scheduler.permission(), unavailable),
    requestPermission: () => real().then((scheduler) => scheduler.requestPermission(), unavailable),
    replace: (requests) => real().then((scheduler) => scheduler.replace(requests), unavailable),
    cancelAll: () => real().then((scheduler) => scheduler.cancelAll(), unavailable),
    pending: () => real().then((scheduler) => scheduler.pending(), unavailable),
    reservedCount: () => real().then((scheduler) => scheduler.reservedCount(), unavailable),
  };
}
