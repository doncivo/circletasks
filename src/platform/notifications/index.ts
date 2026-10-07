import type { OsFamily, Runtime } from '../runtime';
import type { NotificationScheduler } from './types';
import { createUnavailableNotificationScheduler } from './unavailable';

export * from './types';
export { createFakeNotificationScheduler, type FakeNotificationCall, type FakeNotificationScheduler } from './fake';
export { createUnavailableNotificationScheduler } from './unavailable';
export { sortRequests, validateRequests } from './validate';

/**
 * Résolveur : l'implémentation vide partout à N-TECH-01 (PC, navigateur de développement, Playwright, Vitest, et iPhone tant que
 * l'adaptateur réel n'existe pas). N-01 ajoutera la seule branche `tauri` + `ios`. Le PC n'émet aucun rappel (CLAUDE.md).
 */
export function openNotificationScheduler(_runtime: Runtime, _os: OsFamily): NotificationScheduler {
  return createUnavailableNotificationScheduler();
}
