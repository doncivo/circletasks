import { detectOs, detectRuntime, type OsFamily, type Runtime } from '../runtime';
import type { NotificationClock } from '../notifications/notificationClock';
import type { LedgerStore } from '../notifications/notificationLedger';
import { createFakeFocusEndScheduler, createNoopFocusEndScheduler, type FakeFocusEndScheduler } from './endScheduler';
import type { FocusEndScheduler, FocusWindowClient, FocusWindowPlatform } from './types';

export * from './constants';
export { createMemoryFocusWindow, type MemoryFocusWindow } from './memory';
export { createFakeFocusEndScheduler, createNoopFocusEndScheduler, type FakeFocusEndScheduler, type FakeSchedulerCall } from './endScheduler';
export { createFakeSoundPlayer, createHtmlAudioPlayer, type FakeSoundPlayer } from './sound';
export type {
  FocusPhase,
  FocusEndScheduler,
  FocusWindowAction,
  FocusWindowClient,
  FocusWindowPlatform,
  FocusWindowPosition,
  FocusWindowState,
  SoundPlayer,
} from './types';

/**
 * Mini-fenêtre Focus du PC : implémentation Tauri sur Windows installé, `null` ailleurs (navigateur, Playwright, iPhone : la
 * session s'affiche alors dans la fenêtre principale). Import dynamique : l'API fenêtres n'est chargée que dans l'app PC.
 */
export async function openFocusWindowPlatform(runtime: Runtime = detectRuntime(), os: OsFamily = detectOs()): Promise<FocusWindowPlatform | null> {
  if (runtime !== 'tauri' || os !== 'windows') return null;
  const { createTauriFocusWindow } = await import('./tauriFocusWindow');
  return createTauriFocusWindow();
}

/** Côté mini-fenêtre : `null` hors Tauri (la vue n'est alors jamais lancée seule). */
export async function openFocusWindowClient(runtime: Runtime = detectRuntime()): Promise<FocusWindowClient | null> {
  if (runtime !== 'tauri') return null;
  const { createTauriFocusClient } = await import('./tauriFocusWindow');
  return createTauriFocusClient();
}

/** Dépendances de la notification de fin réelle (iPhone) : registre local partagé avec les rappels, horloge, textes de la feature. */
export interface FocusEndDeps {
  readonly ledger: LedgerStore;
  readonly clock: NotificationClock;
  readonly compose: (taskTitle: string, plannedMin: number | null) => { readonly title: string; readonly body: string };
}

/**
 * Notification de fin de session (F-04 critère 11) : l'adaptateur réel pour (`tauri`, `ios`) seulement, chargé à la demande ; l'implémentation
 * vide partout ailleurs (PC, navigateur, Vitest : le PC n'émet que le son de fin). En développement seulement, un test de bout en bout peut
 * poser `globalThis.__ctFocusEnd` ou `globalThis.__ctFocusEndFake = true` (le faux testé, exposé en `__ctFocusEnd`).
 */
export function openFocusEndScheduler(runtime: Runtime, os: OsFamily, deps?: FocusEndDeps): FocusEndScheduler {
  if (import.meta.env.DEV) {
    const scope = globalThis as { __ctFocusEnd?: FocusEndScheduler | FakeFocusEndScheduler; __ctFocusEndFake?: boolean };
    if (!scope.__ctFocusEnd && scope.__ctFocusEndFake === true) scope.__ctFocusEnd = createFakeFocusEndScheduler();
    if (scope.__ctFocusEnd) return scope.__ctFocusEnd;
  }
  if (runtime === 'tauri' && os === 'ios' && deps !== undefined) {
    let loaded: Promise<FocusEndScheduler> | null = null;
    const real = (): Promise<FocusEndScheduler> => {
      loaded ??= Promise.all([import('./tauriFocusEnd'), import('../notifications/tauriNotifications')]).then(([focus, notifications]) =>
        focus.createTauriFocusEndScheduler({ bridge: notifications.createIosNotificationBridge(), ...deps }),
      );
      loaded.catch(() => {
        loaded = null;
      });
      return loaded;
    };
    return {
      schedule: (sessionId, fireAt, title, plannedMin) => real().then((scheduler) => scheduler.schedule(sessionId, fireAt, title, plannedMin)),
      cancel: (sessionId) => real().then((scheduler) => scheduler.cancel(sessionId)),
    };
  }
  return createNoopFocusEndScheduler();
}
