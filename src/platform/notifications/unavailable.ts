import type { NotificationScheduler } from './types';
import { validateRequests } from './validate';

/**
 * Implémentation vide (PC, navigateur de développement, Playwright, Vitest) : le PC n'émet aucune notification de rappel, les rappels
 * sont envoyés par l'iPhone seulement (CLAUDE.md). `availability()` = `unavailable` pour que Réglages > Rappels le dise (N-01).
 * Elle valide quand même la liste : PC et iPhone refusent de la même façon une liste fautive.
 */
export function createUnavailableNotificationScheduler(): NotificationScheduler {
  return {
    availability: () => Promise.resolve('unavailable'),
    permission: () => Promise.resolve('denied'),
    requestPermission: () => Promise.resolve('denied'),
    replace: (requests) => {
      try {
        validateRequests(requests);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return Promise.resolve({ scheduled: 0, cancelled: 0, kept: 0 });
    },
    cancelAll: () => Promise.resolve(),
    pending: () => Promise.resolve([]),
    reservedCount: () => Promise.resolve(0),
  };
}
